ntk
===

node.js desktop UI toolkit for X11

A set of wrappers around the low level [node-x11](https://github.com/sidorares/node-x11)
module to simplify X Window UI programming — window creation, DOM-style event
handling, 2d/3d graphics — using API concepts you already know from the web.

Everything, including font rasterization, is pure JavaScript: `npm install`
never compiles anything.

# Installation

```
npm install ntk
```

Requires Node.js >= 20.19 and an X server. Full documentation lives in
[docs/](docs/README.md).

## Basic usage

```js
import { createClient } from 'ntk';

const app = await createClient();
const wnd = app.createWindow({ width: 500, height: 300, title: 'Hello' });
wnd.on('mousedown', (ev) => wnd.setTitle(`click: ${ev.x},${ev.y}`));
wnd.map();
```

## 2d graphics

Each window (or pixmap) can create a 2d canvas implementing the HTML
[context2d api](https://html.spec.whatwg.org/multipage/canvas.html#2dcontext)
(some features not yet supported) via the
[XRender extension](https://www.x.org/releases/X11R7.7/doc/renderproto/renderproto.txt).
Most operations are performed on the X server side (image composition,
scaling, blur, text composition, gradients etc). Text is fully shaped in
pure JS — OpenType kerning/ligatures and complex scripts (fontkit), bidi
(bidi-js), automatic font fallback — rasterized by a built-in scanline
rasterizer and cached server-side as XRender glyphs, so drawing a line of
text costs about a byte per glyph on the wire. Font names resolve through
fontconfig (`fc-match`). Very large and continuously animated sizes render
as server-side trapezoids instead of cached bitmaps. A `TextLayout` engine
wraps styled text to a target width, a `MarkdownView` widget renders
markdown (with syntax-highlighted code fences) on top of it, and a
KaTeX-backed `TexView` renders TeX math — see [docs/text.md](docs/text.md)
and [docs/tex.md](docs/tex.md).

PNG/JPEG images decode client-side (`loadImage`) and composite server-side
via `ctx.drawImage` ([docs/images.md](docs/images.md)). An `HtmlView`
widget renders a static HTML + CSS subset — block flow and flexbox laid
out by yoga-layout, no scripts, no network — with app-controlled link
navigation ([docs/html.md](docs/html.md)).

```js
import { createClient } from 'ntk';

const app = await createClient();
const wnd = app.createWindow({ width: 800, height: 600 });
const ctx = wnd.getContext('2d');

wnd.on('mousemove', (ev) => {
  const gradient = ctx.createRadialGradient(0, 0, 10, ev.x, ev.y, 500);
  gradient.addColorStop(0, 'red');
  gradient.addColorStop(0.5, 'green');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, ctx.width, ctx.height);
});

wnd.map();
```

`ctx.drawImage()` also accepts a [node-canvas](https://github.com/Automattic/node-canvas)
canvas as a source — for images with lots of drawing calls it might be more
efficient to draw locally and transfer pixels to the server when ready.

## Frame pacing & networked displays

Noisy events (`resize`, `mousemove`, `expose`) are coalesced into paced
frames — the latest state wins, nothing queues up — and each frame is
fenced with a server round-trip, so rendering automatically slows to the
connection's real throughput instead of drawing a trail of stale updates
over ssh-forwarded displays. Animation uses the DOM-style
`requestAnimationFrame`:

```js
function frame(now) {
  // ... draw ...
  wnd.requestAnimationFrame(frame); // ~60fps locally, RTT-paced remotely
}
wnd.requestAnimationFrame(frame);
```

See [docs/window.md](docs/window.md) for the knobs (`frameInterval`,
`frameSync`, `coalesceEvents`) and the raw uncoalesced event stream.

## Resource management

Server-side resources support `using` / `await using` (Node 24+):

```js
{
  await using app = await createClient();
  using pixmap = app.createPixmap({ width: 256, height: 256, depth: 24 });
  // ... draw ...
} // pixmap freed, connection closed
```

## 3d graphics

Only indirect GLX is supported, with most of the OpenGL 1.4 api implemented.
Note that on many systems indirect GLX is disabled by default —
[you'll need to enable it for gl to work](https://github.com/sidorares/node-x11/issues/117#issuecomment-214762185).

```js
import { createClient } from 'ntk';

const app = await createClient();
const wnd = app.createWindow({ width: 300, height: 300 });
wnd.map();

const gl = wnd.getContext('opengl');
gl.ClearColor(0.3, 0.3, 0.3, 0.0);
gl.Clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
gl.Begin(gl.TRIANGLES);
gl.Color3f(1, 0, 0);
gl.Vertex3f(-1, -1, 0);
gl.Vertex3f(1, -1, 0);
gl.Vertex3f(0, 1, 0);
gl.End();
gl.SwapBuffers();
```

See [examples/](examples/) for more (teapot, GL clock, textures, text
rendering).

## High level widgets / layout management etc

Likely to be implemented outside as part of a react renderer
([react-x11](https://github.com/sidorares/react-x11)).
