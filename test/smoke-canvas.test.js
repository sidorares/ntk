// End-to-end pixel tests for the canvas parity features: transforms,
// save/restore, arcs, Path2D, fill rules, clipping, globalAlpha, strokes
// and the SVG widget. Runs against a real X server; skips without one.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createClient, Path2D, Surface, SvgView } from '../lib/index.js';
import { withTimeout } from './helpers/async.js';

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

const readPixels = (ctx, w, h) => ctx.getImageData(0, 0, w, h);

const px = (image, w, x, y) => {
  const i = (y * w + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
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

test('stroke: closed subpaths do not spike to the origin', async (t) => {
  // regression: a closed path whose flattened points end exactly on the
  // start point fed a zero-length segment to extrude-polyline, producing
  // NaN joins rendered as triangles at (0,0)
  if (skip) return t.skip(skip);
  const { pixmap, ctx } = freshCtx();

  ctx.strokeStyle = 'black';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(40, 40, 15, 0, Math.PI * 2);
  ctx.closePath();
  ctx.stroke();

  const image = await readPixels(ctx, 64, 64);
  assert.deepEqual(px(image, 64, 40, 25), [0, 0, 0], 'circle outline drew');
  for (const [x, y] of [[2, 2], [10, 10], [20, 20]]) {
    assert.deepEqual(px(image, 64, x, y), [255, 255, 255], `no spike at ${x},${y}`);
  }
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

test('createPattern: a tile repeats across a fill, on a real server', async (t) => {
  if (skip) return t.skip(skip);
  const { pixmap, ctx } = freshCtx();

  // 4x4 tile: red top-left quadrant, blue bottom-right, the rest transparent
  const tile = new Surface(app, { width: 4, height: 4 });
  tile.render((c) => {
    c.fillStyle = 'red';
    c.fillRect(0, 0, 2, 2);
    c.fillStyle = 'blue';
    c.fillRect(2, 2, 2, 2);
  });
  ctx.fillStyle = ctx.createPattern(tile, 'repeat');
  ctx.fillRect(0, 0, 32, 32);

  // a stroke samples the same paint in canvas space (RENDER aligns the
  // source of a Triangles request with its first vertex, not the surface)
  ctx.lineWidth = 4;
  ctx.strokeStyle = ctx.fillStyle;
  ctx.beginPath();
  ctx.moveTo(0, 50);
  ctx.lineTo(64, 50);
  ctx.stroke();

  const image = await readPixels(ctx, 64, 64);
  for (const [x, y] of [
    [0, 0],
    [16, 8],
    [28, 28],
  ]) {
    assert.deepEqual(px(image, 64, x, y), [255, 0, 0], `tile red quadrant at ${x},${y}`);
    assert.deepEqual(px(image, 64, x + 2, y + 2), [0, 0, 255], `blue quadrant at ${x},${y}`);
    assert.deepEqual(px(image, 64, x + 2, y), [255, 255, 255], `transparent quadrant at ${x},${y}`);
  }
  assert.deepEqual(px(image, 64, 40, 40), [255, 255, 255], 'nothing outside the filled rect');
  assert.deepEqual(px(image, 64, 48, 48), [255, 0, 0], 'the stroke tiles in canvas space');
  assert.deepEqual(px(image, 64, 50, 50), [0, 0, 255], 'and shows the next quadrant along');

  tile.destroy();
  pixmap.destroy();
});

test('gradients: user-space coordinates and pad past the outermost stops', async (t) => {
  if (skip) return t.skip(skip);
  const { pixmap, ctx } = freshCtx();
  const near = (actual, expected, tol, what) =>
    assert.ok(Math.abs(actual - expected) <= tol, `${what}: got ${actual}, want ~${expected}`);

  // a gradient in a translated context paints where the fill is, not where
  // the window origin is (issue #271)
  ctx.save();
  ctx.translate(32, 0);
  const g = ctx.createLinearGradient(0, 0, 32, 0);
  g.addColorStop(0, 'black');
  g.addColorStop(1, 'white');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  ctx.restore();

  // and past its last stop it clamps to that stop's colour, rather than
  // going transparent: RepeatPad, not the RepeatNone a gradient starts with
  const wide = ctx.createLinearGradient(24, 40, 40, 40);
  wide.addColorStop(0, 'black');
  wide.addColorStop(1, 'white');
  ctx.fillStyle = wide;
  ctx.fillRect(0, 40, 64, 24);

  const image = await readPixels(ctx, 64, 64);
  assert.deepEqual(px(image, 64, 16, 16), [255, 255, 255], 'left of the fill is untouched');
  near(px(image, 64, 33, 16)[0], 0, 16, 'the ramp starts at the translated origin');
  near(px(image, 64, 48, 16)[0], 128, 16, 'halfway across at the middle');
  near(px(image, 64, 62, 16)[0], 255, 16, 'and white at the far end');
  near(px(image, 64, 4, 50)[0], 0, 6, 'before the first stop clamps to black');
  near(px(image, 64, 60, 50)[0], 255, 6, 'after the last stop clamps to white');
  pixmap.destroy();
});

test('shadows: offset, blurred and coloured, on a real server', async (t) => {
  if (skip) return t.skip(skip);
  // The hermetic run (test/shadow.test.js) proves the blur against node-x11's
  // JS server. This one proves the same shadow survives the round trip to
  // Xorg's RENDER: the convolution filter is what carries it, and a server
  // that silently ignored the filter would still return a shadow — just an
  // unblurred one, which the profile below would catch.
  const { pixmap, ctx } = freshCtx();

  ctx.shadowColor = 'black';
  ctx.shadowOffsetX = 8;
  ctx.shadowOffsetY = 8;
  ctx.fillStyle = 'red';
  ctx.fillRect(8, 8, 24, 24);

  let image = await readPixels(ctx, 64, 64);
  assert.deepEqual(px(image, 64, 20, 20), [255, 0, 0], 'the rect');
  assert.deepEqual(px(image, 64, 36, 36), [0, 0, 0], 'its shadow, offset by (8, 8)');
  assert.deepEqual(px(image, 64, 41, 41), [255, 255, 255], 'and nothing past it');

  const blurred = freshCtx();
  const bctx = blurred.ctx;
  const blur = 8;
  bctx.shadowColor = 'black';
  bctx.shadowBlur = blur;
  bctx.fillStyle = 'rgba(0, 0, 0, 0)'; // only the shadow paints
  bctx.fillRect(-16, 0, 48, 64); // one edge in view, at x = 32

  image = await readPixels(bctx, 64, 64);
  // white background, black shadow: the grey level is 1 - coverage, and a
  // blurred edge follows the gaussian's CDF (sigma = blur / 2)
  const coverage = (x) => 1 - px(image, 64, x, 32)[0] / 255;
  for (const [x, want] of [
    [32 - blur / 2, 0.841],
    [32, 0.5],
    [32 + blur / 2, 0.159],
  ]) {
    const got = coverage(x);
    assert.ok(
      Math.abs(got - want) < 0.08,
      `coverage at x=${x} is ${got.toFixed(3)}, expected ~${want}`
    );
  }
  assert.ok(coverage(8) > 0.98, 'the interior is fully covered');
  assert.ok(coverage(50) < 0.02, 'and the blur ends');

  blurred.pixmap.destroy();
  pixmap.destroy();
});
