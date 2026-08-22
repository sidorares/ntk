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

## Events

A pixmap is an `EventEmitter` for one reason: extension events name a
*drawable*, and a DAMAGE object can watch a pixmap as readily as a window.
Create one on the pixmap's id and its `damage` events are delivered here —
see [Extension events](app.md#extension-events):

```js
const damage = await app.damage();
damage.Create(app.X.AllocID(), pixmap.id, damage.ReportLevel.NonEmpty);
pixmap.on('damage', (ev) => { /* ev.x/y/width/height changed */ });
```

Unlike a window, a pixmap has no frame clock, so nothing is coalesced: every
event is delivered as it arrives. Note that a pixmap with such a listener is
referenced by the connection and stays alive until `destroy()` — the GC
fallback below cannot collect it.

## Lifecycle

- `pixmap.destroy()` — free the server-side pixmap and release the id
- `Symbol.dispose` — same, for `using pixmap = ...`
- If never destroyed explicitly, the server resource is freed when the
  wrapper is garbage collected (FinalizationRegistry). Don't rely on this
  for long-running apps — see [resource-management.md](resource-management.md).
