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

## Properties

- `wnd.id` — X window id
- `wnd.width`, `wnd.height`, `wnd.x`, `wnd.y` — geometry, kept in sync on `resize`
- `wnd.app`, `wnd.X`, `wnd.display` — owning app / raw client shortcuts

## Methods

All return `this` unless noted.

- `map()` / `unmap()` — show / hide
- `move(x, y)`, `resize(w, h)`, `moveResize(x, y, w, h)`
- `setState({ visible, x, y, width, height })` — declarative variant; only
  sends requests for properties that changed (intended for future
  react-renderer use)
- `setTitle(title)`
- `getContext(name)` — `'2d'`, `'opengl'` or `'x11'`; see the context docs
- `createWindow(params)` — child window (`parent` preset to this window)
- `createPixmap(params)` — pixmap defaulting to this window's size, depth 32
- `queryPointer(cb)`, `grabPointer()`, `setMouseHintOnly(isOn)`
- `queryTree(cb)` — `cb(err, { parent, root, children })`, all as `Window`s
- `reparentTo(newParent, x, y)`
- `setActions()` — opt in to the WM_DELETE_WINDOW protocol (window manager
  sends a `message` event instead of killing the connection on close)
- `destroy()` — destroy the window server-side (also `Symbol.dispose`)

## Events

DOM-inspired names. Selecting an event via `.on(...)` (or an `onXxx`
constructor arg) automatically extends the window's X event mask.

| event | X event | notes |
|---|---|---|
| `mousedown` / `mouseup` | ButtonPress/Release | `ev.x`, `ev.y`, `ev.keycode` (button) |
| `mousemove` | MotionNotify | |
| `mouseover` / `mouseout` | Enter/LeaveNotify | |
| `keydown` / `keyup` | KeyPress/Release | `keydown` carries `ev.codepoint` (unicode) |
| `expose` | Expose | `ev.x/y/width/height` of the damaged area |
| `resize` | ConfigureNotify | updates `wnd.width/height/x/y` first |
| `map` / `unmap` | Map/UnmapNotify | |
| `destroy` | DestroyNotify | wrapper is removed from the cache |
| `map_request`, `configure_request` | SubstructureRedirect | for window managers |
| `property`, `reparent`, `message`, `selection*` | | |

Every event object gets `ev.window` and `ev.target` set to the `Window`.
