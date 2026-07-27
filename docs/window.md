# Window

Windows are created via `app.createWindow(args)` or `window.createWindow(args)`
(child windows). `Window` extends `EventEmitter` (via `Drawable`).

```js
const wnd = app.createWindow({
  width: 500,
  height: 300,
  x: 10,
  y: 10,
  title: 'Hello',
  parent: otherWindow,          // optional, defaults to the root window
  onMouseDown: (ev) => { ... }  // any onXxx event handler, see below
});
wnd.map();
```

Constructing a window with an existing X window id (`{ id }`) returns a
(cached) wrapper around that foreign window; its geometry is populated
asynchronously.

Creation options beyond geometry/`title`/`parent`/`onXxx` handlers:

- `backingStore: false` — opt out of double buffering (below)
- X window attributes, forwarded into the `CreateWindow` value list under
  their node-x11 names: `backgroundPixmap`, `backgroundPixel`,
  `borderPixmap`, `borderPixel`, `bitGravity`, `winGravity`,
  `backingPlanes`, `backingPixel`, `overrideRedirect`, `saveUnder`,
  `doNotPropagateMask`, `colormap`, `cursor`. Defaults stay in effect
  unless overridden: NorthWest `bitGravity` (`1`) and the event mask
  computed from the `onXxx` handlers (an explicit `eventMask` is OR-ed into
  the computed mask). Note the X *backing-store* attribute is **not**
  forwarded: the `backingStore` option name is taken by ntk's double
  buffering opt-out above, which is an unrelated client-side concept.
- `visual`, `depth`, `windowClass`, `borderWidth` — `CreateWindow` header
  fields rather than attributes. They default to `0`, i.e. CopyFromParent /
  InputOutput. A window on a non-default visual (a GLX drawable, an ARGB
  visual) needs all of `visual` + `depth` **and** a colormap for that visual:
  ntk creates one with `app.createColormap(visual)` and frees it in
  `destroy()` unless you pass your own `colormap`, and sets `borderPixel: 0`
  because inheriting a border pixmap across depths is a `BadMatch`. See
  [context-opengl.md](context-opengl.md) for choosing a GLX visual:
  ```js
  const glx = await app.chooseGLXConfig({ DEPTH_SIZE: 24 });
  const wnd = app.createWindow({ width: 400, height: 300, visual: glx.visual, depth: glx.depth });
  ```
- `coalesceEvents: false` — deliver every noisy event individually (see
  [Frames, coalescing and slow connections](#frames-coalescing-and-slow-connections))
- `frameSync: false` — don't pace frames with a server round-trip fence
- `frameInterval: ms` — minimum time between paced frames (default `16`,
  ~60 fps; `0` disables the timer gate). Also writable later as
  `wnd.frameInterval`.

## Double buffering (backing store)

Requesting a 2d context on a window you created enables double buffering
automatically (opt out with `createWindow({ backingStore: false })`):

- All 2d drawing lands in an offscreen **backing pixmap**; the window is
  updated with single `CopyArea` blits — after your event handlers return,
  or coalesced once per event-loop tick for drawing done elsewhere. No
  clear-then-draw flicker, no partially drawn frames.
- **Expose events are served from the backing pixmap** by the library (a
  blit of just the damaged rect); your `expose` handler is *not* called.
  When a real repaint is needed — first paint, or the window was resized —
  the window emits `draw` and `expose` (once per tick, with full-window
  geometry and `ev.synthetic = true`). Existing `wnd.on('expose', draw)`
  code keeps working, it just runs far less often.
- The backing pixmap grows monotonically with the window (fresh area is
  white); `ctx.getImageData` reads it directly, so results are valid even
  where the window is occluded on screen.
- Windows are created with NorthWest `bit-gravity`, so the server keeps old
  content anchored during a resize instead of clearing to background.

Foreign windows (`{ id }`) and windows drawing via the `'opengl'` or
`'x11'` contexts are not double-buffered.

## Frames, coalescing and slow connections

Some X events are noisy by nature: an interactive resize is a stream of
`ConfigureNotify`, the pointer reports `MotionNotify` at device rate, damage
arrives as bursts of `Expose` rectangles. Reacting to each one queues more
drawing than the connection can drain, and the window plays back a trail of
stale intermediate states — most visibly over ssh-forwarded / networked
displays. ntk therefore delivers noisy events and repaints in **paced
frames**, gated by two independent mechanisms:

- **a fence** — after each frame the library sends a cheap request with a
  reply (`GetInputFocus`). X processes requests strictly in order, so the
  reply confirms the server has consumed everything the frame drew. At most
  one fence is ever in flight: on a fast local connection this costs
  nothing, on a slow link frames automatically degrade to one per
  round-trip — the latest state is always the next thing drawn, and no
  backlog builds up. Disable with `frameSync: false`.
- **a timer** — at most one paced frame per `frameInterval` ms (default 16),
  so a local server isn't asked to redraw at input-device rate.

While a frame is pending, noisy events **coalesce** instead of queueing:

- `resize`, `mousemove` — the newest event wins. Every merged raw event is
  kept in `ev.coalesced` (oldest first, like the DOM's
  `getCoalescedEvents()`), for e.g. freehand drawing that wants the full
  pointer trail. `wnd.width/height/x/y` always track the newest
  `ConfigureNotify` immediately, even before the event is delivered.
- `expose` — damage accumulates: `ev.x/y/width/height` is the bounding box
  of all merged rectangles and `ev.rects` lists each one.

Discrete events (`mousedown`, `keydown`, …) are never coalesced and are
delivered immediately — any buffered noisy events are flushed first so
handlers observe them in the order they happened. Blits of an already-drawn
backing store still respect the fence, but skip the timer for latency.

Escape hatches, from mildest to rawest:

- `frameInterval = 0` — fence-only pacing (fastest delivery that cannot
  fall behind the server)
- `frameSync: false` — timer-only pacing
- `coalesceEvents: false` — per-event delivery, no merging at all
- `wnd.on('event', ev => ...)` — the raw X event stream for this window,
  before any name mapping or coalescing

`wnd.frameLatency` reports the last measured fence round-trip in
milliseconds (`null` until the first frame) — a live estimate of connection
+ server latency, useful for adapting rendering quality or animation rates.

### requestAnimationFrame

For animation and manual render scheduling, windows offer the DOM-style

```js
const id = wnd.requestAnimationFrame((now) => { /* draw one frame */ });
wnd.cancelAnimationFrame(id);
```

The callback runs on the window's next paced frame (`now` is a
`performance.now()` timestamp). A re-registering animation loop renders at
~`1000/frameInterval` fps locally and self-throttles to one frame per
round-trip on slow connections — write the loop once, it behaves everywhere.

## Properties

- `wnd.id` — X window id
- `wnd.width`, `wnd.height`, `wnd.x`, `wnd.y` — geometry, kept in sync on `resize`
- `wnd.frameLatency` — last fence round-trip, ms (`null` before the first frame)
- `wnd.frameInterval` — minimum ms between paced frames (writable)
- `wnd.app`, `wnd.X`, `wnd.display` — owning app / raw client shortcuts

## Methods

All return `this` unless noted.

- `map()` / `unmap()` — show / hide
- `move(x, y)`, `resize(w, h)`, `moveResize(x, y, w, h)`
- `setState({ visible, x, y, width, height })` — declarative variant; only
  sends requests for properties that changed (intended for future
  react-renderer use)
- `setTitle(title)` — sets both the legacy latin-1 `WM_NAME` and the EWMH
  UTF-8 `_NET_WM_NAME`, so non-latin titles display correctly under modern
  window managers
- `getContext(name)` — `'2d'`, `'opengl'` or `'x11'`; see the context docs
- `requestAnimationFrame(cb)` — returns an id, does not return `this`;
  `cancelAnimationFrame(id)` (see above)
- `createWindow(params)` — child window (`parent` preset to this window)
- `createPixmap(params)` — pixmap defaulting to this window's size, depth 32
- `setCursor(nameOrShapeId)` — mouse cursor shown over the window (see
  [Cursor](#cursor) below); `setCursor(null)` restores the parent's cursor
- `focus(revertTo = 2)` — take the keyboard focus (X `SetInputFocus`);
  `revertTo` is 0 None / 1 PointerRoot / 2 Parent. A window manager may take
  focus back, so the authority is the `focus`/`blur` events, not the request
- `queryFocus(cb)` — `cb(err, { focus, revertTo })`: which window the server
  currently sends key events to
- `grabPointer(options, cb)` / `ungrabPointer(time)` — a pointer grab is how
  menus work on X: while it is held, presses anywhere on the screen are
  reported to this window instead of the window under the pointer — the
  window manager's frames included — so a click outside can dismiss the
  menu. `options`: `{ ownerEvents = true, events = ButtonPress|
  ButtonRelease|PointerMotion, pointerMode, keyboardMode, confineTo,
  cursor, time }`; `cb(err, status)` where 0 is Success and 1
  AlreadyGrabbed. With `ownerEvents` the client's own windows still get
  their events normally, so a submenu keeps working
- `grabKeyboard(options, cb)` / `ungrabKeyboard(time)` — the same for keys
- `queryPointer(cb)`, `setMouseHintOnly(isOn)`
- `queryTree(cb)` — `cb(err, { parent, root, children })`, all as `Window`s
- `reparentTo(newParent, x, y)`
- `setActions()` — opt in to the WM_DELETE_WINDOW protocol (window manager
  sends a `message` event instead of killing the connection on close)
- `setSizeHints(hints)`, `setClass(instance, class)`,
  `setWindowType(type)`, `setAlwaysOnTop(on)` — see
  [Window manager hints](#window-manager-hints) below
- `destroy()` — destroy the window server-side (also `Symbol.dispose`)

## Window manager hints

Properties the window manager reads to decide how to treat the window.
Each has a method and a matching creation argument.

### Size limits — `setSizeHints(hints)` / `sizeHints`, `resizable`

Writes ICCCM `WM_NORMAL_HINTS`. Without it a window manager lets the user
resize a window to any size at all, so fixed-size dialogs need this.

```js
wnd.setSizeHints({ minWidth: 320, minHeight: 200, maxWidth: 1280 });
wnd.setSizeHints({ widthInc: 8, heightInc: 16 }); // terminal-style steps
wnd.setSizeHints({ minAspect: [4, 3], maxAspect: [16, 9] });
wnd.setSizeHints({ resizable: false }); // pin min and max to the current size

app.createWindow({ width: 400, height: 300, resizable: false });
```

Keys: `minWidth`, `minHeight`, `maxWidth`, `maxHeight`, `widthInc`,
`heightInc`, `baseWidth`, `baseHeight`, `minAspect: [num, den]`,
`maxAspect: [num, den]`, `gravity`, `resizable`. Only the groups you pass
set their flag, so partial hints stay partial.

### Application identity — `setClass(instance, class)` / `wmClass`

Writes ICCCM `WM_CLASS`, the instance/class pair taskbars and window
managers use to group windows, match icons and apply per-application
rules. The class name defaults to the instance name.

```js
wnd.setClass('ntk-demo', 'Ntk-Demo');
app.createWindow({ wmClass: ['ntk-demo', 'Ntk-Demo'] });
```

### Window kind — `setWindowType(type)` / `windowType`

Writes EWMH `_NET_WM_WINDOW_TYPE`. Short names are expanded, so `'dialog'`
becomes `_NET_WM_WINDOW_TYPE_DIALOG`. Pass an array for fallbacks, most
preferred first.

```js
wnd.setWindowType('dialog');
wnd.setWindowType(['dropdown_menu', 'menu']);
```

This is the window-manager-cooperative alternative to override-redirect: a
menu marked `dropdown_menu` still gets shadows and correct stacking, while
an override-redirect window bypasses the window manager entirely.

### Always on top — `setAlwaysOnTop(on)` / `alwaysOnTop`

Prefers the EWMH `_NET_WM_STATE_ABOVE` state, sent as a ClientMessage to
the root window as the spec requires for mapped windows.

quartz-wm (XQuartz) does not advertise `_NET_WM_STATE_ABOVE`, so on macOS
this falls back to the Apple-WM extension's window levels, which are the
only always-on-top mechanism there. The fallback addresses the frame the
window manager created rather than our own window id — Apple-WM answers
`BadWindow` for a reparented client.

Where neither is available the call is a no-op.

## Cursor

`wnd.setCursor(name)` sets the mouse cursor shown while the pointer is over
the window:

```js
input.setCursor('text'); // I-beam over a text input
button.setCursor('pointer'); // hand over a button or link
wnd.setCursor(null); // back to inheriting the parent's cursor
```

Cursors come from the standard X11 `cursor` font. Names are CSS-like and
resolve to cursorfont.h glyph indices; a raw glyph index (any `XC_*`
constant) is accepted too. Unknown names throw synchronously, listing the
valid names. Created cursors are server-side resources, cached per
connection on `app.cursors` and freed on `app.close()`.

| name | cursor font glyph |
|---|---|
| `default`, `arrow` | `XC_left_ptr` (68) |
| `text` | `XC_xterm` (152) |
| `pointer`, `hand` | `XC_hand2` (60) |
| `wait` | `XC_watch` (150) |
| `move` | `XC_fleur` (52) |
| `crosshair` | `XC_crosshair` (34) |
| `ew-resize`, `col-resize` | `XC_sb_h_double_arrow` (108) |
| `ns-resize`, `row-resize` | `XC_sb_v_double_arrow` (116) |
| `nwse-resize` | `XC_bottom_right_corner` (14) |
| `nesw-resize` | `XC_bottom_left_corner` (12) |
| `grab` | `XC_hand1` (58) |
| `help` | `XC_question_arrow` (92) |
| `not-allowed` | `XC_X_cursor` (0) |

`createWindow({ cursor })` still accepts a raw X cursor id at creation time;
`app.cursors.get(name)` supplies one if you need it there:

```js
const wnd = app.createWindow({ width: 300, height: 200, cursor: app.cursors.get('crosshair') });
```

## Events

DOM-inspired names. Selecting an event via `.on(...)` (or an `onXxx`
constructor arg) automatically extends the window's X event mask.

| event | X event | notes |
|---|---|---|
| `mousedown` / `mouseup` | ButtonPress/Release | `ev.x`, `ev.y`, `ev.keycode` (button) |
| `mousemove` | MotionNotify | coalesced per frame; full trail in `ev.coalesced` |
| `mouseover` / `mouseout` | Enter/LeaveNotify | |
| `keydown` / `keyup` | KeyPress/Release | `keydown` carries `ev.codepoint` (unicode) |
| `focus` / `blur` | FocusIn/FocusOut | keyboard focus arrived at or left this window — usually because the window manager moved it. `ev.detail`/`ev.mode` carry the X notify detail and mode |
| `expose` | Expose | `ev.x/y/width/height` of the damaged area, coalesced per frame (bounding box; rect list in `ev.rects`); on double-buffered windows only emitted when a real repaint is needed (see above) |
| `draw` | — | synthetic repaint request on double-buffered windows (same payload as the accompanying `expose`) |
| `resize` | ConfigureNotify | coalesced per frame (last state wins); updates `wnd.width/height/x/y` first |
| `map` / `unmap` | Map/UnmapNotify | |
| `destroy` | DestroyNotify | wrapper is removed from the cache |
| `map_request`, `configure_request` | SubstructureRedirect | for window managers |
| `property`, `reparent`, `message`, `selection*` | | |

Every event object gets `ev.window` and `ev.target` set to the `Window`.
