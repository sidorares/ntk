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

- `loadImage(source, options?)` → `Promise<Image>` — `source` is a file
  path, a file `URL`, or a `Buffer`/`Uint8Array` of encoded PNG/JPEG bytes
- `decodeImage(buffer, options?)` → `Image` — synchronous decode of
  in-memory bytes; the format is sniffed from magic bytes
  - `options.imageOrientation` — `'from-image'` (the default) turns a JPEG
    the way its EXIF Orientation says, see [Orientation](#orientation);
    `'none'` keeps the pixels as stored. The names are canvas's
    (`createImageBitmap`) and CSS's (`image-orientation`)
- `exifOrientation(buffer)` → `1`–`8` — a JPEG's EXIF Orientation, `1` when
  it has none (or the bytes are not a JPEG). What an app that decodes with
  `imageOrientation: 'none'` needs to apply the turn itself
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
  server-side picture for that app's display (uploaded on first call),
  public for manual Render compositing. It comes back read as stored —
  no transform, the `nearest` filter, no repeat — whatever a scaled or
  turned `drawImage` last read it through, and with anything set on it
  through the picture's own `setTransform`, `setFilter`, `setBlurFilter`
  or `setRepeat` still on it; see
  [How an image is read](context-2d.md#how-an-image-is-read)
- `image.pixmap(app)` → [`Pixmap`](pixmap.md) — the drawable those pixels
  were uploaded to (uploading on first call, like `picture`). It is what
  building a *second* picture over the same upload needs:
  [`ctx.createPattern`](context-2d.md#patterns) makes a repeating one there
  rather than changing how `picture(app)` samples everywhere else
- `image.destroy()` / `Symbol.dispose` — free the server-side copies
  (safe: the image re-uploads if drawn again). Client-side pixel data stays
  usable; the server resources are also reclaimed by GC as a fallback (see
  [resource management](resource-management.md))

## Orientation

A camera held upright still reads its sensor sideways, and says so in the
JPEG's EXIF Orientation tag rather than by turning the pixels. A browser
applies the tag (CSS `image-orientation: from-image`, the default since
2020), and so does `decodeImage`: a photo taken in portrait comes out
portrait, with `width` and `height` swapped from the stored ones for the
four orientations that turn a quarter.

| Value | Stored pixels are shown | Size |
| ----- | ----------------------- | ---- |
| 1 | as stored | `w × h` |
| 2 | mirrored left to right | `w × h` |
| 3 | turned half way | `w × h` |
| 4 | mirrored top to bottom | `w × h` |
| 5 | transposed (mirrored, then turned a quarter anticlockwise) | `h × w` |
| 6 | turned a quarter clockwise | `h × w` |
| 7 | transversed (mirrored, then turned a quarter clockwise) | `h × w` |
| 8 | turned a quarter anticlockwise | `h × w` |

Only the tag is read — tag `0x0112` of IFD0 in the first APP1 segment that
carries Exif, in either byte order — and a value it cannot read leaves the
image as stored. The turn is one pass over the pixels, ~18ms at 12
megapixels against ~800ms for jpeg-js to decode them. PNG has no
orientation here: an `eXIf` chunk is not read.

To keep the stored pixels — an editor that shows the tag, or an app that
turns the image at draw time with a transform instead — decode with
`{ imageOrientation: 'none' }` and read the value with `exifOrientation()`.

## Notes

- Alpha is handled correctly: pixels are premultiplied at upload, so
  translucent PNGs blend with what is underneath (`Over` composition).
- Uploads are chunked to respect the server's maximum request length, so
  large images work over the wire.
- Drawing the same `Image` into several windows/pixmaps of one app reuses
  one upload; using it with several apps (rare) keeps one upload per app.
