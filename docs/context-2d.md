# 2d rendering context

`drawable.getContext('2d')` returns a context implementing a subset of the
HTML [CanvasRenderingContext2D](https://html.spec.whatwg.org/multipage/canvas.html#2dcontext)
API. It is backed by the XRender extension: fills, gradients, composition and
glyph drawing are executed **on the X server**, so pixel data does not travel
over the connection for most operations.

On windows, drawing goes into an offscreen backing pixmap and is presented
in single blits (double buffering — flicker-free by default; see
[window.md](window.md)). On pixmaps the context draws directly.
`getImageData` reads the backing pixmap on double-buffered windows, so it is
valid even where the window is occluded.

```js
const ctx = wnd.getContext('2d');
ctx.fillStyle = 'rgba(255, 0, 0, 0.5)';
ctx.fillRect(0, 0, 100, 100);
```

## Properties

- `ctx.canvas` — the owning drawable (window or pixmap), like in the browser
- `ctx.width`, `ctx.height` — drawable size
- `ctx.fillStyle`, `ctx.strokeStyle` — CSS color string (via
  [parse-color](https://www.npmjs.com/package/parse-color)), a premultiplied
  `[r, g, b, a]` array (0..1 floats), a `CanvasGradient`, or a `Picture`
- `ctx.lineWidth` — stroke thickness
- `ctx.font` — CSS-ish font string (`'bold italic 40px "DejaVu Sans"'`),
  resolved through fontconfig; see [fonts.md](fonts.md)

## Rectangles and images

- `fillRect(x, y, w, h)` — respects the current clip
- `clearRect(x, y, w, h)` — resets to opaque white
- `drawImage(source)` — source can be another ntk 2d context (server-side
  composite, fast) or a node-canvas-like object exposing
  `image.context.getImageData()` (pixels are uploaded)
- `createImageData(w, h)`, `putImageData(data, x, y)`
- `getImageData(x, y, w, h, cb)` — async, `cb(err, image)`; `image.data` is
  BGRA byte order

## Paths

- `beginPath()`, `moveTo()`, `lineTo()`, `bezierCurveTo()`, `closePath()`
- `fill()` — non-zero winding fill of the current path (trapezoidated
  client-side via pnltri, composited server-side)
- `stroke()` — extrudes the polyline (extrude-polyline) and renders triangles
- `clip()` — uses the current path as clip mask for subsequent `fillRect` /
  `fill` / `drawImage`
- `arc()`, `save()`, `restore()`, `translate()` — **not implemented yet** (no-ops)
- `scale(s)` — sets a picture transform on the target (experimental)

## Gradients

```js
const g = ctx.createLinearGradient(0, 0, 200, 0);
g.addColorStop(0, 'red');
g.addColorStop(1, 'rgba(255, 255, 255, 0)');
ctx.fillStyle = g;
```

- `createLinearGradient(x0, y0, x1, y1)`
- `createRadialGradient(x0, y0, r0, x1, y1, r1)`
- `createConicalGradient(x0, y0, angle)` — ntk extension (XRender conical
  gradient)

Gradients are uploaded lazily on first use and freed with the context's
pictures on GC.

## Text

Text is fully shaped: OpenType kerning and ligatures, contextual forms for
complex scripts (e.g. Arabic), bidi reordering and automatic font fallback
all apply. Glyphs upload to the server once per (face, size); drawing costs
about a byte per glyph afterwards. Very large (>256px by default),
fractional or frame-to-frame-varying sizes render as trapezoids instead —
no per-size server cache — see
[text.md](text.md#the-vector-trapezoid-text-path); tune via
`app.textPolicy`.

- `fillText(text, x, y)` — draws with the current `font` and `fillStyle`,
  honoring `textAlign` / `textBaseline`
- `measureText(text)` → canvas-style TextMetrics: `width`,
  `actualBoundingBox{Left,Right,Ascent,Descent}`,
  `fontBoundingBox{Ascent,Descent}`
- `textAlign` — `'start' | 'end' | 'left' | 'right' | 'center'`
- `textBaseline` — `'alphabetic' | 'top' | 'hanging' | 'middle' | 'bottom' |
  'ideographic'`
- `layoutText(content, options)` → `TextLayout` — ntk extension: wrap text
  (or styled spans) to a target width without drawing, inspect lines and
  metrics, then `layout.draw(ctx, x, y)`

Custom font files: `app.fonts.load(path)`, then use the family name in
`ctx.font`. See [text.md](text.md) for the full text API and
[fonts.md](fonts.md) for font lookup.
