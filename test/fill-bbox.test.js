// _fillPolys and _strokePolys bound their mask work to the shape's bounding
// box rather than the whole surface. Three things that could break: stale
// mask content from a previous draw leaking in, a shape crossing the surface
// edge, and the antialiased edge losing its slack.
//
// The stroke cases all force the *masked* branch of _strokePolys — round
// caps, a clip or globalAlpha below 1. The other branch composites straight
// to the destination and never touches the scratch mask, so it cannot show
// any of these bugs.
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

const read = (ctx) => ctx.getImageData(0, 0, W, H);

const at = (img, x, y) => {
  const i = (y * W + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
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

// --------------------------------------------------------------- strokes

/** round caps put _strokePolys on its masked branch */
function roundStroke(ctx, style, width = 6) {
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

test('a later stroke does not leak the previous one through a stale mask', async () => {
  const ctx = freshCtx();
  roundStroke(ctx, 'red');
  ctx.beginPath();
  ctx.moveTo(10, 10);
  ctx.lineTo(50, 50);
  ctx.stroke();
  roundStroke(ctx, 'blue');
  ctx.beginPath();
  ctx.moveTo(95, 95);
  ctx.lineTo(110, 110);
  ctx.stroke();

  const img = await read(ctx);
  assert.deepEqual(at(img, 30, 30), [255, 0, 0], 'first stroke still red');
  assert.deepEqual(at(img, 100, 100), [0, 0, 255], 'second stroke blue');
  assert.ok(isWhite(at(img, 75, 20)), 'gap between them untouched');
  assert.ok(isWhite(at(img, 70, 70)), 'and along the line joining them');
});

test('a stroke whose box covers an earlier one does not repaint it', async () => {
  // The bounded clear is only load-bearing where the boxes overlap: the
  // coverage accumulates into the mask with PictOp.Add, so anything the
  // previous stroke left inside this stroke's box would be composited again,
  // in the new colour. Two strokes far apart cannot show this — the second
  // box holds nothing stale — so the diagonal below is chosen to span the
  // horizontal one's box entirely.
  const ctx = freshCtx();
  roundStroke(ctx, 'red');
  ctx.beginPath();
  ctx.moveTo(10, 20);
  ctx.lineTo(110, 20);
  ctx.stroke();
  roundStroke(ctx, 'blue');
  ctx.beginPath();
  ctx.moveTo(10, 10);
  ctx.lineTo(110, 110); // its bounding box swallows the red stroke's
  ctx.stroke();

  const img = await read(ctx);
  assert.deepEqual(at(img, 90, 20), [255, 0, 0], 'red stroke not repainted blue');
  assert.deepEqual(at(img, 90, 90), [0, 0, 255], 'the diagonal is blue');
  assert.ok(isWhite(at(img, 90, 50)), 'between them is untouched');
});

test('a stroke crossing the surface edge still inks what is on-surface', async () => {
  const ctx = freshCtx();
  roundStroke(ctx, 'green', 8);
  ctx.beginPath();
  ctx.moveTo(-30, -30); // starts off-surface on both axes
  ctx.lineTo(40, 40);
  ctx.stroke();

  const img = await read(ctx);
  assert.deepEqual(at(img, 2, 2), [0, 128, 0], 'the on-surface part is inked');
  assert.deepEqual(at(img, 30, 30), [0, 128, 0], 'and further along');
  assert.ok(isWhite(at(img, 70, 70)), 'past the end is untouched');
});

test('a clipped stroke is still clipped', async () => {
  const ctx = freshCtx();
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, 40);
  ctx.clip();
  roundStroke(ctx, 'red');
  ctx.beginPath();
  ctx.moveTo(20, 10);
  ctx.lineTo(20, 90); // extends well past the clip
  ctx.stroke();
  ctx.restore();

  const img = await read(ctx);
  assert.deepEqual(at(img, 20, 20), [255, 0, 0], 'inside the clip is stroked');
  assert.ok(isWhite(at(img, 20, 60)), 'below the clip is untouched');
});

test('a bounded stroke still blends globalAlpha exactly once', async () => {
  const ctx = freshCtx();
  ctx.globalAlpha = 0.5;
  roundStroke(ctx, 'red', 10);
  ctx.beginPath();
  ctx.moveTo(20, 30);
  ctx.lineTo(80, 30);
  ctx.stroke();

  const img = await read(ctx);
  const [r, g, b] = at(img, 50, 30);
  // half-alpha red over white: compositing the mask twice would darken the
  // green and blue channels well below 128
  assert.ok(r > 240, `red channel ${r}`);
  assert.ok(g > 110 && g < 145, `green channel ${g} is a single blend`);
  assert.equal(g, b, 'green and blue blend equally');
  assert.ok(isWhite(at(img, 50, 60)), 'away from the stroke is untouched');
});
