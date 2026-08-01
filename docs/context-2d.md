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

Two companions for the places premultiplied is the *wrong* form, both
exported alongside it:

- `cssColorStraight(value)` — the same parse with **straight** alpha.
  **OpenGL** needs this: `glClearColor` and material colours take
  unassociated components, and premultiplied ones render translucent
  colours dark.
- `premultiply([r, g, b, a])` — converts. Interpolating two colours wants
  both: lerp in straight space, then scale once at the end, because a round
  trip back to an `rgba()` string only closes if the components were never
  scaled. Premultiplying twice is the failure this pair exists to prevent —
  `rgba(255, 0, 0, 0.5)` becomes `rgba(128, 0, 0, 0.5)`, a colour half as
  bright at the same alpha.

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
  be a [`Surface`](surface.md) (pixels the server drew, including a8 coverage
  surfaces that paint in the current `fillStyle`), anything else exposing
  `width`/`height`/`picture(app)`, another ntk 2d context (server-side
  composite of the whole drawable) or a node-canvas-like object exposing
  `image.context.getImageData()` (pixels are uploaded). Under a rectangular
  clip the clip goes to the server directly, rather than through a
  full-surface mask
- `ctx.destroy()` / `Symbol.dispose` — release the context's server-side
  resources: its GC, its Picture, its masks and its solid-colour pictures.
  Needed only for contexts created dynamically, such as one per
  [`Surface`](surface.md); a context on a window lives as long as the window
### Pixels

Pixel access follows the canvas API: `ImageData` is straight
(non-premultiplied) RGBA in a `Uint8ClampedArray`, rows top to bottom, and
ntk converts to and from the drawable's own layout at the boundary.

- `getImageData(x, y, w, h)` — resolves to an `ImageData`. A trailing
  `cb(err, imageData)` is still accepted. Reads the backing pixmap on
  double-buffered windows, so it is valid even where the window is occluded
- `putImageData(data, x, y[, dirtyX, dirtyY, dirtyWidth, dirtyHeight])` —
  writes straight RGBA back, optionally only part of the source
- `createImageData(w, h)` / `createImageData(imagedata)` — a blank
  `ImageData`; the second form copies the size, not the pixels

```js
const img = await ctx.getImageData(0, 0, 64, 64);
img.data[0] = 255; // red channel of the top-left pixel
ctx.putImageData(img, 0, 0);
```

What the drawable actually holds is none of those things — `GetImage`
returns words in the *server's* `image_byte_order` (a different handshake
field from the one the connection speaks), the channel positions come from
the visual's masks, anything XRender composited into is premultiplied, and a
depth-24 drawable's fourth byte is undefined padding rather than opacity.
Converting costs a pass over the pixels: roughly 0.04 ms for a 128×128 read,
0.7 ms at 640×480, 4.6 ms at 1920×1080.

- `readPixels(x, y, w, h)` — the way out when you want the server's own
  bytes, for handing straight back to `PutImage` or into a codec. Resolves to
  `{ width, height, data, depth, bitsPerPixel, byteOrder, masks,
  premultiplied }`, so unlike a bare `GetImage` the bytes say what they mean.
  `byteOrder` is `'lsb'` or `'msb'`; `masks.alpha` is 0 when the drawable has
  no alpha channel

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
  rasterized here or on the server depending on size (see
  [Where drawings are rasterized](#where-drawings-are-rasterized))
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

## Where drawings are rasterized

Every fill and stroke ends the same way: coverage lands in a scratch a8 mask,
the mask is intersected with the clip and `globalAlpha`, and the fill style is
composited through it. Only the first step has a choice of where it happens.

- **Server-side** — the geometry is trapezoidated here
  (`lib/trapezoid.js`) and sent as `AddTraps`/`Triangles`. Cost grows with
  geometric complexity: per-request overhead plus 40 bytes per trapezoid.
- **Locally** — the geometry is rasterized into 8-bit coverage here
  (`lib/rasterize.js`) and uploaded with one `PutImage`. Cost grows with
  area: one byte per pixel of the drawing's bounding box.

The choice is per drawing, made by `routeRaster()` from the bounding-box area
and the flattened edge count. Defaults, measured against XQuartz with shapes
bracketing the range (a rounded rectangle at 14–79 trapezoids, a stroked icon
at 181–1053):

```js
{ maxArea: 64 * 64,   // at or below this bounding-box area, always local
  bytesPerEdge: 150,  // above it, local while area <= 150 * edges
  maxBytes: 1 << 20 } // never upload more coverage than this at once
```

An icon-sized drawing takes the local route, and a wall of 400 of them costs
~24 ms of server time instead of ~1.9 s. A large, geometrically simple shape
(a full-window rounded rectangle) takes the server route, where a handful of
trapezoids beat a megabyte of coverage.

Because what crosses the wire is **coverage, not colour**, the route is
invisible to everything else: gradients, solid fills, `globalAlpha`, clip and
composite ops all work identically either way, and a widget that draws through
`fill()`/`stroke()` — `SvgView`, `HtmlView`, anything of your own — is routed
without knowing this exists.

### Swapping the rasterizer

```js
import { createClient, ScanlineRasterizer, setDefaultRasterizer } from 'ntk';

const app = await createClient({ rasterizer: myRasterizer });
// or per app, at any time:
app.rasterizer = myRasterizer;
app.rasterizer = null;          // send every drawing to the server
// or process-wide, before any app is created:
setDefaultRasterizer(myRasterizer);
```

A rasterizer is any object with one method:

```js
rasterize({ polys, triangles, width, height, rule, dx, dy }) → Uint8Array | Buffer | null
```

- exactly one of `polys` (closed polygons `[x0,y0,x1,y1,…]`, filled by `rule`,
  `'nonzero'` or `'evenodd'`) and `triangles` (a stroke's triangle soup, whose
  overlaps must **union** rather than cancel — caps, joins and segments
  overlap constantly);
- `dx`/`dy` must be added to every coordinate. Geometry arrives in device
  space and the grid covers the drawing's bounding box; the offset maps one to
  the other. It is passed rather than pre-applied because pre-applying means
  copying every point of every path on every frame;
- return `width * height` bytes of 8-bit coverage, row-major and unpadded, or
  `null` to decline. Declining routes that drawing back to the server, so a
  partial implementation is safe — a rasterizer that only understands
  non-zero fills can return `null` for everything else and stay correct.

Thresholds are tunable the same way: `createClient({ rasterPolicy })` or
`app.rasterPolicy`, merged over `DEFAULT_RASTER_POLICY`.

The default `ScanlineRasterizer` uses signed-area accumulation (the font-rs /
stb_truetype v2 algorithm) — exact analytic antialiasing, no supersampling,
no dependencies, and it works in a browser bundle. `CoverageAccumulator` is
exported if you want to drive it directly.

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
