// End-to-end pixel tests for the canvas parity features: transforms,
// save/restore, arcs, Path2D, fill rules, clipping, globalAlpha, strokes
// and the SVG widget. Runs against a real X server; skips without one.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createClient, Path2D, SvgView } from '../lib/index.js';

const withTimeout = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${what}`)), ms).unref())
  ]);

let app = null;
let skip = false;

before(async () => {
  if (!process.env.DISPLAY) {
    skip = 'no DISPLAY set';
    return;
  }
  try {
    app = await withTimeout(createClient(), 5000, 'connecting to X server');
  } catch (err) {
    skip = `cannot connect to X server: ${err.message}`;
  }
});

after(async () => {
  if (app) await app.close();
});

const readPixels = (ctx, w, h) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, w, h, (err, data) => (err ? reject(err) : resolve(data)))
  );

// BGRA readback -> [r, g, b]
const px = (image, w, x, y) => {
  const i = (y * w + x) * 4;
  return [image.data[i + 2], image.data[i + 1], image.data[i]];
};

function freshCtx(size = 64) {
  const pixmap = app.createPixmap({ width: size, height: size, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, size, size);
  return { pixmap, ctx };
}

test('transforms: translate+rotate reposition fillRect', async (t) => {
  if (skip) return t.skip(skip);
  const { pixmap, ctx } = freshCtx();

  ctx.save();
  ctx.translate(32, 32);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = 'red';
  ctx.fillRect(-10, -10, 20, 20); // 20x20 diamond centered at (32,32)
  ctx.restore();

  const image = await readPixels(ctx, 64, 64);
  assert.deepEqual(px(image, 64, 32, 32), [255, 0, 0], 'diamond center is red');
  // (44,32): inside the rotated square (half-diagonal ~14.1), outside the
  // axis-aligned one (half-width 10) — proves the rotation actually applied
  assert.deepEqual(px(image, 64, 44, 32), [255, 0, 0], 'diamond tip is red');
  assert.deepEqual(px(image, 64, 41, 41), [255, 255, 255], 'axis-aligned corner stays white');
  pixmap.destroy();
});

test('transforms: scale applies to paths and restore rolls it back', async (t) => {
  if (skip) return t.skip(skip);
  const { pixmap, ctx } = freshCtx();

  ctx.save();
  ctx.scale(2, 2);
  ctx.fillStyle = 'blue';
  ctx.beginPath();
  ctx.rect(4, 4, 10, 10); // device: 8..28
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = 'red';
  ctx.fillRect(40, 40, 4, 4); // untransformed after restore

  const image = await readPixels(ctx, 64, 64);
  assert.deepEqual(px(image, 64, 20, 20), [0, 0, 255], 'scaled rect covers 2x area');
  assert.deepEqual(px(image, 64, 30, 30), [255, 255, 255], 'outside scaled rect');
  assert.deepEqual(px(image, 64, 41, 41), [255, 0, 0], 'restore reset the transform');
  pixmap.destroy();
});

test('arc: filled circle has correct inside/outside pixels', async (t) => {
  if (skip) return t.skip(skip);
  const { pixmap, ctx } = freshCtx();

  ctx.fillStyle = 'black';
  ctx.beginPath();
  ctx.arc(32, 32, 16, 0, Math.PI * 2);
  ctx.fill();

  const image = await readPixels(ctx, 64, 64);
  assert.deepEqual(px(image, 64, 32, 32), [0, 0, 0], 'center');
  assert.deepEqual(px(image, 64, 32 + 10, 32), [0, 0, 0], 'inside radius');
  assert.deepEqual(px(image, 64, 32 + 24, 32), [255, 255, 255], 'outside radius');
  assert.deepEqual(px(image, 64, 32 + 13, 32 + 13), [255, 255, 255], 'outside diagonal');
  pixmap.destroy();
});

test('Path2D: SVG path fills with even-odd hole', async (t) => {
  if (skip) return t.skip(skip);
  const { pixmap, ctx } = freshCtx();

  const path = new Path2D('M8 8 H56 V56 H8 Z M24 24 H40 V40 H24 Z');
  ctx.fillStyle = 'green';
  ctx.fill(path, 'evenodd');

  const image = await readPixels(ctx, 64, 64);
  assert.deepEqual(px(image, 64, 16, 16), [0, 128, 0], 'ring is green');
  assert.deepEqual(px(image, 64, 32, 32), [255, 255, 255], 'even-odd hole stays white');
  pixmap.destroy();
});

test('clip: fill is constrained to the clip path and restore clears it', async (t) => {
  if (skip) return t.skip(skip);
  const { pixmap, ctx } = freshCtx();

  ctx.save();
  ctx.beginPath();
  ctx.arc(32, 32, 12, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = 'red';
  ctx.fillRect(0, 0, 64, 64);
  ctx.restore();

  ctx.fillStyle = 'blue';
  ctx.fillRect(0, 0, 6, 6); // after restore: unclipped again

  const image = await readPixels(ctx, 64, 64);
  assert.deepEqual(px(image, 64, 32, 32), [255, 0, 0], 'inside clip circle');
  assert.deepEqual(px(image, 64, 8, 32), [255, 255, 255], 'outside clip circle');
  assert.deepEqual(px(image, 64, 2, 2), [0, 0, 255], 'clip cleared by restore');
  pixmap.destroy();
});

test('globalAlpha: half-transparent fill blends with the background', async (t) => {
  if (skip) return t.skip(skip);
  const { pixmap, ctx } = freshCtx();

  ctx.globalAlpha = 0.5;
  ctx.fillStyle = 'red';
  ctx.fillRect(8, 8, 48, 48);
  ctx.globalAlpha = 1;

  const image = await readPixels(ctx, 64, 64);
  const [r, g, b] = px(image, 64, 32, 32);
  assert.ok(r > 200, `red stays high, got ${r}`);
  assert.ok(g > 90 && g < 170, `green blended toward white, got ${g}`);
  assert.ok(b > 90 && b < 170, `blue blended toward white, got ${b}`);
  pixmap.destroy();
});

test('stroke: lineWidth and clipped strokes honor the mask path', async (t) => {
  if (skip) return t.skip(skip);
  const { pixmap, ctx } = freshCtx();

  ctx.strokeStyle = 'black';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(8, 32);
  ctx.lineTo(56, 32);
  ctx.stroke();

  // clipped stroke: only the left half may draw
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 40, 32, 24);
  ctx.clip();
  ctx.strokeStyle = 'red';
  ctx.beginPath();
  ctx.moveTo(0, 52);
  ctx.lineTo(64, 52);
  ctx.stroke();
  ctx.restore();

  const image = await readPixels(ctx, 64, 64);
  assert.deepEqual(px(image, 64, 32, 32), [0, 0, 0], 'stroke center');
  assert.deepEqual(px(image, 64, 32, 36), [255, 255, 255], 'above/below 6px stroke');
  assert.deepEqual(px(image, 64, 16, 52), [255, 0, 0], 'clipped stroke inside clip');
  assert.deepEqual(px(image, 64, 48, 52), [255, 255, 255], 'clipped stroke outside clip');
  pixmap.destroy();
});

test('strokeRect and quadraticCurveTo render', async (t) => {
  if (skip) return t.skip(skip);
  const { pixmap, ctx } = freshCtx();

  ctx.strokeStyle = 'blue';
  ctx.lineWidth = 4;
  ctx.strokeRect(8, 8, 48, 48);

  ctx.fillStyle = 'black';
  ctx.beginPath();
  ctx.moveTo(16, 48);
  ctx.quadraticCurveTo(32, 0, 48, 48);
  ctx.fill();

  const image = await readPixels(ctx, 64, 64);
  assert.deepEqual(px(image, 64, 32, 8), [0, 0, 255], 'strokeRect top edge');
  assert.deepEqual(px(image, 64, 32, 30), [0, 0, 0], 'quad curve interior');
  pixmap.destroy();
});

test('SvgView draws a document into any 2d context', async (t) => {
  if (skip) return t.skip(skip);
  const { pixmap, ctx } = freshCtx();

  const view = new SvgView(null);
  view.setSvg(`<svg viewBox="0 0 16 16">
    <rect width="16" height="16" fill="#0000ff"/>
    <circle cx="8" cy="8" r="4" fill="red"/>
  </svg>`);
  view.draw(ctx, 0, 0, 64, 64);

  const image = await readPixels(ctx, 64, 64);
  assert.deepEqual(px(image, 64, 32, 32), [255, 0, 0], 'scaled circle center is red');
  assert.deepEqual(px(image, 64, 4, 4), [0, 0, 255], 'background rect is blue');
  assert.deepEqual(px(image, 64, 32, 6), [0, 0, 255], 'above circle is blue');
  pixmap.destroy();
});
