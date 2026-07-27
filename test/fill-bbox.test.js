// _fillPolys bounds its mask work to the shape's bounding box rather than
// the whole surface. Three things that could break: stale mask content
// from a previous fill leaking in, a shape crossing the surface edge, and
// the antialiased edge losing its slack.
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';

let app = null;
const W = 120;
const H = 120;

before(async () => {
  const server = xserver.createServer({ width: 200, height: 200 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  app = await createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
});

after(async () => {
  if (app) await app.close();
});

function freshCtx() {
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H);
  return ctx;
}

const read = (ctx) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, W, H, (err, d) => (err ? reject(err) : resolve(d))),
  );

// BGRA -> [r, g, b]
const at = (img, x, y) => {
  const i = (y * W + x) * 4;
  return [img.data[i + 2], img.data[i + 1], img.data[i]];
};
const isWhite = (p) => p[0] > 240 && p[1] > 240 && p[2] > 240;

test('a later fill does not leak the previous shape through a stale mask', async () => {
  const ctx = freshCtx();
  // a big shape, then a small one far away: the small fill must not drag
  // any of the big one's coverage along with it
  ctx.fillStyle = 'red';
  ctx.beginPath();
  ctx.rect(0, 0, 60, 60);
  ctx.fill();
  ctx.fillStyle = 'blue';
  ctx.beginPath();
  ctx.rect(90, 90, 20, 20);
  ctx.fill();

  const img = await read(ctx);
  assert.deepEqual(at(img, 10, 10), [255, 0, 0], 'first shape still red');
  assert.deepEqual(at(img, 95, 95), [0, 0, 255], 'second shape blue');
  assert.ok(isWhite(at(img, 75, 20)), 'gap between them untouched');
  assert.ok(isWhite(at(img, 20, 75)), 'and below the first shape');
});

test('a shape crossing the surface edge still fills what is on-surface', async () => {
  const ctx = freshCtx();
  ctx.fillStyle = 'green';
  ctx.beginPath();
  // starts off-surface on both axes and ends inside it
  ctx.rect(-30, -30, 70, 70);
  ctx.fill();

  const img = await read(ctx);
  assert.deepEqual(at(img, 0, 0), [0, 128, 0], 'top-left corner filled');
  assert.deepEqual(at(img, 30, 30), [0, 128, 0], 'interior filled');
  assert.ok(isWhite(at(img, 60, 60)), 'past the shape is untouched');
});

test('overlapping fills still composite in order', async () => {
  const ctx = freshCtx();
  ctx.fillStyle = 'red';
  ctx.beginPath();
  ctx.rect(10, 10, 50, 50);
  ctx.fill();
  ctx.fillStyle = 'blue';
  ctx.beginPath();
  ctx.rect(35, 35, 50, 50);
  ctx.fill();

  const img = await read(ctx);
  assert.deepEqual(at(img, 20, 20), [255, 0, 0], 'red where only red is');
  assert.deepEqual(at(img, 45, 45), [0, 0, 255], 'blue wins the overlap');
  assert.deepEqual(at(img, 75, 75), [0, 0, 255], 'blue where only blue is');
});

test('a clipped fill is still clipped', async () => {
  const ctx = freshCtx();
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, 40);
  ctx.clip();
  ctx.fillStyle = 'red';
  ctx.beginPath();
  ctx.rect(10, 10, 60, 80); // extends well past the clip
  ctx.fill();
  ctx.restore();

  const img = await read(ctx);
  assert.deepEqual(at(img, 20, 20), [255, 0, 0], 'inside the clip is filled');
  assert.ok(isWhite(at(img, 20, 60)), 'below the clip is untouched');
});
