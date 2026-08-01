/**
 * The canvas pixel contract, and the conversions between it and what an X
 * server actually hands over.
 *
 * Canvas `ImageData` is straight (non-premultiplied) RGBA bytes, one byte per
 * channel, rows top to bottom. An X drawable is none of those things by
 * default:
 *
 *   - `GetImage` returns the drawable's raw words in the *server's*
 *     `image_byte_order`, which is a different field from the byte order this
 *     connection speaks;
 *   - which bits inside a word hold which channel comes from the visual's
 *     masks, not from a convention;
 *   - anything XRender composited into is premultiplied, and a drawable
 *     without an alpha channel has a fourth byte that is undefined padding
 *     rather than opaque.
 *
 * Everything crossing that boundary goes through here, so callers see RGBA
 * and only this file knows about the rest. `readPixels()` is the way out for
 * code that genuinely wants the server's own bytes — it reports the layout
 * alongside them instead of leaving the caller to assume one.
 */

/** shift of the lowest set bit, i.e. where a channel starts inside a word */
function shiftOf(mask) {
  let s = 0;
  while (s < 32 && !((mask >>> s) & 1)) s++;
  return s;
}

/** width of a contiguous mask, so 5- and 6-bit channels can be scaled to 8 */
function widthOf(mask, shift) {
  let w = 0;
  while (shift + w < 32 && (mask >>> (shift + w)) & 1) w++;
  return w;
}

/**
 * How pixels of `depth` are laid out on this display: which bits hold which
 * channel, whether there is an alpha channel at all, and which end of a word
 * the server writes first.
 *
 * Channel positions come from a TrueColor visual of that depth when the
 * screen has one. Depth 32 has no visual on most servers (XQuartz has none at
 * all) but every depth-32 drawable ntk makes is paired with a `Render.rgba32`
 * picture, whose PictStandardARGB32 format pins A=24 R=16 G=8 B=0 — so that
 * is the fallback, and it is a specification rather than a guess.
 */
export function pixelLayout(display, depth) {
  const screen = display.screen[0];
  let masks = null;
  for (const visual of Object.values(screen.depths?.[depth] ?? {})) {
    if (visual.class === 4 || visual.class === 5) {
      // TrueColor / DirectColor
      masks = { red: visual.red_mask, green: visual.green_mask, blue: visual.blue_mask };
      break;
    }
  }
  if (!masks) masks = { red: 0xff0000, green: 0x00ff00, blue: 0x0000ff };

  const bitsPerPixel = display.format?.[depth]?.bits_per_pixel ?? (depth > 16 ? 32 : depth);
  if (bitsPerPixel !== 32) {
    throw new Error(
      `ntk works in 32-bit pixels; depth ${depth} on this server is ` +
        `${bitsPerPixel} bits per pixel. Use readPixels() and unpack it yourself.`
    );
  }

  const hasAlpha = depth === 32;
  // whatever the colour masks leave over, which for ARGB32 is the top byte
  const alpha = hasAlpha ? (~(masks.red | masks.green | masks.blue) & 0xffffffff) >>> 0 : 0;

  return {
    depth,
    bitsPerPixel,
    masks: { ...masks, alpha },
    // 0 LSBFirst, 1 MSBFirst — the server's pixel order, NOT display.byte_order
    byteOrder: display.image_byte_order ? 'msb' : 'lsb',
    // XRender composites premultiplied, so anything with an alpha channel
    // that ntk has drawn into holds premultiplied colour
    premultiplied: hasAlpha
  };
}

/** the common case: LSBFirst words with 8-bit channels at ARGB32 positions */
function isStandardLsb(layout) {
  return (
    layout.byteOrder === 'lsb' &&
    layout.masks.red === 0xff0000 &&
    layout.masks.green === 0x00ff00 &&
    layout.masks.blue === 0x0000ff
  );
}

/**
 * Server pixels -> straight RGBA. `raw` is a `GetImage` reply body.
 *
 * @param {Buffer} raw
 * @param {object} layout from `pixelLayout()`
 * @param {number} width
 * @param {number} height
 * @returns {Uint8ClampedArray}
 */
export function toStraightRgba(raw, layout, width, height) {
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  const { premultiplied } = layout;

  if (isStandardLsb(layout)) {
    // bytes arrive B, G, R, A — a straight index shuffle, which measures
    // faster than reading 32-bit words back out of the Buffer
    for (let i = 0; i < n * 4; i += 4) {
      const a = layout.depth === 32 ? raw[i + 3] : 255;
      if (a === 255) {
        out[i] = raw[i + 2];
        out[i + 1] = raw[i + 1];
        out[i + 2] = raw[i];
      } else if (a === 0 || !premultiplied) {
        out[i] = raw[i + 2];
        out[i + 1] = raw[i + 1];
        out[i + 2] = raw[i];
      } else {
        out[i] = (raw[i + 2] * 255) / a;
        out[i + 1] = (raw[i + 1] * 255) / a;
        out[i + 2] = (raw[i] * 255) / a;
      }
      out[i + 3] = a;
    }
    return out;
  }

  const { masks } = layout;
  const rs = shiftOf(masks.red);
  const gs = shiftOf(masks.green);
  const bs = shiftOf(masks.blue);
  const as = masks.alpha ? shiftOf(masks.alpha) : 0;
  const rw = widthOf(masks.red, rs);
  const gw = widthOf(masks.green, gs);
  const bw = widthOf(masks.blue, bs);
  // scale a channel of `w` bits up to 8, so 0b11111 becomes 255 not 248
  const up = (v, w) => (w === 8 ? v : Math.round((v * 255) / ((1 << w) - 1)));
  const readWord = layout.byteOrder === 'msb'
    ? (o) => raw.readUInt32BE(o)
    : (o) => raw.readUInt32LE(o);

  for (let i = 0; i < n; i++) {
    const px = readWord(i * 4);
    const a = masks.alpha ? (px & masks.alpha) >>> as : 255;
    let r = up((px & masks.red) >>> rs, rw);
    let g = up((px & masks.green) >>> gs, gw);
    let b = up((px & masks.blue) >>> bs, bw);
    if (premultiplied && a !== 0 && a !== 255) {
      r = (r * 255) / a;
      g = (g * 255) / a;
      b = (b * 255) / a;
    }
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = a;
  }
  return out;
}

/**
 * Straight RGBA -> server pixels, ready for `PutImage`.
 *
 * @param {Uint8Array} rgba straight RGBA, 4 bytes per pixel
 * @param {object} layout from `pixelLayout()`
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
export function fromStraightRgba(rgba, layout, width, height) {
  const n = width * height;
  const out = Buffer.allocUnsafe(n * 4);
  const { premultiplied } = layout;

  if (isStandardLsb(layout)) {
    for (let i = 0; i < n * 4; i += 4) {
      const a = rgba[i + 3];
      if (!premultiplied || a === 255) {
        out[i] = rgba[i + 2];
        out[i + 1] = rgba[i + 1];
        out[i + 2] = rgba[i];
      } else {
        // +127 rounds to nearest rather than truncating, which otherwise
        // drifts a translucent fill visibly darker over repeated round trips
        out[i] = (rgba[i + 2] * a + 127) / 255;
        out[i + 1] = (rgba[i + 1] * a + 127) / 255;
        out[i + 2] = (rgba[i] * a + 127) / 255;
      }
      out[i + 3] = layout.depth === 32 ? a : 0;
    }
    return out;
  }

  const { masks } = layout;
  const rs = shiftOf(masks.red);
  const gs = shiftOf(masks.green);
  const bs = shiftOf(masks.blue);
  const as = masks.alpha ? shiftOf(masks.alpha) : 0;
  const rw = widthOf(masks.red, rs);
  const gw = widthOf(masks.green, gs);
  const bw = widthOf(masks.blue, bs);
  const down = (v, w) => (w === 8 ? v : Math.round((v * ((1 << w) - 1)) / 255));
  const writeWord = layout.byteOrder === 'msb'
    ? (v, o) => out.writeUInt32BE(v, o)
    : (v, o) => out.writeUInt32LE(v, o);

  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3];
    let r = rgba[i * 4];
    let g = rgba[i * 4 + 1];
    let b = rgba[i * 4 + 2];
    if (premultiplied && a !== 255) {
      r = (r * a + 127) / 255;
      g = (g * a + 127) / 255;
      b = (b * a + 127) / 255;
    }
    const word =
      ((down(r | 0, rw) << rs) |
        (down(g | 0, gw) << gs) |
        (down(b | 0, bw) << bs) |
        (masks.alpha ? (a << as) & masks.alpha : 0)) >>>
      0;
    writeWord(word, i * 4);
  }
  return out;
}

/**
 * Canvas `ImageData`: straight RGBA in a `Uint8ClampedArray`, rows top to
 * bottom. Both spec constructor forms work:
 *
 *   new ImageData(width, height)
 *   new ImageData(data, width[, height])
 *
 * `data` may be any `Uint8Array` — a node `Buffer` included — and is adopted
 * as-is when it is already a `Uint8ClampedArray`, copied otherwise.
 */
export class ImageData {
  constructor(a, b, c) {
    if (typeof a === 'number') {
      const width = a;
      const height = b;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new Error('ImageData: width and height must be positive integers');
      }
      this.width = width;
      this.height = height;
      this.data = new Uint8ClampedArray(width * height * 4);
      return;
    }
    if (!ArrayBuffer.isView(a)) {
      throw new TypeError('ImageData: first argument must be a width or a typed array');
    }
    const width = b;
    if (!Number.isInteger(width) || width <= 0) {
      throw new Error('ImageData: width must be a positive integer');
    }
    if (a.length % 4 !== 0) {
      throw new Error(`ImageData: data length ${a.length} is not a whole number of RGBA pixels`);
    }
    const height = c ?? a.length / 4 / width;
    if (!Number.isInteger(height) || height <= 0) {
      throw new Error(`ImageData: ${a.length} bytes is not a whole number of ${width}px rows`);
    }
    if (a.length !== width * height * 4) {
      throw new Error(
        `ImageData: data must be ${width * height * 4} bytes for ${width}x${height}, got ${a.length}`
      );
    }
    this.width = width;
    this.height = height;
    this.data =
      a instanceof Uint8ClampedArray
        ? a
        : new Uint8ClampedArray(a.buffer, a.byteOffset, a.byteLength).slice();
  }

  /** the sRGB colour space, for parity with the browser's property */
  get colorSpace() {
    return 'srgb';
  }
}

// --- EWMH _NET_WM_ICON -----------------------------------------------------
//
// The property is a run of CARD32s, repeated once per size:
//
//   width, height, pixel[0] … pixel[width*height-1]
//
// Each pixel is straight ARGB inside the word — A=24 R=16 G=8 B=0. Straight,
// not premultiplied, which is the same thing ImageData holds, so this is a
// repack rather than a conversion. The one thing to get right is which byte
// order: a format-32 property is read back by the server in the *connection's*
// byte order, which is a different handshake field from the image_byte_order
// that `pixelLayout()` uses for GetImage.

const wordIO = (display) =>
  display.byte_order
    ? { read: (b, o) => b.readUInt32BE(o), write: (b, v, o) => b.writeUInt32BE(v, o) }
    : { read: (b, o) => b.readUInt32LE(o), write: (b, v, o) => b.writeUInt32LE(v, o) };

/**
 * Pack one or more images into `_NET_WM_ICON` property bytes.
 *
 * @param {Array<{width: number, height: number, data: Uint8Array}>} images
 *   straight RGBA, as `Image` and `ImageData` both are
 * @param {object} display
 * @returns {Buffer}
 */
export function packIcons(images, display) {
  let words = 0;
  images.forEach((img, i) => {
    const { width, height, data } = img ?? {};
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error(`icon ${i}: width and height must be positive integers`);
    }
    if (!data || data.length !== width * height * 4) {
      throw new Error(
        `icon ${i}: data must be ${width * height * 4} RGBA bytes for ${width}x${height}, ` +
          `got ${data ? data.length : 'nothing'}`
      );
    }
    words += 2 + width * height;
  });

  const out = Buffer.allocUnsafe(words * 4);
  const { write } = wordIO(display);
  let o = 0;
  for (const { width, height, data } of images) {
    write(out, width, o);
    write(out, height, o + 4);
    o += 8;
    for (let i = 0; i < width * height; i++) {
      write(
        out,
        (((data[i * 4 + 3] << 24) |
          (data[i * 4] << 16) |
          (data[i * 4 + 1] << 8) |
          data[i * 4 + 2]) >>>
          0),
        o
      );
      o += 4;
    }
  }
  return out;
}

/**
 * Read `_NET_WM_ICON` bytes back into images.
 *
 * Deliberately forgiving about what it is handed: a window manager runs this
 * over properties written by other people's clients, so a truncated or
 * nonsensical run stops the scan and returns whatever parsed cleanly rather
 * than throwing or trying to allocate a claimed 4-gigapixel icon.
 *
 * @returns {ImageData[]}
 */
export function unpackIcons(buf, display) {
  const { read } = wordIO(display);
  const out = [];
  let o = 0;
  while (o + 8 <= buf.length) {
    const width = read(buf, o);
    const height = read(buf, o + 4);
    // guard the multiplication itself, not just its result
    if (width <= 0 || height <= 0 || width > 0xffff || height > 0xffff) break;
    const pixels = width * height;
    if (o + 8 + pixels * 4 > buf.length) break;
    o += 8;

    const rgba = new Uint8ClampedArray(pixels * 4);
    for (let i = 0; i < pixels; i++) {
      const px = read(buf, o + i * 4);
      rgba[i * 4] = (px >>> 16) & 0xff;
      rgba[i * 4 + 1] = (px >>> 8) & 0xff;
      rgba[i * 4 + 2] = px & 0xff;
      rgba[i * 4 + 3] = (px >>> 24) & 0xff;
    }
    o += pixels * 4;
    out.push(new ImageData(rgba, width, height));
  }
  return out;
}
