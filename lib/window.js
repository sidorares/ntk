import keysym from 'keysym';
import x11 from 'x11';

import { safeRelease } from './cleanup.js';
import Drawable from './drawable.js';
import Pixmap from './pixmap.js';
import * as xevents from './events_map.js';

// X window attributes forwarded verbatim from constructor args into the
// CreateWindow value list (node-x11 valueMask names, see x11
// lib/corereqs.js). Deliberately not forwarded:
//  - eventMask: computed from the onXxx handler args (an explicit
//    args.eventMask is OR-ed into the computed mask instead)
//  - backingStore: ntk's `backingStore: false` creation option opts out of
//    client-side double buffering (see docs/window.md) and predates this
//    list — it is a different concept from the X backing-store attribute,
//    which is therefore not forwarded to avoid a silent collision
// `visual`, `depth`, `windowClass` and `borderWidth` are CreateWindow header
// fields rather than attributes, and are handled separately below
const forwardedXAttributes = [
  'backgroundPixmap',
  'backgroundPixel',
  'borderPixmap',
  'borderPixel',
  'bitGravity',
  'winGravity',
  'backingPlanes',
  'backingPixel',
  'overrideRedirect',
  'saveUnder',
  'doNotPropagateMask',
  'colormap',
  'cursor'
];

/**
 * Turn a GetProperty reply into the shape the caller asked for. X property
 * types are atoms, so the only distinction we can make without a round trip
 * is against the predefined ones: STRING is latin-1 by definition (ICCCM),
 * and everything else carrying text — UTF8_STRING above all — is UTF-8.
 */
function decodeProperty(prop, as, X) {
  if (as === 'string') {
    const encoding = prop.type === X.atoms.STRING ? 'latin1' : 'utf8';
    // these properties are conventionally NUL-terminated, sometimes twice
    return prop.data.toString(encoding).replace(/\0+$/, '');
  }
  if (as === 'numbers') {
    const out = [];
    for (let i = 0; i + 4 <= prop.data.length; i += 4) out.push(prop.data.readUInt32LE(i));
    return out;
  }
  return { type: prop.type, data: prop.data };
}

export default class Window extends Drawable {
  // one wrapper per X window id and connection: constructing a Window for a
  // known id returns the cached instance. Keyed by connection as well as
  // id, because ids are only unique within a server, not within a process —
  // two connections to the same display see the same root window, and a
  // window manager sees every other client's ids.
  static cache = new WeakMap();

  static _cacheFor(app) {
    let byId = Window.cache.get(app);
    if (!byId) Window.cache.set(app, (byId = new Map()));
    return byId;
  }

  constructor(app, args = {}) {
    // 0 is X None, not a window. Without this it fails the truthiness test
    // below and falls through to the create path, silently making a real
    // 800x800 window out of what was almost certainly a missing id.
    if (args.id === 0) {
      throw new Error('ntk: 0 (None) is not a window id');
    }
    if (args.id) {
      const cached = Window._cacheFor(app).get(args.id);
      // TODO: check event mask, if more events in args - update it
      if (cached) return cached;
    }

    super();

    const X = app.X;
    this.X = X;
    this.app = app;
    this.display = app.display;
    this._mapped = false;
    this._destroyed = false;
    this._titleSerial = 0;
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
    this._dirty = false;
    this._presentPending = false;

    // frame clock state: coalesced events, synthetic redraws and
    // requestAnimationFrame callbacks are delivered in paced frames
    // (see docs/window.md "Frames, coalescing and slow connections")
    this._coalesce = args.coalesceEvents !== false;
    this._frameSyncEnabled = args.frameSync !== false;
    this.frameInterval = args.frameInterval ?? 16;
    this.frameLatency = null;
    this._frame = {
      pending: new Map(), // coalescible event name -> merged event
      rafCbs: [],
      rafId: 0,
      inFlight: false, // fence round-trip awaiting the server's reply
      timer: null,
      scheduled: false,
      needsRedraw: false
    };

    if (!args.id) {
      this.id = X.AllocID();
      this.eventMask = x11.eventMask.StructureNotify;

      for (const ntkEventName in xevents.maskCamelCase) {
        if (typeof args[ntkEventName] === 'function') {
          this.eventMask |= xevents.maskCamelCase[ntkEventName];
          this.on(xevents.toSnake[ntkEventName], args[ntkEventName]);
        }
      }

      if (typeof args.eventMask === 'number') {
        this.eventMask |= args.eventMask;
      }

      this.width = args.width ?? 800;
      this.height = args.height ?? 800;
      this.x = args.x ?? 0;
      this.y = args.y ?? 0;
      const values = {
        // NorthWest bit gravity: keep the old content anchored during
        // resize instead of discarding it (less flicker between the resize
        // and our redraw)
        bitGravity: 1,
        eventMask: this.eventMask
      };
      for (const name of forwardedXAttributes) {
        if (args[name] !== undefined) values[name] = args[name];
      }
      // a window on a non-default visual (GLX, ARGB) also needs its own
      // colormap and an explicit border pixel: inheriting either from a
      // parent of a different depth is a BadMatch (X11 CreateWindow)
      this.visual = args.visual ?? 0;
      this.depth = args.depth ?? 0;
      this.windowClass = args.windowClass ?? 0;
      if (this.visual) {
        if (values.colormap === undefined) {
          this._ownedColormap = app.createColormap(this.visual);
          values.colormap = this._ownedColormap;
        }
        if (values.borderPixel === undefined && values.borderPixmap === undefined) values.borderPixel = 0;
      }
      const borderWidth = args.borderWidth ?? 0;
      X.CreateWindow(
        this.id, parentId, this.x, this.y, this.width, this.height,
        borderWidth, this.depth, this.windowClass, this.visual, values
      );
    } else {
      this.id = args.id;
      this.eventMask = 0;
      this.visual = 0;
      this.depth = 0;
      // populate width and height
      X.GetGeometry(this.id, (err, res) => {
        if (!err) {
          this.width = res.width;
          this.height = res.height;
          this.x = res.xPos;
          this.y = res.yPos;
          this.depth = res.depth;
        }
        this._readyPromiseResolve();
      });
    }

    Window._cacheFor(app).set(this.id, this);

    if (args.title) {
      this.setTitle(args.title);
    }
    if (args.wmClass) {
      const c = args.wmClass;
      if (Array.isArray(c)) this.setClass(c[0], c[1]);
      else if (typeof c === 'object') this.setClass(c.instance, c.class ?? c.instance);
      else this.setClass(c);
    }
    if (args.windowType) {
      this.setWindowType(args.windowType);
    }
    if (args.sizeHints || args.resizable === false) {
      this.setSizeHints({ ...args.sizeHints, ...(args.resizable === false && { resizable: false }) });
    }
    if (args.alwaysOnTop) {
      this.setAlwaysOnTop(true);
    }

    X.event_consumers[this.id] = this;
    this.on('event', (ev) => {
      const ntkev = ev; // todo: clone
      ntkev.window = this;
      ntkev.target = this;
      const eventName = xevents.eventName[ev.type];
      if (!eventName) return;
      // geometry bookkeeping happens on the raw stream so wnd.x/y/width/height
      // are current even while a user-facing 'resize' event sits coalesced
      if (eventName === 'resize') {
        this.width = ev.width;
        this.height = ev.height;
        this.x = ev.x;
        this.y = ev.y;
      }
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
      if (this._coalesce && xevents.coalesce[eventName]) {
        this._enqueueCoalesced(eventName, ntkev);
        return;
      }
      // deliver buffered state events before a discrete one so handlers see
      // them in the order they happened (a drag sees the move, then the up)
      this._flushCoalesced();
      this.emit(eventName, ntkev);
      // anything drawn during the handlers becomes visible in one blit
      if (this._dirty) this._present();
    });

    // Events about a *child* of this window: the substructure requests a
    // window manager lives on (map_request, configure_request) plus
    // create. The whole X event is carried through — a ConfigureRequest
    // without its geometry and value mask says only "someone wants
    // something", which is not enough to answer it — with `parent` and
    // `window` upgraded from raw ids to Window objects.
    this.on('child-event', (ev) => {
      const eventName = xevents.eventName[ev.type];
      if (!eventName) return;
      const child = new Window(app, { id: ev.wid });
      const ntkev = { ...ev, parent: this, window: child, target: child };
      // wait until we know that we track correct x,y,w,h values
      child._readyPromise.then(() => {
        this.emit(eventName, ntkev);
      });
    });

    this.on('newListener', (name) => {
      // extend the server-side event mask if this event needs it
      const eventMask = xevents.mask[name];
      if (!eventMask) return;
      if ((eventMask & this.eventMask) === 0) {
        this.eventMask |= eventMask;
        // the selection can legitimately fail — SubstructureRedirect is
        // one-client-only, so `on('map_request')` is how you find out
        // another window manager owns this window. Route it to the app's
        // error hook rather than dropping it; selectInput() is the
        // explicit form that hands the error straight back.
        X.ChangeWindowAttributes(this.id, { eventMask: this.eventMask }, (err) => {
          if (err) this.app.options.onXError?.(err);
        });
      }
    });

    this.on('map', () => (this._mapped = true));
    this.on('unmap', () => (this._mapped = false));
    this.on('destroy', () => {
      this._destroyed = true;
      this._forget();
      this._teardownFrame();
      // the server frees window-backed pictures with the window — let
      // contexts drop their wrappers without issuing FreePicture
      this.emit('_destroyed');
    });

    if (typeof this.width !== 'undefined') {
      this._readyPromiseResolve();
    }
  }

  _forget() {
    Window._cacheFor(this.app).delete(this.id);
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
      // must match the window's depth: CopyArea between drawables of
      // different depths is a BadMatch
      depth: this.depth || this.display.screen[0].root_depth
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

  // ask user code to repaint (full window), on the next paced frame
  _requestRedraw() {
    this._frame.needsRedraw = true;
    this._scheduleFrame();
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

  /*
   * Frame clock. Noisy events (see events_map coalesce), synthetic redraws
   * and requestAnimationFrame callbacks are delivered in "frames", paced by
   * two independent gates:
   *
   *  - a fence: a cheap request with a reply (GetInputFocus) sent after each
   *    frame; X processes requests in order, so its reply confirms the
   *    server consumed everything the frame drew. At most one fence is in
   *    flight — on a slow connection frames degrade to one per round-trip
   *    instead of queueing a trail of stale updates.
   *  - a timer: at most one paced frame per `frameInterval` ms, so a fast
   *    local server doesn't get redraws at input-device rate.
   *
   * Discrete events (mousedown, keydown, ...) bypass the timer for latency,
   * but their blits still respect the fence via _present().
   */
  _scheduleFrame() {
    const f = this._frame;
    if (f.scheduled || f.inFlight || f.timer) return;
    f.scheduled = true;
    setImmediate(() => {
      f.scheduled = false;
      // gates may have been armed after this got scheduled (work queued
      // from inside a running frame, e.g. a rAF loop re-registering) —
      // the fence reply / timer expiry will reschedule then
      if (f.inFlight || f.timer) return;
      this._runFrame();
    });
  }

  _runFrame() {
    const f = this._frame;
    if (!f.pending.size && !f.rafCbs.length && !f.needsRedraw && !this._dirty && !this._presentPending) return;
    this._flushCoalesced();
    if (f.needsRedraw) {
      f.needsRedraw = false;
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
    }
    if (f.rafCbs.length) {
      const cbs = f.rafCbs;
      f.rafCbs = [];
      const now = performance.now();
      for (const entry of cbs) entry.cb(now);
    }
    if (this._dirty || this._presentPending) this._presentNow();
    this._armFence();
    this._armTimer();
  }

  _enqueueCoalesced(name, ev) {
    const pending = this._frame.pending;
    const prev = pending.get(name);
    if (!prev) {
      ev.coalesced = [ev];
      if (xevents.coalesce[name] === 'union') {
        ev.rects = [{ x: ev.x, y: ev.y, width: ev.width, height: ev.height }];
      }
      pending.set(name, ev);
    } else if (xevents.coalesce[name] === 'union') {
      prev.coalesced.push(ev);
      prev.rects.push({ x: ev.x, y: ev.y, width: ev.width, height: ev.height });
      const x2 = Math.max(prev.x + prev.width, ev.x + ev.width);
      const y2 = Math.max(prev.y + prev.height, ev.y + ev.height);
      prev.x = Math.min(prev.x, ev.x);
      prev.y = Math.min(prev.y, ev.y);
      prev.width = x2 - prev.x;
      prev.height = y2 - prev.y;
    } else {
      // keep-last: the newest event wins, older ones ride along
      ev.coalesced = prev.coalesced;
      ev.coalesced.push(ev);
      pending.set(name, ev);
    }
    this._scheduleFrame();
  }

  _flushCoalesced() {
    const pending = this._frame.pending;
    if (!pending.size) return;
    this._frame.pending = new Map();
    // resize first: geometry-dependent handlers (re-layout) run before repaints
    for (const name of ['resize', 'expose']) {
      const ev = pending.get(name);
      if (ev) {
        pending.delete(name);
        this.emit(name, ev);
      }
    }
    for (const [name, ev] of pending) this.emit(name, ev);
  }

  _armFence() {
    if (!this._frameSyncEnabled) return;
    const f = this._frame;
    if (f.inFlight) return;
    const start = performance.now();
    safeRelease(this.X, () => {
      f.inFlight = true;
      this.X.GetInputFocus(() => {
        f.inFlight = false;
        this.frameLatency = performance.now() - start;
        if (this._presentPending) {
          // a blit deferred while the fence was in flight: show it now
          this._presentNow();
          this._armFence();
        }
        if ((f.pending.size || f.rafCbs.length || f.needsRedraw) && !f.timer) this._scheduleFrame();
      });
    });
  }

  _armTimer() {
    if (!(this.frameInterval > 0)) return;
    const f = this._frame;
    if (f.timer) return;
    f.timer = setTimeout(() => {
      f.timer = null;
      if (f.pending.size || f.rafCbs.length || f.needsRedraw) this._scheduleFrame();
    }, this.frameInterval);
    if (typeof f.timer.unref === 'function') f.timer.unref();
  }

  _teardownFrame() {
    const f = this._frame;
    if (f.timer) {
      clearTimeout(f.timer);
      f.timer = null;
    }
    f.pending.clear();
    f.rafCbs = [];
    f.needsRedraw = false;
    this._presentPending = false;
  }

  /**
   * DOM-style requestAnimationFrame: `cb(now)` runs on this window's next
   * paced frame — at most once per `frameInterval` ms and with at most one
   * frame's requests unacknowledged by the server, so animation loops adapt
   * to connection latency instead of flooding a slow link.
   * Returns an id for cancelAnimationFrame().
   */
  requestAnimationFrame(cb) {
    const f = this._frame;
    const id = ++f.rafId;
    f.rafCbs.push({ id, cb });
    this._scheduleFrame();
    return id;
  }

  cancelAnimationFrame(id) {
    const f = this._frame;
    const idx = f.rafCbs.findIndex((entry) => entry.id === id);
    if (idx !== -1) f.rafCbs.splice(idx, 1);
  }

  _present() {
    if (!this._backing) return;
    if (this._frame.inFlight) {
      // the server hasn't confirmed the previous frame yet — defer the blit
      this._presentPending = true;
      return;
    }
    this._presentNow();
    this._armFence();
  }

  _presentNow() {
    this._presentPending = false;
    if (!this._backing) return;
    this._dirty = false;
    const w = Math.min(this.width, this._backing.width);
    const h = Math.min(this.height, this._backing.height);
    // a paced frame can fire after the connection started closing
    safeRelease(this.X, () => {
      this.X.CopyArea(this._backing.id, this.id, this._presentGc, 0, 0, 0, 0, w, h);
    });
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
    const X = this.X;
    const wid = this.id;
    // legacy WM_NAME is latin-1 only (node-x11 encodes plain strings as
    // latin1) — kept for old window managers
    safeRelease(X, () => {
      X.ChangeProperty(0, wid, X.atoms.WM_NAME, X.atoms.STRING, 8, title);
    });
    // modern WMs prefer the EWMH _NET_WM_NAME property, which is UTF-8;
    // interned atoms are cached by node-x11, so this round-trips only once.
    // The lookups are async: by the time they resolve the window may be
    // destroyed (ChangeProperty would BadWindow) or retitled (an older
    // write would clobber a newer one) — the serial/destroyed guards drop
    // the stale write in both cases. Every request in the chain is issued
    // via safeRelease: replies drain while the connection is closing
    // (app.close() pings before terminating), and a follow-up request from
    // inside a reply callback would otherwise throw 'client is in closing
    // state' from the stream read handler, where no user code can catch it.
    const serial = ++this._titleSerial;
    safeRelease(X, () => {
      X.InternAtom(false, '_NET_WM_NAME', (err, netWmName) => {
        if (err) return;
        safeRelease(X, () => {
          X.InternAtom(false, 'UTF8_STRING', (err2, utf8String) => {
            if (err2 || this._destroyed || serial !== this._titleSerial) return;
            safeRelease(X, () => {
              X.ChangeProperty(0, wid, netWmName, utf8String, 8, Buffer.from(title, 'utf8'));
            });
          });
        });
      });
    });
    return this;
  }

  /**
   * Intern several atoms and hand them to `cb` as an object keyed by name.
   * node-x11 caches interned atoms per connection, so a repeated call
   * costs no round trip. Same deferred-chain hazards as setTitle: by the
   * time the replies land the window may be gone, so callers re-check
   * `this._destroyed`.
   */
  _withAtoms(names, cb) {
    const X = this.X;
    const out = {};
    let pending = names.length;
    let failed = false;
    for (const name of names) {
      safeRelease(X, () => {
        X.InternAtom(false, name, (err, atom) => {
          if (failed) return;
          if (err) {
            failed = true;
            return;
          }
          out[name] = atom;
          if (--pending === 0 && !this._destroyed) cb(out);
        });
      });
    }
    return this;
  }

  /**
   * ICCCM WM_NORMAL_HINTS — how the window manager may resize this window.
   *
   *   setSizeHints({ minWidth, minHeight, maxWidth, maxHeight,
   *                  widthInc, heightInc, baseWidth, baseHeight,
   *                  minAspect: [num, den], maxAspect: [num, den],
   *                  gravity })
   *
   * `resizable: false` is shorthand for pinning min and max to the current
   * size. Without this property a WM lets the user resize a window to any
   * size at all, which is why fixed-size dialogs need it.
   */
  setSizeHints(hints = {}) {
    const {
      minWidth,
      minHeight,
      maxWidth,
      maxHeight,
      widthInc,
      heightInc,
      baseWidth,
      baseHeight,
      minAspect,
      maxAspect,
      gravity,
      resizable
    } = hints;

    let minW = minWidth;
    let minH = minHeight;
    let maxW = maxWidth;
    let maxH = maxHeight;
    if (resizable === false) {
      minW = minW ?? this.width;
      minH = minH ?? this.height;
      maxW = maxW ?? this.width;
      maxH = maxH ?? this.height;
    }

    // XSizeHints: 18 CARD32s, flags first (ICCCM 4.1.2.3)
    const PMinSize = 16;
    const PMaxSize = 32;
    const PResizeInc = 64;
    const PAspect = 128;
    const PBaseSize = 256;
    const PWinGravity = 512;

    const v = new Uint32Array(18);
    let flags = 0;
    if (minW !== undefined || minH !== undefined) {
      flags |= PMinSize;
      v[5] = minW ?? 0;
      v[6] = minH ?? 0;
    }
    if (maxW !== undefined || maxH !== undefined) {
      flags |= PMaxSize;
      v[7] = maxW ?? 0;
      v[8] = maxH ?? 0;
    }
    if (widthInc !== undefined || heightInc !== undefined) {
      flags |= PResizeInc;
      v[9] = widthInc ?? 1;
      v[10] = heightInc ?? 1;
    }
    if (minAspect || maxAspect) {
      flags |= PAspect;
      v[11] = minAspect?.[0] ?? 0;
      v[12] = minAspect?.[1] ?? 1;
      v[13] = maxAspect?.[0] ?? 0;
      v[14] = maxAspect?.[1] ?? 1;
    }
    if (baseWidth !== undefined || baseHeight !== undefined) {
      flags |= PBaseSize;
      v[15] = baseWidth ?? 0;
      v[16] = baseHeight ?? 0;
    }
    if (gravity !== undefined) {
      flags |= PWinGravity;
      v[17] = gravity;
    }
    v[0] = flags;

    safeRelease(this.X, () => {
      this.X.ChangeProperty(
        0,
        this.id,
        this.X.atoms.WM_NORMAL_HINTS,
        this.X.atoms.WM_SIZE_HINTS,
        32,
        Buffer.from(v.buffer, v.byteOffset, v.byteLength)
      );
    });
    return this;
  }

  /**
   * ICCCM WM_CLASS — the instance/class pair taskbars and WMs use to group
   * windows, match icons and apply per-application rules. Two NUL-
   * terminated latin-1 strings.
   */
  setClass(instance, className = instance) {
    const data = Buffer.from(`${instance}\0${className}\0`, 'latin1');
    safeRelease(this.X, () => {
      this.X.ChangeProperty(0, this.id, this.X.atoms.WM_CLASS, this.X.atoms.STRING, 8, data);
    });
    return this;
  }

  /**
   * EWMH _NET_WM_WINDOW_TYPE — what kind of window this is, e.g. 'dialog',
   * 'utility', 'tooltip', 'dropdown_menu', 'notification'. Window managers
   * use it to pick decorations, stacking and whether the window belongs in
   * the taskbar. Accepts a short name or a full atom name, and a list when
   * you want fallbacks (most-preferred first, per the spec).
   *
   * This is the WM-cooperative alternative to override-redirect: a menu
   * marked 'dropdown_menu' still gets shadows and correct stacking, while
   * an override-redirect window bypasses the WM entirely.
   */
  setWindowType(type) {
    const names = (Array.isArray(type) ? type : [type]).map((t) =>
      t.startsWith('_NET_WM_WINDOW_TYPE_') ? t : `_NET_WM_WINDOW_TYPE_${t.toUpperCase()}`
    );
    return this._withAtoms(['_NET_WM_WINDOW_TYPE', ...names], (atoms) => {
      const v = new Uint32Array(names.map((n) => atoms[n]));
      safeRelease(this.X, () => {
        this.X.ChangeProperty(
          0,
          this.id,
          atoms._NET_WM_WINDOW_TYPE,
          this.X.atoms.ATOM,
          32,
          Buffer.from(v.buffer, v.byteOffset, v.byteLength)
        );
      });
    });
  }

  /**
   * Keep this window above normal windows.
   *
   * Prefers EWMH `_NET_WM_STATE_ABOVE`. quartz-wm (XQuartz) does not
   * advertise that state, so on macOS this falls back to the Apple-WM
   * extension's window levels, which are the only always-on-top mechanism
   * there. Apple-WM addresses the window the WM manages, so once we have
   * been reparented the request must name our frame — the ancestor whose
   * parent is root — not our own id.
   */
  setAlwaysOnTop(on = true) {
    const X = this.X;
    const _NET_WM_STATE_ADD = 1;
    const _NET_WM_STATE_REMOVE = 0;

    this._withAtoms(['_NET_WM_STATE', '_NET_WM_STATE_ABOVE', '_NET_SUPPORTED'], (atoms) => {
      const root = this.app.display.screen[0].root;
      safeRelease(X, () => {
        X.GetProperty(0, root, atoms._NET_SUPPORTED, X.atoms.ATOM, 0, 1024, (err, prop) => {
          if (err || this._destroyed) return;
          let supported = false;
          const data = prop?.data;
          for (let i = 0; data && i + 4 <= data.length; i += 4) {
            if (data.readUInt32LE(i) === atoms._NET_WM_STATE_ABOVE) {
              supported = true;
              break;
            }
          }
          if (supported) {
            // a mapped window changes state by asking the WM, not by
            // writing the property (EWMH 7.7). SendEvent takes raw event
            // bytes, so pack the 32-byte ClientMessage by hand.
            const ev = Buffer.alloc(32);
            ev.writeUInt8(33, 0); // ClientMessage
            ev.writeUInt8(32, 1); // format
            ev.writeUInt32LE(this.id >>> 0, 4);
            ev.writeUInt32LE(atoms._NET_WM_STATE >>> 0, 8);
            ev.writeUInt32LE(on ? _NET_WM_STATE_ADD : _NET_WM_STATE_REMOVE, 12);
            ev.writeUInt32LE(atoms._NET_WM_STATE_ABOVE >>> 0, 16);
            ev.writeUInt32LE(0, 20); // second property: none
            ev.writeUInt32LE(1, 24); // source indication: application
            safeRelease(X, () => {
              X.SendEvent(
                root,
                false,
                x11.eventMask.SubstructureRedirect | x11.eventMask.SubstructureNotify,
                ev
              );
            });
          } else {
            this._appleWMSetLevel(on);
          }
        });
      });
    });
    return this;
  }

  /** Apple-WM fallback for setAlwaysOnTop; no-op where the extension is absent. */
  _appleWMSetLevel(on) {
    const X = this.X;
    safeRelease(X, () => {
      X.require('apple-wm', (err, ext) => {
        if (err || this._destroyed) return;
        // the level belongs on the window quartz-wm manages: our frame
        this.queryTree((treeErr, tree) => {
          if (treeErr || this._destroyed) return;
          const rootId = tree.root.id;
          const target = tree.parent.id === rootId ? this.id : tree.parent.id;
          safeRelease(X, () => {
            ext.SetWindowLevel(target, on ? ext.WindowLevel.Floating : ext.WindowLevel.Normal);
          });
        });
      });
    });
  }

  /**
   * Set the mouse cursor shown over this window. Accepts a friendly name
   * ('text', 'pointer', 'wait', ... — see cursorShapes in lib/cursor.js and
   * docs/window.md) or a raw X11 cursor-font glyph index. Cursors are
   * created once per connection and cached on the app. `setCursor(null)`
   * restores the parent window's cursor (X cursor = None). Throws
   * synchronously on unknown names.
   */
  setCursor(nameOrShape) {
    const cursor = nameOrShape == null ? 0 : this.app.cursors.get(nameOrShape);
    safeRelease(this.X, () => {
      this.X.ChangeWindowAttributes(this.id, { cursor }, () => {});
    });
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

  /**
   * Take the keyboard focus (X SetInputFocus). `revertTo` says where focus
   * goes if this window becomes unviewable: 0 None, 1 PointerRoot,
   * 2 Parent (the default, and the sane choice for a child window).
   *
   * Note a window manager may take focus back — the authority is the
   * 'focus'/'blur' events, not the request.
   */
  focus(revertTo = 2) {
    safeRelease(this.X, () => this.X.SetInputFocus(this.id, revertTo));
    return this;
  }

  /** Which window the server currently gives keyboard input to. */
  queryFocus(callback) {
    this.X.GetInputFocus(callback);
    return this;
  }

  /**
   * Take a pointer grab (X GrabPointer). This is how menus work on X: while
   * the grab is held, presses anywhere on the screen are reported to this
   * window instead of going to the window under the pointer — including the
   * window manager's frames — so a click outside can dismiss the menu.
   *
   * With `ownerEvents` (the default) events over the client's *own* windows
   * are still delivered to them normally, so a submenu keeps working.
   *
   * @param {object} [options] { ownerEvents, events, cursor, confineTo, time }
   * @param {function} [callback] cb(err, status) — 0 is Success, 1 is
   *   AlreadyGrabbed by another client
   */
  grabPointer(options = {}, callback) {
    const {
      ownerEvents = true,
      events = x11.eventMask.ButtonPress | x11.eventMask.ButtonRelease | x11.eventMask.PointerMotion,
      pointerMode = 1, // Asynchronous
      keyboardMode = 1,
      confineTo = 0,
      cursor = 0,
      time = 0 // CurrentTime
    } = options;
    this.X.GrabPointer(
      this.id,
      ownerEvents,
      events,
      pointerMode,
      keyboardMode,
      confineTo,
      cursor,
      time,
      callback ?? (() => {})
    );
    return this;
  }

  ungrabPointer(time = 0) {
    safeRelease(this.X, () => this.X.UngrabPointer(time));
    return this;
  }

  /** Keyboard counterpart: keys go here while the grab is held. */
  grabKeyboard(options = {}, callback) {
    const { ownerEvents = true, pointerMode = 1, keyboardMode = 1, time = 0 } = options;
    this.X.GrabKeyboard(this.id, ownerEvents, time, pointerMode, keyboardMode, callback ?? (() => {}));
    return this;
  }

  ungrabKeyboard(time = 0) {
    safeRelease(this.X, () => this.X.UngrabKeyboard(time));
    return this;
  }

  reparentTo(newParent, x, y) {
    this.X.ReparentWindow(this.id, newParent.id, x, y);
    return this;
  }

  /** Move to the top of the stacking order among its siblings. */
  raise() {
    safeRelease(this.X, () => this.X.RaiseWindow(this.id));
    return this;
  }

  /** Move to the bottom of the stacking order among its siblings. */
  lower() {
    safeRelease(this.X, () => this.X.ConfigureWindow(this.id, { stackMode: 1 }));
    return this;
  }

  // ---------------------------------------------------------------------
  // Reading properties
  //
  // ntk could write window properties (setTitle, setSizeHints, setClass)
  // but never read them, which is fine for a client — it knows what it
  // wrote — and useless for a window manager, whose whole job is to act on
  // what *other* clients declare about themselves.
  // ---------------------------------------------------------------------

  /**
   * Read a property. `name` is an atom name ('WM_NAME', '_NET_WM_STATE');
   * interned atoms are cached per connection, so repeat reads cost no
   * extra round trip.
   *
   * Resolves to `null` when the property is not set, otherwise to the
   * decoded value chosen by `as`:
   *   'buffer' (default) — `{ type, data }` with the raw bytes
   *   'string'           — text, UTF-8 or latin-1 by the property's type
   *   'numbers'          — an array of 32-bit values (atom lists, cardinals)
   *
   * @param {string} name
   * @param {object} [options] `{ as, type, length }` — `type` restricts the
   *   read to one property type (0, the default, accepts any), `length` is
   *   the cap in 32-bit units.
   */
  async getProperty(name, options = {}) {
    const { as = 'buffer', type = 0, length = 0x1fffffff } = options;
    const atom = await this.atom(name);
    return new Promise((resolve, reject) => {
      safeRelease(this.X, () =>
        this.X.GetProperty(0, this.id, atom, type, 0, length, (err, prop) => {
          if (err) return reject(err);
          // an unset property answers with type None and no bytes
          if (!prop || !prop.type || !prop.data.length) return resolve(null);
          resolve(decodeProperty(prop, as, this.X));
        })
      );
    });
  }

  /**
   * Intern an atom by name. node-x11 caches them per connection, so asking
   * again for one already interned costs no round trip.
   * @returns {Promise<number>} the atom id
   */
  atom(name) {
    return new Promise((resolve, reject) => {
      this.X.InternAtom(false, name, (err, id) => (err ? reject(err) : resolve(id)));
    });
  }

  /**
   * The window's title as the ICCCM/EWMH pair defines it: _NET_WM_NAME
   * (UTF-8) if the client set one, else WM_NAME. Resolves to null when the
   * window has neither. The read counterpart of setTitle.
   */
  async getTitle() {
    const netName = await this.getProperty('_NET_WM_NAME', { as: 'string' }).catch(() => null);
    if (netName) return netName;
    return this.getProperty('WM_NAME', { as: 'string' }).catch(() => null);
  }

  /**
   * WM_NORMAL_HINTS as an object shaped like setSizeHints' argument —
   * `{ minWidth, minHeight, maxWidth, maxHeight, widthInc, heightInc,
   * baseWidth, baseHeight, minAspect, maxAspect, gravity }`, each present
   * only if the client set its flag. Resolves to `{}` when the window has
   * no hints, so callers can destructure without a null check.
   */
  async getSizeHints() {
    const v = await this.getProperty('WM_NORMAL_HINTS', { as: 'numbers' }).catch(() => null);
    if (!v || v.length < 18) return {};
    const flags = v[0];
    const hints = {};
    if (flags & 16) {
      hints.minWidth = v[5];
      hints.minHeight = v[6];
    }
    if (flags & 32) {
      hints.maxWidth = v[7];
      hints.maxHeight = v[8];
    }
    if (flags & 64) {
      hints.widthInc = v[9];
      hints.heightInc = v[10];
    }
    if (flags & 128) {
      hints.minAspect = [v[11], v[12]];
      hints.maxAspect = [v[13], v[14]];
    }
    if (flags & 256) {
      hints.baseWidth = v[15];
      hints.baseHeight = v[16];
    }
    if (flags & 512) hints.gravity = v[17];
    return hints;
  }

  /**
   * GetWindowAttributes — `{ mapState, overrideRedirect, ... }`. A window
   * manager adopting the windows that already existed when it started
   * needs both: override-redirect windows are none of its business, and
   * only mapped ones should get a frame.
   */
  getAttributes() {
    return new Promise((resolve, reject) => {
      safeRelease(this.X, () =>
        this.X.GetWindowAttributes(this.id, (err, attrs) => (err ? reject(err) : resolve(attrs)))
      );
    });
  }

  // ---------------------------------------------------------------------
  // Managing other clients' windows
  // ---------------------------------------------------------------------

  /**
   * Select an event mask explicitly, reporting failure. Handler-driven
   * selection (`on('map_request')`, the onXxx constructor args) covers the
   * ordinary case; this exists for the mask that can be refused —
   * SubstructureRedirect belongs to one client at a time, so
   *
   *   await app.rootWindow().selectInput(SubstructureRedirect | SubstructureNotify)
   *
   * either makes you the window manager or rejects with BadAccess because
   * something else already is. The mask is OR-ed into whatever handlers
   * have already asked for.
   */
  selectInput(mask) {
    this.eventMask |= mask;
    return new Promise((resolve, reject) => {
      this.X.ChangeWindowAttributes(this.id, { eventMask: this.eventMask }, (err) =>
        err ? reject(err) : resolve(this)
      );
    });
  }

  /**
   * Add this window to our save-set (X ChangeSaveSet). A window manager
   * reparents clients into frames it owns; without the save-set, the
   * clients would be destroyed along with those frames if the WM exits.
   * With it the server reparents them back to the root and remaps them.
   */
  addToSaveSet() {
    safeRelease(this.X, () => this.X.ChangeSaveSet(1, this.id));
    return this;
  }

  removeFromSaveSet() {
    safeRelease(this.X, () => this.X.ChangeSaveSet(0, this.id));
    return this;
  }

  /**
   * Tell the client where it really ended up (ICCCM 4.1.5). A reparented
   * window's own ConfigureNotify carries coordinates relative to its
   * frame, which is not what the client asked about, and a
   * ConfigureRequest the window manager decided to refuse produces no
   * ConfigureNotify at all — clients that resize themselves hang waiting
   * for one. Both cases are answered by a synthetic event carrying
   * root-relative coordinates.
   *
   * @param {object} geometry `{ x, y, width, height, borderWidth }` in
   *   root coordinates; anything omitted comes from the window.
   */
  sendConfigureNotify(geometry = {}) {
    const {
      x = this.x,
      y = this.y,
      width = this.width,
      height = this.height,
      borderWidth = 0
    } = geometry;
    const ev = Buffer.alloc(32);
    ev[0] = 22; // ConfigureNotify
    ev.writeUInt32LE(this.id >>> 0, 4); // event window
    ev.writeUInt32LE(this.id >>> 0, 8); // the window itself
    ev.writeUInt32LE(0, 12); // above-sibling: None
    ev.writeInt16LE(x, 16);
    ev.writeInt16LE(y, 18);
    ev.writeUInt16LE(width, 20);
    ev.writeUInt16LE(height, 22);
    ev.writeUInt16LE(borderWidth, 24);
    ev[26] = 0; // override-redirect
    safeRelease(this.X, () =>
      this.X.SendEvent(this.id, 0, x11.eventMask.StructureNotify, ev)
    );
    return this;
  }

  /**
   * Ask the client to close, the polite way: a WM_DELETE_WINDOW client
   * message if it advertised the protocol in WM_PROTOCOLS, so it can save
   * work or put up a confirmation. Clients that did not advertise it have
   * no such path and are killed outright (X KillClient), which is what
   * `xkill` does.
   *
   * This is the window manager's side of the protocol `setActions()` opts
   * a window into.
   *
   * @returns {Promise<boolean>} true if asked politely, false if killed
   */
  async close() {
    const protocols = await this.getProperty('WM_PROTOCOLS', { as: 'numbers' }).catch(() => null);
    const deleteAtom = await this.atom('WM_DELETE_WINDOW').catch(() => 0);
    if (!deleteAtom || !protocols || !protocols.includes(deleteAtom)) {
      safeRelease(this.X, () => this.X.KillClient(this.id));
      return false;
    }
    const wmProtocols = await this.atom('WM_PROTOCOLS');
    const ev = Buffer.alloc(32);
    ev[0] = 33; // ClientMessage
    ev[1] = 32; // format
    ev.writeUInt32LE(this.id >>> 0, 4);
    ev.writeUInt32LE(wmProtocols >>> 0, 8);
    ev.writeUInt32LE(deleteAtom >>> 0, 12);
    ev.writeUInt32LE(0, 16); // CurrentTime
    safeRelease(this.X, () => this.X.SendEvent(this.id, 0, 0, ev));
    return true;
  }

  /**
   * Grab a mouse button on this window (X GrabButton). A window manager
   * uses this to see clicks that belong to the client: with
   * `pointerMode: 0` (synchronous) the pointer freezes on press until
   * `app.allowEvents()` decides what happens — 'replay' hands the click
   * back to the client, so click-to-focus can raise the window without
   * swallowing the click.
   *
   * @param {object} [options] `{ button (0 = any), modifiers (0x8000 =
   *   any), ownerEvents, events, pointerMode, keyboardMode, confineTo,
   *   cursor }`
   */
  grabButton(options = {}) {
    const {
      button = 0,
      modifiers = 0x8000,
      ownerEvents = false,
      events = x11.eventMask.ButtonPress | x11.eventMask.ButtonRelease,
      pointerMode = 1,
      keyboardMode = 1,
      confineTo = 0,
      cursor = 0
    } = options;
    this.X.GrabButton(
      this.id, ownerEvents, events, pointerMode, keyboardMode,
      confineTo, cursor, button, modifiers
    );
    return this;
  }

  ungrabButton(button = 0, modifiers = 0x8000) {
    safeRelease(this.X, () => this.X.UngrabButton(this.id, button, modifiers));
    return this;
  }

  queryTree(callback) {
    const app = this.app;
    this.X.QueryTree(this.id, (err, tree) => {
      if (err) return callback(err);
      const children = tree.children.map((id) => new Window(app, { id }));
      // the root window has no parent — QueryTree answers None (0) for it
      const parent = tree.parent ? new Window(app, { id: tree.parent }) : null;
      // note that this root may be different from app.rootWindow() because
      // there can be multiple screens (and roots)
      const root = new Window(app, { id: tree.root });
      const wrappers = [...children, root, ...(parent ? [parent] : [])];
      Promise.all(wrappers.map((w) => w._readyPromise)).then(() => {
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
    // same deferred-chain shape as setTitle: each step runs from a reply
    // callback and must no-op instead of throwing if the connection
    // started closing (or the window died) while the replies were in flight
    safeRelease(X, () => {
      X.InternAtom(false, 'WM_PROTOCOLS', (err, WM_PROTOCOLS) => {
        if (err) return;
        safeRelease(X, () => {
          X.InternAtom(false, 'WM_DELETE_WINDOW', (err2, WM_DELETE_WINDOW) => {
            if (err2 || this._destroyed) return;
            const data = Buffer.alloc(4);
            data.writeUInt32LE(WM_DELETE_WINDOW, 0);
            safeRelease(X, () => {
              X.ChangeProperty(0, wid, WM_PROTOCOLS, X.atoms.ATOM, 32, data);
            });
          });
        });
      });
    });
  }

  destroy() {
    this._destroyed = true;
    this._forget();
    this._teardownFrame();
    this.emit('_destroyed');
    if (this._backing) {
      this._backing.destroy();
      this._backing = null;
    }
    safeRelease(this.X, () => this.X.DestroyWindow(this.id));
    if (this._ownedColormap) {
      const colormap = this._ownedColormap;
      this._ownedColormap = null;
      safeRelease(this.X, () => this.X.FreeColormap(colormap));
    }
  }

  [Symbol.dispose]() {
    this.destroy();
  }

  inspect() {
    return `[Window ${this.id}]`;
  }
}
