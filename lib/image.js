import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

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

    // node-x11 has no FreeGC — share one upload GC per app (valid for any
    // depth-32 drawable on the screen)
    let gc = app._imageUploadGC;
    if (!gc) {
      gc = app._imageUploadGC = X.AllocID();
      X.CreateGC(gc, pixmap.id);
    }
    // stay under the server's maximum request size by uploading row bands
    const stride = this.width * 4;
    const maxBytes = ((app.display.max_request_length ?? 65535) - 8) * 4;
    const rowsPerBand = Math.max(1, Math.floor(maxBytes / stride));
    for (let y = 0; y < this.height; y += rowsPerBand) {
      const rows = Math.min(rowsPerBand, this.height - y);
      X.PutImage(2, pixmap.id, gc, this.width, rows, 0, y, 0, 32, bgra.subarray(y * stride, (y + rows) * stride));
    }

    const picture = new Picture(app, { drawable: pixmap, format: Render.rgba32 });
    upload = { pixmap, picture };
    this._uploads.set(app, upload);
    return picture;
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

/**
 * Decode a PNG or JPEG buffer (sniffed by magic bytes) into an Image.
 *
 * @param {Buffer|Uint8Array} buffer encoded image bytes
 * @returns {Image}
 */
export function decodeImage(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length > 4 && PNG_MAGIC.every((b, i) => buf[i] === b)) {
    const png = PNG.sync.read(buf);
    return new Image({ width: png.width, height: png.height, data: png.data });
  }
  if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) {
    const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 512 });
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
 * @returns {Promise<Image>}
 */
export async function loadImage(source) {
  if (typeof source === 'string' || source instanceof URL) {
    // lazy builtin lookup: browser bundles must not depend on node:fs
    const fsp = globalThis.process?.getBuiltinModule?.('node:fs/promises');
    if (!fsp) {
      throw new Error('loadImage: file paths need node — pass the encoded bytes instead');
    }
    return decodeImage(await fsp.readFile(source));
  }
  return decodeImage(source);
}
