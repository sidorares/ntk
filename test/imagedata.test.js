// The canvas pixel contract: getImageData/putImageData speak straight
// (non-premultiplied) RGBA, whatever the server underneath is doing.
//
// Split in two. The conversions are pure functions, so the byte-order and
// premultiply cases are tested directly — no X server can cover them here,
// because every server available to CI is LSBFirst. The rest runs against
// node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';
import {
  ImageData,
  fromStraightRgba,
  pixelLayout,
  toStraightRgba
} from '../lib/imagedata.js';

// --- pure conversions ------------------------------------------------------

const TRUECOLOR = {
  class: 4,
  red_mask: 0xff0000,
  green_mask: 0x00ff00,
  blue_mask: 0x0000ff
};

const fakeDisplay = (imageByteOrder) => ({
  image_byte_order: imageByteOrder,
  format: { 24: { bits_per_pixel: 32 }, 32: { bits_per_pixel: 32 } },
  screen: [{ root_depth: 24, depths: { 24: { 1: TRUECOLOR } } }]
});

describe('pixelLayout', () => {
  test('depth 24 has no alpha channel and is not premultiplied', () => {
    const l = pixelLayout(fakeDisplay(0), 24);
    assert.equal(l.masks.alpha, 0, 'the spare byte is padding, not opacity');
    assert.equal(l.premultiplied, false);
    assert.equal(l.byteOrder, 'lsb');
  });

  test('depth 32 gets ARGB32 positions even with no depth-32 visual', () => {
    // XQuartz exposes none at all, and this is the case that matters
    const l = pixelLayout(fakeDisplay(0), 32);
    assert.equal(l.masks.alpha >>> 0, 0xff000000);
    assert.equal(l.masks.red, 0xff0000);
    assert.equal(l.premultiplied, true, 'XRender composites premultiplied');
  });

  test('byteOrder follows image_byte_order, not the connection', () => {
    assert.equal(pixelLayout(fakeDisplay(1), 24).byteOrder, 'msb');
  });
});

describe('toStraightRgba', () => {
  test('LSBFirst depth 24 arrives B,G,R and comes out opaque RGBA', () => {
    const layout = pixelLayout(fakeDisplay(0), 24);
    // one pixel, and a fourth byte of junk that must not become the alpha
    const raw = Buffer.from([0x33, 0x22, 0x11, 0x00]);
    assert.deepEqual([...toStraightRgba(raw, layout, 1, 1)], [0x11, 0x22, 0x33, 255]);
  });

  test('MSBFirst reads the same pixel from the other end of the word', () => {
    const layout = pixelLayout(fakeDisplay(1), 24);
    const raw = Buffer.from([0x00, 0x11, 0x22, 0x33]);
    assert.deepEqual([...toStraightRgba(raw, layout, 1, 1)], [0x11, 0x22, 0x33, 255]);
  });

  test('depth 32 un-premultiplies', () => {
    const layout = pixelLayout(fakeDisplay(0), 32);
    // premultiplied half-alpha red: B=0 G=0 R=128 A=128
    const raw = Buffer.from([0x00, 0x00, 0x80, 0x80]);
    const [r, g, b, a] = toStraightRgba(raw, layout, 1, 1);
    assert.equal(a, 128);
    assert.ok(Math.abs(r - 255) <= 1, `red back to full, got ${r}`);
    assert.equal(g, 0);
    assert.equal(b, 0);
  });

  test('a fully transparent pixel does not divide by zero', () => {
    const layout = pixelLayout(fakeDisplay(0), 32);
    const out = toStraightRgba(Buffer.alloc(4), layout, 1, 1);
    assert.deepEqual([...out], [0, 0, 0, 0]);
  });

  test('the result is a Uint8ClampedArray, as the canvas spec says', () => {
    const layout = pixelLayout(fakeDisplay(0), 24);
    assert.ok(toStraightRgba(Buffer.alloc(4), layout, 1, 1) instanceof Uint8ClampedArray);
  });
});

describe('fromStraightRgba', () => {
  for (const order of [0, 1]) {
    const name = order ? 'MSBFirst' : 'LSBFirst';
    test(`${name}: depth 24 round-trips exactly`, () => {
      const layout = pixelLayout(fakeDisplay(order), 24);
      const rgba = new Uint8ClampedArray([0x11, 0x22, 0x33, 255, 0xaa, 0xbb, 0xcc, 255]);
      const packed = fromStraightRgba(rgba, layout, 2, 1);
      assert.deepEqual([...toStraightRgba(packed, layout, 2, 1)], [...rgba]);
    });

    test(`${name}: depth 32 round-trips through premultiplication`, () => {
      const layout = pixelLayout(fakeDisplay(order), 32);
      // alphas chosen so the premultiplied value divides back cleanly
      const rgba = new Uint8ClampedArray([255, 128, 0, 255, 255, 0, 0, 128]);
      const back = toStraightRgba(fromStraightRgba(rgba, layout, 2, 1), layout, 2, 1);
      assert.deepEqual([...back.slice(0, 4)], [255, 128, 0, 255]);
      const [r, g, b, a] = back.slice(4);
      assert.equal(a, 128);
      assert.ok(Math.abs(r - 255) <= 2, `red survives the round trip, got ${r}`);
      assert.equal(g, 0);
      assert.equal(b, 0);
    });
  }

  test('the two orders really do produce different bytes', () => {
    const rgba = new Uint8ClampedArray([0x11, 0x22, 0x33, 255]);
    const lsb = fromStraightRgba(rgba, pixelLayout(fakeDisplay(0), 24), 1, 1);
    const msb = fromStraightRgba(rgba, pixelLayout(fakeDisplay(1), 24), 1, 1);
    assert.notDeepEqual([...lsb], [...msb], 'otherwise the byte order is being ignored');
    assert.deepEqual([...lsb], [0x33, 0x22, 0x11, 0]);
    assert.deepEqual([...msb], [0, 0x11, 0x22, 0x33]);
  });
});

describe('ImageData', () => {
  test('(width, height) allocates transparent black', () => {
    const d = new ImageData(2, 3);
    assert.equal(d.width, 2);
    assert.equal(d.height, 3);
    assert.equal(d.data.length, 24);
    assert.ok(d.data.every((b) => b === 0));
    assert.equal(d.colorSpace, 'srgb');
  });

  test('(data, width) infers the height', () => {
    const d = new ImageData(new Uint8ClampedArray(24), 2);
    assert.equal(d.height, 3);
  });

  test('a Buffer is accepted and converted', () => {
    const d = new ImageData(Buffer.alloc(16), 2, 2);
    assert.ok(d.data instanceof Uint8ClampedArray);
  });

  test('a length that is not whole rows throws', () => {
    assert.throws(() => new ImageData(new Uint8ClampedArray(20), 3), /rows|pixels/);
  });

  test('a length that disagrees with an explicit height throws', () => {
    assert.throws(() => new ImageData(new Uint8ClampedArray(16), 2, 3), /must be 24 bytes/);
  });
});

// --- against the in-process X server ---------------------------------------

let app = null;

before(async () => {
  const server = xserver.createServer({ width: 200, height: 200 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  app = await createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
});

after(async () => {
  if (app) await app.close();
});

const W = 16;
const H = 16;

function freshCtx(depth = 24) {
  const pixmap = app.createPixmap({ width: W, height: H, depth });
  return pixmap.getContext('2d');
}

describe('getImageData', () => {
  test('returns canvas ImageData in RGBA order', async () => {
    const ctx = freshCtx();
    ctx.fillStyle = 'rgb(17, 34, 51)';
    ctx.fillRect(0, 0, W, H);

    const img = await ctx.getImageData(0, 0, W, H);
    assert.ok(img instanceof ImageData);
    assert.ok(img.data instanceof Uint8ClampedArray);
    assert.equal(img.width, W);
    assert.equal(img.data.length, W * H * 4);
    assert.deepEqual([...img.data.slice(0, 4)], [17, 34, 51, 255]);
  });

  test('a depth-24 read is opaque, not transparent', async () => {
    // the drawable's fourth byte is padding; reporting it as alpha made the
    // whole image transparent
    const ctx = freshCtx();
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, W, H);
    const img = await ctx.getImageData(0, 0, W, H);
    assert.ok([...img.data].filter((_, i) => i % 4 === 3).every((a) => a === 255));
  });

  test('the callback form still works and agrees with the promise', async () => {
    const ctx = freshCtx();
    ctx.fillStyle = 'rgb(10, 20, 30)';
    ctx.fillRect(0, 0, W, H);

    const viaCallback = await new Promise((resolve, reject) =>
      ctx.getImageData(0, 0, W, H, (err, d) => (err ? reject(err) : resolve(d)))
    );
    const viaPromise = await ctx.getImageData(0, 0, W, H);
    assert.deepEqual([...viaCallback.data], [...viaPromise.data]);
  });

  test('errors reach the callback rather than becoming an unhandled rejection', async () => {
    const ctx = freshCtx();
    ctx.canvas.destroy(); // reading a freed drawable is a BadDrawable
    const err = await new Promise((resolve) =>
      ctx.getImageData(0, 0, W, H, (e) => resolve(e))
    );
    assert.ok(err, 'expected an X error');
  });

  test('errors reject the promise when no callback is given', async () => {
    const ctx = freshCtx();
    ctx.canvas.destroy();
    await assert.rejects(() => ctx.getImageData(0, 0, W, H));
  });

  test('a translucent fill on a depth-32 target reads back straight', async () => {
    const ctx = freshCtx(32);
    ctx.fillStyle = 'rgba(255, 0, 0, 0.5)';
    ctx.fillRect(0, 0, W, H);

    const img = await ctx.getImageData(0, 0, W, H);
    const [r, g, b, a] = img.data.slice(0, 4);
    assert.ok(Math.abs(a - 128) <= 2, `half alpha, got ${a}`);
    assert.ok(r > 245, `red is straight, not premultiplied down to ~128 (got ${r})`);
    assert.equal(g, 0);
    assert.equal(b, 0);
  });
});

describe('putImageData', () => {
  test('createImageData -> fill RGBA -> putImageData round-trips', async () => {
    // the path that used to swap red and blue: the canvas idiom, where the
    // caller never sees a server byte
    const ctx = freshCtx();
    const data = ctx.createImageData(W, H);
    for (let i = 0; i < data.data.length; i += 4) {
      data.data[i] = 200; // r
      data.data[i + 1] = 100; // g
      data.data[i + 2] = 50; // b
      data.data[i + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);

    const back = await ctx.getImageData(0, 0, W, H);
    assert.deepEqual([...back.data.slice(0, 4)], [200, 100, 50, 255]);
  });

  test('what getImageData read can be written straight back', async () => {
    const ctx = freshCtx();
    ctx.fillStyle = 'rgb(1, 2, 3)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgb(250, 240, 230)';
    ctx.fillRect(0, 0, 4, 4);

    const first = await ctx.getImageData(0, 0, W, H);
    const other = freshCtx();
    other.putImageData(first, 0, 0);
    const second = await other.getImageData(0, 0, W, H);
    assert.deepEqual([...second.data], [...first.data]);
  });

  test('the dirty rectangle limits the write to part of the source', async () => {
    const ctx = freshCtx();
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, W, H);

    const data = ctx.createImageData(W, H);
    data.data.fill(255); // opaque white everywhere

    ctx.putImageData(data, 0, 0, 2, 2, 4, 4);
    const back = await ctx.getImageData(0, 0, W, H);
    const at = (x, y) => [...back.data.slice((y * W + x) * 4, (y * W + x) * 4 + 3)];
    assert.deepEqual(at(3, 3), [255, 255, 255], 'inside the dirty rect');
    assert.deepEqual(at(1, 1), [0, 0, 0], 'above-left of it, untouched');
    assert.deepEqual(at(7, 7), [0, 0, 0], 'below-right of it, untouched');
  });

  test('data of the wrong length is rejected rather than sent', () => {
    const ctx = freshCtx();
    assert.throws(
      () => ctx.putImageData({ width: 4, height: 4, data: new Uint8ClampedArray(16) }, 0, 0),
      /must be 64 RGBA bytes/
    );
  });
});

describe('createImageData', () => {
  test('the copy form takes the size and leaves the pixels blank', () => {
    const ctx = freshCtx();
    const src = ctx.createImageData(3, 5);
    src.data.fill(9);
    const copy = ctx.createImageData(src);
    assert.equal(copy.width, 3);
    assert.equal(copy.height, 5);
    assert.ok(copy.data.every((b) => b === 0), 'spec says blank, not a clone');
  });
});

describe('composition with Image', () => {
  test('an ImageData can be handed straight to new Image()', async () => {
    // both sides are straight RGBA now, so no conversion in user code
    const { Image } = await import('../lib/image.js');
    const ctx = freshCtx();
    ctx.fillStyle = 'rgb(12, 34, 56)';
    ctx.fillRect(0, 0, W, H);

    const img = new Image(await ctx.getImageData(0, 0, W, H));
    assert.equal(img.width, W);

    const target = freshCtx();
    target.fillStyle = 'black';
    target.fillRect(0, 0, W, H);
    target.drawImage(img, 0, 0);

    const back = await target.getImageData(0, 0, W, H);
    assert.deepEqual([...back.data.slice(0, 4)], [12, 34, 56, 255]);
  });
});

describe('readPixels', () => {
  test('reports the layout alongside the server bytes', async () => {
    const ctx = freshCtx();
    ctx.fillStyle = 'rgb(17, 34, 51)';
    ctx.fillRect(0, 0, W, H);

    const raw = await ctx.readPixels(0, 0, W, H);
    assert.equal(raw.depth, 24);
    assert.equal(raw.byteOrder, 'lsb');
    assert.equal(raw.premultiplied, false);
    assert.equal(raw.masks.red, 0xff0000);
    assert.equal(raw.masks.alpha, 0);
    // unconverted, so on this LSBFirst server the bytes are B, G, R
    assert.deepEqual([...raw.data.subarray(0, 3)], [51, 34, 17]);
  });

  test('its bytes are what getImageData converts', async () => {
    const ctx = freshCtx();
    ctx.fillStyle = 'rgb(9, 99, 199)';
    ctx.fillRect(0, 0, W, H);

    const raw = await ctx.readPixels(0, 0, W, H);
    const converted = toStraightRgba(raw.data, raw.layout, W, H);
    const img = await ctx.getImageData(0, 0, W, H);
    assert.deepEqual([...converted], [...img.data]);
  });
});
