import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

import { builtin } from './builtin.js';
import { fromStraightRgba, pixelLayout } from './imagedata.js';
import Picture from './picture.js';

/**
 * A decoded raster image: `width`, `height` and non-premultiplied RGBA
 * pixels in `data`. Images are client-side objects independent of any X
 * connection; the first time one is drawn it is uploaded to that server
 * as a 32-bit pixmap and cached, so repeated draws are a single
 * server-side composite.
 *
 * Create with `loadImage(pathOrBuffer)` / `decodeImage(buffer)`, or from
 * raw pixels: `new Image({ width, height, data })`.
 */
export class Image {
  constructor({ width, height, data }) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error('Image: width and height must be positive integers');
    }
    if (!data || data.length !== width * height * 4) {
      throw new Error(`Image: data must be RGBA, ${width * height * 4} bytes`);
    }
    this.width = width;
    this.height = height;
    this.data = data;
    this._uploads = new Map(); // App -> { pixmap, picture }
  }

  /**
   * The server-side Picture for this image on `app`'s display (uploaded
   * and cached on first use). Used by `ctx.drawImage`; useful directly
   * when compositing manually via the Render extension.
   */
  picture(app) {
    let upload = this._uploads.get(app);
    if (upload) return upload.picture;

    const X = app.X;
    const Render = app.display.Render;
    const pixmap = app.createPixmap({ depth: 32, width: this.width, height: this.height });

    // straight RGBA in, the server's own premultiplied layout out. This used
    // to assume BGRA, which is only what a little-endian server with the
    // standard visual masks happens to want.
    const bgra = fromStraightRgba(
      this.data,
      pixelLayout(app.display, 32),
      this.width,
      this.height
    );

    // One upload GC per app: a GC is valid for any depth-32 drawable on the
    // screen, so sharing is cheaper than creating and freeing one per image.
    // It outlives every Image and is released with the connection.
    let gc = app._imageUploadGC;
    if (!gc) {
      gc = app._imageUploadGC = X.AllocID();
      X.CreateGC(gc, pixmap.id);
    }
    const bytes = Buffer.isBuffer(bgra) ? bgra : Buffer.from(bgra.buffer, bgra.byteOffset, bgra.byteLength);
    // Shared memory for a large image; otherwise upload row bands that stay
    // under the server's maximum request size.
    if (!app.shm.putImage(pixmap.id, gc, { width: this.width, height: this.height, depth: 32, data: bytes })) {
      const stride = this.width * 4;
      const maxBytes = ((app.display.max_request_length ?? 65535) - 8) * 4;
      const rowsPerBand = Math.max(1, Math.floor(maxBytes / stride));
      for (let y = 0; y < this.height; y += rowsPerBand) {
        const rows = Math.min(rowsPerBand, this.height - y);
        X.PutImage(2, pixmap.id, gc, this.width, rows, 0, y, 0, 32, bytes.subarray(y * stride, (y + rows) * stride));
      }
    }

    const picture = new Picture(app, { drawable: pixmap, format: Render.rgba32 });
    upload = { pixmap, picture };
    this._uploads.set(app, upload);
    return picture;
  }

  /**
   * The Pixmap those pixels live in on `app` (uploading on first use, like
   * `picture`). What it is for is building a *second* Picture over the same
   * upload — `ctx.createPattern` needs a repeating one, and changing the
   * cached picture's attributes instead would change how `drawImage` samples
   * this image everywhere else.
   */
  pixmap(app) {
    this.picture(app);
    return this._uploads.get(app).pixmap;
  }

  /** free server-side copies of this image (safe to draw again afterwards) */
  destroy() {
    for (const { pixmap, picture } of this._uploads.values()) {
      picture.destroy();
      pixmap.destroy();
    }
    this._uploads.clear();
  }

  [Symbol.dispose]() {
    this.destroy();
  }
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

const ORIENTATIONS = ['from-image', 'none'];

/**
 * Decode a PNG or JPEG buffer (sniffed by magic bytes) into an Image.
 *
 * A JPEG comes out the way up its EXIF Orientation says, as a browser shows
 * it (CSS `image-orientation: from-image`, the default since 2020) and as
 * every phone photo expects: a camera held upright writes the sensor's rows
 * as they were read, sideways, and records the turn in the tag rather than
 * in the pixels. `{ imageOrientation: 'none' }` keeps the stored pixels, for
 * an app that applies the turn itself — `exifOrientation()` says which.
 *
 * @param {Buffer|Uint8Array} buffer encoded image bytes
 * @param {{ imageOrientation?: 'from-image' | 'none' }} [options]
 * @returns {Image}
 */
export function decodeImage(buffer, { imageOrientation = 'from-image' } = {}) {
  if (!ORIENTATIONS.includes(imageOrientation)) {
    throw new Error(
      `decodeImage: imageOrientation must be 'from-image' or 'none', not ${JSON.stringify(imageOrientation)}`
    );
  }
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length > 4 && PNG_MAGIC.every((b, i) => buf[i] === b)) {
    const png = PNG.sync.read(buf);
    return new Image({ width: png.width, height: png.height, data: png.data });
  }
  if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) {
    const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 512 });
    const orientation = imageOrientation === 'none' ? 1 : exifOrientation(buf);
    if (orientation !== 1) return new Image(orientPixels(img, orientation));
    return new Image({ width: img.width, height: img.height, data: Buffer.from(img.data) });
  }
  throw new Error('decodeImage: unsupported image format (PNG and JPEG are supported)');
}

/**
 * Load and decode a PNG or JPEG image.
 *
 *   const img = await loadImage('logo.png');
 *   ctx.drawImage(img, 10, 10);
 *
 * @param {string|URL|Buffer|Uint8Array} source file path (or file URL), or
 *   an in-memory buffer of encoded bytes
 * @param {{ imageOrientation?: 'from-image' | 'none' }} [options] as for
 *   `decodeImage`
 * @returns {Promise<Image>}
 */
export async function loadImage(source, options) {
  if (typeof source === 'string' || source instanceof URL) {
    // lazy builtin lookup: browser bundles must not depend on node:fs
    const fsp = builtin('node:fs/promises');
    if (!fsp) {
      throw new Error('loadImage: file paths need node — pass the encoded bytes instead');
    }
    return decodeImage(await fsp.readFile(source), options);
  }
  return decodeImage(source, options);
}

const APP1 = 0xe1;
const SOS = 0xda;
const EOI = 0xd9;
const ORIENTATION_TAG = 0x0112;
const SHORT = 3;

/**
 * The EXIF Orientation of a JPEG, 1 to 8 — the TIFF numbering, where 1 is
 * as stored, 2 to 4 mirror left to right, turn half way and mirror top to
 * bottom, 6 and 8 turn a quarter clockwise and anticlockwise, and 5 and 7
 * are those quarter turns mirrored. 1 for anything else: no Exif, no tag, a
 * value out of range, a segment cut short, or bytes that are not a JPEG.
 *
 * Only the tag itself is read: the first APP1 segment that carries Exif,
 * tag 0x0112 of its IFD0, and only as the one SHORT the standard defines it
 * as. The segments before the scan are walked by their lengths, so the cost
 * is a few reads whatever the size of the image.
 *
 * @param {Buffer|Uint8Array} buf encoded image bytes
 * @returns {number}
 */
export function exifOrientation(buf) {
  if (!(buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8)) return 1;
  for (let at = 2; at + 4 <= buf.length; ) {
    if (buf[at] !== 0xff) return 1;
    const marker = buf[at + 1];
    // a marker may follow any number of 0xff fill bytes
    if (marker === 0xff) {
      at++;
      continue;
    }
    // the metadata segments all come before the scan
    if (marker === SOS || marker === EOI) return 1;
    const end = at + 2 + ((buf[at + 2] << 8) | buf[at + 3]);
    if (end < at + 4 || end > buf.length) return 1;
    // the payload opens with "Exif\0\0" and the TIFF header after it, 14 bytes
    if (marker === APP1 && end - (at + 4) >= 14 && isExifHeader(buf, at + 4)) {
      return ifd0Orientation(buf, at + 10, end);
    }
    at = end;
  }
  return 1;
}

/** "Exif\0\0", which tells Exif's APP1 from XMP's */
function isExifHeader(buf, at) {
  return (
    buf[at] === 0x45 && buf[at + 1] === 0x78 && buf[at + 2] === 0x69 && buf[at + 3] === 0x66 &&
    buf[at + 4] === 0 && buf[at + 5] === 0
  );
}

/** The Orientation in the IFD0 of the TIFF structure from `tiff` to `end`. */
function ifd0Orientation(buf, tiff, end) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // 'II' is little-endian, 'MM' big; both are written, by cameras and by editors
  const little = buf[tiff] === 0x49 && buf[tiff + 1] === 0x49;
  if (!little && !(buf[tiff] === 0x4d && buf[tiff + 1] === 0x4d)) return 1;
  if (view.getUint16(tiff + 2, little) !== 42) return 1;
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd + 2 > end) return 1;
  const count = view.getUint16(ifd, little);
  for (let i = 0, entry = ifd + 2; i < count && entry + 12 <= end; i++, entry += 12) {
    if (view.getUint16(entry, little) !== ORIENTATION_TAG) continue;
    if (view.getUint16(entry + 2, little) !== SHORT || view.getUint32(entry + 4, little) !== 1) return 1;
    // one SHORT sits in the first two bytes of the entry's value field
    const value = view.getUint16(entry + 8, little);
    return value >= 1 && value <= 8 ? value : 1;
  }
  return 1;
}

/**
 * Stored RGBA pixels turned the way `orientation` says, into a new buffer:
 * where stored pixel (x, y) lands is `start + x * dx + y * dy`, in pixels of
 * the result, which is `height` wide for the four that turn a quarter. Each
 * pixel moves as one 32-bit word, so the byte order is never looked at.
 */
function orientPixels({ width: w, height: h, data }, orientation) {
  const n = w * h;
  const [start, dx, dy] = [
    null,
    [0, 1, w], // as stored
    [w - 1, -1, w], // mirrored left to right
    [n - 1, -1, -w], // half turn
    [n - w, 1, -w], // mirrored top to bottom
    [0, h, 1], // transposed: mirrored, then a quarter turn anticlockwise
    [h - 1, h, -1], // a quarter turn clockwise
    [n - 1, -h, -1], // transversed: mirrored, then a quarter turn clockwise
    [n - h, -h, 1] // a quarter turn anticlockwise
  ][orientation];
  // jpeg-js hands over a fresh array, so its offset is word-aligned
  const from = new Uint32Array(data.buffer, data.byteOffset, n);
  const out = Buffer.alloc(n * 4);
  const to = new Uint32Array(out.buffer, out.byteOffset, n);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0, j = start + y * dy; x < w; x++, j += dx) to[j] = from[i++];
  }
  const turned = orientation >= 5;
  return { width: turned ? h : w, height: turned ? w : h, data: out };
}
