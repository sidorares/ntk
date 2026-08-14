// Batching N disjoint subpaths into one fill/stroke must cost what the
// pieces cost, not what the box around them costs (issue #264) — and it must
// draw exactly what it drew before the mask was allowed to split.
//
// The identity tests pin `app.rasterizer = null` so every drawing takes the
// trapezoid route: coverage then comes from the same absolute geometry
// whatever the mask box is, and any difference is the split's fault. (With
// the local rasterizer a small cluster and a big union box can route
// differently — analytic coverage against trapezoids — which is a legitimate
// difference in antialiasing, not one this test can assert away.)
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';

let app = null;
const W = 600;
const H = 450;

before(async () => {
  const server = xserver.createServer({ width: 800, height: 600 });
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
  ctx.maskStats = { masks: 0, pixels: 0, split: 0 };
  return ctx;
}

const read = (ctx) => ctx.getImageData(0, 0, W, H);
const at = (img, x, y) => [...img.data.slice((y * W + x) * 4, (y * W + x) * 4 + 3)];

/** the same drawing under two mask policies, with its pixels and stats */
async function both(draw) {
  const one = freshCtx();
  app.maskPolicy = { maxMasks: 1 }; // the one-mask-per-drawing behaviour
  draw(one);
  const oneImg = await read(one);
  const oneStats = { ...one.maskStats };

  const split = freshCtx();
  app.maskPolicy = null;
  draw(split);
  const splitImg = await read(split);
  return { oneImg, oneStats, splitImg, splitStats: { ...split.maskStats }, ctx: split };
}

/**
 * `tol` is what curved geometry on the trapezoid route costs: the slab
 * boundaries a trapezoidization cuts at are the y coordinates of *every*
 * subpath in the batch, so splitting a batch re-cuts each shape's traps at
 * slightly different places and an antialiased edge lands a few levels
 * either way. What this test is really looking for is bigger by an order of
 * magnitude — a piece composited twice through overlapping mask boxes is 64
 * levels off at half alpha, and a piece dropped between two boxes is 127.
 * Axis-aligned geometry has no such wobble and is compared exactly.
 */
function assertSamePixels(a, b, what, tol = 0) {
  let worst = 0;
  let at = -1;
  for (let i = 0; i < a.data.length; ++i) {
    const d = Math.abs(a.data[i] - b.data[i]);
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  if (worst <= tol) return;
  const p = Math.floor(at / 4);
  assert.fail(
    `${what}: pixel (${p % W}, ${Math.floor(p / W)}) channel ${at % 4} ` +
      `is ${b.data[at]}, was ${a.data[at]}`
  );
}

/**
 * A deterministic scatter of handle-sized points, as a node graph draws
 * them, no two within 40px of each other — so the pieces never overlap and
 * drawing them singly is a fair comparison (overlapping translucent pieces
 * blend twice singly and once batched, which is the caller's business, not
 * the mask's).
 */
const POINTS = (() => {
  let seed = 20240264;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out = [];
  while (out.length < 24) {
    const p = [20 + rand() * (W - 40), 20 + rand() * (H - 40)];
    if (out.every(([x, y]) => Math.hypot(x - p[0], y - p[1]) > 40)) out.push(p);
  }
  return out;
})();

/** all of them as one path, leaving the style to the caller */
function discPath(ctx, r = 8) {
  ctx.beginPath();
  for (const [x, y] of POINTS) {
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
}

function discs(ctx) {
  ctx.fillStyle = 'rgba(0, 0, 255, 0.5)';
  discPath(ctx);
  ctx.fill();
}

/** a pixel no disc can reach — the gaps a split leaves untouched */
function emptySpot() {
  for (let y = 20; y < H - 20; y += 7) {
    for (let x = 20; x < W - 20; x += 7) {
      if (POINTS.every(([px, py]) => Math.hypot(px - x, py - y) > 40)) return [x, y];
    }
  }
  throw new Error('the scatter left no gap');
}

test('a scattered batch draws what one mask drew, for a fraction of it', async () => {
  app.rasterizer = null;
  const { oneImg, oneStats, splitImg, splitStats } = await both(discs);
  assertSamePixels(oneImg, splitImg, 'discs', 12);
  assert.equal(oneStats.masks, 1, 'one mask over the lot, before');
  assert.equal(splitStats.split, 1, 'and a split after');
  assert.ok(splitStats.masks >= 6, `${splitStats.masks} masks`);
  assert.ok(
    splitStats.pixels < oneStats.pixels / 5,
    `mask area ${splitStats.pixels} against ${oneStats.pixels}`
  );
});

test('a batch of separated rectangles is what drawing them singly is', async () => {
  app.rasterizer = null;
  // axis-aligned and non-overlapping: the one comparison that can be exact,
  // and the one that says what the split is for — a caller may now batch
  // without having to know whether its pieces are scattered
  const boxes = POINTS.map(([x, y]) => [Math.round(x) - 9, Math.round(y) - 9, 18, 18]);
  const { splitImg, splitStats, oneStats } = await both((ctx) => {
    ctx.fillStyle = 'rgba(0, 0, 255, 0.5)';
    ctx.beginPath();
    for (const [x, y, w, h] of boxes) ctx.rect(x, y, w, h);
    ctx.fill();
  });
  const singly = freshCtx();
  singly.fillStyle = 'rgba(0, 0, 255, 0.5)';
  for (const [x, y, w, h] of boxes) {
    singly.beginPath();
    singly.rect(x, y, w, h);
    singly.fill();
  }
  assertSamePixels(await read(singly), splitImg, 'batched against singly');
  assert.ok(
    splitStats.pixels < oneStats.pixels / 5,
    `mask area ${splitStats.pixels} against ${oneStats.pixels}`
  );
});

test('a batch that spans its box is left alone', async () => {
  app.rasterizer = null;
  const { oneStats, splitStats } = await both((ctx) => {
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round'; // the masked branch of _strokePolys
    ctx.beginPath();
    for (let i = 0; i < 8; ++i) {
      ctx.moveTo(10, 10 + i * 20);
      ctx.lineTo(W - 10, H - 10 - i * 20);
    }
    ctx.stroke();
  });
  assert.equal(splitStats.split, 0, 'nothing to gain, nothing split');
  assert.equal(splitStats.masks, 1);
  assert.equal(splitStats.pixels, oneStats.pixels);
});

test('scattered strokes are split, and draw the same', async () => {
  app.rasterizer = null;
  const strokes = (ctx) => {
    ctx.strokeStyle = 'rgba(200, 0, 0, 0.5)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [x, y] of POINTS) {
      ctx.moveTo(x - 8, y - 8);
      ctx.lineTo(x + 8, y + 8);
    }
    ctx.stroke();
  };
  const { oneImg, oneStats, splitImg, splitStats } = await both(strokes);
  assertSamePixels(oneImg, splitImg, 'strokes');
  assert.equal(splitStats.split, 1);
  assert.ok(
    splitStats.pixels < oneStats.pixels / 5,
    `mask area ${splitStats.pixels} against ${oneStats.pixels}`
  );
});

test('touching pieces keep one mask, so no seam blends twice', async () => {
  app.rasterizer = null;
  // two translucent rectangles sharing an edge, plus a far-away one to make
  // the drawing worth splitting at all: the shared edge must not fall on a
  // cluster boundary, or the column would composite twice
  const { oneImg, splitImg, splitStats } = await both((ctx) => {
    ctx.fillStyle = 'rgba(255, 0, 0, 0.5)';
    ctx.beginPath();
    ctx.rect(40, 40, 60, 60);
    ctx.rect(100, 40, 60, 60);
    ctx.rect(480, 380, 40, 40);
    ctx.fill();
  });
  assert.equal(splitStats.split, 1, 'the far rectangle is worth a mask of its own');
  assertSamePixels(oneImg, splitImg, 'touching rectangles');
  const seam = at(splitImg, 100, 70);
  assert.deepEqual(seam, at(splitImg, 70, 70), 'the seam is one blend, like the interior');
});

test('globalAlpha still blends exactly once per cluster', async () => {
  app.rasterizer = null;
  const { oneImg, splitImg, splitStats } = await both((ctx) => {
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = 'rgb(255, 0, 0)';
    discPath(ctx);
    ctx.fill();
    ctx.globalAlpha = 1;
  });
  assert.equal(splitStats.split, 1);
  assertSamePixels(oneImg, splitImg, 'half-alpha discs');
  const [x, y] = POINTS[0];
  const [r, g, b] = at(splitImg, Math.round(x), Math.round(y));
  assert.ok(r > 240, `red channel ${r}`);
  assert.ok(g > 110 && g < 145, `green channel ${g} is a single blend`);
  assert.equal(g, b, 'green and blue blend equally');
});

test('a rectangular clip keeps its pixels, and skips the masks outside it', async () => {
  app.rasterizer = null;
  const inside = POINTS.find(([, y]) => y < 100).map(Math.round);
  const outside = POINTS.find(([, y]) => y > 200).map(Math.round);
  const { oneImg, oneStats, splitImg, splitStats } = await both((ctx) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, 120); // only the top band of discs survives
    ctx.clip();
    discs(ctx);
    ctx.restore();
  });
  assertSamePixels(oneImg, splitImg, 'clipped discs');
  assert.ok(at(splitImg, ...inside)[2] > at(splitImg, ...inside)[0], 'the top band is blue');
  assert.deepEqual(at(splitImg, ...outside), [255, 255, 255], 'the rest is clipped away');
  assert.ok(
    splitStats.pixels < oneStats.pixels,
    `${splitStats.masks} masks over ${splitStats.pixels}px, against one over ${oneStats.pixels}`
  );
});

test('a non-rectangular clip applies to every cluster', async () => {
  app.rasterizer = null;
  // a circle clip cannot be applied server-side, so it materializes the clip
  // mask — on demand, from inside the cluster loop. Every cluster after the
  // first sees it already built, and the first one must not slip through.
  const { oneImg, oneStats, splitImg, splitStats } = await both((ctx) => {
    ctx.save();
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 170, 0, Math.PI * 2);
    ctx.clip();
    discs(ctx);
    ctx.restore();
  });
  assert.equal(splitStats.split, 1);
  assertSamePixels(oneImg, splitImg, 'circle-clipped discs', 12);
  assert.ok(
    splitStats.pixels < oneStats.pixels / 5,
    `mask area ${splitStats.pixels} against ${oneStats.pixels}`
  );
  const outside = POINTS.find(
    ([x, y]) => Math.hypot(x - W / 2, y - H / 2) > 220
  ).map(Math.round);
  assert.deepEqual(at(splitImg, ...outside), [255, 255, 255], 'clipped away');
});

test('an op that writes outside its coverage keeps one mask', async () => {
  app.rasterizer = null;
  // `copy` replaces the destination across the whole mask box, gaps
  // included, so splitting the box would change what it erases
  const { oneImg, splitImg, splitStats } = await both((ctx) => {
    ctx.globalCompositeOperation = 'copy';
    ctx.fillStyle = 'rgb(0, 128, 0)';
    discs(ctx);
    ctx.globalCompositeOperation = 'source-over';
  });
  assert.equal(splitStats.split, 0, 'copy is never split');
  assert.equal(splitStats.masks, 1);
  assertSamePixels(oneImg, splitImg, 'copy');
});

test('the even-odd rule survives the split', async () => {
  app.rasterizer = null;
  // rings: each is an outer and an inner subpath that must cancel, and the
  // rings themselves are far enough apart to be split
  const rings = (ctx) => {
    ctx.fillStyle = 'rgba(0, 128, 0, 0.6)';
    ctx.beginPath();
    for (let i = 0; i < 6; ++i) {
      const x = 80 + (i % 3) * 200;
      const y = 80 + Math.floor(i / 3) * 200;
      ctx.moveTo(x + 40, y);
      ctx.arc(x, y, 40, 0, Math.PI * 2);
      ctx.moveTo(x + 20, y);
      ctx.arc(x, y, 20, 0, Math.PI * 2);
    }
    ctx.fill('evenodd');
  };
  const { oneImg, splitImg, splitStats } = await both(rings);
  assert.equal(splitStats.split, 1);
  assertSamePixels(oneImg, splitImg, 'even-odd rings');
  assert.deepEqual(at(splitImg, 80, 80), [255, 255, 255], 'the hole is a hole');
  assert.ok(at(splitImg, 110, 80)[1] > at(splitImg, 110, 80)[0], 'the ring is green');
});

test('with the local rasterizer, the split routes each cluster on its own', async () => {
  app.rasterizer = undefined; // back to the process-wide default
  app.maskPolicy = null;
  const ctx = freshCtx();
  discs(ctx);
  const img = await read(ctx);
  assert.equal(ctx.maskStats.split, 1);
  const [x, y] = POINTS[0].map(Math.round);
  const [r, g, b] = at(img, x, y);
  assert.ok(b > 240 && r < 140 && g < 140, `disc centre is blue, got ${[r, g, b]}`);
  assert.deepEqual(at(img, ...emptySpot()), [255, 255, 255], 'and the gaps are untouched');
});
