# Images

PNG and JPEG decoding is client-side and pure JS
([pngjs](https://www.npmjs.com/package/pngjs),
[jpeg-js](https://www.npmjs.com/package/jpeg-js) — no native modules). A
decoded `Image` is independent of any X connection; the first time it is
drawn it uploads to that server as a 32-bit ARGB pixmap and is cached, so
repeated draws cost a single server-side composite.

```js
import { createClient, loadImage } from 'ntk';

const app = await createClient();
const wnd = app.createWindow({ width: 400, height: 300 });
const ctx = wnd.getContext('2d');

const img = await loadImage('photo.jpg');       // path, file URL or Buffer
ctx.drawImage(img, 0, 0);                        // natural size
ctx.drawImage(img, 0, 0, 200, 150);              // scaled (server-side, bilinear)
ctx.drawImage(img, 10, 10, 80, 80, 220, 10, 160, 160); // source crop + scale
wnd.map();
```

## API

- `loadImage(source)` → `Promise<Image>` — `source` is a file path, a file
  `URL`, or a `Buffer`/`Uint8Array` of encoded PNG/JPEG bytes
- `decodeImage(buffer)` → `Image` — synchronous decode of in-memory bytes;
  the format is sniffed from magic bytes
- `new Image(imagedata)` — an `ImageData` from
  [`ctx.getImageData()`](context-2d.md) is already the right shape, so
  reading pixels back and turning them into a reusable server-side image
  needs no conversion
- `new Image({ width, height, data })` — wrap raw non-premultiplied RGBA
  pixels (`width * height * 4` bytes)

### `Image`

- `image.width`, `image.height` — pixel dimensions
- `image.data` — non-premultiplied RGBA bytes (`Buffer`)
- `image.picture(app)` → [`Picture`](../lib/picture.js) — the cached
  server-side picture for that app's display (uploaded on first call).
  `ctx.drawImage` uses this internally; it is public for manual Render
  compositing
- `image.pixmap(app)` → [`Pixmap`](pixmap.md) — the drawable those pixels
  were uploaded to (uploading on first call, like `picture`). It is what
  building a *second* picture over the same upload needs:
  [`ctx.createPattern`](context-2d.md#patterns) makes a repeating one there
  rather than changing how `picture(app)` samples everywhere else
- `image.destroy()` / `Symbol.dispose` — free the server-side copies
  (safe: the image re-uploads if drawn again). Client-side pixel data stays
  usable; the server resources are also reclaimed by GC as a fallback (see
  [resource management](resource-management.md))

## Notes

- Alpha is handled correctly: pixels are premultiplied at upload, so
  translucent PNGs blend with what is underneath (`Over` composition).
- Uploads are chunked to respect the server's maximum request length, so
  large images work over the wire.
- Drawing the same `Image` into several windows/pixmaps of one app reuses
  one upload; using it with several apps (rare) keeps one upload per app.
