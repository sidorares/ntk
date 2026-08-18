// CanvasGradient: a gradient's coordinates are user space, resolved against
// the transform in force when it is *painted* (issue #271), and past its
// outermost stop it clamps to that stop's colour.
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed. It
// implements SetPictureTransform on gradient sources, which is what the
// user-space mapping rests on.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { StaticFontSource, createClient } from '../lib/index.js';

let app = null;
const W = 64;
const H = 64;

before(async () => {
  const server = xserver.createServer({ width: 200, height: 200 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  app = await createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
});

after(async () => {
  if (app) await app.close();
});

/** a fresh context painted opaque white, so every test owns its pixels */
function freshCtx() {
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H);
  return ctx;
}

const pixels = async (ctx) => {
  const img = await ctx.getImageData(0, 0, W, H);
  return (x, y) => [...img.data.slice((y * W + x) * 4, (y * W + x) * 4 + 3)];
};

/** black -> white along `len` user-space units of x, from the origin */
function rampX(ctx, len) {
  const g = ctx.createLinearGradient(0, 0, len, 0);
  g.addColorStop(0, 'black');
  g.addColorStop(1, 'white');
  return g;
}

const near = (actual, expected, tol, what) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: got ${actual}, want ~${expected}`);

test('a gradient is painted in user space: the CTM moves it', async () => {
  // the bug: the gradient stayed anchored to the window origin, so a fill
  // translated to a node's origin ran out of gradient partway across
  const ctx = freshCtx();
  ctx.translate(32, 0);
  ctx.fillStyle = rampX(ctx, 32);
  ctx.fillRect(0, 0, 32, H);

  const at = await pixels(ctx);
  assert.deepEqual(at(16, 32), [255, 255, 255], 'left of the fill is untouched');
  near(at(33, 32)[0], 0, 16, 'the ramp starts at the translated origin');
  near(at(48, 32)[0], 128, 16, 'and is halfway across at the middle');
  near(at(62, 32)[0], 255, 16, 'and reaches white at the far end');
});

test('the transform that counts is the one in force at paint time', async () => {
  // per the canvas spec (and every browser): a gradient created under a
  // transform and painted without it is not offset by that transform
  const ctx = freshCtx();
  ctx.translate(32, 0);
  const g = rampX(ctx, 32);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, H);

  const at = await pixels(ctx);
  near(at(1, 32)[0], 0, 16, 'the ramp starts at the device origin');
  near(at(30, 32)[0], 255, 16, 'and ends where its own coordinates say');
});

test('a scaled CTM scales the gradient with the drawing', async () => {
  const ctx = freshCtx();
  ctx.scale(2, 1);
  ctx.fillStyle = rampX(ctx, 32);
  ctx.fillRect(0, 0, 32, H); // 64 device pixels wide

  const at = await pixels(ctx);
  near(at(1, 32)[0], 0, 16, 'still black at the origin');
  near(at(32, 32)[0], 128, 16, 'the midpoint moved to device x=32');
  near(at(62, 32)[0], 255, 16, 'and white lands at the far edge');
});

test('a stroke and a fill of one gradient agree under a transform', async () => {
  const ctx = freshCtx();
  ctx.translate(16, 0);
  const g = rampX(ctx, 32);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 8);
  ctx.strokeStyle = g;
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(0, 20);
  ctx.lineTo(32, 20);
  ctx.stroke();

  const at = await pixels(ctx);
  for (const x of [20, 32, 44]) {
    near(at(x, 20)[0], at(x, 4)[0], 4, `x=${x}: the stroke matches the fill`);
  }
});

test('a fill through the clip mask keeps the gradient in user space', async () => {
  // a non-rectangular-clipped fill composites through the scratch a8 mask
  // rather than straight to the destination — a separate source path
  const ctx = freshCtx();
  ctx.translate(24, 0);
  ctx.fillStyle = rampX(ctx, 32);
  ctx.beginPath();
  ctx.rect(0, 0, 32, H);
  ctx.clip();
  ctx.fillRect(0, 0, 32, H);

  const at = await pixels(ctx);
  assert.deepEqual(at(8, 32), [255, 255, 255], 'outside the clip');
  near(at(25, 32)[0], 0, 16, 'the clipped fill still starts its ramp at the origin');
  near(at(54, 32)[0], 255, 16, 'and finishes it inside the clip');
});

test('globalAlpha over a gradient keeps the gradient in user space', async () => {
  // alpha < 1 with a non-plain style routes through the scratch mask, a
  // separate composite path from the direct one above
  const ctx = freshCtx();
  ctx.translate(32, 0);
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = rampX(ctx, 32);
  ctx.fillRect(0, 0, 32, H);

  const at = await pixels(ctx);
  assert.deepEqual(at(16, 32), [255, 255, 255], 'left of the fill is untouched');
  // black at half strength over white is mid gray; white over white is white
  near(at(33, 32)[0], 128, 20, 'the ramp starts at the translated origin');
  near(at(62, 32)[0], 255, 16, 'and still ends white');
});

test('a degenerate CTM paints nothing rather than the last transform', async () => {
  const ctx = freshCtx();
  ctx.fillStyle = rampX(ctx, 32);
  ctx.scale(0, 1);
  ctx.fillRect(0, 0, 64, H);

  const at = await pixels(ctx);
  assert.deepEqual(at(32, 32), [255, 255, 255], 'a collapsed transform has nothing to sample');
});

test('beyond its outermost stops a gradient clamps to their colours', async () => {
  const ctx = freshCtx();
  const g = ctx.createLinearGradient(24, 0, 40, 0);
  g.addColorStop(0, 'black');
  g.addColorStop(1, 'white');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const at = await pixels(ctx);
  near(at(4, 32)[0], 0, 6, 'before the first stop clamps to black');
  near(at(60, 32)[0], 255, 6, 'after the last stop clamps to white');
});
