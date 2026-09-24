// fillRects batches many rectangle fills into one Render.FillRectangles
// when the style is a solid colour, the CTM is identity and the clip is
// rectangular (or absent) — and falls back to a per-rect fillRect loop
// everywhere else, so the pixels are always the ones fillRect would have
// produced and only the request count varies (issue #253).
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';

let app = null;
const W = 64;
const H = 64;

before(async () => {
  const server = xserver.createServer({ width: 200, height: 200 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  app = await createClient({
    stream: clientEnd,
    fontSource: new StaticFontSource(),
  });
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

const RED = [255, 0, 0];
const WHITE = [255, 255, 255];

test('nested-array form fills every rectangle and nothing else', async () => {
  const ctx = freshCtx();
  ctx.fillStyle = 'red';
  ctx.fillRects([
    [2, 2, 4, 4],
    [10, 10, 4, 4],
    [20, 2, 4, 4],
  ]);

  const at = await pixels(ctx);
  assert.deepEqual(at(3, 3), RED, 'first rect');
  assert.deepEqual(at(11, 11), RED, 'second rect');
  assert.deepEqual(at(21, 3), RED, 'third rect');
  assert.deepEqual(at(8, 8), WHITE, 'the gap between them is untouched');
});

test('flat form draws the same as the nested form', async () => {
  const ctx = freshCtx();
  ctx.fillStyle = 'red';
  ctx.fillRects([2, 2, 4, 4, 10, 10, 4, 4]);

  const at = await pixels(ctx);
  assert.deepEqual(at(3, 3), RED);
  assert.deepEqual(at(11, 11), RED);
  assert.deepEqual(at(8, 8), WHITE);
});

test('a solid-colour batch is a single request', async () => {
  const ctx = freshCtx();
  ctx.fillStyle = 'red';
  // warm up: the colour's CreateSolidFill, if any, is out of the way
  ctx.fillRects([[0, 0, 1, 1]]);
  await app.X.sync();

  const rects = [];
  for (let i = 0; i < 50; i++) rects.push([i, (i * 7) % H, 1, 1]);
  const before = app.X.seq_num;
  ctx.fillRects(rects);
  const emitted = app.X.seq_num - before;
  await app.X.sync();
  assert.equal(emitted, 1, 'fifty rectangles, one FillRectangles');
});

test('a rectangular clip is honored, still without a mask', async () => {
  const ctx = freshCtx();
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, 16, H);
  ctx.clip();
  ctx.fillStyle = 'red';

  const before = app.X.seq_num;
  ctx.fillRects([[10, 10, 20, 4]]); // straddles the clip edge at x = 16
  const emitted = app.X.seq_num - before;
  ctx.restore();

  const at = await pixels(ctx);
  assert.deepEqual(at(12, 11), RED, 'inside the clip');
  assert.deepEqual(at(20, 11), WHITE, 'outside the clip is untouched');
  // SetPictureClipRectangles + FillRectangles. The reset is owed, not sent:
  // it is only stamped when something that does not set its own clip draws
  // next, and a second batch under the same clip skips the set too (#308).
  assert.equal(emitted, 2, 'server-side clip, no a8 mask');
});

test('globalAlpha folds into the colour', async () => {
  const ctx = freshCtx();
  ctx.fillStyle = 'red';
  ctx.globalAlpha = 0.5;
  ctx.fillRects([[0, 0, 8, 8]]);
  ctx.globalAlpha = 1;

  const at = await pixels(ctx);
  const [r, g, b] = at(4, 4);
  assert.ok(r > 240, `red stays, got ${[r, g, b]}`);
  assert.ok(g > 100 && g < 155, `half of white shows through, got ${g}`);
  assert.ok(b > 100 && b < 155, `half of white shows through, got ${b}`);
});

test('empty and negative rectangles are skipped, not wrapped', async () => {
  const ctx = freshCtx();
  ctx.fillStyle = 'red';
  ctx.fillRects([
    [2, 2, 0, 4],
    [2, 2, 4, -4],
    [10, 10, 4, 4],
  ]);
  ctx.fillRects([]); // and an empty batch is a no-op, not an error

  const at = await pixels(ctx);
  assert.deepEqual(at(11, 11), RED, 'the real rectangle still lands');
  assert.deepEqual(at(3, 3), WHITE, 'the degenerate ones drew nothing');
});

test('a transform falls back to the fillRect loop and still lands right', async () => {
  const ctx = freshCtx();
  ctx.save();
  ctx.translate(20, 0);
  ctx.fillStyle = 'red';
  ctx.fillRects([[2, 2, 4, 4]]);
  ctx.restore();

  const at = await pixels(ctx);
  assert.deepEqual(at(23, 3), RED, 'filled where the transform moved it');
  assert.deepEqual(at(3, 3), WHITE, 'not where it was asked from');
});

test('a gradient style falls back per rect and paints the gradient', async () => {
  const ctx = freshCtx();
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, 'red');
  g.addColorStop(1, 'red');
  ctx.fillStyle = g;
  ctx.fillRects([
    [2, 2, 4, 4],
    [10, 10, 4, 4],
  ]);

  const at = await pixels(ctx);
  assert.deepEqual(at(3, 3), RED);
  assert.deepEqual(at(11, 11), RED);
  assert.deepEqual(at(8, 8), WHITE);
});

// Under a clip that is not a rectangle — a rounded card — rectangles that do
// not overlap are three requests however many there are: their coverage into
// the scratch mask, the clip applied once, one composite (issue #374). The
// loop it replaces was a composite through the clip per rectangle. The
// pixels are the loop's, so the reference is the same rectangles drawn one
// fillRect at a time under the same clip.
{
  // a chart's shapes: per-column spans and a grid of cells, fractional and
  // half off the surface — disjoint, which is what the batch is for
  const DISJOINT = [];
  for (let x = -3; x < 40; x++) {
    DISJOINT.push([x, 10 + ((x * 7) % 23) + 0.5, 1, 4.75 + (x % 5)]);
  }
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 9; col++) {
      if ((row * 9 + col) % 3) DISJOINT.push([40 + col * 3, 20 + row * 7.5, 3, 7.25]);
    }
  }
  DISJOINT.push([30, 65, 40, 10]); // below the grid, half off the surface
  // …and the same with two of them overlapping, which the loop blends twice
  // where the overlap meets the clip's antialiased edge
  const OVERLAPPING = [...DISJOINT, [4, 6, 12, 12], [8, 8, 6, 20]];

  function roundedClip(ctx) {
    ctx.beginPath();
    ctx.roundRect(6, 8, 50, 44, 12);
    ctx.clip();
  }

  async function drawn(rects, style, { batch, op = 'source-over', alpha = 1 }) {
    const ctx = freshCtx();
    ctx.save();
    roundedClip(ctx);
    ctx.fillStyle = style;
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = op;
    const R = ctx.Render;
    let composites = 0;
    const composite = R.Composite;
    R.Composite = function (...args) {
      composites += 1;
      return composite.apply(this, args);
    };
    try {
      if (batch) ctx.fillRects(rects);
      else for (const r of rects) ctx.fillRect(...r);
    } finally {
      R.Composite = composite;
    }
    ctx.restore();
    const img = await ctx.getImageData(0, 0, W, H);
    return { img, composites };
  }

  test('rectangles that do not overlap, under a rounded clip, are three requests and the loop’s pixels', async () => {
    for (const [style, alpha] of [
      ['#1f7a4d', 1],
      ['rgba(31, 122, 77, 0.5)', 1],
      ['#1f7a4d', 0.4],
    ]) {
      const loop = await drawn(DISJOINT, style, { batch: false, alpha });
      const batch = await drawn(DISJOINT, style, { batch: true, alpha });
      assert.ok(loop.composites >= DISJOINT.length / 2, 'the loop composites per rectangle');
      assert.equal(batch.composites, 2, `${style} at ${alpha}: the clip once, the colour once`);
      assert.deepEqual(batch.img.data, loop.img.data, `${style} at ${alpha}`);
    }
  });

  test('overlapping rectangles under a rounded clip keep the loop', async () => {
    const loop = await drawn(OVERLAPPING, '#1f7a4d', { batch: false });
    const batch = await drawn(OVERLAPPING, '#1f7a4d', { batch: true });
    assert.equal(batch.composites, loop.composites);
    assert.deepEqual(batch.img.data, loop.img.data);
  });

  test('copy under a rounded clip keeps the loop, and the gaps between rectangles', async () => {
    const loop = await drawn(DISJOINT, '#1f7a4d', { batch: false, op: 'copy' });
    const batch = await drawn(DISJOINT, '#1f7a4d', { batch: true, op: 'copy' });
    assert.equal(batch.composites, loop.composites);
    assert.deepEqual(batch.img.data, loop.img.data);
  });
}
