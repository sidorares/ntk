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
- `reparentTo(newParent, x, y)`, `raise()`, `lower()`
- `setActions()` — opt in to the WM_DELETE_WINDOW protocol (window manager
  sends a `message` event instead of killing the connection on close)
- `setSizeHints(hints)`, `setClass(instance, class)`,
  `setWindowType(type)`, `setAlwaysOnTop(on)` — see
  [Window manager hints](#window-manager-hints) below
- `getProperty(name, options)`, `setProperty(name, value, options)`,
  `getTitle()`, `getSizeHints()`, `getAttributes()`, `atom(name)`,
  `selectInput(mask)`, `addToSaveSet()`, `sendConfigureNotify(geometry)`,
  `close()`, `grabButton(options)` — the window manager side, see
  [Being the window manager](#being-the-window-manager)
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

## Being the window manager

Everything above is the application's side: hints a window *writes* about
itself for whichever window manager happens to be running. This section is
the other side — the API for being that window manager, which on X11 is an
ordinary client with one special privilege.

### Claiming the role

A window manager is the client holding `SubstructureRedirect` on the root.
Only one client may hold it, so claiming it is also how you discover that
another window manager is already running:

```js
import x11 from 'x11';

const root = app.rootWindow();
try {
  await root.selectInput(
    x11.eventMask.SubstructureRedirect | x11.eventMask.SubstructureNotify
  );
} catch (err) {
  throw new Error('another window manager is already running'); // BadAccess
}
```

`selectInput(mask)` ORs `mask` into whatever handlers already asked for and
resolves once the server accepts it. Handler-driven selection
(`root.on('map_request', ...)`, or the `onMapRequest` creation argument)
still works and covers the ordinary case; `selectInput` exists for the mask
that can be refused, because a rejected selection is the answer rather than
an error to log.

### The requests you now answer

With the redirect held, these never take effect on their own — they arrive
as events instead, and nothing happens until you make it happen:

| event | what the client asked for |
| --- | --- |
| `map_request` | to be shown. Frame it, then `map()` both |
| `configure_request` | to move or resize. Honour, adjust, or refuse it |
| `circulate_request` | to be raised or lowered |
| `create` | a window appeared (SubstructureNotify, not a request) |

Each carries the full X event — `ev.window` and `ev.parent` as `Window`
objects, plus the raw fields. For `configure_request` those fields are the
point:

```js
root.on('configure_request', (ev) => {
  // ev.mask says which of x/y/width/height the client actually set; the
  // rest hold the window's current values and mean nothing
  const width = ev.mask & 0x0004 ? ev.width : ev.window.width;
  const height = ev.mask & 0x0008 ? ev.height : ev.window.height;
  ev.window.resize(width, height);
});
```

### Framing a client

Reparenting a client into a frame you own is what lets you draw
decorations around it:

```js
root.on('map_request', async (ev) => {
  const client = ev.window;
  const title = (await client.getTitle()) ?? 'untitled';
  const { minWidth = 1, minHeight = 1 } = await client.getSizeHints();

  const frame = app.createWindow({
    x: 40, y: 40,
    width: client.width + 2 * BORDER,
    height: client.height + TITLEBAR + 2 * BORDER
  });
  client.addToSaveSet();          // survive us exiting
  client.reparentTo(frame, BORDER, TITLEBAR);
  frame.map();
  client.map();
});
```

`addToSaveSet()` matters: the client is now a child of a window you own, so
without it your frames would take every client with them if the window
manager exits. With it the server reparents them back to the root.

After moving a framed client, tell it where it really is —
its own `ConfigureNotify` carries frame-relative coordinates, and a
`configure_request` you refused produces no notification at all, which
hangs clients that wait for one:

```js
client.sendConfigureNotify({ x: frameX + BORDER, y: frameY + TITLEBAR });
```

### Reading what clients declare

The counterparts of the hint setters, for reading other clients' windows:

- `getTitle()` — `_NET_WM_NAME` if set, else `WM_NAME`; `null` for neither
- `getSizeHints()` — `WM_NORMAL_HINTS` shaped like `setSizeHints`' argument,
  `{}` when unset, each key present only if the client set its flag
- `getAttributes()` — `{ mapState, overrideRedirect, ... }`. Both matter
  when adopting the windows that already existed at startup: skip
  override-redirect ones, frame only the mapped ones
- `getProperty(name, { as })` — any property. `as` is `'buffer'` (default,
  `{ type, data }`), `'string'`, or `'numbers'` for 32-bit lists. Resolves
  to `null` when the property is not set
- `setProperty(name, value, { type, format })` — the write side, and the
  general form of `setTitle`/`setClass`. Strings go out as `UTF8_STRING`,
  arrays of numbers as 32-bit lists; `type` names the property type atom,
  which is what EWMH readers check:

  ```js
  root.setProperty('_NET_CLIENT_LIST', ids, { type: 'WINDOW' });
  root.setProperty('_NET_SUPPORTED', atoms, { type: 'ATOM' });
  ```

- `atom(name)` — intern an atom id, cached per connection

Title changes arrive as `property` events (`PropertyChange`), so a frame
that redraws its titlebar on those stays in sync.

### Closing and focusing

```js
await client.close();   // true if asked politely, false if killed
```

`close()` sends `WM_DELETE_WINDOW` when the client advertised it in
`WM_PROTOCOLS` — the protocol `setActions()` opts a window into — so it can
confirm or save first. A client that never advertised it has no such path
and is killed outright, which is what `xkill` does.

Click-to-focus needs to see presses that belong to the client. Grab the
button synchronously, then release the pointer once you have raised and
focused the window, so the click still reaches the application:

```js
client.grabButton({ button: 1, pointerMode: 0 /* synchronous */ });

client.on('mousedown', () => {
  frame.raise();
  client.focus();
  app.allowEvents('replay'); // hand the click back to the client
});
```

`app.allowEvents(mode)` takes `'replay'`, `'async'`, `'sync'`, the
`*_keyboard` variants, or a raw X mode number.

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
| `keydown` / `keyup` | KeyPress/Release | `keydown` carries `ev.codepoint` (unicode) — see [Keyboard input](#keyboard-input) |
| `focus` / `blur` | FocusIn/FocusOut | keyboard focus arrived at or left this window — usually because the window manager moved it. `ev.detail`/`ev.mode` carry the X notify detail and mode |
| `expose` | Expose | `ev.x/y/width/height` of the damaged area, coalesced per frame (bounding box; rect list in `ev.rects`); on double-buffered windows only emitted when a real repaint is needed (see above) |
| `draw` | — | synthetic repaint request on double-buffered windows (same payload as the accompanying `expose`) |
| `resize` | ConfigureNotify | coalesced per frame (last state wins); updates `wnd.width/height/x/y` first |
| `map` / `unmap` | Map/UnmapNotify | |
| `destroy` | DestroyNotify | wrapper is removed from the cache |
| `map_request`, `configure_request` | SubstructureRedirect | for window managers |
| `property`, `reparent`, `message`, `selection*` | | |

Every event object gets `ev.window` and `ev.target` set to the `Window`.

## Keyboard input

`keydown` carries the raw X `ev.keycode` plus `ev.codepoint`, the Unicode
codepoint the key types, resolved against the keyboard mapping ntk fetches at
connect and refreshes on `MappingNotify`.

**`codepoint` is absent when the key types nothing** — arrows, function keys,
modifiers, `Pause`, and dead keys (ntk has no compose support yet, and emitting
a bare combining accent would attach it to the previous character). Test for
presence rather than comparing against `0`:

```js
wnd.on('keydown', (ev) => {
  if (ev.codepoint === 8) text = text.slice(0, -1); // BackSpace
  else if (ev.codepoint) text += String.fromCodePoint(ev.codepoint);
});
```

Keys that do produce a character include the ones whose codepoint is a control
character: `BackSpace` (8), `Tab` (9), `Return` (13), `Escape` (27) and
`Delete` (127) — filter those out if you are appending to a text buffer. The
keypad produces the character on the key (`KP_5` → `'5'`, `KP_Enter` → 13).

Both legacy keysyms and the direct-Unicode form modern non-Latin layouts emit
(`0x01000000 | codepoint`) resolve, from a table built into ntk — nothing on the
keypress path reads the filesystem, so this works the same in an esbuild bundle,
a single-executable build and the browser.

> Selecting the keysym still ignores the active XKB group, so a second
> (non-Latin) layout does not take effect and `AltGr` levels are unreachable.
> Tracked in [#116](https://github.com/sidorares/ntk/issues/116).
