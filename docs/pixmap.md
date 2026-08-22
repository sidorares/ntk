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
- `await Pixmap.adopt(app, id, options)` — adopt an existing pixmap id: ask
  the server for its geometry and depth, and own it (see
  [Adoption](#adoption)).
- `new Pixmap(app, { id, own, width, height, depth, visual })` — the
  synchronous form of the same (see [Adoption](#adoption)).

`visual` is the one X itself does not ask for: a pixmap has no visual, only a
depth, so what its pixels *mean* is decided by whoever put them there. Name
it for a pixmap holding a window's content — a compositor's
`NameWindowPixmap` result, a foreign pixmap handed over by another client —
and everything drawing on it reads the channels the way that window's visual
lays them out (see [Picture formats](app.md#picture-formats)). Left out, the
format is picked from the depth, which is right for the usual 8:8:8 and 8-bit
coverage layouts and wrong for the rest. A window's own backing pixmap is
given the window's visual already.

## Adoption

A pixmap id from outside — another client's handover, or
`XCompositeNameWindowPixmap` naming a window's contents into an id you
allocated — becomes a `Pixmap` in one of two ways:

```js
const pixmap = await Pixmap.adopt(app, id);         // GetGeometry, own it
const pixmap = new Pixmap(app, { id, own: true, width, height, depth });
```

`Pixmap.adopt(app, id, options)` asks the server for the pixmap's geometry
and real depth, records them, and returns the pixmap owned: `destroy()`,
`using` and the GC fallback free it exactly as for a pixmap ntk created.
It rejects if the pixmap no longer exists — for a compositor, whose named
pixmap dies with every resize of the window it names, that means: name the
window again and adopt the fresh id. Options: `own: false` to observe a
pixmap that stays another client's to free, `visual` (see above), and any
of `width`/`height`/`depth` already known — with all three declared no
round trip is made.

`new Pixmap(app, { id })` is the synchronous form. **Nothing is defaulted**:
`width`, `height` and `depth` are whatever the caller declared, and where
any is missing the constructor sends a `GetGeometry` whose reply fills them
in — `await pixmap.ready` is the wait for it, exactly as on an
[adopted window](window.md#adopted-windows). Until it lands, anything that
picks a picture format from the depth — `getContext('2d')`,
`createPattern` — cannot know a depth-32 pixmap from a depth-24 one, which
is how an ARGB pixmap loses its alpha channel. `own` defaults to `false`
here.

Ownership frees the pixmap with `FreePixmap` either way; the id itself goes
back into the connection's allocator only when it came from there (the
`NameWindowPixmap` case) — a foreign client's id is never recycled into
ours.

## Properties

- `pixmap.id`, `pixmap.width`, `pixmap.height`, `pixmap.depth` — on a
  pixmap adopted by bare id, `width`/`height`/`depth` are `undefined` until
  the constructor's `GetGeometry` replies
- `pixmap.visualId` — the visual its pixels are in, or `0` for "go by the
  depth"
- `pixmap.ready` — resolves with the pixmap once its geometry and depth are
  known: immediately for a pixmap ntk created or adopted fully declared,
  when `GetGeometry` replies for one adopted by bare id. Never rejects — a
  pixmap that was already gone resolves with `width` still `undefined`
  (`Pixmap.adopt` is the form that rejects instead).
- `await pixmap.getGeometry()` — ask the server now; resolves with
  `{ x, y, width, height, depth, borderWidth, root }` (the same shape as
  [`wnd.getGeometry()`](window.md#adopted-windows); `x`/`y`/`borderWidth`
  are 0 for a pixmap) and writes the answer back to the properties above.

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

- `pixmap.destroy()` — free the server-side pixmap and release the id.
  A no-op on a pixmap adopted without `own` — that one is someone else's
  to free.
- `Symbol.dispose` — same, for `using pixmap = ...`
- If never destroyed explicitly, the server resource is freed when the
  wrapper is garbage collected (FinalizationRegistry). Don't rely on this
  for long-running apps — see [resource-management.md](resource-management.md).
