# Pixmap

An offscreen X drawable. Like windows, pixmaps can create rendering contexts
(`getContext('2d')`), which makes them useful for double-buffering:

```js
const pixmap = wnd.createPixmap({ width: 800, height: 800 }); // depth 32
const ctx = pixmap.getContext('2d');
// ... draw into ctx ...
wnd.getContext('2d').drawImage(ctx, 0, 0);
```

## Creation

- `app.createPixmap({ width, height, depth = 24, parent })` — `parent` (a
  window) determines the screen; defaults to the root window.
- `wnd.createPixmap(params)` — defaults: `parent` = the window, `width`/`height`
  = window size, `depth` = 32.
- `new Pixmap(app, { id })` — wrap an existing pixmap id (not owned: it will
  not be freed by ntk).

## Properties

- `pixmap.id`, `pixmap.width`, `pixmap.height`, `pixmap.depth`

## Lifecycle

- `pixmap.destroy()` — free the server-side pixmap and release the id
- `Symbol.dispose` — same, for `using pixmap = ...`
- If never destroyed explicitly, the server resource is freed when the
  wrapper is garbage collected (FinalizationRegistry). Don't rely on this
  for long-running apps — see [resource-management.md](resource-management.md).
