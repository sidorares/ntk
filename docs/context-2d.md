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
- `ctx.fillStyle`, `ctx.strokeStyle` — a CSS color string, a premultiplied
  `[r, g, b, a]` array (0..1 floats), a `CanvasGradient`, or a `Picture`.
  Named colors, `rgb[a]()`, `hsl[a]()` and hex in all four lengths
  (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`) are accepted; anything
  unparseable throws rather than drawing something arbitrary. See
  **Color** below for what alpha does
- `ctx.lineWidth`, `ctx.lineCap`, `ctx.lineJoin`, `ctx.miterLimit` — stroke
  geometry, including `'round'` caps and joins (rendered as triangle-fan
  disks unioned with the stroke mesh)
- `ctx.setLineDash(segments)`, `ctx.getLineDash()`, `ctx.lineDashOffset` —
  canvas-spec dashes: an empty list is solid, an odd-length list doubles,
  negative/non-finite values invalidate the call, `getLineDash()` returns a
  copy, and the state participates in `save()`/`restore()`. Dashing splits
  the flattened polyline by arc length, so caps apply to each dash; on
  closed subpaths the pattern continues around the loop (no cap at the seam
  unless a gap lands there)
- `ctx.globalAlpha` — multiplies fills, strokes, `fillRect` and `drawImage`
  (not text)
- `ctx.globalCompositeOperation` — Porter-Duff subset mapped to XRender ops:
  `source-over` (default), `copy`, `destination-over`, `source-in`,
  `destination-in`, `source-out`, `destination-out`, `source-atop`,
  `destination-atop`, `xor`, `lighter`. With a shape/clip mask the op only
  applies inside the mask coverage
- `ctx.font` — CSS-ish font string (`'bold italic 40px "DejaVu Sans"'`),
  resolved through fontconfig; see [fonts.md](fonts.md)

Everything that puts ink on the surface goes through the clip: fills,
strokes, images, text (`fillText`, `TextLayout.draw`) and the KaTeX boxes
of [`layoutTex`](tex.md). Rectangular clips take a server-side fast path
(`SetPictureClipRectangles`); non-rectangular ones build an a8 mask.

## Color

XRender colors are **premultiplied**: each of `r`, `g` and `b` is already
scaled by `a`, so all three must be `<= a`. Color *strings* are converted
for you — `'rgba(255, 0, 0, 0.5)'` reaches the server as
`[0.5, 0, 0, 0.5]` — but an **array is taken as already premultiplied and
passes through untouched**:

```js
ctx.fillStyle = 'rgba(255, 0, 0, 0.5)'; // half-alpha red
ctx.fillStyle = [0.5, 0, 0, 0.5]; // the same thing
ctx.fillStyle = [1, 0, 0, 0.5]; // NOT half-alpha red: out of gamut
```

The last line is the mistake to know about. It is not rejected — the
protocol allows it — but it renders brighter than any real color at that
alpha, and over a white background it clamps to the same pixels as the
correct value, so it tends to look fine until something dark is underneath.
White at half alpha is `[0.5, 0.5, 0.5, 0.5]`, not `[1, 1, 1, 0.5]`.

`cssColor(value)` (exported from the package) does the conversion, returning
premultiplied `[r, g, b, a]` in 0..1, or `null`. Gradient stops go through
the same path, so `addColorStop(0, 'rgba(255, 0, 0, 0.5)')` is right too.

Set `NTK_STRICT_COLORS=1` to make a component outside 0..1 throw instead of
being clamped (it wires up x11's `Render.strictColors`); ntk's own test run
sets it. Note what that does *not* cover: an unpremultiplied `[1, 0, 0, 0.5]`
is inside 0..1 on every component, so only rendering catches it.

## State and transforms

- `save()` / `restore()` — full state stack: styles, line settings, font,
  text alignment, `globalAlpha`, composite op, transform and clip
- `translate(x, y)`, `rotate(angle)`, `scale(x[, y])`,
  `transform(a, b, c, d, e, f)`, `setTransform(...)`, `resetTransform()`,
  `getTransform()` → `{a, b, c, d, e, f}`

The transform applies to path commands as they are recorded, to
`fillRect`/`strokeRect`/`clearRect`, and to `drawImage` (server-side, via
the picture transform). **Text is the exception**: the translation applies
to the anchor point, but glyphs are not rotated/scaled — size text via
`ctx.font`.

## Rectangles and images

- `fillRect(x, y, w, h)` — respects clip, transform, `globalAlpha` and the
  composite op
- `strokeRect(x, y, w, h)` — outlines a rect without touching the current path
- `clearRect(x, y, w, h)` — resets to opaque white (honors clip + transform)
- `drawImage(image, dx, dy)` / `drawImage(image, dx, dy, dw, dh)` /
  `drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh)` — draws an ntk
  [`Image`](images.md) (decoded PNG/JPEG). The image uploads to the server
  once and is cached; scaling (and any affine transform) happens server-side
  with bilinear filtering. Respects clip and `globalAlpha`. `image` can also
  be another ntk 2d context (server-side composite of the whole drawable) or
  a node-canvas-like object exposing `image.context.getImageData()` (pixels
  are uploaded)
- `createImageData(w, h)`, `putImageData(data, x, y)`
- `getImageData(x, y, w, h, cb)` — async, `cb(err, image)`; `image.data` is
  BGRA byte order

## Paths

Full canvas path surface:

- `beginPath()`, `moveTo()`, `lineTo()`, `closePath()`
- `bezierCurveTo()`, `quadraticCurveTo()` — flattened adaptively
  (error-bounded subdivision in device pixels, so curves stay smooth at any
  transform scale)
- `arc(x, y, r, a0, a1[, ccw])`, `ellipse(x, y, rx, ry, rot, a0, a1[, ccw])`,
  `arcTo(x1, y1, x2, y2, r)`
- `rect(x, y, w, h)`, `roundRect(x, y, w, h, radii)` — radii like the spec:
  a number, or an array of 1–4 numbers / `{x, y}` pairs
- `fill([path][, fillRule])` — `'nonzero'` (default) or `'evenodd'`;
  trapezoidated client-side (`lib/trapezoid.js`), composited server-side
- `stroke([path])` — extrudes the polyline (extrude-polyline) and renders
  triangles; honors line dashes, round caps/joins, clip, `globalAlpha` and
  the composite op. Round-cap/join disks overlap the stroke body, so their
  coverage is accumulated in a clamped a8 mask and composited in a single
  pass — semi-transparent strokes (`globalAlpha < 1` or an alpha stroke
  style) do not double-darken at the overlaps
- `clip([path][, fillRule])` — intersects the clip region; restored by
  `restore()`
- `isPointInPath([path, ]x, y[, fillRule])` — hit test in canvas (device)
  coordinates

## Path2D

`Path2D` is exported from the package root and matches the browser class:

```js
import { Path2D } from 'ntk';

const p = new Path2D('M8 8 H56 V56 H8 Z M24 24 H40 V40 H24 Z');
ctx.fill(p, 'evenodd');

const copy = new Path2D(p);          // copy constructor
copy.addPath(p, [2, 0, 0, 2, 0, 0]); // append with an affine transform
```

- constructors: `new Path2D()`, `new Path2D(otherPath)`, `new Path2D(svgPathData)`
- all context path-segment methods (`moveTo` … `roundRect`) plus
  `addPath(path[, transform])` (`[a,b,c,d,e,f]` array or `{a..f}` object)
- SVG path data supports the full grammar — `M L H V C S Q T A Z`, relative
  forms, implicit repeats, compact arc flags; elliptical arcs are converted
  to cubics. The parser is also exported as `parseSvgPath(d)`
- per the canvas spec, a `Path2D` is transformed by the **current** transform
  at `fill`/`stroke`/`clip` time, while the default path records points as
  commands are issued

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
