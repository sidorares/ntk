// Pure client-side image decoding tests (no X server needed).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

import { Image, decodeImage, loadImage } from '../lib/image.js';

function encodePng(width, height, paint) {
  const png = new PNG({ width, height });
  paint(png.data);
  return PNG.sync.write(png);
}

test('decodeImage: PNG round-trips pixels', () => {
  const buf = encodePng(2, 1, (d) => {
    d.set([255, 0, 0, 255, 0, 0, 255, 128]); // red, half-transparent blue
  });
  const img = decodeImage(buf);
  assert.ok(img instanceof Image);
  assert.equal(img.width, 2);
  assert.equal(img.height, 1);
  assert.deepEqual([...img.data.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...img.data.subarray(4, 8)], [0, 0, 255, 128]);
});

test('decodeImage: JPEG decodes to full-alpha RGBA', () => {
  const raw = Buffer.alloc(4 * 4 * 4);
  for (let i = 0; i < raw.length; i += 4) raw.set([200, 100, 50, 255], i);
  const enc = jpeg.encode({ width: 4, height: 4, data: raw }, 100);
  const img = decodeImage(enc.data);
  assert.equal(img.width, 4);
  assert.equal(img.height, 4);
  // lossy: just require the channel ordering to survive
  assert.ok(img.data[0] > 150, `r ${img.data[0]}`);
  assert.ok(img.data[2] < 120, `b ${img.data[2]}`);
  assert.equal(img.data[3], 255);
});

test('decodeImage: rejects unknown formats', () => {
  assert.throws(() => decodeImage(Buffer.from('GIF89a not supported here')), /unsupported image format/);
});

test('loadImage: accepts buffers and rejects bad paths', async () => {
  const img = await loadImage(encodePng(1, 1, (d) => d.set([1, 2, 3, 255])));
  assert.equal(img.width, 1);
  await assert.rejects(loadImage('/nonexistent/na.png'));
});

test('Image: validates dimensions against data length', () => {
  assert.throws(() => new Image({ width: 2, height: 2, data: Buffer.alloc(4) }), /RGBA/);
  assert.throws(() => new Image({ width: 0, height: 2, data: Buffer.alloc(0) }), /positive/);
  const ok = new Image({ width: 1, height: 2, data: Buffer.alloc(8) });
  assert.equal(ok.height, 2);
});
