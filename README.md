ntk
===

node.js desktop UI toolkit for X11

A set of wrappers around the low level [node-x11](https://github.com/sidorares/node-x11)
module to simplify X Window UI programming — window creation, DOM-style event
handling, 2d/3d graphics — using API concepts you already know from the web.

Everything, including font rasterization, is pure JavaScript: `npm install`
never compiles anything.

**Docs & live playground:** <https://sidorares.github.io/ntk/> — the
playground runs ordinary ntk code in your browser against node-x11's
in-browser pure-JS X server (XRender included) with bundled fonts. The same server also works headless in node — see
[docs/xserver.md](docs/xserver.md) — so ntk apps and tests can run with no
real X server at all.

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
via the
[XRender extension](https://www.x.org/releases/X11R7.7/doc/renderproto/renderproto.txt) —
paths (arcs, beziers, `Path2D` with SVG path data, non-zero/even-odd fill
rules), transforms with `save()`/`restore()`, clipping, `globalAlpha` and
Porter-Duff composite ops ([docs/context-2d.md](docs/context-2d.md)).
Most operations are performed on the X server side (image composition,
scaling, blur, text composition, gradients etc). Text is fully shaped in
pure JS — OpenType kerning/ligatures and complex scripts (fontkit), bidi
(bidi-js), automatic font fallback — rasterized by a built-in scanline
rasterizer and cached server-side as XRender glyphs, so drawing a line of
text costs about a byte per glyph on the wire. Font names resolve through
fontconfig (`fc-match`). Very large and continuously animated sizes render
as server-side trapezoids instead of cached bitmaps. A `TextLayout` engine
wraps styled text to a target width — see [docs/text.md](docs/text.md).

PNG/JPEG images decode client-side (`loadImage`) and composite server-side
via `ctx.drawImage` ([docs/images.md](docs/images.md)). An `SvgView` widget
renders static SVG (shapes, gradients, transforms, `use`) through the same
2d pipeline ([docs/svg.md](docs/svg.md)).

Rendering documents — markdown, formulas, rich text — is not ntk's job:
it draws, and a document is a tree of layout decisions on top of that.
[`@react-x11/components`](https://github.com/sidorares/react-x11-components)
is where those live, over the react-x11 renderer.

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

Two backends, chosen by `glPolicy`
([docs/context-gles.md](docs/context-gles.md)):

- **direct** (opt-in) — shader GL on the real GPU with no pixels on the
  socket: OpenGL ES 2 over DRI3 + Present on Linux, CGL over the Apple-DRI
  extension on macOS/XQuartz. Needs the optional `x11-dri` addon.
- **indirect GLX** (default) — most of the OpenGL 1.4 api, serialized into
  the X connection. Note that on many systems indirect GLX is disabled by
  default —
  [you'll need to enable it for gl to work](https://github.com/sidorares/node-x11/issues/117#issuecomment-214762185).

```js
import { createClient } from 'ntk';

const app = await createClient();
// GLX drawables need a GLX-capable visual, chosen before the window exists
const glx = await app.chooseGLXConfig({ DEPTH_SIZE: 24 });
const wnd = app.createWindow({ width: 300, height: 300, visual: glx.visual, depth: glx.depth });
wnd.map();

const gl = wnd.getContext('opengl', glx);
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
