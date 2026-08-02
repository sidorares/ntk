# Headless X server

ntk apps can run without any real X server: node-x11 (x11 >= 3.1.0) ships a
pure-JS X server with the XRender extension built in — everything ntk's
rendering model needs. Connect ntk to an in-process server over a stream
pair:

```js
import { createClient } from 'ntk';
import xserver from 'x11/lib/xserver/index.js';

const { createServer, createStreamPair } = xserver;

const server = createServer({ width: 640, height: 480 });
const [serverEnd, clientEnd] = createStreamPair();
server.addClientStream(serverEnd);

// no display, and no fontconfig either: name the faces the test ships
const app = await createClient({ stream: clientEnd, fontSource: './test/fonts' });
```

Everything the 2d context does — path fills (trapezoids), text
(glyphsets), gradients, `drawImage` (picture transforms + bilinear
filtering), Porter-Duff composite ops, clipping and `globalAlpha` masks —
renders into the server's in-memory rasters. Read pixels back with
`ctx.getImageData` / `GetImage`, or composite the screen with
`server.compose()` and present `server.root.raster` yourself (this is what
the [browser playground](https://sidorares.github.io/ntk/playground) draws
to a canvas via node-x11's `CanvasPresenter`).

Use a [`StaticFontSource`](fonts.md) so text works without fontconfig; the
node-x11 server keeps no timers, so tests only need `await app.close()`.

Rasterization is antialiased but intentionally not pixel-exact with Xorg —
assert on regions/tolerances, not exact edge pixels (see
`test/xserver.test.js` for the patterns; that suite runs ntk end-to-end
against this server with no `$DISPLAY` and no fontconfig).
