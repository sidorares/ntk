# Surface

A `Surface` is something you draw **once** and composite **many times**: a
[pixmap](pixmap.md), its XRender Picture, and enough of the
[`Image`](images.md) shape that `ctx.drawImage` takes it as a source.

```js
import { createClient, Surface, SvgView } from 'ntk';

const icon = new SvgView(null).setSvg(iconMarkup);
const surface = new Surface(app, { width: 20, height: 20 });
surface.render((ctx) => icon.draw(ctx, 0, 0, 20, 20));

for (const { x, y } of cells) ctx.drawImage(surface, x, y); // one composite each
```

`Image` already does this for decoded PNG/JPEG pixels uploaded from the
client. A Surface is the same contract for pixels the **server** drew, so
nothing crosses the wire but the composite — which is the point when the
drawing is expensive to produce and cheap to copy. Rendering an icon means
walking a parsed document, building path geometry, flattening it and running
the stroker; compositing the result is one request.

## Coverage surfaces

`format: 'a8'` stores **coverage** instead of colour. Drawn through
`drawImage`, the surface becomes the *mask* and the context's current
`fillStyle` becomes the source:

```js
const mask = new Surface(app, { width: 20, height: 20, format: 'a8' });
mask.render((ctx) => icon.draw(ctx, 0, 0, 20, 20, { color: '#fff' }));

ctx.fillStyle = theme.fg;      ctx.drawImage(mask, x, y);
ctx.fillStyle = theme.accent;  ctx.drawImage(mask, x, y + 24); // same surface
```

One rendered copy then serves every colour it is ever asked for, so a hover,
a disabled state and a theme change all reuse it instead of each needing
their own. This is the trick the glyph cache already runs on text, applied to
arbitrary drawings — and it is a quarter of the storage, one byte per pixel
instead of four.

Not every drawing qualifies: a document with two colours in it, or a
gradient, has colours of its own that a mask cannot carry.
[`SvgView.paintKind`](svg.md#paintkind-which-documents-can-be-recoloured)
answers that question for SVG documents.

`globalAlpha` still applies — it folds into the source colour rather than the
mask, since the mask slot is taken.

## Scrolling and panning: `copyWithin`

A widget that keeps its content in a retained surface — a terminal grid, a
log view, a minimap, a panning chart — scrolls the way terminals always
have: copy the band that survives the shift, then repaint only the sliver
the shift exposed.

```js
// scroll the whole grid up one 18px row
if (grid.copyWithin({ x: 0, y: 0, width: grid.width, height: grid.height }, 0, -18)) {
  drawRow(lastRow); // only the newly exposed row
} else {
  drawAllRows();    // nothing survived the shift
}
ctx.drawImage(grid, 0, 0);
```

`surface.copyWithin(src, dx, dy)` shifts the pixels of `src`
(`{x, y, width, height}`, surface coordinates) by `(dx, dy)` **in place**,
server-side — one `CopyArea` of the surviving band. The overlap is safe:
pixmap contents cannot be occluded, and the server fetches the source region
before storing. The copy is issued in-order with whatever the caller draws
next on the same connection, and goes out with a shared
`graphicsExposures: 0` GC — one per app and depth, created on first use —
so it never emits exposure events.

Returns `false` — having done nothing, so the caller just repaints `src` as
it would have anyway — when `dx`/`dy` are fractional (a sub-pixel shift
changes every pixel) or both zero, when nothing of `src` survives the shift
after clamping to the surface, or on a destroyed surface.

This is [`wnd.scrollRegion`](window.md#wndscrollregionrect-dx-dy--boolean)
for an offscreen surface, minus the damage bookkeeping — a pixmap has no
backing store or present path, so compositing the surface afterwards is the
caller's normal job.

## API

- `new Surface(app, { width, height, format })` — `format` is `'argb32'`
  (default) or `'a8'`. Sizes must be positive integers. Contents start
  transparent
- `surface.width` / `surface.height` / `surface.format` / `surface.depth`
- `surface.bytes` — server-side storage, which is what a cache budgets
  against: `w * h * 4` for argb32, `w * h` for a8
- `surface.render(fn)` — call `fn(ctx)` with a 2d context on the surface, in
  surface-local coordinates where `(0, 0)` is its top-left corner. The
  context is created for the call and destroyed after it
- `surface.getContext('2d')` — a context the caller owns, and owes a
  `destroy()`. Use this instead of `render()` for many draws into one surface
- `surface.clear()` — reset every pixel to transparent
- `surface.copyWithin(src, dx, dy)` → boolean — shift the pixels of `src`
  in place by an integer `(dx, dy)`, server-side; see
  [Scrolling and panning](#scrolling-and-panning-copywithin)
- `surface.picture(app)` — the server-side Picture, mirroring
  `Image.picture(app)`. Throws for a different connection
- a surface is also what [`ctx.createPattern`](context-2d.md#patterns) tiles:
  drawn once, then repeated across a fill by the server. A background grid,
  a checkerboard or a hatch is a tile-sized surface and one composite,
  instead of a pane-sized coverage mask per frame
- `surface.destroy()` / `Symbol.dispose` — free the pixmap and the picture.
  Both carry finalizers, so a dropped surface still releases

## Drawing sources in general

`drawImage` does not check types: it takes anything that knows its own size
and can hand over a Picture.

```js
ctx.drawImage({ width, height, picture: (app) => somePicture }, x, y);
```

That is the whole contract — `width`, `height`, `picture(app)`, plus an
optional `format: 'a8'` to be treated as coverage. A caller keeping its own
cache of rendered things can satisfy it without ntk knowing the type.

## Context lifetime

Contexts are not free: each one holds a GC and a Picture (fill colours are
cached on the `App` and shared by every context on the connection, so a
colour costs its one server object no matter how many contexts use it). A
context bound to a window normally lives as long as the window, so this
rarely mattered — but creating them per surface makes it matter, which is
why `RenderingContext2d` now has `destroy()` (and `Symbol.dispose`).
`Surface.render()` calls it for you.

```js
using ctx = surface.getContext('2d'); // or ctx.destroy() when done
```
