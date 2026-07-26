# Headless X server (`ntk/xserver`)

ntk apps can run without any real X server: node-x11 ships a pure-JS X
server (used by its own test-suite and by browser playgrounds), and ntk adds
the one extension its rendering model needs — XRender. The `ntk/xserver`
entry wires the two together.

```js
import { createClient } from 'ntk';
import { createServer, createStreamPair } from 'ntk/xserver';

const server = createServer({ width: 640, height: 480 });
const [serverEnd, clientEnd] = createStreamPair();
server.addClientStream(serverEnd);

const app = await createClient({ stream: clientEnd, fontSource });
```

Everything the 2d context does — path fills (trapezoids), text
(glyphsets), gradients, `drawImage` (picture transforms + bilinear
filtering), Porter-Duff composite ops, clipping and `globalAlpha` masks —
renders into the server's in-memory rasters. Read pixels back with
`ctx.getImageData` / `GetImage`, or composite the screen with
`server.compose()` and present `server.root.raster` yourself (this is what
the browser playground draws to a canvas).

Use a [`StaticFontSource`](fonts.md) so text works without fontconfig; the
node-x11 server keeps no timers, so tests only need `await app.close()`.

## Exports

- `createServer(options)` — construct node-x11's `XServer` (`{ width,
  height }`) with RENDER installed. This is the usual entry point.
- `installRender(server)` — register the RENDER extension on an existing
  `XServer` and apply two core patches ntk depends on: `CreatePixmap`
  accepts depth 8 (a8 masks), and `PutImage` preserves the alpha byte for
  depth-32 → depth-32 ZPixmap uploads (premultiplied BGRA image data).
  Returns the extension record.
- `createRenderExtension(options)` — the raw extension definition for
  `server.registerExtension('RENDER', …)`. Self-contained (no node builtins,
  no x11 imports), so browser bundles can register it against the browser
  build of the server; the two `installRender` core patches must then be
  applied by the embedder.
- `createStreamPair()` — re-export of node-x11's in-process duplex pair.

## What the RENDER implementation covers

Requests used by ntk are implemented: QueryVersion (reports 0.11),
QueryPictFormats (rgba32 / rgb24 / a8 / mono1), Create/Change/FreePicture,
Composite, FillRectangles, Triangles, AddTraps (antialiased, ADD-accumulated
coverage), glyphsets (a8) + CompositeGlyphs8/16/32, SetPictureTransform
(general affine), SetPictureFilter (`nearest`, `bilinear`, `convolution`;
`fast`/`good`/`best`/`binomial`/`gaussian` are accepted and sample nearest),
solid fills and linear/radial/conical gradients (edge-clamped stops, as
canvas gradients expect). Everything else answers `BadImplementation`.

Rasterization is antialiased but intentionally not pixel-exact with Xorg —
assert on regions/tolerances, not exact edge pixels (see
`test/xserver.test.js` for the patterns).
