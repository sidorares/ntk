import x11 from 'x11';

import { safeRelease } from './cleanup.js';
import Drawable from './drawable.js';
import { packIcons, unpackIcons } from './imagedata.js';
import Pixmap from './pixmap.js';
import * as xevents from './events_map.js';
import { decodeKey } from './keyboard.js';

/**
 * How many rectangles a frame's dirty region is allowed to hold.
 *
 * Drawing reports one region per operation, so a repaint reports hundreds, and
 * an uncapped list would turn every one of them into its own CopyArea. Past
 * the cap the cheapest pair is merged (see addDirtyRect), which keeps
 * genuinely separated clusters apart while adjacent ones coalesce.
 */
const MAX_DIRTY_RECTS = 8;

/**
 * How much of the surrounding box a split has to save to be worth making.
 *
 * Several rectangles are several CopyArea requests, and they only beat the one
 * box around them when they are meaningfully smaller than it: two tab headers
 * side by side describe nearly the same area either way, two corners of the
 * window do not. Below this fraction the region is collapsed to its box.
 */
const SPLIT_SAVING = 0.75;

/**
 * Backing pixmap dimensions are rounded up to this granularity.
 *
 * An interactive enlarge delivers a resize per frame, and an exact grow-only
 * allocation crosses its previous maximum on every one of them — each frame
 * paying for a CreatePixmap, a full white clear, a FreePixmap and a picture
 * rebind. With headroom the reuse check absorbs the intermediate steps and a
 * continuous drag reallocates O(log) times. The spare pixels are never
 * presented — every blit is clamped to window ∩ backing — they just sit
 * white until the window grows into them.
 */
const BACKING_GRANULARITY = 128;

function rectArea(r) {
  return Math.max(0, r.w) * Math.max(0, r.h);
}

function coversRect(outer, inner) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

function mergeRects(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: right - x, h: bottom - y };
}

/** The box around a non-empty list of rectangles. */
function rectsBounds(rects) {
  let out = rects[0];
  for (let i = 1; i < rects.length; i++) out = mergeRects(out, rects[i]);
  return out;
}

/**
 * Add one rectangle to a capped list, returning a new list.
 *
 * A rectangle already covered by one in the list adds nothing, which is the
 * common case by a wide margin: consecutive operations under the same clip all
 * report the same region. Otherwise it goes on the end, and if that overflows
 * the cap the pair whose merge wastes the least area is merged — waste being
 * the area the merged rectangle covers that neither of the two did, so
 * overlapping and adjacent pairs go first and far-apart ones last.
 */
function addDirtyRect(rects, add) {
  for (const r of rects) {
    if (coversRect(r, add)) return rects;
  }
  const out = rects.filter((r) => !coversRect(add, r));
  out.push({ x: add.x, y: add.y, w: add.w, h: add.h });
  if (out.length <= MAX_DIRTY_RECTS) return out;
  let bestI = 0;
  let bestJ = 1;
  let bestMerged = null;
  let bestWaste = Infinity;
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const merged = mergeRects(out[i], out[j]);
      const waste = rectArea(merged) - rectArea(out[i]) - rectArea(out[j]);
      if (waste < bestWaste) {
        bestWaste = waste;
        bestI = i;
        bestJ = j;
        bestMerged = merged;
      }
    }
  }
  out[bestI] = bestMerged;
  out.splice(bestJ, 1);
  return out;
}

/**
 * Union a reported region into a frame's dirty region, where `undefined` is
 * "nothing yet" and `null` is "unbounded".
 *
 * The asymmetry is the whole point: once any operation declines to say where it
 * drew, the region cannot be trusted to bound the frame, and it has to stay
 * unbounded no matter what is unioned into it afterwards. Getting that
 * backwards means blitting less than was drawn, which leaves stale pixels on
 * screen — so the absorbing state is the safe one.
 */
function unionDirty(current, add) {
  if (current === null || add === null || add === undefined) return null;
  if (current === undefined) return [{ x: add.x, y: add.y, w: add.w, h: add.h }];
  return addDirtyRect(current, add);
}

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

// ICCCM 4.1.2.3 WM_NORMAL_HINTS flags. The first four say who chose the
// window's geometry — without one of them a window manager is free to place
// the window wherever it likes, whatever x/y it was created with.
const SIZE_HINT = {
  USPosition: 1,
  USSize: 2,
  PPosition: 4,
  PSize: 8,
  PMinSize: 16,
  PMaxSize: 32,
  PResizeInc: 64,
  PAspect: 128,
  PBaseSize: 256,
  PWinGravity: 512
};

// ICCCM 4.1.2.4 WM_HINTS flags. MessageHint (128) is obsolete and unused.
const WM_HINT = {
  Input: 1,
  State: 2,
  IconPixmap: 4,
  IconWindow: 8,
  IconPosition: 16,
  IconMask: 32,
  WindowGroup: 64,
  Urgency: 256
};

const SIZE_HINT_KEYS = new Set([
  'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'widthInc', 'heightInc', 'baseWidth', 'baseHeight',
  'minAspect', 'maxAspect', 'gravity', 'resizable',
  'position', 'size', 'x', 'y', 'width', 'height'
]);

const WM_HINT_KEYS = new Set([
  'input', 'initialState', 'urgent', 'icon', 'iconPixmap',
  'iconMask', 'iconWindow', 'iconX', 'iconY', 'windowGroup'
]);

// Hint keys `createWindow` also accepts at the top level, per the API sketch
// in ntk#19. x/y/width/height are deliberately absent: at the top level they
// are the window's geometry, and only inside a `hints`/`sizeHints` object do
// they mean the WM_NORMAL_HINTS fields of the same name. `position`/`size`
// are absent for the same reason — as bare creation arguments they read as
// geometry rather than as "who chose it".
const CREATION_HINT_KEYS = [
  ...[...SIZE_HINT_KEYS].filter(
    (k) => !['x', 'y', 'width', 'height', 'position', 'size', 'resizable'].includes(k)
  ),
  ...WM_HINT_KEYS,
  'transientFor',
  'protocols'
];

// EWMH 5.7 _NET_WM_STATE, in spec order. FOCUSED and HIDDEN are set by the
// window manager rather than asked for, but a client still reads them.
const EWMH_STATES = [
  'modal',
  'sticky',
  'maximized_vert',
  'maximized_horz',
  'shaded',
  'skip_taskbar',
  'skip_pager',
  'hidden',
  'fullscreen',
  'above',
  'below',
  'demands_attention',
  'focused'
];

/** 'fullscreen' -> '_NET_WM_STATE_FULLSCREEN'; a full atom name passes through. */
function stateAtomName(name) {
  return name.startsWith('_NET_WM_STATE_') ? name : `_NET_WM_STATE_${name.toUpperCase()}`;
}

/** The inverse, for reporting what the window manager put on the window. */
function stateShortName(atomName) {
  return atomName.startsWith('_NET_WM_STATE_')
    ? atomName.slice('_NET_WM_STATE_'.length).toLowerCase()
    : atomName;
}

/**
 * Normalize the argument of setWmState.
 *
 * 'maximized' is the one name that is not an atom: EWMH maximizes an axis at
 * a time, and giving the message both atoms at once is exactly what its two
 * state slots are for.
 */
function expandStateNames(names) {
  const list = Array.isArray(names) ? names : [names];
  return list.flatMap((n) =>
    n === 'maximized' ? ['maximized_vert', 'maximized_horz'] : [n]
  );
}

/**
 * Warn once per process about a hint that will do nothing.
 *
 * These mistakes are silent everywhere else: the server stores whatever
 * property bytes it is handed, and only a window manager could tell that
 * what it read means nothing. Same shape as node-x11's ChangeProperty
 * warning, so a caller who gets it wrong on every window hears it once.
 */
const warnedHints = new Set();
function warnHint(key, message) {
  if (warnedHints.has(key)) return;
  warnedHints.add(key);
  console.warn(`ntk: ${message} Further occurrences are not reported.`);
}

/** A Window, a Pixmap, or a bare XID — all of these name a server resource. */
function resourceId(value) {
  return typeof value === 'number' ? value : (value?.id ?? 0);
}

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
    this._overrideRedirect = !!args.overrideRedirect;
    // WM_PROTOCOLS is a set: read-modify-write, serialized (see addProtocol)
    this._protocols = null;
    this._protocolQueue = Promise.resolve();
    // so is _NET_WM_STATE, on the unmapped path (see setWmState)
    this._wmStateQueue = Promise.resolve();
    this._netWmStateAtom = 0; // resolved when a 'statechange' listener appears
    // what setHints has accumulated per struct, so a later call can rewrite
    // the whole property without dropping what an earlier one set
    this._sizeHints = null;
    this._wmHints = null;
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
    // _NET_WM_SYNC_REQUEST (see enableSyncRequest): the counter the window
    // manager watches, the value it last asked for, and the watchdog that
    // guarantees an answer even when nothing repaints
    this._syncCounter = null;
    this._syncRequestAtom = 0;
    this._syncPending = null;
    this._syncWatchdog = null;
    // Present-based blits (see enablePresent): the extension objects, the
    // XFixes region reused as the update region, and the serial the server
    // echoes back in its completion events
    this._presentExt = null;
    this._fixesExt = null;
    this._updateRegion = 0;
    this._presentSerial = 0;
    this.frameInterval = args.frameInterval ?? 16;
    this.frameLatency = null;
    this._frame = {
      pending: new Map(), // coalescible event name -> merged event
      rafCbs: [],
      rafId: 0,
      inFlight: false, // fence round-trip awaiting the server's reply
      timer: null,
      scheduled: false,
      needsRedraw: false,
      // minimum inter-blit pacing: when the last blit went out, and the timer
      // that guarantees a blit held back by the interval still lands.
      // -Infinity so the first blit after construction is never delayed.
      lastPresentAt: -Infinity,
      presentTimer: null
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
      // the baseline 'resize' compares against (see _tagResize): what the
      // window was asked to be, so the window manager's first ConfigureNotify
      // reports only what it actually overrode
      this._deliveredGeom = { x: this.x, y: this.y, width: this.width, height: this.height };
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
      // an adopted window's geometry is not known until GetGeometry replies
      this._deliveredGeom = null;
      // populate width and height
      X.GetGeometry(this.id, (err, res) => {
        if (!err) {
          this.width = res.width;
          this.height = res.height;
          this.x = res.xPos;
          this.y = res.yPos;
          this.depth = res.depth;
          // nothing was known about this window until now, so until this
          // reply lands a 'resize' reports both moved and resized (see
          // _tagResize) rather than guessing
          this._deliveredGeom ??= { x: this.x, y: this.y, width: this.width, height: this.height };
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
    if (args.icon) {
      // needs the atom interned first, so unlike the writers above it is not
      // on the wire by the time createWindow returns
      this.setIcon(args.icon).catch((err) => app.options.onXError?.(err));
    }
    // ICCCM/EWMH hints at creation: `hints: { ... }`, the `sizeHints`/
    // `resizable` arguments that predate it, or the hint names on their own
    // at the top level. All of them land in one setHints call so that a
    // window created with `minWidth` and a `hints` block writes
    // WM_NORMAL_HINTS once, with both.
    const hints = { ...args.sizeHints, ...args.hints };
    if (args.resizable !== undefined) hints.resizable = args.resizable;
    for (const key of CREATION_HINT_KEYS) {
      if (args[key] !== undefined) hints[key] = args[key];
    }
    if (Object.keys(hints).length) {
      this.setHints(hints);
    }
    // EWMH wants a pid and a client machine on top-level windows; child
    // windows are an implementation detail nothing asks about
    if (!args.id && args.pid !== false && parentId === app.display.screen[0].root) {
      this.setPid(typeof args.pid === 'number' ? args.pid : undefined);
    }
    if (args.alwaysOnTop) {
      this.setAlwaysOnTop(true);
    }
    if (args.syncRequest && !args.id) {
      // fire and forget: the window manager only reads the counter when it
      // starts managing the window, and map() is the caller's next line at
      // the earliest. `await wnd.enableSyncRequest()` when that is too close.
      this.enableSyncRequest().catch((err) => this.app.options.onXError?.(err));
    }
    if (args.present && !args.id) {
      // fire and forget: until the extensions answer, blits use CopyArea,
      // which is what they would have done anyway
      this.enablePresent().catch((err) => this.app.options.onXError?.(err));
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
      if (eventName === 'keydown' || eventName === 'keyup') {
        // the active layout arrives in the event's own state bits, not in the
        // keymap — see lib/keyboard.js. Keys that type nothing (arrows,
        // F-keys, modifiers) leave `codepoint` absent rather than reporting 0.
        const key = decodeKey(X.keycode2keysyms[ev.keycode], ev.buttons);
        if (key) {
          ev.keysym = key.keysym;
          ev.baseKeysym = key.baseKeysym;
          ev.group = key.group;
          if (key.codepoint !== undefined) ev.codepoint = key.codepoint;
        }
      }
      if (this._coalesce && xevents.coalesce[eventName]) {
        this._enqueueCoalesced(eventName, ntkev);
        return;
      }
      // the window manager reporting what it did with the window: a user who
      // hit maximize or a fullscreen hotkey changes the state behind the
      // app's back, and this is the only way an app that mirrors it in its
      // own UI stays honest
      if (eventName === 'property' && ev.atom === this._netWmStateAtom) {
        this.getWmStates().then(
          (states) => this.emit('statechange', states),
          () => {}
        );
      }
      // deliver buffered state events before a discrete one so handlers see
      // them in the order they happened (a drag sees the move, then the up)
      this._flushCoalesced();
      if (eventName === 'resize') this._tagResize(ntkev);
      this.emit(eventName, ntkev);
      // a WM_DELETE_WINDOW ClientMessage is the window manager *asking*, and
      // 'close' is that question in a form an application can answer
      if (eventName === 'message') {
        this._emitCloseRequest(ntkev);
        this._handleSyncRequest(ntkev);
      }
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
      // Listening for 'close' is the opt-in. WM_DELETE_WINDOW only reaches a
      // client that advertised it in WM_PROTOCOLS — a window manager kills
      // anyone else outright — and having to know that, on top of decoding a
      // ClientMessage by hand, is the protocol showing through the toolkit.
      if (name === 'close' && !this._closeArmed) {
        this._closeArmed = true;
        // interning WM_PROTOCOLS here as well as in addProtocol: the
        // dispatch path matches against both atoms and node-x11 caches them
        // per connection, so this costs one round trip and no more
        this.atom('WM_PROTOCOLS').catch(() => {});
        this.addProtocol('WM_DELETE_WINDOW').catch((err) => this.app.options.onXError?.(err));
      }
      // 'statechange' is derived from a PropertyNotify, so it needs the atom
      // to compare against as well as the mask the table below selects
      if (name === 'statechange' && !this._netWmStateAtom) {
        this.atom('_NET_WM_STATE').then(
          (atom) => {
            this._netWmStateAtom = atom;
          },
          () => {}
        );
      }
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

    this._presentGc = this.X.AllocID();
    this.X.CreateGC(this._presentGc, this.id, { graphicsExposures: 0 });
    this._allocBacking(this.width, this.height);

    // the redraw cycle is driven by Expose interception — make sure the
    // server sends them even if user code only listens to 'draw'
    if (!(this.eventMask & x11.eventMask.Exposure)) {
      this.eventMask |= x11.eventMask.Exposure;
      this.X.ChangeWindowAttributes(this.id, { eventMask: this.eventMask }, () => {});
    }

    // a pure move is a ConfigureNotify too, and reallocating a backing
    // pixmap per step of a window drag is the bug this flag exists to spare
    // everyone (see _tagResize)
    this.on('resize', (ev) => {
      if (!ev.resized) return;
      this._allocBacking(ev.width, ev.height);
      this._backingValid = false;
      this._requestRedraw();
    });
  }

  // grow-only backing pixmap (re)allocation, with headroom (see
  // BACKING_GRANULARITY); new area is cleared to white
  _allocBacking(w, h) {
    const cur = this._backing;
    if (cur && cur.width >= w && cur.height >= h) return;
    const roundUp = (v) => Math.ceil(v / BACKING_GRANULARITY) * BACKING_GRANULARITY;
    const newW = roundUp(Math.max(w, cur ? cur.width : 0));
    const newH = roundUp(Math.max(h, cur ? cur.height : 0));
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
      // same screen and depth, so one outlives every backing pixmap
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

  /**
   * Called by rendering contexts after each drawing operation.
   *
   * `bounds` is the region that operation could have touched — a context
   * reports its clip rectangle, which by definition contains everything it
   * drew. The regions accumulate, and the next blit copies just those instead
   * of the whole backing store: a repaint of two tab headers is a 125x31
   * CopyArea rather than a 1000x700 one. They accumulate as a short list of
   * rectangles rather than one box around them all, so two repaints at
   * opposite corners of the window no longer drag everything between them
   * along. An operation that reports nothing, because it was not clipped,
   * gives up the optimisation for this frame and the blit covers everything —
   * the safe direction, and the reason this needs no cooperation from the
   * caller to be correct.
   */
  _markDirty(bounds) {
    if (!this._backing) return;
    if (!this._dirty) this._dirtyRegion = undefined;
    this._dirtyRegion = unionDirty(this._dirtyRegion, bounds);
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

  /**
   * Scroll the pixels of `rect` (window coordinates, `{x, y, width, height}`)
   * by (dx, dy) within the retained backing store, server-side: one CopyArea
   * of the band that survives the shift, in place of the caller re-drawing
   * everything that merely moved. Returns true when the blit was issued;
   * false means "not possible here", and the caller repaints `rect` exactly
   * as it would have without this method — every refusal is the status quo.
   *
   * Refused when there is no (valid) backing store, when the delta is
   * fractional (a sub-pixel shift changes every pixel, so there is nothing
   * to copy), when it is zero, or when nothing of `rect` survives the shift
   * after clamping to window ∩ backing.
   *
   * Backing-store only, deliberately: pixmap contents cannot be occluded, so
   * an overlapping self-copy is fully defined (the server fetches the source
   * region before storing) and the GraphicsExpose handling a window-drawable
   * scroll would need never exists. The copy goes out with the present GC —
   * graphicsExposures: 0, where the 2d context's GC would emit a NoExposure
   * packet per copy — and in-order with the caller's follow-up drawing of
   * the exposed strip on the same connection.
   *
   * The whole of `rect` is marked dirty, so the next present shows the
   * scrolled band through the normal fence-aware path; the caller only has
   * to draw the strip the shift exposed, plus any chrome that moved with
   * the content (a scrollbar thumb, say).
   */
  scrollRegion(rect, dx, dy) {
    if (!this._backing || !this._backingValid) return false;
    if (!Number.isInteger(dx) || !Number.isInteger(dy) || (dx === 0 && dy === 0)) return false;
    // clamp like a present: the backing is grow-only, so it can be larger
    // than the window after a shrink
    const w = Math.min(this.width, this._backing.width);
    const h = Math.min(this.height, this._backing.height);
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(w, Math.ceil(rect.x + rect.width));
    const y1 = Math.min(h, Math.ceil(rect.y + rect.height));
    // the band that survives: dest = clamped rect ∩ (clamped rect + delta)
    const dstX0 = Math.max(x0, x0 + dx);
    const dstY0 = Math.max(y0, y0 + dy);
    const dstX1 = Math.min(x1, x1 + dx);
    const dstY1 = Math.min(y1, y1 + dy);
    if (dstX1 <= dstX0 || dstY1 <= dstY0) return false;
    safeRelease(this.X, () => {
      this.X.CopyArea(
        this._backing.id,
        this._backing.id,
        this._presentGc,
        dstX0 - dx,
        dstY0 - dy,
        dstX0,
        dstY0,
        dstX1 - dstX0,
        dstY1 - dstY0
      );
    });
    this._markDirty({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    return true;
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
   * Discrete events (mousedown, keydown, ...) bypass the timer for latency:
   * the first blit after a quiet moment goes out with the handler's own
   * requests. Their blits are still bounded, by the fence and by a minimum
   * inter-blit interval (also `frameInterval`) — see _present(). Without that
   * interval a stream of discrete events blits at round-trip rate, which on a
   * local server is several hundred per second, and under a compositor every
   * blit is a recomposite.
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
    if (
      !f.pending.size &&
      !f.rafCbs.length &&
      !f.needsRedraw &&
      !this._dirty &&
      !this._presentPending &&
      this._syncPending == null
    )
      return;
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
    // covers a window with no backing store, and a resize that changed
    // nothing: _presentNow did not run, but the frame is still "handled"
    this._ackSyncRequest();
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

  /**
   * Say what a 'resize' actually changed.
   *
   * 'resize' is ConfigureNotify, which fires for pure moves and for
   * reparents as much as for size changes — under an opaque-move window
   * manager a window drag is one per pointer step. Every consumer used to
   * rediscover that by keeping its own copy of the last size (this library
   * included, in the backing-store listener), and one that didn't paid a
   * full relayout per step of a drag.
   *
   * So the delivered event says which it was:
   *
   *   - `ev.resized` — the size differs from the last delivered event's
   *   - `ev.moved` — the position does
   *   - `ev.previous` — that event's `{x, y, width, height}`, for a delta;
   *     null on an adopted window whose geometry is not known yet, where
   *     both flags read true because nothing can be ruled out
   *
   * Measured against the last *delivered* event, not the last raw one, so
   * that coalescing cannot swallow a change: a frame that merges two moves
   * and a resize reports both, where per-hop flags would report only the
   * final hop. The merged raw events in `ev.coalesced` are not tagged for
   * that reason — the flags are a property of the delivery.
   *
   * Position is compared as reported. A reparenting window manager sends
   * real ConfigureNotify in frame coordinates and synthetic ones in root
   * coordinates (ICCCM 4.2.3), so a frame's own offset can read as a move
   * on the first event after the switch. That is the safe direction —
   * spurious work, never missed work — and the alternative is a
   * TranslateCoordinates round trip per event, which is the cost this flag
   * exists to avoid.
   */
  _tagResize(ev) {
    const prev = this._deliveredGeom;
    ev.previous = prev;
    ev.moved = !prev || ev.x !== prev.x || ev.y !== prev.y;
    ev.resized = !prev || ev.width !== prev.width || ev.height !== prev.height;
    this._deliveredGeom = { x: ev.x, y: ev.y, width: ev.width, height: ev.height };
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
        if (name === 'resize') this._tagResize(ev);
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
          // a blit deferred while the fence was in flight: show it as soon as
          // the minimum inter-blit interval allows (immediately when the last
          // blit is already older than that, which is the common case)
          this._present();
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
    if (f.presentTimer) {
      clearTimeout(f.presentTimer);
      f.presentTimer = null;
    }
    if (this._syncWatchdog) {
      clearTimeout(this._syncWatchdog);
      this._syncWatchdog = null;
    }
    // Destroying the counter releases any Await the window manager is
    // blocked in, so a window that goes away mid-drag does not strand it.
    if (this._syncCounter && this._sync) {
      const counter = this._syncCounter;
      this._syncCounter = null;
      this._syncPending = null;
      safeRelease(this.X, () => {
        this._sync.DestroyCounter(counter);
        this.X.ReleaseID(counter);
      });
    }
    if (this._updateRegion && this._fixesExt) {
      const region = this._updateRegion;
      this._updateRegion = 0;
      this._presentExt = null;
      const fixes = this._fixesExt;
      this._fixesExt = null;
      safeRelease(this.X, () => {
        fixes.DestroyRegion(region);
        this.X.ReleaseID(region);
      });
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

  /**
   * Whether the fence for the last frame is still unanswered — the server has
   * not yet confirmed it consumed everything that frame drew.
   *
   * The one bit of frame-clock state worth publishing, because it is the
   * difference between the two ways a toolkit can answer a discrete input.
   * Drawing the response inside the event handler costs a frame less latency:
   * the blit goes out with the handler's own requests (see the `_present()`
   * at the end of the event dispatch) instead of waiting for the next paced
   * frame — provided the last blit is at least `frameInterval` old, which is
   * what a discrete input arriving out of the blue always is. Drawing it while
   * a frame is in flight costs a frame's *work* for nothing: the present is
   * deferred until the ack and coalesces with the one already pending, so only
   * the last paint is ever seen. So `false`
   * means "draw it now", `true` means "leave it to the frame clock" — which
   * is how a burst of discrete events (a spun wheel) paints its first notch
   * immediately and folds the rest into one catch-up frame.
   *
   * Always `false` under `frameSync: false`: no fence is ever sent, so there
   * is nothing to wait for, and a caller gating on this gets the unpaced
   * behaviour that option asks for.
   */
  frameInFlight() {
    return this._frame.inFlight;
  }

  _present() {
    if (!this._backing) return;
    const wait = this._presentWait();
    if (this._frame.inFlight || wait > 0) {
      // the server hasn't confirmed the previous frame yet, or the last blit
      // was too recent — defer, and leave a wakeup behind
      this._deferPresent(wait);
      return;
    }
    this._presentNow();
    this._armFence();
  }

  /**
   * How long until the next blit may go out; 0 when it may go now.
   *
   * The gate is `frameInterval`, the same knob that paces frames, so
   * `frameInterval: 0` keeps the old fence-only behaviour — a caller who asked
   * for no timer gate gets none here either.
   */
  _presentWait() {
    const min = this.frameInterval;
    if (!(min > 0)) return 0;
    const since = performance.now() - this._frame.lastPresentAt;
    return since >= min ? 0 : min - since;
  }

  /**
   * Hold a blit back, and guarantee it still happens.
   *
   * This is the only place `_presentPending` is set, because every deferral has
   * to leave a wakeup behind: the fence reply when the fence is what we are
   * waiting on, this timer when the interval is. Nothing else reschedules a
   * present — `_scheduleFrame()` bails while a frame timer is armed, and
   * neither reschedule condition (in `_armFence`'s reply or `_armTimer`'s
   * callback) looks at the present. Without the timer the last blit of a burst
   * would simply never go out, leaving stale pixels on screen.
   */
  _deferPresent(wait) {
    this._presentPending = true;
    if (wait <= 0) return; // waiting on the fence: its reply blits this
    const f = this._frame;
    if (f.presentTimer) return; // already armed
    f.presentTimer = setTimeout(() => {
      f.presentTimer = null;
      if (!this._presentPending && !this._dirty) return; // someone blitted it
      const again = this._presentWait();
      if (again > 0) return this._deferPresent(again); // a paced frame re-stamped
      if (f.inFlight) return; // the fence ack is closer; it will blit
      this._presentNow();
      this._armFence();
    }, wait);
    if (typeof f.presentTimer.unref === 'function') f.presentTimer.unref();
  }

  /**
   * Blit with the Present extension instead of `CopyArea`.
   *
   * A frame's dirty rectangles become one `PresentPixmap` with an update
   * region, in place of one `CopyArea` per rectangle. Two things follow:
   * a frame is a fixed two requests however fragmented the damage is, and
   * `_blitList`'s bounding-box collapse becomes unnecessary — its whole
   * premise is "each rectangle costs a request", so with Present the exact
   * rectangles are sent and pixels outside them are never touched.
   *
   * Presents are also scheduled by the server against the display's refresh
   * rather than executed on arrival, so a burst cannot produce more updates
   * than the output can show; the server drops superseded frames itself.
   *
   * Worth being precise about what this does *not* do: under a compositing
   * manager the window is redirected, so this schedules the server's copy
   * into the redirect pixmap — the compositor still composites on its own
   * schedule. Aligning with *that* is what `_NET_WM_SYNC_REQUEST`'s extended
   * counters are for.
   *
   * Opt-in via `createWindow({ present: true })`, and inert unless both
   * Present and XFixes are available — blits fall back to `CopyArea`, which
   * stays correct at all times, so the two paths can even alternate.
   *
   * @returns {Promise<Window>}
   */
  enablePresent() {
    if (this._presentExt || this._destroyed) return Promise.resolve(this);
    const X = this.X;
    const need = (name) =>
      new Promise((resolve) => X.require(name, (err, ext) => resolve(err ? null : ext)));
    return Promise.all([need('present'), need('fixes')]).then(([present, fixes]) => {
      if (!present || !fixes || this._destroyed) return this; // stay on CopyArea
      this._updateRegion = X.AllocID();
      safeRelease(X, () => fixes.CreateRegion(this._updateRegion, []));
      this._presentExt = present;
      this._fixesExt = fixes;
      return this;
    });
  }

  /**
   * The Present form of the blit. Returns false when it did not happen, so
   * the caller falls back to CopyArea — which is also what runs before the
   * extensions have answered.
   */
  _presentWithExtension(rects) {
    const P = this._presentExt;
    if (!P || !this._fixesExt || !this._updateRegion) return false;
    safeRelease(this.X, () => {
      this._fixesExt.SetRegion(
        this._updateRegion,
        rects.map((r) => ({ x: r.x, y: r.y, width: r.w, height: r.h }))
      );
      this._presentExt.Pixmap(this.id, this._backing.id, {
        serial: ++this._presentSerial,
        update: this._updateRegion,
        // Option.Copy forces the copy path. Without it the server may *flip*
        // the pixmap to the screen and take ownership of it until an
        // IdleNotify — and ntk reuses one grow-only backing pixmap, so
        // drawing into it while the server owned it would paint the screen
        // directly. Removing this needs a swap chain, not just a smaller diff.
        options: P.Option.Copy
        // targetMsc stays 0: "the next vblank", which is what we want. An
        // explicit target only adds ways to fall behind.
      });
    });
    return true;
  }

  _presentNow() {
    this._presentPending = false;
    if (!this._backing) return;
    this._dirty = false;
    const region = this._dirtyRegion;
    this._dirtyRegion = undefined;
    const w = Math.min(this.width, this._backing.width);
    const h = Math.min(this.height, this._backing.height);
    // Clamped to both drawables: CopyArea outside either is a no-op region at
    // best, and the backing store is grow-only so it can be larger than the
    // window after a shrink. A rectangle that survives clamping with no area
    // left is dropped; if that leaves nothing, nothing needs copying.
    const clamped = [];
    for (const rect of region ?? [{ x: 0, y: 0, w, h }]) {
      const x0 = Math.max(0, Math.floor(rect.x));
      const y0 = Math.max(0, Math.floor(rect.y));
      const x1 = Math.min(w, Math.ceil(rect.x + rect.w));
      const y1 = Math.min(h, Math.ceil(rect.y + rect.h));
      if (x1 > x0 && y1 > y0) clamped.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    if (!clamped.length) return;
    // Stamped here rather than at the call sites so it is a true inter-blit
    // interval across all three of them, and only when pixels really move — a
    // present that copies nothing must not push the next one out.
    this._frame.lastPresentAt = performance.now();
    // Present sends the exact rectangles in one request, so the bounding-box
    // collapse — which trades pixels for fewer requests — has nothing to buy
    if (!this._presentWithExtension(clamped)) {
      const rects = this._blitList(clamped);
      // a paced frame can fire after the connection started closing
      safeRelease(this.X, () => {
        for (const r of rects) {
          this.X.CopyArea(this._backing.id, this.id, this._presentGc, r.x, r.y, r.x, r.y, r.w, r.h);
        }
      });
    }
    // Queued behind whichever of the two put the pixels on their way, so the
    // window manager hears about the new size only once the server has drawn
    // it. Both paths must reach this: a window using Present *and*
    // _NET_WM_SYNC_REQUEST would otherwise never answer, and the resize would
    // stall.
    this._ackSyncRequest();
  }

  /**
   * The rectangles a present actually copies, given the ones drawing reported.
   *
   * The list is not used as it stands: each rectangle is a request, and a
   * region whose pieces nearly fill the box around them is better served by
   * one copy of the box. So the split is kept only when it saves enough of
   * that box to pay for the extra requests, and collapsed otherwise. Both
   * directions cover every reported pixel, so this is a cost decision and
   * never a correctness one.
   */
  _blitList(rects) {
    if (rects.length < 2) return rects;
    const box = rectsBounds(rects);
    let sum = 0;
    for (const r of rects) sum += rectArea(r);
    return sum > rectArea(box) * SPLIT_SAVING ? [box] : rects;
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
   * ICCCM WM_NORMAL_HINTS — how the window manager may size and place this
   * window.
   *
   *   setSizeHints({ minWidth, minHeight, maxWidth, maxHeight,
   *                  widthInc, heightInc, baseWidth, baseHeight,
   *                  minAspect: [num, den], maxAspect: [num, den],
   *                  gravity, position, size, resizable })
   *
   * `resizable: false` is shorthand for pinning min and max to the current
   * size. Without this property a WM lets the user resize a window to any
   * size at all, which is why fixed-size dialogs need it.
   *
   * `position` and `size` are `'user'` or `'program'` and declare who chose
   * the geometry — a window manager that sees neither is free to place the
   * window wherever its own policy says, whatever x/y it was created with.
   * Passing `x`/`y` or `width`/`height` here implies `'program'`.
   *
   * This writes the whole struct: hints not passed are not carried over from
   * an earlier call. `setHints()` is the accumulating form.
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
      resizable,
      x,
      y,
      width,
      height
    } = hints;
    let { position, size } = hints;

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
    // naming a geometry here is itself the statement that the program chose
    // it; the flag is what carries that, and the fields alone are obsolete
    if (position === undefined && (x !== undefined || y !== undefined)) position = 'program';
    if (size === undefined && (width !== undefined || height !== undefined)) size = 'program';

    // XSizeHints: 18 CARD32s, flags first (ICCCM 4.1.2.3)
    const v = new Uint32Array(18);
    let flags = 0;
    if (position) {
      flags |= position === 'user' ? SIZE_HINT.USPosition : SIZE_HINT.PPosition;
      v[1] = x ?? this.x ?? 0;
      v[2] = y ?? this.y ?? 0;
    }
    if (size) {
      flags |= size === 'user' ? SIZE_HINT.USSize : SIZE_HINT.PSize;
      v[3] = width ?? this.width ?? 0;
      v[4] = height ?? this.height ?? 0;
    }
    if (minW !== undefined || minH !== undefined) {
      flags |= SIZE_HINT.PMinSize;
      v[5] = minW ?? 0;
      v[6] = minH ?? 0;
    }
    if (maxW !== undefined || maxH !== undefined) {
      flags |= SIZE_HINT.PMaxSize;
      v[7] = maxW ?? 0;
      v[8] = maxH ?? 0;
    }
    if (widthInc !== undefined || heightInc !== undefined) {
      flags |= SIZE_HINT.PResizeInc;
      v[9] = widthInc ?? 1;
      v[10] = heightInc ?? 1;
    }
    if (minAspect || maxAspect) {
      flags |= SIZE_HINT.PAspect;
      v[11] = minAspect?.[0] ?? 0;
      v[12] = minAspect?.[1] ?? 1;
      v[13] = maxAspect?.[0] ?? 0;
      v[14] = maxAspect?.[1] ?? 1;
    }
    if (baseWidth !== undefined || baseHeight !== undefined) {
      flags |= SIZE_HINT.PBaseSize;
      v[15] = baseWidth ?? 0;
      v[16] = baseHeight ?? 0;
    }
    if (gravity !== undefined) {
      flags |= SIZE_HINT.PWinGravity;
      v[17] = gravity;
    }
    v[0] = flags;

    if (flags === 0) {
      // WM_NORMAL_HINTS with flags 0 is a legal property meaning "I declare
      // nothing" — indistinguishable from never having written it, and
      // reported by nobody. `resizable: true` legitimately means that, so it
      // is the one silent case; anything else here is a typo or a key from
      // the wrong hint struct.
      const keys = Object.keys(hints);
      const onlyResizable = keys.length === 1 && resizable === true;
      if (!onlyResizable) {
        warnHint(
          'sizeHints-empty',
          `setSizeHints({ ${keys.join(', ')} }) sets no WM_NORMAL_HINTS flag, so nothing was ` +
            'written — a flags word of 0 declares nothing and no window manager reports it.'
        );
      }
      return this;
    }

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
   * ICCCM WM_HINTS — what the window wants from the window manager beyond
   * its geometry.
   *
   *   setWmHints({ input, initialState, urgent, icon, iconMask, iconWindow,
   *                iconX, iconY, windowGroup })
   *
   * - `input` is the ICCCM 4.1.7 input model: true if the window expects the
   *   window manager to give it the keyboard focus. Set it before relying on
   *   focus at all — a window manager reading no input hint is entitled to
   *   assume the window takes focus for itself.
   * - `initialState` is `'normal'` or `'iconic'` — the state to start in,
   *   read once, when the window is first mapped.
   * - `urgent` is the attention flag: taskbars flash, some window managers
   *   raise. Clear it when the user has looked.
   * - `icon` (an ntk `Pixmap` or an XID) is the ICCCM icon pixmap, which is
   *   the old 1-bit-or-depth-matched mechanism. Modern desktops prefer
   *   EWMH `_NET_WM_ICON`; set both if you care about old window managers.
   * - `windowGroup` names a window the others belong to — the group
   *   `setTransientFor('root')` refers to.
   *
   * Like `setSizeHints`, this writes the whole struct rather than merging
   * with what an earlier call set; `setHints()` is the accumulating form.
   */
  setWmHints(hints = {}) {
    const {
      input,
      initialState,
      urgent,
      icon,
      iconPixmap,
      iconMask,
      iconWindow,
      iconX,
      iconY,
      windowGroup
    } = hints;

    // XWMHints: 9 CARD32s, flags first (ICCCM 4.1.2.4)
    const v = new Uint32Array(9);
    let flags = 0;
    if (input !== undefined) {
      flags |= WM_HINT.Input;
      v[1] = input ? 1 : 0;
    }
    if (initialState !== undefined) {
      flags |= WM_HINT.State;
      // NormalState 1, IconicState 3 (ICCCM 4.1.2.4); the states between
      // them were withdrawn from the spec
      v[2] = initialState === 'iconic' ? 3 : initialState === 'normal' ? 1 : initialState;
    }
    const pixmap = iconPixmap ?? icon;
    if (pixmap !== undefined) {
      flags |= WM_HINT.IconPixmap;
      v[3] = resourceId(pixmap);
    }
    if (iconWindow !== undefined) {
      flags |= WM_HINT.IconWindow;
      v[4] = resourceId(iconWindow);
    }
    if (iconX !== undefined || iconY !== undefined) {
      flags |= WM_HINT.IconPosition;
      v[5] = iconX ?? 0;
      v[6] = iconY ?? 0;
    }
    if (iconMask !== undefined) {
      flags |= WM_HINT.IconMask;
      v[7] = resourceId(iconMask);
    }
    if (windowGroup !== undefined) {
      flags |= WM_HINT.WindowGroup;
      v[8] = resourceId(windowGroup);
    }
    if (urgent) flags |= WM_HINT.Urgency;
    v[0] = flags;

    // `urgent: false` is the one call that legitimately produces flags 0:
    // clearing attention means rewriting the struct without the bit. So the
    // test here is whether any key was understood, not whether a flag came
    // out of it.
    const keys = Object.keys(hints);
    const understood = keys.filter((k) => WM_HINT_KEYS.has(k));
    if (understood.length === 0) {
      warnHint(
        'wmHints-empty',
        `setWmHints({ ${keys.join(', ')} }) recognises none of those keys, so no WM_HINTS was written.`
      );
      return this;
    }

    safeRelease(this.X, () => {
      this.X.ChangeProperty(
        0,
        this.id,
        this.X.atoms.WM_HINTS,
        this.X.atoms.WM_HINTS,
        32,
        Buffer.from(v.buffer, v.byteOffset, v.byteLength)
      );
    });
    return this;
  }

  /**
   * ICCCM WM_TRANSIENT_FOR — the window this one belongs to. It is what
   * makes a second top-level window a *dialog* rather than an unrelated
   * application window: the window manager stacks it above its owner, keeps
   * it out of the taskbar and pager, iconifies it alongside, places it
   * relative to the owner and gives it a dialog's reduced frame.
   *
   * Accepts a `Window`, an XID, `'root'` (transient for the whole window
   * group — see `setWmHints({ windowGroup })`), or `null` to clear.
   *
   * Both atoms involved are predefined, so this needs no round trip and is
   * on the wire before a `map()` on the next line — which is what ICCCM
   * 4.1.2.6 expects, since a window manager may read the property only when
   * the transient is mapped.
   *
   * Related but not the same as `setWindowType('dialog')`: this names *which*
   * window is the owner, the type says *what kind* of window this is. EWMH
   * treats a managed window with WM_TRANSIENT_FOR and no `_NET_WM_WINDOW_TYPE`
   * as a dialog, but setting any type at all turns that fallback off — so
   * real toolkits set both.
   */
  setTransientFor(owner) {
    const X = this.X;
    if (owner == null) {
      safeRelease(X, () => X.DeleteProperty(this.id, X.atoms.WM_TRANSIENT_FOR));
      return this;
    }
    const id = owner === 'root' ? this.app.display.screen[0].root : resourceId(owner);
    if (this._overrideRedirect) {
      // ICCCM 4.1.2.6 contrasts the two mechanisms: this property is for
      // windows the WM manages, and an override-redirect window is never
      // managed, so the property just sits there
      warnHint(
        'transient-override-redirect',
        'setTransientFor on an override-redirect window has no effect — the window manager ' +
          'never sees the window, so nothing reads the property.'
      );
    }
    safeRelease(X, () => {
      X.ChangeProperty(0, this.id, X.atoms.WM_TRANSIENT_FOR, X.atoms.WINDOW, 32, [id]);
    });
    return this;
  }

  /** The XID in WM_TRANSIENT_FOR, or null. The read side, for WM helpers. */
  async getTransientFor() {
    const v = await this.getProperty('WM_TRANSIENT_FOR', { as: 'numbers' }).catch(() => null);
    return v && v.length ? v[0] : null;
  }

  /**
   * ICCCM WM_PROTOCOLS — the messages this window is willing to receive, by
   * atom name: `'WM_DELETE_WINDOW'`, `'WM_TAKE_FOCUS'`, `'_NET_WM_PING'`,
   * `'_NET_WM_SYNC_REQUEST'`. Each arrives as a `'message'` event.
   *
   * `WM_DELETE_WINDOW` needs none of this by hand: listening for the
   * `'close'` event adds the protocol and decodes the message for you.
   * `_NET_WM_SYNC_REQUEST` likewise has a real opt-in — `enableSyncRequest()`
   * / `createWindow({ syncRequest: true })`. Adding that atom here instead
   * advertises a protocol this window cannot answer, which is worse than not
   * advertising it: the counter the window manager looks for is missing.
   *
   * Replaces the whole list. `addProtocol`/`removeProtocol` are the
   * accumulating forms, and the ones to reach for: the property is a *set*,
   * and a plain write of one atom silently drops the rest.
   *
   * @returns {Promise<Window>}
   */
  async setProtocols(names) {
    const list = (Array.isArray(names) ? names : [names]).filter(Boolean);
    const atoms = await Promise.all(list.map((n) => this.atom(n)));
    this._protocols = new Set(atoms);
    return this._writeProtocols();
  }

  /**
   * Add one protocol to WM_PROTOCOLS, keeping the ones already there.
   * @returns {Promise<Window>}
   */
  addProtocol(name) {
    return this._changeProtocols(name, true);
  }

  /** Remove one protocol from WM_PROTOCOLS. @returns {Promise<Window>} */
  removeProtocol(name) {
    return this._changeProtocols(name, false);
  }

  /** The atom names in WM_PROTOCOLS. @returns {Promise<string[]>} */
  async getProtocols() {
    const atoms = await this.getProperty('WM_PROTOCOLS', { as: 'numbers' }).catch(() => null);
    if (!atoms || !atoms.length) return [];
    return Promise.all(
      atoms.map(
        (a) =>
          new Promise((resolve) => this.X.GetAtomName(a, (err, name) => resolve(err ? null : name)))
      )
    ).then((names) => names.filter(Boolean));
  }

  /**
   * Read-modify-write on the atom set, serialized.
   *
   * Two adds in the same tick would otherwise each read the list before the
   * other wrote it, and the second would drop the first — the same clobber
   * this method exists to prevent, just harder to see.
   */
  _changeProtocols(name, add) {
    const run = async () => {
      const [current, atom] = await Promise.all([this._loadProtocols(), this.atom(name)]);
      if (add) current.add(atom);
      else current.delete(atom);
      return this._writeProtocols();
    };
    this._protocolQueue = this._protocolQueue.then(run, run);
    return this._protocolQueue;
  }

  /**
   * The atom set as it stands on the server, read once.
   *
   * A window we created has none. A window adopted by id may already carry a
   * list its own client wrote, and replacing that is exactly the bug.
   */
  async _loadProtocols() {
    if (this._protocols) return this._protocols;
    const current = await this.getProperty('WM_PROTOCOLS', { as: 'numbers' }).catch(() => null);
    this._protocols = new Set(current || []);
    return this._protocols;
  }

  async _writeProtocols() {
    const property = await this.atom('WM_PROTOCOLS');
    if (this._destroyed) return this;
    const atoms = [...this._protocols];
    safeRelease(this.X, () => {
      this.X.ChangeProperty(0, this.id, property, this.X.atoms.ATOM, 32, atoms);
    });
    return this;
  }

  /**
   * EWMH `_NET_WM_PID` and ICCCM `WM_CLIENT_MACHINE` — which process on
   * which host owns this window. Together they are how a desktop offers to
   * force-quit an unresponsive application, and how `xkill`-style tools name
   * what they are about to kill; EWMH requires the machine for the pid to
   * mean anything, so both are written or neither is.
   *
   * Top-level windows get this automatically; pass `pid: false` at creation
   * to opt out. In a browser bundle there is no pid and no hostname, so the
   * call does nothing.
   */
  setPid(pid, hostname) {
    const proc = globalThis.process;
    const id = pid ?? proc?.pid;
    const host = hostname ?? Window._hostname();
    if (id === undefined || !host) return this;
    const X = this.X;
    safeRelease(X, () => {
      X.ChangeProperty(
        0,
        this.id,
        X.atoms.WM_CLIENT_MACHINE,
        X.atoms.STRING,
        8,
        Buffer.from(String(host), 'latin1')
      );
    });
    return this._withAtoms(['_NET_WM_PID'], (atoms) => {
      safeRelease(X, () => {
        X.ChangeProperty(0, this.id, atoms._NET_WM_PID, X.atoms.CARDINAL, 32, [id]);
      });
    });
  }

  /**
   * EWMH `_NET_WM_ICON` — the icon a taskbar, alt-tab switcher or titlebar
   * draws for this window.
   *
   *   wnd.setIcon(await loadImage('icon-48.png'));
   *   wnd.setIcon([icon16, icon32, icon48]);
   *   wnd.setIcon(await ctx.getImageData(0, 0, 64, 64));
   *   wnd.setIcon(null);            // remove it
   *
   * An image is an ntk [`Image`](images.md), an `ImageData`, or anything
   * with `{ width, height, data }` where `data` is straight
   * (non-premultiplied) RGBA — the same contract as the rest of ntk, so
   * whatever `loadImage()` or `getImageData()` gives you goes straight in.
   *
   * Passing several is the useful case: supply the sizes you have and the
   * window manager picks whichever suits the slot it is filling, instead of
   * scaling a single one badly. Nothing requires a particular order or a
   * particular set of sizes; 16, 32 and 48 cover most desktops.
   *
   * This is the modern mechanism. `setWmHints({ icon })` writes the ICCCM
   * pixmap instead, which is 1-bit-or-matched-depth and has no alpha; a
   * window manager that understands both prefers this one.
   *
   * @param {object|object[]|null} images
   * @returns {Promise<Window>}
   */
  async setIcon(images) {
    const list = images == null ? [] : Array.isArray(images) ? images : [images];
    if (!list.length) return this.deleteProperty('_NET_WM_ICON');

    const data = packIcons(list, this.app.display);
    const property = await this.atom('_NET_WM_ICON');
    const cardinal = this.X.atoms.CARDINAL;
    if (this._destroyed) return this;

    // A ChangeProperty carries 24 bytes of header, so a full icon set can
    // outrun the request limit on a connection created with
    // `disableBigRequests` — 256x256 alone is 262152 bytes against a 262140
    // cap. Replace with the first chunk, append the rest.
    const maxBytes = ((this.app.display.max_request_length ?? 65535) - 6) * 4;
    safeRelease(this.X, () => {
      for (let o = 0; o < data.length; o += maxBytes) {
        this.X.ChangeProperty(
          o === 0 ? 0 : 2, // Replace, then Append
          this.id,
          property,
          cardinal,
          32,
          data.subarray(o, Math.min(o + maxBytes, data.length))
        );
      }
    });
    return this;
  }

  /**
   * Read `_NET_WM_ICON` back — every size the window advertises, largest
   * last or in whatever order its client wrote them, as `ImageData`.
   *
   * Useful on your own window, and the point of it on someone else's: a
   * window manager drawing titlebars reads this off each client it frames.
   * Property bytes from another client are not to be trusted, so a
   * truncated or nonsensical run yields the images that parsed cleanly
   * rather than throwing.
   *
   * Resolves to `null` when the window has no icon.
   *
   * @returns {Promise<ImageData[]|null>}
   */
  async getIcon() {
    const prop = await this.getProperty('_NET_WM_ICON');
    if (!prop || !prop.data.length) return null;
    const icons = unpackIcons(prop.data, this.app.display);
    return icons.length ? icons : null;
  }

  /** os.hostname(), looked up once, and absent in a browser bundle. */
  static _hostname() {
    if (Window._cachedHostname === undefined) {
      const os = globalThis.process?.getBuiltinModule?.('node:os');
      Window._cachedHostname = os?.hostname?.() ?? null;
    }
    return Window._cachedHostname;
  }

  /**
   * Set window manager hints by name, across whichever properties they
   * belong to, keeping the ones set before.
   *
   *   wnd.setHints({ transientFor: main, maxWidth: 900, urgent: true });
   *
   * Every key `setSizeHints` and `setWmHints` understand works here, plus
   * `transientFor` and `protocols`. The same keys are accepted by
   * `createWindow`, at the top level or under `hints`.
   *
   * The difference from calling the two setters directly is that this one
   * remembers: each property is rewritten from everything set on this window
   * so far, so `setHints({ urgent: true })` after `setHints({ input: true })`
   * keeps the input hint. Those setters write their struct whole.
   *
   * Everything but `protocols` is on the wire when this returns — a
   * `map()` on the next line cannot overtake it. `protocols` needs the atom
   * interned first; await `setProtocols()` if the ordering matters.
   */
  setHints(hints = {}) {
    const size = {};
    const wm = {};
    let sizeTouched = false;
    let wmTouched = false;
    const unknown = [];

    for (const key of Object.keys(hints)) {
      if (SIZE_HINT_KEYS.has(key)) {
        size[key] = hints[key];
        sizeTouched = true;
      } else if (WM_HINT_KEYS.has(key)) {
        wm[key] = hints[key];
        wmTouched = true;
      } else if (key !== 'transientFor' && key !== 'protocols') {
        unknown.push(key);
      }
    }
    if (unknown.length) {
      warnHint(
        `hints-unknown-${unknown.join(',')}`,
        `setHints ignored unknown hint${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`
      );
    }

    if (hints.transientFor !== undefined) this.setTransientFor(hints.transientFor);
    if (sizeTouched) {
      this._sizeHints = { ...this._sizeHints, ...size };
      this.setSizeHints(this._sizeHints);
    }
    if (wmTouched) {
      this._wmHints = { ...this._wmHints, ...wm };
      this.setWmHints(this._wmHints);
    }
    if (hints.protocols !== undefined) {
      this.setProtocols(hints.protocols).catch((err) => this.app.options.onXError?.(err));
    }
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
   * EWMH `_NET_WM_STATE` — fullscreen, maximized, sticky, skip-taskbar and
   * the rest of the states a window can be in.
   *
   *   await wnd.setWmState('fullscreen');            // add, the default
   *   await wnd.setWmState('maximized', 'add');      // both axes at once
   *   await wnd.setWmState(['skip_taskbar', 'skip_pager'], 'add');
   *   await wnd.setWmState('fullscreen', 'toggle');
   *
   * Names are the EWMH atoms without their `_NET_WM_STATE_` prefix, in
   * lower case; full atom names work too. `'maximized'` expands to the
   * `MAXIMIZED_VERT` + `MAXIMIZED_HORZ` pair, which is why the spec allows
   * two states per message.
   *
   * How the change is made depends on whether the window is mapped, and the
   * two are not interchangeable (EWMH 7.7): a mapped window *asks* the
   * window manager with a ClientMessage to the root, an unmapped one
   * *declares* its initial state by writing the property. This asks the
   * server which it is rather than trusting the last map/unmap event, so it
   * is right even on the line after `map()`.
   *
   * @param {string|string[]} names
   * @param {'add'|'remove'|'toggle'} [action]
   * @returns {Promise<boolean>} whether the window manager advertises every
   *   state asked for in `_NET_SUPPORTED`. The request is made either way —
   *   an unmapped window may legitimately declare a state before any window
   *   manager is running — but `false` means nothing is listening for it.
   */
  async setWmState(names, action = 'add') {
    const list = expandStateNames(names);
    if (!list.length) return false;
    if (list.length > 2) {
      // EWMH gives the message two atom slots and no more; splitting into
      // several messages is fine, but silently sending the first two is not
      throw new RangeError(
        `setWmState: a _NET_WM_STATE message carries at most 2 states, got ${list.length}`
      );
    }
    const mode = { remove: 0, add: 1, toggle: 2 }[action];
    if (mode === undefined) {
      throw new TypeError(`setWmState: action must be add, remove or toggle, got ${action}`);
    }

    const [atoms, supported, attrs] = await Promise.all([
      this._stateAtoms(list),
      this._netSupported(),
      this.getAttributes().catch(() => null)
    ]);
    if (this._destroyed) return false;
    const ids = list.map((n) => atoms.get(n));
    // mapState: 0 Unmapped, 1 Unviewable, 2 Viewable. Unviewable is mapped
    // under an unmapped ancestor, which is still mapped as far as EWMH cares
    const mapped = attrs ? attrs.mapState !== 0 : this._mapped;

    if (mapped) {
      const root = this.app.display.screen[0].root;
      const messageType = await this.atom('_NET_WM_STATE');
      if (this._destroyed) return false;
      safeRelease(this.X, () => {
        this.X.SendClientMessage(root, this.id, messageType, 32, [
          mode,
          ids[0],
          ids[1] ?? 0,
          1 // source indication: a normal application, not a pager
        ]);
      });
    } else {
      await this._writeWmState(ids, mode);
    }
    return ids.every((id) => supported.has(id));
  }

  /** `setWmState(names, 'add')`. @returns {Promise<boolean>} */
  addWmState(names) {
    return this.setWmState(names, 'add');
  }

  /** `setWmState(names, 'remove')`. @returns {Promise<boolean>} */
  removeWmState(names) {
    return this.setWmState(names, 'remove');
  }

  /**
   * The states currently in `_NET_WM_STATE`, as short lower-case names.
   * `[]` when the window has none.
   *
   * This is what the window manager put there, so it is the answer to "am I
   * actually fullscreen", where `setWmState` is only the request.
   *
   * @returns {Promise<string[]>}
   */
  async getWmStates() {
    const ids = await this.getProperty('_NET_WM_STATE', { as: 'numbers' }).catch(() => null);
    if (!ids || !ids.length) return [];
    const known = await this._stateAtoms(EWMH_STATES);
    const byAtom = new Map([...known].map(([name, atom]) => [atom, name]));
    return Promise.all(
      ids.map(async (id) => {
        const name = byAtom.get(id);
        if (name) return name;
        // a state this build does not know about, or a vendor one
        const full = await new Promise((resolve) =>
          this.X.GetAtomName(id, (err, n) => resolve(err ? null : n))
        );
        return full ? stateShortName(full) : null;
      })
    ).then((names) => names.filter(Boolean));
  }

  /**
   * Read-modify-write on the atom list an unmapped window declares.
   *
   * `_NET_WM_STATE` is a list, so a plain Replace with one atom drops the
   * rest — the same trap WM_PROTOCOLS had. Serialized for the same reason:
   * two changes in a tick would each read the list before the other wrote.
   */
  _writeWmState(ids, mode) {
    const run = async () => {
      const current = new Set(
        (await this.getProperty('_NET_WM_STATE', { as: 'numbers' }).catch(() => null)) || []
      );
      for (const id of ids) {
        const add = mode === 2 ? !current.has(id) : mode === 1;
        if (add) current.add(id);
        else current.delete(id);
      }
      const property = await this.atom('_NET_WM_STATE');
      if (this._destroyed) return this;
      safeRelease(this.X, () => {
        this.X.ChangeProperty(0, this.id, property, this.X.atoms.ATOM, 32, [...current]);
      });
      return this;
    };
    this._wmStateQueue = this._wmStateQueue.then(run, run);
    return this._wmStateQueue;
  }

  /** Intern the atoms for a list of short state names. @returns {Promise<Map>} */
  async _stateAtoms(names) {
    const ids = await Promise.all(names.map((n) => this.atom(stateAtomName(n))));
    return new Map(names.map((n, i) => [n, ids[i]]));
  }

  /**
   * The atoms in the root window's `_NET_SUPPORTED`, read once per
   * connection.
   *
   * It is one property on one window describing one window manager, so
   * re-reading it per window per call is pure round trips. A window manager
   * that restarts and advertises differently is the cost, and the same one
   * every toolkit accepts.
   *
   * @returns {Promise<Set<number>>}
   */
  _netSupported() {
    if (!this.app._netSupportedPromise) {
      this.app._netSupportedPromise = this.app
        .rootWindow()
        .getProperty('_NET_SUPPORTED', { as: 'numbers' })
        .then((ids) => new Set(ids || []))
        .catch(() => new Set());
    }
    return this.app._netSupportedPromise;
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
    this.setWmState('above', on ? 'add' : 'remove').then(
      (supported) => {
        if (!supported && !this._destroyed) this._appleWMSetLevel(on);
      },
      (err) => this.app.options.onXError?.(err)
    );
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
   * created once per connection and cached on the app. Throws synchronously
   * on unknown names.
   *
   * Two things that sound alike and are not:
   *
   *   setCursor('none')  the pointer is invisible over this window
   *   setCursor(null)    X cursor None — *inherit* the parent's cursor,
   *                      which for a top-level window is the root's, so the
   *                      pointer stays visible
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
   * Write a property — the counterpart of getProperty, and the general form
   * of setTitle/setClass/setSizeHints. Strings are written as UTF8_STRING,
   * arrays of numbers as 32-bit lists; `type` names the property type atom
   * ('ATOM', 'CARDINAL', 'WINDOW', 'UTF8_STRING', 'STRING'), which is what
   * EWMH properties are picky about.
   *
   *   wnd.setProperty('_NET_WM_NAME', 'a title');
   *   wnd.setProperty('_NET_CLIENT_LIST', ids, { type: 'WINDOW' });
   *
   * @param {string} name atom name of the property
   * @param {string|number[]|Buffer} value
   * @param {object} [options] `{ type, format }`
   */
  async setProperty(name, value, options = {}) {
    const isList = Array.isArray(value);
    const { type = isList ? 'CARDINAL' : 'UTF8_STRING', format = isList ? 32 : 8 } =
      options;
    const [property, typeAtom] = await Promise.all([this.atom(name), this.atom(type)]);
    let data = value;
    if (isList) {
      const words = new Uint32Array(value);
      data = Buffer.from(words.buffer, words.byteOffset, words.byteLength);
    } else if (typeof value === 'string') {
      data = Buffer.from(value, type === 'STRING' ? 'latin1' : 'utf8');
    }
    if (this._destroyed) return this;
    safeRelease(this.X, () => {
      this.X.ChangeProperty(0, this.id, property, typeAtom, format, data);
    });
    return this;
  }

  /**
   * Remove a property.
   *
   * Not the same as writing an empty value, and not at all the same as
   * writing a zero: a deleted property reads back as type None — which is
   * how "this client never declared that" is spelled — and a window manager
   * watching gets a PropertyNotify with state Delete. `setTransientFor(null)`
   * goes through here for exactly that reason; a `WM_TRANSIENT_FOR` of 0
   * would name window None as the owner rather than saying there is none.
   *
   * @returns {Promise<Window>}
   */
  async deleteProperty(name) {
    const atom = await this.atom(name);
    if (this._destroyed) return this;
    safeRelease(this.X, () => {
      this.X.DeleteProperty(this.id, atom);
    });
    return this;
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
   * `{ position, size, x, y, width, height, minWidth, minHeight, maxWidth,
   * maxHeight, widthInc, heightInc, baseWidth, baseHeight, minAspect,
   * maxAspect, gravity }`, each present only if the client set its flag.
   * Resolves to `{}` when the window has no hints, so callers can
   * destructure without a null check.
   */
  async getSizeHints() {
    const v = await this.getProperty('WM_NORMAL_HINTS', { as: 'numbers' }).catch(() => null);
    if (!v || v.length < 18) return {};
    const flags = v[0];
    const hints = {};
    if (flags & (SIZE_HINT.USPosition | SIZE_HINT.PPosition)) {
      hints.position = flags & SIZE_HINT.USPosition ? 'user' : 'program';
      hints.x = v[1];
      hints.y = v[2];
    }
    if (flags & (SIZE_HINT.USSize | SIZE_HINT.PSize)) {
      hints.size = flags & SIZE_HINT.USSize ? 'user' : 'program';
      hints.width = v[3];
      hints.height = v[4];
    }
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
   * WM_HINTS as an object shaped like setWmHints' argument, each field
   * present only if the client set its flag. `{}` when the window has none.
   * `urgent` is reported whenever the property exists, since its absence is
   * meaningful — it is what "the user has looked" looks like.
   */
  async getWmHints() {
    const v = await this.getProperty('WM_HINTS', { as: 'numbers' }).catch(() => null);
    if (!v || v.length < 9) return {};
    const flags = v[0];
    const hints = { urgent: !!(flags & WM_HINT.Urgency) };
    if (flags & WM_HINT.Input) hints.input = !!v[1];
    if (flags & WM_HINT.State) hints.initialState = v[2] === 3 ? 'iconic' : 'normal';
    if (flags & WM_HINT.IconPixmap) hints.iconPixmap = v[3];
    if (flags & WM_HINT.IconWindow) hints.iconWindow = v[4];
    if (flags & WM_HINT.IconPosition) {
      hints.iconX = v[5];
      hints.iconY = v[6];
    }
    if (flags & WM_HINT.IconMask) hints.iconMask = v[7];
    if (flags & WM_HINT.WindowGroup) hints.windowGroup = v[8];
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
    safeRelease(this.X, () =>
      this.X.SendEvent(this.id, 0, x11.eventMask.StructureNotify, {
        name: 'ConfigureNotify',
        wid: this.id, // event window
        wid1: this.id, // the window the event is about
        aboveSibling: 0, // None: bottom of the stack
        x,
        y,
        width,
        height,
        borderWidth,
        overrideRedirect: 0
      })
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
    // mask 0: deliver to the client that created the window, not to whoever
    // selected events on it — a WM_PROTOCOLS message is addressed to the
    // owner, so it must not go out with the EWMH substructure default
    safeRelease(this.X, () =>
      this.X.SendClientMessage(this.id, this.id, wmProtocols, 32, [deleteAtom, 0 /* CurrentTime */], 0)
    );
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

  /**
   * Opt in to the WM_DELETE_WINDOW protocol: the window manager sends a
   * 'message' event instead of killing the connection when the user closes
   * the window.
   *
   * Kept for compatibility, and now an alias — it used to write
   * WM_PROTOCOLS as a list of exactly one atom, so the next protocol added
   * by any other means erased it. Prefer `addProtocol('WM_DELETE_WINDOW')`,
   * which is awaitable.
   */
  setActions() {
    this.addProtocol('WM_DELETE_WINDOW').catch((err) => this.app.options.onXError?.(err));
    return this;
  }

  /**
   * Turn a WM_DELETE_WINDOW ClientMessage into the `close` event.
   *
   * Only fires when something is listening, so a window that handles the
   * raw `message` event itself — the only way to do this before `close`
   * existed — keeps behaving exactly as it did, rather than suddenly
   * acquiring a second handler that destroys it.
   */
  /**
   * Opt into `_NET_WM_SYNC_REQUEST` (EWMH §6.2): let the window manager pace
   * an interactive resize to how fast this window actually repaints.
   *
   * Without it a WM has no idea when a resize has been drawn, so it either
   * throws ConfigureNotify at the client as fast as the pointer moves — and
   * the window lags behind the frame the user is dragging — or guesses with a
   * timer. With it, the WM sends a serial before each resize and waits for
   * this window to echo it back once the new size is on screen.
   *
   * Also available as `createWindow({ syncRequest: true })`. This is the
   * awaitable form, for when `map()` follows immediately: the counter and the
   * `_NET_WM_SYNC_REQUEST_COUNTER` property have to exist before the window
   * leaves the withdrawn state, because that is when the WM reads them.
   *
   * Silently does nothing when the server has no SYNC extension — a WM that
   * finds no counter simply drives the resize the old way.
   *
   * Only basic (single-counter) synchronization is implemented. The extended
   * two-counter form buys frame-timing feedback rather than resize pacing, and
   * its odd/even parity rules freeze the window if they are ever got wrong; a
   * compositor that supports it falls back to basic mode on its own when the
   * property holds one counter.
   *
   * @returns {Promise<Window>}
   */
  enableSyncRequest() {
    if (this._syncCounter || this._destroyed) return Promise.resolve(this);
    const X = this.X;
    return new Promise((resolve, reject) => {
      X.require('sync', (err, Sync) => {
        if (err || !Sync || this._destroyed) return resolve(this); // no SYNC: stay quiet
        this._sync = Sync;
        const counter = X.AllocID();
        safeRelease(X, () => Sync.CreateCounter(counter, 0));
        this._syncCounter = counter;
        // The dispatch path compares against both atoms, and node-x11 caches
        // interned atoms per connection, so this is one round trip and no more.
        this.atom('WM_PROTOCOLS').catch(() => {});
        this._withAtoms(['_NET_WM_SYNC_REQUEST_COUNTER', '_NET_WM_SYNC_REQUEST'], (atoms) => {
          this._syncRequestAtom = atoms._NET_WM_SYNC_REQUEST;
          safeRelease(X, () =>
            X.ChangeProperty(
              0,
              this.id,
              atoms._NET_WM_SYNC_REQUEST_COUNTER,
              X.atoms.CARDINAL,
              32,
              [counter]
            )
          );
          // property first, protocol second: a window manager that sees the
          // protocol advertised must always find the counter behind it
          this.addProtocol('_NET_WM_SYNC_REQUEST').then(() => resolve(this), reject);
        });
      });
    });
  }

  /**
   * The window manager asking us to report when a resize has been painted.
   *
   * Only the value is recorded here — acknowledging now would claim a frame
   * that has not been drawn. `_ackSyncRequest` sends it once the pixels are on
   * their way. EWMH is explicit that only the *last* message is acknowledged,
   * so a newer request simply overwrites an older one.
   */
  _handleSyncRequest(ev) {
    if (!this._syncCounter || ev.format !== 32) return;
    const X = this.X;
    if (!X.atoms.WM_PROTOCOLS || ev.message_type !== X.atoms.WM_PROTOCOLS) return;
    if (!this._syncRequestAtom || ev.data?.[0] !== this._syncRequestAtom) return;
    // data[2] is the low half of the 64-bit request number, data[3] the high
    this._syncPending = ev.data[3] * 0x100000000 + ev.data[2];
    // Not every request leads to a repaint — a move, or a resize to the size
    // we already are, leaves nothing dirty and no frame scheduled. The
    // watchdog turns a missed acknowledgement into a stutter instead of a
    // window manager that waits forever.
    this._armSyncWatchdog();
  }

  _armSyncWatchdog() {
    if (this._syncWatchdog || this._syncPending == null) return;
    this._syncWatchdog = setTimeout(() => {
      this._syncWatchdog = null;
      this._ackSyncRequest();
    }, Math.max(this.frameInterval, 16) * 2);
    if (typeof this._syncWatchdog.unref === 'function') this._syncWatchdog.unref();
  }

  /**
   * Answer the window manager's last sync request.
   *
   * Called after the requests that repaint have been queued, never before: X
   * runs a client's requests in order, so a SetCounter queued behind the
   * copies is executed behind them too, which is exactly the "having handled
   * all repainting" the spec asks for. (It rides the same output batch, which
   * is flushed before the event loop polls — no manual flush needed.)
   */
  _ackSyncRequest() {
    const value = this._syncPending;
    if (value == null || !this._syncCounter || !this._sync) return;
    this._syncPending = null;
    if (this._syncWatchdog) {
      clearTimeout(this._syncWatchdog);
      this._syncWatchdog = null;
    }
    safeRelease(this.X, () => this._sync.SetCounter(this._syncCounter, value));
  }

  _emitCloseRequest(ev) {
    if (ev.format !== 32 || !this.listenerCount('close')) return;
    // node-x11 caches interned atoms per connection, so these are the ids
    // the 'close' listener's addProtocol already interned
    const X = this.X;
    if (!X.atoms.WM_PROTOCOLS || ev.message_type !== X.atoms.WM_PROTOCOLS) return;
    if (!X.atoms.WM_DELETE_WINDOW || ev.data?.[0] !== X.atoms.WM_DELETE_WINDOW) return;

    let prevented = false;
    this.emit('close', {
      name: 'close',
      window: this,
      target: this,
      // the timestamp the window manager stamped the request with, for
      // passing back to setInputFocus and friends
      time: ev.data[1],
      preventDefault() {
        prevented = true;
      },
      get defaultPrevented() {
        return prevented;
      }
    });
    // the default action, and the reason preventDefault has to be called
    // synchronously: there is no point at which it could be awaited
    if (!prevented && !this._destroyed) this.destroy();
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
