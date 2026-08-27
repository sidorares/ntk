import x11 from 'x11';

import { builtin } from './builtin.js';
import { connectionGone, safeRelease } from './cleanup.js';
import Drawable from './drawable.js';
import { packIcons, unpackIcons } from './imagedata.js';
import Pixmap from './pixmap.js';
import * as xevents from './events_map.js';
import { decodeKey } from './keyboard.js';
import {
  DEFAULT_XI2_EVENTS,
  POINTER_EMULATED,
  ScrollTracker,
  WHEEL_BUTTONS,
  normalizeXI2Types,
  scrollAxes,
  toNtkEvent,
  wheelEvent,
  xi2EventName
} from './xi2.js';

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

/**
 * Frame period assumed before anything better is known, in ms.
 *
 * The fence clock's rate limit, and the vblank clock's placeholder until the
 * display has reported its own period (see _sampleRefresh).
 */
const DEFAULT_FRAME_INTERVAL = 16;

/**
 * The range a measured vblank period has to fall in to be believed, in ms.
 *
 * Completion timestamps come from the server's clock and its idea of a frame
 * counter, neither of which is guaranteed to mean what it does on a physical
 * output — a window with no CRTC behind it gets a synthesized msc, and an idle
 * gap between two presents inflates the period derived from them. A sample
 * outside 1000Hz..10Hz is not a refresh rate and is dropped.
 */
const MIN_REFRESH_INTERVAL = 1;
const MAX_REFRESH_INTERVAL = 100;

/**
 * How many recent completion intervals the refresh estimate is drawn from,
 * and how far up their sorted order it reads.
 *
 * Near the bottom rather than the middle, because what the msc counts is not
 * the same everywhere. Where it counts vertical blanks a one-blank gap is
 * exactly one period and every sample agrees; where it counts *presents* —
 * Xwayland advances it once per frame the compositor takes — a slow frame
 * reports its own duration as if it were the display's, and only the quick
 * frames are telling the truth. Not the outright minimum, because a
 * timer-driven fake vblank (Xvfb) jitters in both directions and a single
 * short gap should not become the answer. A history, rather than a running
 * value, is what lets the estimate rise again after a mode change to a slower
 * rate.
 */
const REFRESH_SAMPLES = 16;
const REFRESH_QUANTILE = 0.25;

/**
 * How long a frame may stay outstanding before the vblank clock is abandoned
 * for the fence, in ms.
 *
 * Deliberately far above any frame rate: this is a deadlock breaker, not a
 * pacer, and the rate a window is *legitimately* given can be very low. A
 * Wayland compositor throttles a window nobody can see — measured at ~1Hz for
 * an occluded window under Mutter — by simply not sending the frame callback
 * that completes its present, and that window is right to stop rendering.
 * Waking it up to run frames at fence rate would burn CPU on pixels no one
 * sees, so the timeout has to sit above the slowest honest answer.
 *
 * A server that never completes anything is a different case and worth
 * catching quickly, so the first present a window ever sends is given the
 * shorter deadline — nothing has proved it will be answered yet.
 */
const STALL_TIMEOUT = 2000;
const STALL_TIMEOUT_FIRST = 250;

/**
 * MotionNotify detail saying "this is the only motion you get until you ask".
 *
 * The core protocol calls it NotifyHint and puts it in the event's detail
 * byte; node-x11 parses a MotionNotify's detail into `keycode`, the field
 * that carries a button number on ButtonPress — so this is compared against
 * `ev.keycode`, not `ev.detail`, which motion events do not have.
 */
const MOTION_NOTIFY_HINT = 1;

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

/**
 * A GetGeometry reply in ntk's spelling. node-x11 calls the position `xPos`/
 * `yPos` and the reply's root window `windowid`, neither of which is what X
 * calls them; the `root` here is the root of the screen the drawable is on,
 * not this window's parent.
 */
function unpackGeometry(res) {
  return {
    x: res.xPos,
    y: res.yPos,
    width: res.width,
    height: res.height,
    depth: res.depth,
    borderWidth: res.borderWidth,
    root: res.windowid
  };
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
    // `wnd.ready` (see the getter): resolved as soon as this wrapper knows
    // its geometry — at the end of the constructor for a window ntk created,
    // when GetGeometry replies for one adopted by id
    this._readyPromiseResolve = null;
    this._readyPromise = new Promise((resolve) => {
      this._readyPromiseResolve = resolve;
    });
    // constructor round trips still outstanding, for an adopted window
    this._readyPending = 0;

    const parentId = args.parent ? args.parent.id : app.display.screen[0].root;

    // double buffering (see docs/window.md): windows we created get a
    // backing pixmap when a 2d context is requested, unless opted out
    this._foreign = !!args.id;
    // Adopting a window is not the same as "another client paints these
    // pixels", though it is the safe default reading of one. The Composite
    // overlay window and a window handed over by an embedding host (XEmbed's
    // plug side, an `--wid` handoff) are ours completely — they are foreign
    // only in the sense that `createWindow` did not make them, and they are
    // exactly the windows that most want an unflickering double buffer and a
    // vblank-paced blit. Saying so is `{ id, backingStore: true }` or
    // `{ id, present: true }`; from there such a window behaves like any
    // other window ntk owns (issue #294).
    this._ownsPixels = !this._foreign || args.backingStore === true || args.present === true;
    this._backingOptOut = args.backingStore === false;
    this._backing = null;
    // an adopted window has no geometry, depth or visual to build a backing
    // pixmap from until its constructor's questions reply — see
    // _enableBackingStoreWhenReady
    this._backingScheduled = false;
    // What the backing store clears to, and the window attribute it mirrors.
    // Undefined means "nothing was asked for" — see _clearColour.
    this._clearPixel = args.backgroundPixel;
    this._dirty = false;
    this._presentPending = false;

    // frame clock state: coalesced events, synthetic redraws and
    // requestAnimationFrame callbacks are delivered in paced frames
    // (see docs/window.md "Frames, coalescing and slow connections")
    this._coalesce = args.coalesceEvents !== false;
    this._frameSyncEnabled = args.frameSync !== false;
    // which signal ends a frame (see _clockOnPresent): 'auto' takes the
    // display's own vblank where the Present path can supply it and the fence
    // everywhere else, 'fence' pins the round-trip clock
    this._frameClockPref = args.frameClock ?? 'auto';
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
    this._presentEid = 0;
    // Generic Events (type 35) carry an extension opcode where a core event
    // carries its code, so they are routed by opcode: Present's completions,
    // XI2's device events, and whatever else selects them later.
    this._geHandlers = new Map();
    // A direct GL context's swap chain, when one is presenting on this window
    // — an override ahead of that table (see _setGenericEventSink)
    this._geSink = null;
    this._geSinkOpcode = 0;
    // XI2 state, once a window has selected it (see selectXI2)
    this._xi2 = null;
    // PointerMotionHint bookkeeping (see setMouseHintOnly and
    // _rearmMotionHint): whether a frame owes the server the QueryPointer
    // that re-arms the hint, whether one is already in flight, the timestamp
    // of the hint that asked for it, and the last position delivered — a
    // reply that repeats it is not an event.
    this._hintRearm = false;
    this._hintPollPending = false;
    this._hintTime = 0;
    this._hintLast = null;
    // The vblank clock (see _onPresentComplete): the period learnt from
    // completion events, the samples it is drawn from, and the latch the
    // watchdog sets when completions stop arriving.
    this.refreshInterval = null;
    this.droppedFrames = 0;
    this._refreshSamples = [];
    this._lastComplete = null;
    this._clockStalled = false;
    // `frameInterval` is a plain number, but whether the caller set it is what
    // decides its meaning under the vblank clock — an explicit value caps the
    // frame rate, an unasked-for default must not (see _armTimer). Assigning
    // the property later is the caller setting it, hence the accessor.
    //
    // The default is the display's own period where the connection has found
    // it out, and DEFAULT_FRAME_INTERVAL until it has: a window built before
    // that probe answers adopts the result when it lands.
    this._frameInterval = args.frameInterval ?? app.frameInterval ?? DEFAULT_FRAME_INTERVAL;
    this._frameIntervalExplicit = args.frameInterval !== undefined;
    this.frameLatency = null;
    this._frame = {
      pending: new Map(), // coalescible event name -> merged event
      rafCbs: [],
      rafId: 0,
      inFlight: false, // fence round-trip awaiting the server's reply
      presentInFlight: false, // present awaiting the display's CompleteNotify
      presentAt: 0, // when that present was sent, for frameLatency
      stallTimer: null,
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
      this.windowClass = args.windowClass ?? 0;
      const values = {
        eventMask: this.eventMask
      };
      // NorthWest bit gravity: keep the old content anchored during resize
      // instead of discarding it (less flicker between the resize and our
      // redraw). An InputOnly window (class 2) has no content to anchor and
      // the attribute is not one it accepts — setting it is a BadMatch.
      if (this.windowClass !== 2) values.bitGravity = 1;
      for (const name of forwardedXAttributes) {
        if (args[name] !== undefined) values[name] = args[name];
      }
      // what setCursor compares against, so setting the cursor a window was
      // created with is free rather than a redundant round trip
      this._currentCursor = values.cursor;
      // a window on a non-default visual (GLX, ARGB) also needs its own
      // colormap and an explicit border pixel: inheriting either from a
      // parent of a different depth is a BadMatch (X11 CreateWindow)
      this.visual = args.visual ?? 0;
      this.depth = args.depth ?? 0;
      // `visual` is the CreateWindow argument, where 0 means CopyFromParent;
      // `visualId` is the visual the pixels are actually in, which is what a
      // picture format is picked from (issue #295). CopyFromParent is only
      // ever the parent's, and the default parent is the root.
      this.visualId = this.visual || args.parent?.visualId || app.display.screen[0].root_visual;
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
      // nothing is known about another client's window until it answers
      this.visualId = 0;
      this.depth = 0;
      // an adopted window's geometry is not known until GetGeometry replies
      this._deliveredGeom = null;
      // Two questions, because a drawable's pixels take both to describe:
      // GetGeometry for width, height and depth, GetWindowAttributes for the
      // visual — depth alone does not name a picture format, and the windows
      // whose format was picked wrongest are exactly these, the ones another
      // client chose the visual for (issue #295). They go out in the same
      // batch, so the pair costs one round trip, not two, and `ready` is the
      // wait for both.
      //
      // Nothing is asked of a connection that is going away: node-x11 throws
      // synchronously at a request once close() has begun, and adoption
      // happens from places with no caller to catch — a routed child-event,
      // XEmbed, the shared glyph cache all build windows from inside the X
      // event dispatch (issue #321). There is nothing to learn there either,
      // so `ready` settles with the geometry unknown, the same outcome as a
      // window destroyed before its reply landed (see the getter).
      this._readyPending = connectionGone(X) ? 0 : 2;
      if (this._readyPending) {
        X.GetGeometry(this.id, (err, res) => {
          // A window that was destroyed between the id reaching us and this
          // request reaching the server answers BadWindow, and there is
          // nothing to record. `ready` still resolves: adopting a window that
          // has since gone is ordinary for a window manager, and a wait that
          // never ends is worse than one that ends with width undefined.
          this._readyPending--;
          if (err) this._settleReady();
          else this._applyGeometry(unpackGeometry(res));
        });
        X.GetWindowAttributes(this.id, (err, attrs) => {
          this._readyPending--;
          if (!err) this.visualId = attrs.visual;
          this._settleReady();
        });
      } else {
        this._settleReady();
      }
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
    if (args.xi2) {
      // fire and forget: until the extension answers, the window is on core
      // events, which is where it would have been anyway. `await
      // wnd.selectXI2()` is the form that says whether the server has XI2.
      this.selectXI2(args.xi2 === true ? undefined : args.xi2).catch((err) =>
        this.app.options.onXError?.(err)
      );
    }
    if (args.syncRequest && !args.id) {
      // fire and forget: the window manager only reads the counter when it
      // starts managing the window, and map() is the caller's next line at
      // the earliest. `await wnd.enableSyncRequest()` when that is too close.
      this.enableSyncRequest().catch((err) => this.app.options.onXError?.(err));
    }
    // Presenting is what a double-buffered window does unless it says
    // otherwise, so the decision is deferred to the point one gets a backing
    // store (see _enableBackingStore): a window drawing through 'opengl' or
    // 'x11' has no pixmap to present and would only be paying for an update
    // region and an event selection it never uses. `present: true` is still
    // honoured eagerly, for a caller who wants it up before the first paint.
    this._presentOptOut = args.present === false;
    if (args.present === true) {
      // fire and forget: until the extensions answer, blits use CopyArea,
      // which is what they would have done anyway. Present needs nothing of
      // the window but its id, so an adopted one can have it up before its
      // geometry has even replied.
      this.enablePresent().catch((err) => this.app.options?.onXError?.(err));
    }
    // A window adopted with ownership declared starts its backing store now
    // rather than waiting for the first getContext('2d'): the allocation
    // needs the constructor's replies anyway, so starting it here means it
    // is normally already there by the time the caller's `await wnd.ready`
    // returns and it draws.
    if (this._foreign && this._ownsPixels && !this._backingOptOut) {
      this._enableBackingStoreWhenReady();
    }

    X.event_consumers[this.id] = this;
    this.on('event', (ev) => {
      // Present and XI2 speak in X Generic Events, which carry an extension
      // opcode and a sub-type where a core event carries its code — the name
      // table below cannot see them, so they are routed by opcode instead
      if (ev.type === 35) {
        // A direct GL context presenting on this window selected these events
        // itself and owns the pixmaps they name, so they are its to read — and
        // it is the only user of Present there, a GL window having no backing
        // store to blit. Hence an override rather than another table entry:
        // it claims the same extension the window's own blit path uses.
        if (this._geSink && ev.extension === this._geSinkOpcode) {
          this._geSink.handleEvent(ev);
          return;
        }
        this._geHandlers.get(ev.extension)?.(ev);
        return;
      }
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
      // the server saying "the pointer moved, and I will say no more about it
      // until you ask": the event still carries the position it was generated
      // at, so it is delivered like any other move, but the conversation has
      // to be picked back up or this is the last one (see _rearmMotionHint)
      if (eventName === 'mousemove' && ev.keycode === MOTION_NOTIFY_HINT) {
        this._hintTime = ev.time;
        this._hintLast = { x: ev.x, y: ev.y };
        this._hintRearm = true;
        this._deliverEvent(eventName, ntkev);
        // the frame that just took the move sends the poll — one per frame,
        // which is the rate a frame's worth of motion is reduced to anyway.
        // An uncoalesced window has no frame to hang it on, so it goes now.
        if (!this._coalesce) this._rearmMotionHint();
        return;
      }
      // a wheel is a button in the core protocol; say so in the units a
      // consumer wants. Suppressed once XI2 is delivering the same scroll as
      // valuators, which is the whole reason to select it (see selectXI2).
      if (eventName === 'mousedown' && WHEEL_BUTTONS[ev.keycode] && !this._xi2?.smooth) {
        const [deltaX, deltaY] = WHEEL_BUTTONS[ev.keycode];
        this._deliverEvent('wheel', wheelEvent({ ...ntkev }, deltaX, deltaY, 'button'));
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
      this._deliverEvent(eventName, ntkev);
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
      // Events buffered before `close()` keep being dispatched after it, and
      // a window this client already saw destroyed has no substructure left
      // to report. Neither is worth building a child for — and the questions
      // the constructor would ask on the way out are what used to throw into
      // the dispatcher (issue #321).
      if (this._destroyed || connectionGone(X)) return;
      const child = new Window(app, { id: ev.wid });
      const ntkev = { ...ev, parent: this, window: child, target: child };
      // wait until we know that we track correct x,y,w,h values
      child.ready.then(() => {
        this.emit(eventName, ntkev);
      });
    });

    this.on('newListener', (name) => {
      // one of ntk's own handlers going on, not a caller asking for an
      // event: nothing to arm and nothing to select — see _listenInternal
      if (this._internalListen) return;
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
        // A connection on its way out can select nothing, and node-x11 throws
        // synchronously at a request from then on. This hook runs from
        // `.on()` — including the calls made while adopting a window from
        // inside the X event dispatch, where there is no caller to catch it
        // (issue #321). Before the mask is touched, so it goes on saying what
        // this connection holds.
        if (connectionGone(X)) return;
        this.eventMask |= eventMask;
        // the selection can legitimately fail — SubstructureRedirect is
        // one-client-only, so `on('map_request')` is how you find out
        // another window manager owns this window. Route it to the app's
        // error hook rather than dropping it; selectInput() is the
        // explicit form that hands the error straight back.
        X.ChangeWindowAttributes(this.id, { eventMask: this.eventMask }, (err) => {
          if (!err) return;
          // the request failed as a whole, so the server kept the mask it
          // had: drop the bits again rather than leave `eventMask` claiming
          // a selection this connection does not hold. selectInput() trusts
          // it to decide whether a write can be skipped.
          this.eventMask &= ~eventMask;
          this.app.options.onXError?.(err);
        });
      }
    });

    // ntk's own bookkeeping listens for the same events an app does, and the
    // hook above reads a listener as a caller expressing interest and selects
    // for it. For a window ntk created that is free — StructureNotify is in
    // the CreateWindow value list already — but for an adopted one the
    // tracked mask starts at zero and the write is absolute, so it would
    // replace whatever this connection had selected on a window another
    // client owns (issue #322). Subscribe past the hook: adopting a window
    // costs no requests and changes no server-side state, and a caller that
    // wants these events still asks for them, with on('map') or selectInput.
    this._listenInternal('map', () => (this._mapped = true));
    this._listenInternal('unmap', () => (this._mapped = false));
    this._listenInternal('destroy', () => {
      this._destroyed = true;
      this._forget();
      this._teardownFrame(false); // the server has already taken the window
      // the server frees window-backed pictures with the window — let
      // contexts drop their wrappers without issuing FreePicture
      this.emit('_destroyed');
    });

    if (typeof this.width !== 'undefined') {
      this._settleReady();
    }
  }

  /**
   * Attach one of ntk's own handlers without the `newListener` hook reading
   * it as a caller asking for the event. The hook's job is to turn expressed
   * interest into a server-side selection; ntk's internal bookkeeping
   * expresses none — it only wants the events that arrive anyway — and on an
   * adopted window a selection nobody asked for overwrites another
   * subsystem's (issue #322). The flag is read synchronously by the hook,
   * which EventEmitter emits before the listener is stored.
   */
  _listenInternal(name, fn) {
    this._internalListen = true;
    try {
      this.on(name, fn);
    } finally {
      this._internalListen = false;
    }
  }

  /**
   * Resolves with this window once its geometry is known — immediately for a
   * window ntk created (it already knows what it asked for), when the
   * GetGeometry sent by the constructor replies for one adopted by id.
   *
   * Adoption is the case that needs it: until the reply lands, `width`,
   * `height`, `x` and `y` are `undefined` and `depth` is `0`, so anything
   * that picks a pixel format from the depth — `getContext('2d')`,
   * `createPattern` — would pick the wrong one. Awaiting is safe
   * unconditionally, so code that takes windows from either source need not
   * ask which it has:
   *
   *   const wnd = new Window(app, { id: ev.wid });
   *   await wnd.ready;
   *   const ctx = wnd.getContext('2d');
   *
   * The promise never rejects. A window destroyed before the reply arrives
   * resolves all the same, with `width` still `undefined` — the request that
   * hits the gone window is the one that reports it.
   */
  get ready() {
    return this._readyPromise;
  }

  /**
   * Ask the server where this window is now — `{ x, y, width, height, depth,
   * borderWidth, root }`, with `x`/`y` relative to the parent, as X reports
   * them.
   *
   * `wnd.x`/`y`/`width`/`height`/`depth` are kept current from the event
   * stream and are the cheap answer; this is the round trip for the cases
   * the events cannot cover — a window nobody selected StructureNotify on, a
   * window ntk created with the default `depth: 0` (CopyFromParent, whose
   * real depth only the server knows), or simply the state at a point in
   * time. The reply is written back to those properties, and resolves
   * `ready` if it was still pending.
   */
  getGeometry() {
    return new Promise((resolve, reject) => {
      this.X.GetGeometry(this.id, (err, res) => {
        if (err) return reject(err);
        const geometry = unpackGeometry(res);
        this._applyGeometry(geometry);
        resolve(geometry);
      });
    });
  }

  /** Record a GetGeometry reply, and let anything waiting on it go. */
  _applyGeometry({ x, y, width, height, depth }) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.depth = depth;
    // Only where nothing is known yet: on an adopted window a 'resize'
    // reports both moved and resized until there is a baseline to compare
    // against (see _tagResize), and the event stream may already have set
    // one — that is the delivered geometry, and this reply is not.
    this._deliveredGeom ??= { x, y, width, height };
    this._settleReady();
  }

  /**
   * Let anything waiting on `ready` go, once the questions the constructor
   * asked have all been answered. A window ntk created asked none.
   */
  _settleReady() {
    if (this._readyPending > 0) return;
    this._readyPromiseResolve(this);
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
   *
   * A window adopted by id is left alone by default — another client's
   * pixels are not ntk's to buffer — and opts in with
   * `createWindow({ id, backingStore: true })` (see `_ownsPixels`).
   */
  getContext(name, ...args) {
    if (name === '2d' && !this._backing && !this._backingOptOut && this._ownsPixels) {
      if (this._foreign) this._enableBackingStoreWhenReady();
      else this._enableBackingStore();
    }
    return super.getContext(name, ...args);
  }

  /**
   * The backing store for an adopted window, once there is something to build
   * it out of.
   *
   * A pixmap needs a width, a height, a depth and a visual, and an adopted
   * window knows none of them until `GetGeometry` and `GetWindowAttributes`
   * reply — so the allocation waits on `ready`. A 2d context taken in the
   * meantime draws straight to the window and re-binds itself to the pixmap
   * when it appears (the `_backing` event), which is the same path a resize
   * reallocation takes.
   */
  _enableBackingStoreWhenReady() {
    if (this._backingScheduled) return;
    this._backingScheduled = true;
    this.ready.then(() => {
      // A window destroyed before the replies arrived still settles `ready`,
      // with its geometry never filled in — there is no pixmap to make for
      // one, and CreatePixmap with an undefined size is not the way to find
      // that out.
      if (this._destroyed || this._backing || !this.width || !this.height) return;
      this._enableBackingStore();
    });
  }

  _enableBackingStore() {
    this._dirty = false;
    this._backingValid = false;
    this._presentScheduled = false;
    // Now there is a pixmap to present. Inert where the extensions are
    // missing, so this costs a window on such a server two extension queries
    // that node-x11 answers from its cache after the first.
    if (!this._presentOptOut && this._ownsPixels) {
      this.enablePresent().catch((err) => this.app.options?.onXError?.(err));
    }

    this._presentGc = this.X.AllocID();
    this.X.CreateGC(this._presentGc, this.id, { graphicsExposures: 0 });
    this._allocBacking(this.width, this.height);

    // the redraw cycle is driven by Expose interception — make sure the
    // server sends them even if user code only listens to 'draw'
    if (!(this.eventMask & x11.eventMask.Exposure)) {
      this.eventMask |= x11.eventMask.Exposure;
      // no callback: it would only buy node-x11's void-sync round trip, see setCursor
      this.X.ChangeWindowAttributes(this.id, { eventMask: this.eventMask });
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

  /**
   * The pixel the backing store's unpainted area is cleared to.
   *
   * A pixmap's contents start *undefined* — whatever was in that memory — so
   * something has to be written before it can be presented, and the same goes
   * for the region a grow adds. What that something is follows the window's
   * own `backgroundPixel`, which is exactly what the server would paint into
   * exposed area on a window with no backing store. Without one: transparent
   * for a depth-32 ARGB window, and the screen's white otherwise.
   */
  _clearColour() {
    if (this._clearPixel !== undefined) return this._clearPixel;
    const depth = this.depth || this.display.screen[0].root_depth;
    return depth === 32 ? 0 : this.display.screen[0].white_pixel;
  }

  /**
   * The window's background colour, as an X pixel value.
   *
   * A double-buffered window has two of them and they have to agree: the X
   * window attribute the server paints into exposed area, and the colour the
   * backing store clears to. Setting one and not the other is why a resize
   * could show white on a window that draws itself dark.
   *
   * The backing store's *headroom* — the area a future grow will expand
   * into, which by definition holds nothing yet — is recoloured too, so a
   * later resize does not expose the previous colour.
   */
  setBackgroundPixel(pixel) {
    this._clearPixel = pixel;
    if (this._destroyed) return this;
    if (this._clearGc) this.X.ChangeGC(this._clearGc, { foreground: pixel });
    // The window attribute half is only ours to write on a window whose
    // pixels are ours — an adopted one has to have said so (see _ownsPixels).
    if (this._ownsPixels) {
      // no callback: it would only buy node-x11's void-sync round trip, see setCursor
      this.X.ChangeWindowAttributes(this.id, { backgroundPixel: pixel });
    }
    const backing = this._backing;
    if (backing && this._clearGc) {
      const rects = [];
      if (backing.width > this.width) {
        rects.push(this.width, 0, backing.width - this.width, backing.height);
      }
      if (backing.height > this.height) {
        rects.push(0, this.height, this.width, backing.height - this.height);
      }
      if (rects.length) this.X.PolyFillRectangle(backing.id, this._clearGc, rects);
    }
    return this;
  }

  // grow-only backing pixmap (re)allocation, with headroom (see
  // BACKING_GRANULARITY). What is already drawn is carried across and only
  // the region the grow adds is cleared (see _clearColour) — clearing the
  // whole pixmap made the *entire* window flash the clear colour between a
  // resize and the redraw, not just the new strip.
  _allocBacking(w, h) {
    const cur = this._backing;
    if (cur && cur.width >= w && cur.height >= h) return;
    const roundUp = (v) => Math.ceil(v / BACKING_GRANULARITY) * BACKING_GRANULARITY;
    const newW = roundUp(Math.max(w, cur ? cur.width : 0));
    const newH = roundUp(Math.max(h, cur ? cur.height : 0));
    const depth = this.depth || this.display.screen[0].root_depth;
    const pixmap = new Pixmap(this.app, {
      parent: this,
      width: newW,
      height: newH,
      depth,
      // it holds this window's pixels, so it is read through this window's
      // visual — a pixmap has none of its own (issue #295)
      visual: this.visualId
    });
    if (!this._clearGc) {
      this._clearGc = this.X.AllocID();
      this.X.CreateGC(this._clearGc, pixmap.id, {
        foreground: this._clearColour(),
        graphicsExposures: 0
      });
    }
    if (cur) {
      // The new pixmap is strictly larger, so the old content lands at the
      // same coordinates and only the L-shaped remainder is new.
      this.X.CopyArea(cur.id, pixmap.id, this._clearGc, 0, 0, 0, 0, cur.width, cur.height);
      const rects = [];
      if (newW > cur.width) rects.push(cur.width, 0, newW - cur.width, newH);
      if (newH > cur.height) rects.push(0, cur.height, cur.width, newH - cur.height);
      if (rects.length) this.X.PolyFillRectangle(pixmap.id, this._clearGc, rects);
    } else {
      this.X.PolyFillRectangle(pixmap.id, this._clearGc, [0, 0, newW, newH]);
    }
    if (cur) cur.destroy();
    this._backing = pixmap;
    this._backingValid = false;
    // contexts re-bind their pictures to the new pixmap
    this.emit('_backing');
  }

  _handleExpose(ev) {
    if (this._backingValid) {
      // an expose can arrive after the connection started closing, and this
      // runs inside the event dispatch where a throw has no caller (#321)
      safeRelease(this.X, () => {
        this.X.CopyArea(this._backing.id, this.id, this._presentGc, ev.x, ev.y, ev.x, ev.y, ev.width, ev.height);
      });
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
   * and requestAnimationFrame callbacks are delivered in "frames". What ends
   * a frame — and so what paces the next one — is one of two signals:
   *
   *  - the display, on a window presenting through the Present extension: the
   *    CompleteNotify for the frame's PresentPixmap, which the server sends
   *    when it has executed the copy at a vertical blank. Frames then run at
   *    the output's own rate, phase-locked to it, whatever that rate is.
   *  - a fence, everywhere else: a cheap request with a reply
   *    (GetInputFocus) sent after each frame; X processes requests in order,
   *    so its reply confirms the server consumed everything the frame drew.
   *
   * Either way at most one is outstanding, which is what bounds the work in
   * flight: on a slow connection frames degrade to one per round-trip instead
   * of queueing a trail of stale updates.
   *
   * A timer backs both up. Under the fence it is the rate limit — at most one
   * frame per `frameInterval` ms, so a fast local server isn't asked to redraw
   * at input-device rate. Under the vblank clock the display is the rate
   * limit, and the timer only covers frames that drew nothing: those produce
   * no present, so no completion is coming and something else has to run the
   * next frame (`refreshInterval` is the period there, so a compute-only
   * animation loop still runs at display rate).
   *
   * Discrete events (mousedown, keydown, ...) bypass the timer for latency:
   * the first blit after a quiet moment goes out with the handler's own
   * requests. Their blits are still bounded, by whichever clock is running and
   * by a minimum inter-blit interval (`frameInterval` again) — see _present().
   * Without that interval a stream of discrete events blits at round-trip
   * rate, which on a local server is several hundred per second, and under a
   * compositor every blit is a recomposite. The vblank clock has no need of
   * it: a present outstanding already means the display has not caught up.
   */
  _scheduleFrame() {
    const f = this._frame;
    if (f.scheduled || f.inFlight || f.presentInFlight || f.timer) return;
    f.scheduled = true;
    setImmediate(() => {
      f.scheduled = false;
      // gates may have been armed after this got scheduled (work queued
      // from inside a running frame, e.g. a rAF loop re-registering) —
      // the completion / fence reply / timer expiry will reschedule then
      if (f.inFlight || f.presentInFlight || f.timer) return;
      this._runFrame();
    });
  }

  /**
   * Minimum ms between paced frames, and between blits.
   *
   * Under the vblank clock an *explicit* value is a cap on top of the
   * display's rate — `frameInterval: 33` renders at 30fps on any output,
   * which is a real ask on battery — while the default must not cap anything,
   * or a 165Hz display would be held to the 62.5fps that 16ms implies.
   * Assigning the property counts as explicit, which is why this is an
   * accessor: `wnd.frameInterval = 33` has to mean the same as passing it.
   */
  get frameInterval() {
    return this._frameInterval;
  }

  set frameInterval(ms) {
    this._frameInterval = ms;
    this._frameIntervalExplicit = true;
  }

  /**
   * Take the connection's measured default, if this window is still on the
   * guess. Called when the RandR probe answers, which is normally a few
   * round trips after the first window was built — see App#_probeRefreshRate.
   */
  _adoptDefaultFrameInterval(ms) {
    if (this._frameIntervalExplicit || this._destroyed) return;
    this._frameInterval = ms;
  }

  /**
   * Which clock is ending this window's frames right now: 'present' when the
   * display is, 'fence' when the server round-trip is. Assignable with
   * 'auto' (prefer the display) or 'fence' (never use it).
   */
  get frameClock() {
    return this._clockOnPresent() ? 'present' : 'fence';
  }

  set frameClock(mode) {
    this._frameClockPref = mode === 'present' ? 'auto' : mode;
    if (this._frameClockPref !== 'fence') this._selectPresentInput();
  }

  /**
   * Is the display ending frames on this window, rather than the socket?
   *
   * Needs the Present path up (there is no completion event without it) and
   * the frame sync the caller may have turned off — `frameSync: false` asks
   * for pacing that never waits on the server, and a completion is the
   * strongest wait there is. `_clockStalled` is the watchdog's latch: a
   * completion that never came drops the window back to the fence until one
   * does, so a clock that stops cannot stop the window with it.
   *
   * `_presentFlipped` is the one-way door — a server that has flipped a copy
   * present is off this path for good, and its blits no longer produce the
   * completions the clock is made of.
   */
  _clockOnPresent() {
    return (
      this._frameClockPref !== 'fence' &&
      this._frameSyncEnabled &&
      !this._clockStalled &&
      !this._presentFlipped &&
      !!this._presentExt &&
      !!this._presentEid
    );
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
    // after the flush: the frame's motion has been delivered, so what the
    // server is asked for now is what happened since
    if (this._hintRearm) this._rearmMotionHint();
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
    // A frame that presented is already clocked — its completion ends it. One
    // that drew nothing has to fall back to the timer, or nothing would ever
    // run the next frame.
    if (!this._clockOnPresent()) this._armFence();
    this._armTimer();
  }

  /**
   * Deliver one named event: buffer it if its kind coalesces, and otherwise
   * flush what is buffered before emitting, so handlers see events in the
   * order they happened (a drag sees the move, then the up).
   *
   * Every source ends here — the core event stream, the XI2 one, and the
   * `wheel` both of them derive.
   */
  _deliverEvent(name, ev) {
    if (this._coalesce && xevents.coalesce[name]) {
      this._enqueueCoalesced(name, ev);
      return;
    }
    this._flushCoalesced();
    if (name === 'resize') this._tagResize(ev);
    this.emit(name, ev);
    // a WM_DELETE_WINDOW ClientMessage is the window manager *asking*, and
    // 'close' is that question in a form an application can answer
    if (name === 'message') {
      this._emitCloseRequest(ev);
      this._handleSyncRequest(ev);
    }
    // anything drawn during the handlers becomes visible in one blit
    if (this._dirty) this._present();
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
    } else if (xevents.coalesce[name] === 'accumulate') {
      // scroll distance adds up, and the frame's scroll happened wherever the
      // pointer ended up. The first event of the frame carries the sum, the
      // way the union path grows its first event's rectangle.
      prev.coalesced.push(ev);
      prev.deltaX += ev.deltaX;
      prev.deltaY += ev.deltaY;
      prev.x = ev.x;
      prev.y = ev.y;
      prev.rootx = ev.rootx;
      prev.rooty = ev.rooty;
      prev.time = ev.time;
      prev.buttons = ev.buttons;
      prev.smooth = ev.smooth;
      prev.source = ev.source;
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
        this._frameEnded();
      });
    });
  }

  /**
   * Route this window's Generic Events for one extension to `sink`, ahead of
   * the built-in Present handling.
   *
   * The direct GL context is the caller: its swap chain selects Present's
   * CompleteNotify and IdleNotify for itself, because it needs to know when a
   * *specific* buffer came back — a question the window's own present path,
   * which owns exactly one grow-only pixmap, never has to ask. Pass `null` to
   * unregister.
   *
   * @param {number} majorOpcode the extension whose events to route
   * @param {{handleEvent: (ev: object) => void}|null} sink
   */
  _setGenericEventSink(majorOpcode, sink) {
    this._geSink = sink;
    this._geSinkOpcode = sink ? majorOpcode : 0;
  }

  /**
   * Ask for XI2 device events on this window, and deliver them as the events
   * ntk already has names for.
   *
   * What this buys is the wheel: the core protocol reports a scroll as a
   * click of button 4/5/6/7, so a touchpad's two-finger gesture arrives as
   * whole notches however finely the hardware measured it. XI2 carries the
   * same gesture as a scroll *valuator*, and `wheel` then reports fractions
   * of a notch (see docs/window.md "Wheel and smooth scrolling"). Touch and
   * per-device input come with it — `ev.deviceId`/`ev.sourceId` are on every
   * translated event, and the core protocol has no way to say either.
   *
   * Opt-in per window, via `createWindow({ xi2: true })` or this call,
   * because selecting XI2 changes what the server sends: a window that has
   * not asked keeps costing exactly what it did before.
   *
   * **Selecting XI2 replaces the core events of the same types.** The server
   * delivers an event to a client once, and an XI2 selection wins, so
   * `selectXI2(['Motion'])` means this window's `mousemove` is built from
   * `XIMotion` from then on. It carries the same fields (plus `ev.xi2`,
   * the device ids and sub-pixel `preciseX`/`preciseY`), so handlers do not
   * change — but a window that selects XI2 KeyPress and nothing else still
   * gets core motion, and mixing the two per-type is what the `types`
   * argument is for.
   *
   * The emulated wheel buttons are dropped once the valuators are flowing:
   * the server sends both halves of a smooth scroll (the axis and a button
   * 4-7 click flagged `PointerEmulated`) so that clients which cannot read
   * valuators still scroll, and delivering both would count every notch
   * twice. So an app that opts in reads `wheel`, not `mousedown` on button 4.
   *
   * @param {string[]|string} [types] XI2 event type names —
   *   `Motion`, `ButtonPress`, `ButtonRelease`, `KeyPress`, `KeyRelease`,
   *   `TouchBegin`, `TouchUpdate`, `TouchEnd`. An empty array deselects.
   * @param {{deviceId?: number}} [options] which device to select for,
   *   defaulting to every master device (the virtual pointer and keyboard
   *   the user is actually driving). A selection is per device, so a
   *   selection on one device id does not replace one made on another.
   * @returns {Promise<boolean>} false where the server has no XI2 — in which
   *   case nothing changed and the window keeps its core events, `wheel`
   *   included, at notch granularity
   */
  selectXI2(types = DEFAULT_XI2_EVENTS, { deviceId } = {}) {
    const names = normalizeXI2Types(types);
    return Promise.all([this.app.xinput(), this.app.inputDevices()]).then(([XI, devices]) => {
      if (!XI || !XI.xi2 || this._destroyed) return false;
      const target = deviceId ?? XI.AllMasterDevices;
      if (!names.length) {
        safeRelease(this.X, () => XI.XISelectEvents(this.id, { deviceId: target, mask: 0 }));
        this._geHandlers.delete(XI.majorOpcode);
        this._xi2 = null;
        return true;
      }
      // DeviceChanged rides along uninvited: it is the only announcement that
      // a master pointer's valuators are now some other slave's, which
      // invalidates both the axis map and the accumulators built on it. Its
      // body is undecoded, and the device id is all this needs from it.
      safeRelease(this.X, () =>
        XI.XISelectEvents(this.id, { deviceId: target, mask: [...names, 'DeviceChanged'] })
      );
      this._xi2 = {
        ext: XI,
        deviceId: target,
        types: names,
        // evtype -> the ntk event it becomes, resolved through the extension's
        // own table rather than hardcoded numbers
        byType: new Map(names.map((name) => [XI.EventType[name], xi2EventName[name]])),
        scroll: this._xi2?.scroll ?? new ScrollTracker(),
        axes: new Map(devices.map((device) => [device.deviceId, scrollAxes(device)])),
        // whether the core wheel buttons are now redundant: a scroll-capable
        // device plus a selection that carries its valuators
        smooth: names.includes('Motion') && devices.some((device) => scrollAxes(device).size > 0)
      };
      this._geHandlers.set(XI.majorOpcode, (ev) => this._handleXI2Event(ev));
      return true;
    });
  }

  /**
   * One XI2 Generic Event: scroll valuators become `wheel`, everything else
   * becomes the core-shaped event it stands in for.
   */
  _handleXI2Event(ev) {
    const xi2 = this._xi2;
    if (!xi2) return;
    if (ev.evtype === xi2.ext.EventType.DeviceChanged) {
      this._refreshXI2Devices(ev.deviceId);
      return;
    }
    const name = xi2.byType.get(ev.evtype);
    if (!name) return;

    const base = toNtkEvent(name, ev);
    base.window = this;
    base.target = this;

    if (name === 'mousemove') {
      // a scroll is a Motion carrying scroll axes; the pointer itself did not
      // move, so it is a wheel event and not also a mouse move — including
      // the first one, which has nothing to subtract from yet
      const scroll = xi2.scroll.delta(ev, this._xi2Axes(ev));
      if (scroll) {
        if (scroll.moved) {
          this._deliverEvent('wheel', wheelEvent(base, scroll.deltaX, scroll.deltaY, 'valuator'));
        }
        return;
      }
    }
    if (name === 'mousedown' || name === 'mouseup') {
      const wheelButton = WHEEL_BUTTONS[ev.detail];
      // the click the server emulated for clients that cannot read valuators
      // — we can, and the valuator half of the same scroll is already on its
      // way, so this one is noise
      if (wheelButton && ev.flags & POINTER_EMULATED) return;
      if (wheelButton && name === 'mousedown') {
        const wheel = wheelEvent({ ...base }, wheelButton[0], wheelButton[1], 'button');
        this._deliverEvent('wheel', wheel);
      }
    }
    if (name === 'keydown' || name === 'keyup') {
      const key = decodeKey(this.X.keycode2keysyms[ev.detail], base.buttons);
      if (key) {
        base.keysym = key.keysym;
        base.baseKeysym = key.baseKeysym;
        base.group = key.group;
        if (key.codepoint !== undefined) base.codepoint = key.codepoint;
      }
    }
    this._deliverEvent(name, base);
  }

  /** This window's scroll-axis map for the device an event came from. */
  _xi2Axes(ev) {
    return this._xi2?.axes.get(ev.deviceId);
  }

  /**
   * A master device's slave changed: re-read what its axes are now, and drop
   * the accumulators, because the values arriving next belong to a different
   * device and subtracting across the switch is the jump seeding exists to
   * avoid.
   */
  _refreshXI2Devices(deviceId) {
    const xi2 = this._xi2;
    if (!xi2) return;
    xi2.scroll.reset(deviceId);
    this.app.inputDevices({ refresh: true }).then(
      (devices) => {
        if (this._xi2 !== xi2) return; // deselected or reselected meanwhile
        xi2.axes = new Map(devices.map((device) => [device.deviceId, scrollAxes(device)]));
        xi2.smooth =
          xi2.types.includes('Motion') && devices.some((device) => scrollAxes(device).size > 0);
      },
      () => {}
    );
  }

  /**
   * Present's events, which are the ones the core event table cannot name:
   * they arrive as X Generic Events (type 35), carrying an extension opcode
   * and a sub-type instead of an event code.
   */
  _handlePresentEvent(ev) {
    const P = this._presentExt;
    if (!P || ev.evtype !== P.events.CompleteNotify) return;
    if (ev.kind !== P.CompleteKind.Pixmap) return; // not a frame of ours
    if (ev.mode === P.CompleteMode.Flip) {
      // The server took the pixmap for scanout instead of copying it, and
      // keeps it until some later present — but ntk has one grow-only backing
      // pixmap and is about to draw into it, which would now paint the screen
      // directly. Option.Copy is passed on every present precisely so this
      // cannot happen (presentproto: "'pixmap' will be idle ... as soon as the
      // operation occurs"), so a server doing it anyway is one whose Present
      // path we cannot use at all.
      this._presentFlipped = true;
      this.app.options.onXError?.(
        new Error(
          'ntk: the X server flipped a present sent with Option.Copy, which leaves it ' +
            "owning the window's backing pixmap — falling back to CopyArea blits"
        )
      );
      this._stallClock();
      return;
    }
    this._onPresentComplete(ev);
  }

  /**
   * A frame reached the display: the server executed the copy, at a vblank.
   *
   * This is `_armFence`'s reply callback with a better trigger behind it. The
   * fence proves the server *read* the frame's requests; this proves it *ran*
   * them, on the output, which is both a stronger flow-control signal and the
   * moment the backing pixmap is ours to draw into again.
   */
  _onPresentComplete(ev) {
    const f = this._frame;
    const now = performance.now();
    this._clearStallWatchdog();
    // completions are arriving again, whatever the watchdog concluded before
    this._clockStalled = false;
    if (!f.presentInFlight) return; // a completion we are not clocking on
    f.presentInFlight = false;
    this.frameLatency = now - f.presentAt;
    this._sampleRefresh(ev, now);
    this._frameEnded();
  }

  /**
   * What both clocks do when a frame ends: send the blit that was held back
   * behind it, then run the next frame if anything is waiting for one.
   */
  _frameEnded() {
    const f = this._frame;
    if (this._presentPending) {
      // a blit deferred while the frame was outstanding: show it as soon as
      // the pacing allows, which under the vblank clock is now
      this._present();
    }
    if ((f.pending.size || f.rafCbs.length || f.needsRedraw) && !f.timer) this._scheduleFrame();
  }

  /**
   * Learn the display's refresh period from the frame that just landed.
   *
   * Two completions give it without asking anyone: `ust` is when the
   * presentation happened (microseconds, on the server's clock) and `msc`
   * counts the frames between them, so their ratio is one vblank. Nothing is
   * configured, nothing is queried, and it follows the window to another
   * monitor or through a mode change on its own — where a RandR lookup would
   * need change-tracking to keep up.
   *
   * Only differences are read from the server clock, never an absolute time,
   * and a sample is believed only if it lands in the range a refresh rate can
   * be in — which is also what keeps a window the compositor has throttled to
   * a frame a second from being mistaken for a 1Hz display.
   */
  _sampleRefresh(ev, now) {
    const prev = this._lastComplete;
    this._lastComplete = { msc: ev.msc, ust: ev.ust, at: now };
    if (!prev || !(ev.msc > prev.msc)) return;
    const frames = ev.msc - prev.msc;
    // Frames the display went through without one of ours. Counted from the
    // msc, which is the only place the information exists: where the counter
    // tracks presents rather than vblanks the gap is always 1 and a miss is
    // simply not observable, and reporting nothing beats inferring it from
    // elapsed time on a server whose timing is synthetic to begin with.
    //
    // Only across a gap short enough to have been a frame at all. A window
    // that sat idle between two clicks also let the counter run, and that is
    // not a dropped frame; past a tenth of a second the two are anyway
    // indistinguishable, and under-reporting is the right way for a
    // diagnostic to be wrong.
    if (now - prev.at <= MAX_REFRESH_INTERVAL) this.droppedFrames += frames - 1;
    // Only a single-frame gap measures a frame's length. A longer one spans a
    // miss, and dividing it out assumes the msc advanced for the same reason
    // in each — true of a hardware counter, false of one driven off a timer,
    // where it makes a late frame look like a *faster* display.
    if (frames !== 1) return;
    // ust is the server's clock and local receipt is ours; they measure the
    // same interval, so the local one stands in when ust is not usable (a
    // synthesized msc can carry a ust that does not move with it)
    const byUst = (ev.ust - prev.ust) / 1000;
    const sample = byUst >= MIN_REFRESH_INTERVAL ? byUst : now - prev.at;
    if (!(sample >= MIN_REFRESH_INTERVAL && sample <= MAX_REFRESH_INTERVAL)) return;
    const samples = this._refreshSamples;
    samples.push(sample);
    if (samples.length > REFRESH_SAMPLES) samples.shift();
    const sorted = [...samples].sort((a, b) => a - b);
    this.refreshInterval = sorted[Math.floor(REFRESH_QUANTILE * (sorted.length - 1))];
  }

  /**
   * Guarantee that a frame ends even if its completion does not arrive.
   *
   * A fence is a request with a reply and the server always sends one. A
   * completion is an event about work the server may never do: an unmapped
   * window, a compositor changing its mind about redirection, or simply a
   * server whose Present is a stub. `_presentPending` has exactly one wakeup,
   * so a completion that never comes would be a window that never updates
   * again — a permanently stale window, which is the trap #195 hit.
   *
   * See STALL_TIMEOUT for why the deadline is measured in seconds rather than
   * in frames: a slow answer is usually the display being honest about how
   * often this window is worth drawing.
   */
  _armStallWatchdog() {
    const f = this._frame;
    if (f.stallTimer) return;
    const timeout = this._lastComplete ? STALL_TIMEOUT : STALL_TIMEOUT_FIRST;
    f.stallTimer = setTimeout(() => {
      f.stallTimer = null;
      if (f.presentInFlight) this._stallClock();
    }, timeout);
    if (typeof f.stallTimer.unref === 'function') f.stallTimer.unref();
  }

  _clearStallWatchdog() {
    const f = this._frame;
    if (!f.stallTimer) return;
    clearTimeout(f.stallTimer);
    f.stallTimer = null;
  }

  /**
   * Give up on the display as a clock, for now. The fence takes over, and the
   * next completion to arrive hands it back (see _onPresentComplete) — a
   * window that is merely unmapped for a while must not be left on the slower
   * clock forever.
   */
  _stallClock() {
    const f = this._frame;
    this._clockStalled = true;
    f.presentInFlight = false;
    this._clearStallWatchdog();
    // nothing else needs re-arming: an idle window wants no clock, and the
    // frame _frameEnded schedules will arm the fence on its way out
    this._frameEnded();
  }

  /**
   * The timer gate, whose period depends on what it is standing in for.
   *
   * Under the fence it is the rate limit and `frameInterval` is the period.
   * Under the vblank clock it is the fallback for a frame that presented
   * nothing — there is no completion coming for a frame that drew nothing —
   * so the period is the display's, and a frame that *did* present arms no
   * timer at all: the completion is closer and more accurate than any timer,
   * and arming one would only cap the rate the display just set. An explicit
   * `frameInterval` is honoured in both, since a cap the caller asked for
   * applies whatever ends the frame.
   */
  _armTimer() {
    const f = this._frame;
    if (f.timer) return;
    let period = this.frameInterval;
    if (this._clockOnPresent() && !this._frameIntervalExplicit) {
      if (f.presentInFlight) return;
      period = this.refreshInterval ?? DEFAULT_FRAME_INTERVAL;
    }
    if (!(period > 0)) return;
    f.timer = setTimeout(() => {
      f.timer = null;
      if (f.pending.size || f.rafCbs.length || f.needsRedraw) this._scheduleFrame();
    }, period);
    if (typeof f.timer.unref === 'function') f.timer.unref();
  }

  /**
   * @param {boolean} [windowAlive] false when the server has already destroyed
   *   the window (a DestroyNotify), which takes its Present event context with
   *   it — deleting one explicitly then is a request against a window id that
   *   no longer exists, i.e. a BadWindow for the app's error hook to explain.
   */
  _teardownFrame(windowAlive = true) {
    const f = this._frame;
    if (f.timer) {
      clearTimeout(f.timer);
      f.timer = null;
    }
    if (f.presentTimer) {
      clearTimeout(f.presentTimer);
      f.presentTimer = null;
    }
    this._clearStallWatchdog();
    if (this._presentEid) {
      const eid = this._presentEid;
      const P = this._presentExt;
      this._presentEid = 0;
      f.presentInFlight = false;
      safeRelease(this.X, () => {
        // an empty mask deletes the event context (presentproto)
        if (windowAlive && P) P.SelectInput(eid, this.id, P.EventMask.NoEvent);
        this.X.ReleaseID(eid);
      });
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
    // a window with no frames left has nothing to send the poll from
    this._hintRearm = false;
    this._hintLast = null;
  }

  /**
   * DOM-style requestAnimationFrame: `cb(now)` runs on this window's next
   * paced frame — one per vertical blank where the display is the clock (see
   * _clockOnPresent), otherwise at most once per `frameInterval` ms — and
   * always with at most one frame outstanding, so animation loops adapt to
   * the output's rate and to connection latency instead of flooding either.
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
   * Whether a blit this window already owes is still waiting to go out —
   * because the last frame is unanswered (its fence unreplied, or its present
   * not yet on the display), or because a present is deferred behind the
   * minimum inter-blit interval.
   *
   * The one bit of frame-clock state worth publishing, because it is the
   * difference between the two ways a toolkit can answer a discrete input.
   * Drawing the response inside the event handler costs a frame less latency:
   * the blit goes out with the handler's own requests (see the `_present()`
   * at the end of the event dispatch) instead of waiting for the next paced
   * frame. Drawing it when a blit is already queued costs a frame's *work* for
   * nothing: the paint lands in the same backing store and coalesces into the
   * present already pending, so only the last one is ever seen. So `false`
   * means "draw it now", `true` means "leave it to the frame clock" — which
   * is how a burst of discrete events (a spun wheel) paints its first notch
   * immediately and folds the rest into one catch-up frame.
   *
   * Both gates have to be reported, not just the fence. The fence is the one
   * that bites on a slow connection. The minimum inter-blit interval (#195) is
   * the one that bites on a fast local server, where the fence for a notch is
   * answered well before the next notch is even read, and what actually holds
   * the burst back is the interval. Reporting only the fence there answers
   * "draw it now" to every notch — the precise work this gate exists to skip.
   *
   * `false` whenever nothing gates blits at all: `frameSync: false` sends no
   * fence and takes the vblank clock with it (a completion is a wait on the
   * server too), and `frameInterval: 0` keeps no interval, so a caller who
   * asked for both gets the unpaced behaviour those options ask for.
   */
  frameInFlight() {
    return this._frame.inFlight || this._frame.presentInFlight || this._presentPending;
  }

  _present() {
    if (!this._backing) return;
    const f = this._frame;
    const wait = this._presentWait();
    if (f.inFlight || f.presentInFlight || wait > 0) {
      // the server hasn't confirmed the previous frame yet, the display hasn't
      // shown it, or the last blit was too recent — defer, leaving a wakeup
      this._deferPresent(wait);
      return;
    }
    this._presentNow();
    // the fence is what ends this blit's frame unless the display is doing
    // it — which is decided by _presentNow, since a blit that fell back to
    // CopyArea gets no completion however the clock is configured
    if (!f.presentInFlight) this._armFence();
  }

  /**
   * How long until the next blit may go out; 0 when it may go now.
   *
   * The gate is `frameInterval`, the same knob that paces frames, so
   * `frameInterval: 0` keeps the old fence-only behaviour — a caller who asked
   * for no timer gate gets none here either.
   *
   * The vblank clock needs no such gate and must not inherit the default one:
   * an outstanding present already means the display has not caught up, and
   * that is a truer statement of the same thing than any interval. Holding a
   * click's repaint for a 16ms default on a 165Hz output is exactly the
   * latency this gate was careful not to add. An explicit interval still
   * applies — a cap the caller asked for is a cap.
   */
  _presentWait() {
    if (this._clockOnPresent() && !this._frameIntervalExplicit) return 0;
    const min = this.frameInterval;
    if (!(min > 0)) return 0;
    const since = performance.now() - this._frame.lastPresentAt;
    return since >= min ? 0 : min - since;
  }

  /**
   * Hold a blit back, and guarantee it still happens.
   *
   * This is the only place `_presentPending` is set, because every deferral has
   * to leave a wakeup behind: the end of the frame we are waiting on (its
   * fence reply, or its completion), this timer when the interval is what we
   * are waiting on. Nothing else reschedules a present — `_scheduleFrame()`
   * bails while a frame timer is armed, and no reschedule condition
   * (`_frameEnded`, `_armTimer`'s callback) looks at the present. Without the
   * timer the last blit of a burst would simply never go out, leaving stale
   * pixels on screen.
   */
  _deferPresent(wait) {
    this._presentPending = true;
    if (wait <= 0) return; // waiting on the frame: its end blits this
    const f = this._frame;
    if (f.presentTimer) return; // already armed
    f.presentTimer = setTimeout(() => {
      f.presentTimer = null;
      if (!this._presentPending && !this._dirty) return; // someone blitted it
      const again = this._presentWait();
      if (again > 0) return this._deferPresent(again); // a paced frame re-stamped
      if (f.inFlight || f.presentInFlight) return; // the frame's end is closer
      this._presentNow();
      if (!f.presentInFlight) this._armFence();
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
    // Memoized because `createWindow({ present: true })` starts this and
    // `await wnd.enablePresent()` is the documented way to find out whether it
    // took — doing both is the normal thing to write, and two runs in flight
    // at once would each allocate an update region, orphaning one on the
    // server for the life of the window.
    if (this._presentPromise) return this._presentPromise;
    const X = this.X;
    const need = (name) =>
      new Promise((resolve) => X.require(name, (err, ext) => resolve(err ? null : ext)));
    this._presentPromise = Promise.all([need('present'), need('fixes')]).then(([present, fixes]) => {
      if (!present || !fixes || this._destroyed) return this; // stay on CopyArea
      this._updateRegion = X.AllocID();
      safeRelease(X, () => fixes.CreateRegion(this._updateRegion, []));
      this._presentExt = present;
      this._fixesExt = fixes;
      this._geHandlers.set(present.majorOpcode, (ev) => this._handlePresentEvent(ev));
      this._selectPresentInput();
      return this;
    });
    return this._presentPromise;
  }

  /**
   * Ask for the completion events the vblank clock runs on.
   *
   * CompleteNotify only; IdleNotify would say the same thing twice, since
   * every present ntk sends carries Option.Copy and the spec makes such a
   * pixmap idle "as soon as the operation occurs" — the moment the completion
   * reports. Nothing is selected for a window pinned to the fence, so a
   * caller who opted out is not sent events it will not read.
   */
  _selectPresentInput() {
    const P = this._presentExt;
    if (!P || this._presentEid || this._destroyed) return;
    if (this._frameClockPref === 'fence' || !this._frameSyncEnabled) return;
    const eid = this.X.AllocID();
    // the id is only recorded once the request is really on its way: the
    // clock's whole contract is that a completion will arrive, and a
    // selection that never left (a connection closing under us) promises
    // nothing. Failing this way leaves the window on the fence, which works.
    safeRelease(this.X, () => {
      P.SelectInput(eid, this.id, P.EventMask.CompleteNotify);
      this._presentEid = eid;
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
    if (this._presentFlipped) return false; // see _handlePresentEvent
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
    const f = this._frame;
    f.lastPresentAt = performance.now();
    // Present sends the exact rectangles in one request, so the bounding-box
    // collapse — which trades pixels for fewer requests — has nothing to buy
    if (this._presentWithExtension(clamped)) {
      // This frame is now the display's to end. Only a present through the
      // extension can be: a CopyArea reports nothing back, so a window that
      // fell back to it must keep the fence even with the clock configured.
      if (this._clockOnPresent()) {
        f.presentInFlight = true;
        f.presentAt = f.lastPresentAt;
        this._armStallWatchdog();
      }
    } else {
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
   * Interned atoms are cached per connection — which is true because App
   * makes it true, see `_isolateAtoms` — so a repeated call costs no round
   * trip. Same deferred-chain hazards as setTitle: by the
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
      const os = builtin('node:os');
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
      // EWMH 7.7: delivered to the root with the substructure mask, so the
      // window manager watching there sees it, but about this window
      await this.sendClientMessage(
        '_NET_WM_STATE',
        [
          mode,
          ids[0],
          ids[1] ?? 0,
          1 // source indication: a normal application, not a pager
        ],
        {
          target: root,
          mask: x11.eventMask.SubstructureRedirect | x11.eventMask.SubstructureNotify
        }
      );
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
    // resolved first: an unknown name has to throw whether or not the memo
    // below short-circuits the request
    const cursor = nameOrShape == null ? 0 : this.app.cursors.get(nameOrShape);
    if (cursor === this._currentCursor) return this;
    this._currentCursor = cursor;
    safeRelease(this.X, () => {
      // no callback, deliberately: node-x11 guarantees a callback on a *void*
      // request eventually fires, and buys that by injecting a GetInputFocus
      // round trip when nothing else in the tick expects a reply (node-x11
      // issue #85). A callback that ignores its argument costs that round trip
      // per cursor change and buys nothing — an X error reaches
      // `client.emit('error')`, and so app's onXError hook, either way.
      this.X.ChangeWindowAttributes(this.id, { cursor });
    });
    return this;
  }

  /**
   * Trade motion events for round trips: ask the server to report the pointer
   * moving *once*, and then wait to be asked where it went.
   *
   * PointerMotionHint is a two-party protocol. With it selected the server
   * may send a single MotionNotify carrying detail NotifyHint and then say
   * nothing more about the pointer until the client asks — so a window that
   * only sets the bit hears about one move and then silence (issue #319).
   * ntk holds up the other end: a hinted move is delivered with the position
   * it carries, and the frame it lands in sends the QueryPointer that lets
   * the server speak again (see _rearmMotionHint).
   *
   * What that buys, and what it costs, are the same thing. Motion stops being
   * paced by the input device and starts being paced by the connection: one
   * event per round trip instead of one per hardware sample, which is a large
   * saving on a link where bytes are scarce — X over ssh, a tunnel, a slow
   * network — and no saving at all on a local socket, where the poll costs
   * more bytes than the events it replaced. It also means a handler acts on a
   * position that is up to one round trip old. Reach for it when bandwidth is
   * the problem; leave it alone when latency is.
   *
   * Two things it is not:
   *
   *   - not a substitute for selecting motion. The hint modifies
   *     PointerMotion, it does not imply it — a window with no `mousemove`
   *     listener and no PointerMotion in its mask receives nothing either way.
   *   - not an XI2 control. A window that called `selectXI2(['Motion'])` is
   *     off the core motion stream entirely (see lib/xi2.js), and the core
   *     hint has nothing left to thin.
   */
  setMouseHintOnly(isOn) {
    if (isOn && !(this.eventMask & x11.eventMask.PointerMotionHint)) {
      this.eventMask |= x11.eventMask.PointerMotionHint;
    } else if (!isOn && this.eventMask & x11.eventMask.PointerMotionHint) {
      this.eventMask &= ~x11.eventMask.PointerMotionHint;
      // the server will report motion on its own again, so no frame owes it a
      // question. A poll already in flight is left alone: its answer is a
      // real position, and it is deduped against the last one like any other.
      this._hintRearm = false;
    } else {
      return this;
    }
    // no callback: it would only buy node-x11's void-sync round trip, see setCursor
    this.X.ChangeWindowAttributes(this.id, { eventMask: this.eventMask });
    return this;
  }

  /**
   * Answer a NotifyHint: ask where the pointer is, which is what re-arms the
   * server, and deliver the answer if it moved somewhere no event reported.
   *
   * The reply is not redundant with the hint that asked for it. Between the
   * hint being generated and the server processing this request the pointer
   * may have moved again, and that motion produces no event — it is exactly
   * what the hint suppressed. Dropped, the last position of a gesture that
   * ends mid-flight is lost and the window's idea of where the pointer is
   * stays wrong until it moves again. So the poll's position is delivered as
   * a motion event when it differs from the last one delivered, and nothing
   * is emitted when the pointer sat still.
   *
   * One poll at a time, and one per frame: a burst of motion cannot queue a
   * round trip each, and the flag stays raised if a poll is already out, so
   * the next frame picks it up.
   */
  _rearmMotionHint() {
    if (this._hintPollPending) return;
    this._hintRearm = false;
    if (this._destroyed || connectionGone(this.X)) return;
    this._hintPollPending = true;
    const time = this._hintTime;
    this.X.QueryPointer(this.id, (err, pointer) => {
      this._hintPollPending = false;
      if (err || this._destroyed || connectionGone(this.X)) return;
      // the pointer is on another screen: `child` and the window-relative
      // coordinates are zero by protocol, not a position (core QueryPointer)
      if (!pointer.sameScreen) return;
      const last = this._hintLast;
      if (last && last.x === pointer.childX && last.y === pointer.childY) return;
      this._hintLast = { x: pointer.childX, y: pointer.childY };
      this._deliverEvent('mousemove', {
        type: 6,
        name: 'MotionNotify',
        // the poll has no timestamp of its own — QueryPointer's reply carries
        // no time — so the event is stamped with the hint that prompted it
        time,
        keycode: 0,
        root: pointer.root,
        wid: this.id,
        child: pointer.child,
        rootx: pointer.rootX,
        rooty: pointer.rootY,
        x: pointer.childX,
        y: pointer.childY,
        buttons: pointer.keyMask,
        sameScreen: pointer.sameScreen,
        // built from a reply rather than read off the wire, the way a paced
        // window's redraw events are
        synthetic: true,
        window: this,
        target: this
      });
    });
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
        this.X.GetWindowAttributes(this.id, (err, attrs) => {
          if (err) return reject(err);
          // the visual names the picture format (see `visualId`), and this
          // reply is the only place the server ever states it
          this.visualId = attrs.visual;
          resolve(attrs);
        })
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
   *
   * A mask this connection already holds is a request that would change
   * nothing, so it resolves without one — `eventMask` is what this
   * connection selected and nothing else adds to it behind the caller's
   * back. It resolves rather than returning undefined because the promise is
   * the whole interface: an awaited no-op still has to mean "you have it".
   *
   * `deselectInput(mask)` is the inverse, and the only thing that lowers the
   * mask again — `off()` drops the listener and leaves the selection.
   */
  selectInput(mask) {
    const added = mask & ~this.eventMask;
    if (added === 0) return Promise.resolve(this);
    this.eventMask |= added;
    return new Promise((resolve, reject) => {
      this.X.ChangeWindowAttributes(this.id, { eventMask: this.eventMask }, (err) => {
        if (!err) return resolve(this);
        // a refused write left the server's mask as it was — give back the
        // bits, or the next call would find them held and skip a request
        // that has not happened yet
        this.eventMask &= ~added;
        reject(err);
      });
    });
  }

  /**
   * The bits of the event mask something in this process still needs: the
   * union over every event name with a live listener, plus what ntk's own
   * machinery requires. `deselectInput` refuses exactly these, so
   * `mask & wnd.heldEventMask` asks "would that be refused?" without making
   * the request.
   *
   * Not a subset of `eventMask`. A listener implies a bit whether or not
   * this connection ever selected it — an adopted window selects nothing
   * (issue #322), and ntk's own map/unmap/destroy handlers listen without
   * asking for anything.
   */
  get heldEventMask() {
    let held = 0;
    for (const name in xevents.mask) {
      const bit = xevents.mask[name];
      // 0 marks an event that arrives regardless of any selection
      if (bit && this.listenerCount(name) > 0) held |= bit;
    }
    // the redraw cycle is driven by intercepting Expose, whether or not
    // anyone listens for it: a double-buffered window that stops selecting
    // Exposure stops repainting (see _enableBackingStore)
    if (this._backing) held |= x11.eventMask.Exposure;
    return held;
  }

  /**
   * Stop selecting `mask` — the inverse of `selectInput`, and the only way a
   * window's event mask ever goes down (issue #318).
   *
   * `on(name, fn)` raises the mask as a side effect and `off()` does not
   * lower it again, so a window that stops needing an event goes on being
   * sent it until it is destroyed. For most masks that is invisible; for
   * PointerMotion it is 32 bytes per motion event — 2 KB/s at 60 Hz, and
   * 8 KB/s where the motion is XI2's — for as long as the pointer is over
   * the window. A viewer that hides its chrome, a toolbar that unmounts, a
   * window that goes to a background tab: they know when they stop needing
   * hover, and this is how they say so.
   *
   * Bits a live listener still needs are kept rather than cleared, because
   * dropping PointerMotion out from under an `on('mousemove')` is the one
   * bug this API can have. Several names share one bit — `map`, `unmap`,
   * `resize`, `reparent`, `gravity`, `circulate` and `destroy` are all
   * StructureNotify — so losing the last `map` listener does not make the
   * bit free. It resolves with the bits it kept for that reason, `0` when it
   * cleared everything it was asked to:
   *
   *   const kept = await wnd.deselectInput(x11.eventMask.PointerMotion);
   *   if (kept) ... // something in this process is still listening
   *
   * Two selections it will therefore not clear: StructureNotify, held by
   * ntk's own map/unmap/destroy bookkeeping on every window, and Exposure on
   * a double-buffered one. XI2 is selected separately and keeps its own
   * inverse — `selectXI2([])` (see lib/xi2.js).
   */
  deselectInput(mask) {
    const clear = mask & this.eventMask & ~this.heldEventMask;
    const kept = mask & this.eventMask & ~clear;
    // asking to drop what is not selected, or only what is spoken for, is a
    // request that would change nothing
    if (clear === 0) return Promise.resolve(kept);
    this.eventMask &= ~clear;
    // no motion means no hints, so no frame owes the server the QueryPointer
    // that re-arms one. A poll already in flight is left alone, as
    // setMouseHintOnly leaves it: its answer is a real position.
    if (clear & (x11.eventMask.PointerMotion | x11.eventMask.PointerMotionHint)) {
      this._hintRearm = false;
    }
    // A window the server has already taken, or a connection on its way out:
    // there is no selection left to lower, and node-x11 throws at a request
    // from then on (issue #321). The tracked mask is lowered all the same —
    // it says what this connection holds, and it holds nothing.
    if (this._destroyed || connectionGone(this.X)) return Promise.resolve(kept);
    return new Promise((resolve, reject) => {
      this.X.ChangeWindowAttributes(this.id, { eventMask: this.eventMask }, (err) => {
        if (!err) return resolve(kept);
        // the request failed as a whole, so the server kept the mask it had:
        // take the bits back rather than leave `eventMask` denying a
        // selection this connection still holds — the next on() reads it to
        // decide whether a write can be skipped
        this.eventMask |= clear;
        reject(err);
      });
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
   * Send a ClientMessage about this window (X SendEvent with a
   * ClientMessage payload).
   *
   * ClientMessage is the carrier of every convention layered over the core
   * protocol — EWMH state changes, WM_PROTOCOLS, XEmbed, XDND, the system
   * tray — and they differ only in the atom naming the message and the five
   * 32-bit words in it. `type` is an atom name (or an already-interned id),
   * `data` the words; anything past the end of the list is sent as zero.
   *
   *   await wnd.sendClientMessage('WM_PROTOCOLS', [deleteAtom, time]);
   *
   * Two options carry the meaning that the raw request buries in argument
   * order:
   *
   * - `target` — where the message is *delivered*, which is not always the
   *   window it is *about*. EWMH messages are about a client window and
   *   delivered to the root, so the window manager (which selected
   *   SubstructureRedirect there) sees them.
   * - `mask` — who on the target gets it. `0`, the default, delivers to the
   *   client that owns the target window whatever it selected, which is
   *   what a message addressed to another client needs. Root-window EWMH
   *   messages instead pass
   *   `SubstructureRedirect | SubstructureNotify`.
   *
   * @param {string|number} type atom name of the message type, or its id
   * @param {number[]} [data] up to five 32-bit words (ten at format 16,
   *   twenty at format 8)
   * @param {object} [options] `{ target = this.id, format = 32, mask = 0 }`
   * @returns {Promise<Window>}
   */
  async sendClientMessage(type, data = [], options = {}) {
    const { target = this.id, format = 32, mask = 0 } = options;
    const slots = { 8: 20, 16: 10, 32: 5 }[format];
    if (!slots) {
      throw new TypeError(`sendClientMessage: format must be 8, 16 or 32, got ${format}`);
    }
    if (data.length > slots) {
      // the wire event is 32 bytes and no more; sending the first `slots`
      // words of a longer list would drop the rest without a sound
      throw new RangeError(
        `sendClientMessage: a format-${format} ClientMessage carries ${slots} values, got ${data.length}`
      );
    }
    const messageType = typeof type === 'number' ? type : await this.atom(type);
    if (this._destroyed) return this;
    safeRelease(this.X, () => {
      this.X.SendClientMessage(target, this.id, messageType, format, data, mask);
    });
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
    // the default mask of 0 delivers to the client that created the window,
    // not to whoever selected events on it — a WM_PROTOCOLS message is
    // addressed to the owner, so it must not go out with the EWMH
    // substructure mask
    await this.sendClientMessage('WM_PROTOCOLS', [deleteAtom, 0 /* CurrentTime */]);
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
      Promise.all(wrappers.map((w) => w.ready)).then(() => {
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
    // interned atoms are cached per connection (App#_isolateAtoms), so these
    // are the ids this window's own addProtocol interned — an id another
    // connection happened to intern would not be one this server still knows
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
