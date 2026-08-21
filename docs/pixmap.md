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

- `app.createPixmap({ width, height, depth = 24, parent, visual })` —
  `parent` (a window) determines the screen; defaults to the root window.
- `wnd.createPixmap(params)` — defaults: `parent` = the window, `width`/`height`
  = window size, `depth` = 32.
- `new Pixmap(app, { id })` — wrap an existing pixmap id (not owned: it will
  not be freed by ntk).

`visual` is the one X itself does not ask for: a pixmap has no visual, only a
depth, so what its pixels *mean* is decided by whoever put them there. Name
it for a pixmap holding a window's content — a compositor's
`NameWindowPixmap` result, a foreign pixmap handed over by another client —
and everything drawing on it reads the channels the way that window's visual
lays them out (see [Picture formats](app.md#picture-formats)). Left out, the
format is picked from the depth, which is right for the usual 8:8:8 and 8-bit
coverage layouts and wrong for the rest. A window's own backing pixmap is
given the window's visual already.

## Properties

- `pixmap.id`, `pixmap.width`, `pixmap.height`, `pixmap.depth`
- `pixmap.visualId` — the visual its pixels are in, or `0` for "go by the
  depth"

## Lifecycle

- `pixmap.destroy()` — free the server-side pixmap and release the id
- `Symbol.dispose` — same, for `using pixmap = ...`
- If never destroyed explicitly, the server resource is freed when the
  wrapper is garbage collected (FinalizationRegistry). Don't rely on this
  for long-running apps — see [resource-management.md](resource-management.md).
