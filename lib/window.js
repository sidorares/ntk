import keysym from 'keysym';
import x11 from 'x11';

import { safeRelease } from './cleanup.js';
import Drawable from './drawable.js';
import Pixmap from './pixmap.js';
import * as xevents from './events_map.js';

export default class Window extends Drawable {
  // one wrapper per X window id and connection: constructing a Window for a
  // known id returns the cached instance
  static cache = new Map();

  constructor(app, args = {}) {
    if (args.id) {
      const cached = Window.cache.get(args.id);
      // TODO: check event mask, if more events in args - update it
      if (cached) return cached;
    }

    super();

    const X = app.X;
    this.X = X;
    this.app = app;
    this.display = app.display;
    this._mapped = false;
    this._readyPromiseResolve = null;
    this._readyPromise = new Promise((resolve) => {
      this._readyPromiseResolve = resolve;
    });

    const parentId = args.parent ? args.parent.id : app.display.screen[0].root;

    // double buffering (see docs/window.md): windows we created get a
    // backing pixmap when a 2d context is requested, unless opted out
    this._foreign = !!args.id;
    this._backingOptOut = args.backingStore === false;
    this._backing = null;

    if (!args.id) {
      this.id = X.AllocID();
      this.eventMask = x11.eventMask.StructureNotify;

      for (const ntkEventName in xevents.maskCamelCase) {
        if (typeof args[ntkEventName] === 'function') {
          this.eventMask |= xevents.maskCamelCase[ntkEventName];
          this.on(xevents.toSnake[ntkEventName], args[ntkEventName]);
        }
      }

      this.width = args.width ?? 800;
      this.height = args.height ?? 800;
      this.x = args.x ?? 0;
      this.y = args.y ?? 0;
      X.CreateWindow(this.id, parentId, this.x, this.y, this.width, this.height, 0, 0, 0, 0, {
        // NorthWest bit gravity: keep the old content anchored during
        // resize instead of discarding it (less flicker between the resize
        // and our redraw)
        bitGravity: 1,
        eventMask: this.eventMask
      });
    } else {
      this.id = args.id;
      this.eventMask = 0;
      // populate width and height
      X.GetGeometry(this.id, (err, res) => {
        if (!err) {
          this.width = res.width;
          this.height = res.height;
          this.x = res.xPos;
          this.y = res.yPos;
        }
        this._readyPromiseResolve();
      });
    }

    Window.cache.set(this.id, this);

    if (args.title) {
      this.setTitle(args.title);
    }

    X.event_consumers[this.id] = this;
    this.on('event', (ev) => {
      const ntkev = ev; // todo: clone
      ntkev.window = this;
      ntkev.target = this;
      const eventName = xevents.eventName[ev.type];
      if (!eventName) return;
      // double-buffered windows serve expose events from the backing pixmap
      // — user code is only asked to redraw when the content is invalid
      if (eventName === 'expose' && this._backing) {
        this._handleExpose(ev);
        return;
      }
      // TODO cleanup
      // also it seems that in keysym module not all keys have valid unicode values
      if (eventName === 'keydown') {
        const evKeysym = X.keycode2keysyms[ev.keycode];
        const shift = ev.buttons & 1;
        const capsLock = ev.buttons & 2;
        const capital = (capsLock && !shift) || (shift && !capsLock);
        const symInd = capital ? 1 : 0; // TODO: AltGr & other modifiers to use syms 2, 3, 4 etc
        const entry = evKeysym && keysym.fromKeysym(evKeysym[symInd]);
        if (entry) {
          ev.codepoint = entry.unicode;
        }
      }
      this.emit(eventName, ntkev);
      // anything drawn during the handlers becomes visible in one blit
      if (this._dirty) this._present();
    });

    this.on('child-event', (ev) => {
      const eventName = xevents.eventName[ev.type];
      const ntkev = {
        parent: this,
        window: new Window(app, { id: ev.wid })
      };
      // wait until we know that we track correct x,y,w,h values
      ntkev.window._readyPromise.then(() => {
        this.emit(eventName, ntkev);
      });
    });

    this.on('newListener', (name) => {
      // extend the server-side event mask if this event needs it
      const eventMask = xevents.mask[name];
      if (!eventMask) return;
      if ((eventMask & this.eventMask) === 0) {
        this.eventMask |= eventMask;
        X.ChangeWindowAttributes(this.id, { eventMask: this.eventMask }, () => {});
      }
    });

    this.on('resize', (ev) => {
      this.width = ev.width;
      this.height = ev.height;
      this.x = ev.x;
      this.y = ev.y;
    });

    this.on('map', () => (this._mapped = true));
    this.on('unmap', () => (this._mapped = false));
    this.on('destroy', () => {
      this._forget();
      // the server frees window-backed pictures with the window — let
      // contexts drop their wrappers without issuing FreePicture
      this.emit('_destroyed');
    });

    if (typeof this.width !== 'undefined') {
      this._readyPromiseResolve();
    }
  }

  _forget() {
    Window.cache.delete(this.id);
    delete this.X.event_consumers[this.id];
  }

  /**
   * 2d contexts on windows draw into a backing pixmap by default and blit to
   * the window in single CopyArea requests (after event handlers return, and
   * coalesced per event-loop tick otherwise) — no clear-then-draw flicker.
   * Expose events are served from the pixmap without invoking user handlers;
   * an 'expose' (and 'draw') event is emitted only when a real redraw is
   * needed (first paint, resize). Opt out with
   * `createWindow({ backingStore: false })`.
   */
  getContext(name, ...args) {
    if (name === '2d' && !this._backing && !this._backingOptOut && !this._foreign) {
      this._enableBackingStore();
    }
    return super.getContext(name, ...args);
  }

  _enableBackingStore() {
    this._dirty = false;
    this._backingValid = false;
    this._presentScheduled = false;
    this._redrawScheduled = false;
    this._backedW = this.width;
    this._backedH = this.height;

    this._presentGc = this.X.AllocID();
    this.X.CreateGC(this._presentGc, this.id, { graphicsExposures: 0 });
    this._allocBacking(this.width, this.height);

    // the redraw cycle is driven by Expose interception — make sure the
    // server sends them even if user code only listens to 'draw'
    if (!(this.eventMask & x11.eventMask.Exposure)) {
      this.eventMask |= x11.eventMask.Exposure;
      this.X.ChangeWindowAttributes(this.id, { eventMask: this.eventMask }, () => {});
    }

    this.on('resize', (ev) => {
      if (ev.width === this._backedW && ev.height === this._backedH) return;
      this._backedW = ev.width;
      this._backedH = ev.height;
      this._allocBacking(ev.width, ev.height);
      this._backingValid = false;
      this._requestRedraw();
    });
  }

  // grow-only backing pixmap (re)allocation; new area is cleared to white
  _allocBacking(w, h) {
    const cur = this._backing;
    if (cur && cur.width >= w && cur.height >= h) return;
    const newW = Math.max(w, cur ? cur.width : 0);
    const newH = Math.max(h, cur ? cur.height : 0);
    const pixmap = new Pixmap(this.app, {
      parent: this,
      width: newW,
      height: newH,
      depth: this.display.screen[0].root_depth
    });
    if (!this._clearGc) {
      // reusable across reallocs: a GC is valid for any drawable of the
      // same screen and depth (node-x11 has no FreeGC request)
      this._clearGc = this.X.AllocID();
      this.X.CreateGC(this._clearGc, pixmap.id, {
        foreground: this.display.screen[0].white_pixel,
        graphicsExposures: 0
      });
    }
    this.X.PolyFillRectangle(pixmap.id, this._clearGc, [0, 0, newW, newH]);
    if (cur) cur.destroy();
    this._backing = pixmap;
    this._backingValid = false;
    // contexts re-bind their pictures to the new pixmap
    this.emit('_backing');
  }

  _handleExpose(ev) {
    if (this._backingValid) {
      this.X.CopyArea(this._backing.id, this.id, this._presentGc, ev.x, ev.y, ev.x, ev.y, ev.width, ev.height);
    } else {
      this._requestRedraw();
    }
  }

  // ask user code to repaint (full window), at most once per tick
  _requestRedraw() {
    if (this._redrawScheduled) return;
    this._redrawScheduled = true;
    setImmediate(() => {
      this._redrawScheduled = false;
      const ev = {
        x: 0,
        y: 0,
        width: this.width,
        height: this.height,
        synthetic: true,
        window: this,
        target: this
      };
      this.emit('draw', ev);
      this.emit('expose', ev);
      if (this._dirty) this._present();
    });
  }

  // called by rendering contexts after each drawing operation
  _markDirty() {
    if (!this._backing) return;
    this._dirty = true;
    this._backingValid = true;
    if (this._presentScheduled) return;
    // coalesce draws that happen outside event handlers into one blit
    this._presentScheduled = true;
    setImmediate(() => {
      this._presentScheduled = false;
      if (this._dirty) this._present();
    });
  }

  _present() {
    if (!this._backing) return;
    this._dirty = false;
    const w = Math.min(this.width, this._backing.width);
    const h = Math.min(this.height, this._backing.height);
    this.X.CopyArea(this._backing.id, this.id, this._presentGc, 0, 0, 0, 0, w, h);
  }

  map() {
    this.X.MapWindow(this.id);
    return this;
  }

  unmap() {
    this.X.UnmapWindow(this.id);
    return this;
  }

  resize(w, h) {
    this.X.ResizeWindow(this.id, w, h);
    return this;
  }

  move(x, y) {
    this.X.MoveWindow(this.id, x, y);
    return this;
  }

  moveResize(x, y, w, h) {
    this.X.MoveResizeWindow(this.id, x, y, w, h);
    return this;
  }

  setState(newState) {
    if (newState.visible && !this._mapped) {
      this.map();
    }
    if (newState.visible === false && this._mapped) {
      this.unmap();
    }

    const configureProps = {};
    let needConfigureWindow = false;
    if (newState.x !== undefined && this.x !== newState.x) {
      needConfigureWindow = true;
      configureProps.x = newState.x;
    }
    if (newState.y !== undefined && this.y !== newState.y) {
      needConfigureWindow = true;
      configureProps.y = newState.y;
    }
    if (newState.width !== undefined && this.width !== newState.width) {
      needConfigureWindow = true;
      configureProps.width = newState.width;
    }
    if (newState.height !== undefined && this.height !== newState.height) {
      needConfigureWindow = true;
      configureProps.height = newState.height;
    }
    if (needConfigureWindow) {
      this.X.ConfigureWindow(this.id, configureProps);
    }

    // TODO: map other window attributes ( border, gravity, cursor etc )
    // via ChangeWindowAttributes
  }

  setTitle(title) {
    this.X.ChangeProperty(
      0,
      this.id,
      this.X.atoms.WM_NAME,
      this.X.atoms.STRING,
      8,
      title
    );
    return this;
  }

  setMouseHintOnly(isOn) {
    if (isOn && !(this.eventMask & x11.eventMask.PointerMotionHint)) {
      this.eventMask |= x11.eventMask.PointerMotionHint;
    } else if (!isOn && this.eventMask & x11.eventMask.PointerMotionHint) {
      this.eventMask &= ~x11.eventMask.PointerMotionHint;
    } else {
      return this;
    }
    this.X.ChangeWindowAttributes(this.id, { eventMask: this.eventMask }, () => {});
    return this;
  }

  queryPointer(callback) {
    this.X.QueryPointer(this.id, callback);
    return this;
  }

  grabPointer() {
    this.X.GrabPointer(this.id, true, x11.eventMask.PointerMotion, 0, 1, 0, 0, 0);
  }

  reparentTo(newParent, x, y) {
    this.X.ReparentWindow(this.id, newParent.id, x, y);
  }

  queryTree(callback) {
    const app = this.app;
    this.X.QueryTree(this.id, (err, tree) => {
      if (err) return callback(err);
      const children = tree.children.map((id) => new Window(app, { id }));
      const parent = new Window(app, { id: tree.parent });
      // note that this root may be different from app.rootWindow() because
      // there can be multiple screens (and roots)
      const root = new Window(app, { id: tree.root });
      const readyPromises = [...children, parent, root].map((w) => w._readyPromise);
      Promise.all(readyPromises).then(() => {
        callback(null, { parent, root, children });
      });
    });
    return this;
  }

  createPixmap(params = {}) {
    return new Pixmap(this.app, {
      parent: this,
      width: this.width,
      height: this.height,
      // TODO: use window depth
      depth: 32,
      ...params
    });
  }

  createWindow(params = {}) {
    return new Window(this.app, { parent: this, ...params });
  }

  // opt in to the WM_DELETE_WINDOW protocol: the window manager sends a
  // 'message' event instead of killing the connection when the user closes
  // the window
  setActions() {
    const X = this.X;
    const wid = this.id;
    X.InternAtom(false, 'WM_PROTOCOLS', (err, WM_PROTOCOLS) => {
      X.InternAtom(false, 'WM_DELETE_WINDOW', (err2, WM_DELETE_WINDOW) => {
        if (err || err2) return;
        const data = Buffer.alloc(4);
        data.writeUInt32LE(WM_DELETE_WINDOW, 0);
        X.ChangeProperty(0, wid, WM_PROTOCOLS, X.atoms.ATOM, 32, data);
      });
    });
  }

  destroy() {
    this._forget();
    this.emit('_destroyed');
    if (this._backing) {
      this._backing.destroy();
      this._backing = null;
    }
    safeRelease(this.X, () => this.X.DestroyWindow(this.id));
  }

  [Symbol.dispose]() {
    this.destroy();
  }

  inspect() {
    return `[Window ${this.id}]`;
  }
}
