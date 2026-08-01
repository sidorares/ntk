// Local rasterization: small fills and strokes are rasterized here and
// uploaded as an a8 coverage mask instead of going to the server as
// trapezoids (react-x11#148). The route must be invisible — same pixels,
// whichever side did the work — and must stay correct through the clip,
// globalAlpha and composite-op machinery the mask feeds.
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import {
  CoverageAccumulator,
  DEFAULT_RASTER_POLICY,
  ScanlineRasterizer,
  createClient,
  StaticFontSource
} from '../lib/index.js';
import { routeRaster } from '../lib/rasterize.js';

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

/** run `draw` twice, once rasterizing locally and once on the server */
async function bothRoutes(draw) {
  const out = [];
  for (const rasterizer of [new ScanlineRasterizer(), null]) {
    app.rasterizer = rasterizer;
    const ctx = freshCtx();
    draw(ctx);
    out.push(await read(ctx));
  }
  app.rasterizer = new ScanlineRasterizer();
  return out;
}

/** worst and mean per-channel difference between two readbacks */
function diff(a, b) {
  let max = 0;
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) {
    const d = Math.abs(a.data[i] - b.data[i]);
    if (d > max) max = d;
    sum += d;
  }
  return { max, mean: sum / a.data.length };
}

// --------------------------------------------------------------- the policy

test('routeRaster: small drawings are local, large simple ones are not', () => {
  const p = DEFAULT_RASTER_POLICY;
  // at or below maxArea, always local — a 20px icon, a 64x64 box
  assert.equal(routeRaster(20, 20, 8, p), 'local');
  assert.equal(routeRaster(64, 64, 4, p), 'local');
  // above it, complexity decides: a rounded rect at 128px has ~73 edges and
  // measured faster as trapezoids; a stroked icon at 512px has ~3000 and
  // measured faster as a bitmap
  assert.equal(routeRaster(128, 128, 73, p), 'server');
  assert.equal(routeRaster(512, 512, 3012, p), 'local');
  // and nothing uploads more than maxBytes of coverage
  assert.equal(routeRaster(2000, 2000, 1e6, p), 'server');
  assert.equal(routeRaster(0, 10, 4, p), 'server');
});

test('routeRaster: policy is overridable', () => {
  const never = { maxArea: 0, bytesPerEdge: 0, maxBytes: 0 };
  assert.equal(routeRaster(8, 8, 4, never), 'server');
  const always = { maxArea: Infinity, bytesPerEdge: 0, maxBytes: Infinity };
  assert.equal(routeRaster(4000, 4000, 1, always), 'local');
});

// ---------------------------------------------------------- the accumulator

test('CoverageAccumulator: fill rules on a self-intersecting path', () => {
  // a five-pointed star drawn as one self-crossing contour — the canonical
  // case where the two rules disagree: the middle pentagon is wound twice,
  // so non-zero fills it and even-odd leaves it hollow
  const star = [];
  for (let i = 0; i < 5; i++) {
    const a = (i * 4 * Math.PI) / 5 - Math.PI / 2;
    star.push(20 + 18 * Math.cos(a), 20 + 18 * Math.sin(a));
  }
  const nonzero = new CoverageAccumulator(40, 40).polygon(star).toAlpha(undefined, 'nonzero');
  const evenodd = new CoverageAccumulator(40, 40).polygon(star).toAlpha(undefined, 'evenodd');
  assert.equal(nonzero[20 * 40 + 20], 255, 'non-zero fills the middle pentagon');
  assert.equal(evenodd[20 * 40 + 20], 0, 'even-odd leaves it hollow');
  // the arms are inked either way
  assert.ok(nonzero[8 * 40 + 20] > 200, 'non-zero inks the top arm');
  assert.ok(evenodd[8 * 40 + 20] > 200, 'even-odd inks the top arm too');
});

test('CoverageAccumulator: overlapping triangles union instead of cancelling', () => {
  // two triangles wound in opposite directions, overlapping. Added as
  // polygons their windings cancel; added as triangles they must not.
  const tris = [0, 0, 20, 0, 0, 20, 20, 20, 20, 0, 0, 20];
  const union = new CoverageAccumulator(24, 24).triangles(tris).toAlpha();
  assert.equal(union[10 * 24 + 5], 255, 'first triangle covered');
  assert.equal(union[10 * 24 + 15], 255, 'second triangle covered');
  assert.equal(union[10 * 24 + 10], 255, 'the shared diagonal stays covered');
});

test('CoverageAccumulator: geometry outside the grid clips instead of wrapping', () => {
  const acc = new CoverageAccumulator(16, 16);
  acc.polygon([-50, -50, 50, -50, 50, 50, -50, 50]); // covers the grid entirely
  const alpha = acc.toAlpha();
  for (let i = 0; i < alpha.length; i++) assert.equal(alpha[i], 255, `pixel ${i}`);
});

// ------------------------------------------------------------- the pixels

test('local and server routes paint the same fill', async () => {
  const [local, server] = await bothRoutes((ctx) => {
    ctx.fillStyle = '#2d3436';
    ctx.beginPath();
    ctx.moveTo(20, 10);
    ctx.bezierCurveTo(60, 0, 60, 50, 30, 45);
    ctx.lineTo(10, 30);
    ctx.closePath();
    ctx.fill();
  });
  const d = diff(local, server);
  // antialiasing on the curve differs slightly between the two rasterizers;
  // interiors and background must agree exactly, edges within a few counts
  assert.ok(d.mean < 2, `mean channel difference ${d.mean.toFixed(2)}`);
  assert.deepEqual(at(local, 25, 25), at(server, 25, 25), 'interior identical');
  assert.ok(isWhite(at(local, 100, 100)), 'background untouched');
});

test('local and server routes paint the same stroke', async () => {
  const [local, server] = await bothRoutes((ctx) => {
    ctx.strokeStyle = '#2d3436';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(15, 15);
    ctx.lineTo(45, 40);
    ctx.lineTo(20, 55);
    ctx.stroke();
  });
  const d = diff(local, server);
  assert.ok(d.mean < 3, `mean channel difference ${d.mean.toFixed(2)}`);
  assert.ok(isWhite(at(local, 100, 100)), 'background untouched');
  assert.ok(!isWhite(at(local, 30, 27)), 'the stroke is actually there');
});

test('the local route honours the even-odd fill rule', async () => {
  const [local, server] = await bothRoutes((ctx) => {
    ctx.fillStyle = '#2d3436';
    ctx.beginPath();
    ctx.rect(10, 10, 40, 40);
    ctx.rect(20, 20, 20, 20); // same winding: even-odd punches a hole
    ctx.fill('evenodd');
  });
  assert.ok(isWhite(at(local, 30, 30)), 'hole is empty');
  assert.ok(isWhite(at(server, 30, 30)), 'and on the server route too');
  assert.ok(!isWhite(at(local, 15, 15)), 'the ring is inked');
});

test('the local route honours clip and globalAlpha', async () => {
  const [local, server] = await bothRoutes((ctx) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, 40);
    ctx.clip();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = 'red';
    ctx.beginPath();
    ctx.rect(10, 10, 50, 60); // crosses the clip edge
    ctx.fill();
    ctx.restore();
  });
  assert.ok(isWhite(at(local, 20, 60)), 'below the clip is untouched');
  assert.deepEqual(at(local, 20, 20), at(server, 20, 20), 'blend matches the server route');
  const [r] = at(local, 20, 20);
  assert.ok(r > 240 && at(local, 20, 20)[1] > 100, 'half-transparent red');
});

test('a locally rasterized shape crossing the surface edge clips correctly', async () => {
  const [local] = await bothRoutes((ctx) => {
    ctx.fillStyle = 'green';
    ctx.beginPath();
    ctx.rect(-20, -20, 50, 50); // 30x30 on-surface: comfortably local
    ctx.fill();
  });
  assert.deepEqual(at(local, 0, 0), [0, 128, 0], 'top-left corner filled');
  assert.deepEqual(at(local, 20, 20), [0, 128, 0], 'interior filled');
  assert.ok(isWhite(at(local, 50, 50)), 'past the shape is untouched');
});

test('a later local fill does not leak the previous shape', async () => {
  const [local] = await bothRoutes((ctx) => {
    ctx.fillStyle = 'red';
    ctx.beginPath();
    ctx.rect(0, 0, 60, 60);
    ctx.fill();
    ctx.fillStyle = 'blue';
    ctx.beginPath();
    ctx.rect(90, 90, 20, 20);
    ctx.fill();
  });
  assert.deepEqual(at(local, 10, 10), [255, 0, 0], 'first shape still red');
  assert.deepEqual(at(local, 95, 95), [0, 0, 255], 'second shape blue');
  assert.ok(isWhite(at(local, 75, 20)), 'gap between them untouched');
});

// ---------------------------------------------------------------- the seam

test('a custom rasterizer is used, and declining falls back to the server', async () => {
  const calls = [];
  const inner = new ScanlineRasterizer();

  app.rasterizer = {
    rasterize(job) {
      calls.push({ width: job.width, height: job.height, kind: job.triangles ? 'stroke' : 'fill' });
      return inner.rasterize(job);
    }
  };
  let ctx = freshCtx();
  ctx.fillStyle = 'red';
  ctx.beginPath();
  ctx.rect(10, 10, 30, 30);
  ctx.fill();
  const used = await read(ctx);
  assert.equal(calls.length, 1, 'the hook was called once');
  assert.equal(calls[0].kind, 'fill');
  // the bbox carries a pixel of antialiasing slack on each side
  assert.equal(calls[0].width, 32);
  assert.deepEqual(at(used, 20, 20), [255, 0, 0]);

  // a rasterizer that declines everything must still draw, via the server
  app.rasterizer = { rasterize: () => null };
  ctx = freshCtx();
  ctx.fillStyle = 'red';
  ctx.beginPath();
  ctx.rect(10, 10, 30, 30);
  ctx.fill();
  const declined = await read(ctx);
  assert.deepEqual(at(declined, 20, 20), [255, 0, 0], 'declined work still lands');
  assert.ok(isWhite(at(declined, 60, 60)));

  app.rasterizer = new ScanlineRasterizer();
});

test('rasterizer: null sends everything to the server', async () => {
  app.rasterizer = null;
  const ctx = freshCtx();
  ctx.fillStyle = 'red';
  ctx.beginPath();
  ctx.rect(10, 10, 20, 20);
  ctx.fill();
  const img = await read(ctx);
  assert.deepEqual(at(img, 20, 20), [255, 0, 0]);
  app.rasterizer = new ScanlineRasterizer();
});
