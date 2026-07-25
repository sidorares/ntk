# 2d rendering context

`drawable.getContext('2d')` returns a context implementing a subset of the
HTML [CanvasRenderingContext2D](https://html.spec.whatwg.org/multipage/canvas.html#2dcontext)
API. It is backed by the XRender extension: fills, gradients, composition and
glyph drawing are executed **on the X server**, so pixel data does not travel
over the connection for most operations.

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

- `fillText(text, x, y)` — draws with the current `font` and `fillStyle`
- `measureText(text)` → `{ width, height }`
- `loadFont(path, size)` → glyphset — load a `.ttf`/`.otf` directly, bypassing
  fontconfig
- `setFont(glyphset)` — use a glyphset returned by `loadFont`

See [fonts.md](fonts.md) for how the text pipeline works.
