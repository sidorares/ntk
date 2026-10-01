// End-to-end pixel tests for the canvas parity features: transforms,
// save/restore, arcs, Path2D, fill rules, clipping, globalAlpha, strokes
// and the SVG widget. Runs against a real X server; skips without one.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { blurCoverage, blurScale, createClient, Image, Path2D, Surface, SvgView } from '../lib/index.js';
import { withTimeout } from './helpers/async.js';

let app = null;
let skip = false;

before(async () => {
  if (!process.env.DISPLAY) {
    skip = 'no DISPLAY set';
    return;
  }
  try {
    app = await withTimeout(createClient(), 5000, 'connecting to X server', (late) => late.close());
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

test('transforms: a thumbnail rotated far from the origin lands where the matrix puts it', async (t) => {
  if (skip) return t.skip(skip);
  const W = 2300;
  const H = 100;
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H);
  // one colour per quadrant of a 2000x1200 image
  const iw = 2000;
  const ih = 1200;
  const data = Buffer.alloc(iw * ih * 4);
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      const i = (y * iw + x) * 4;
      data[i] = x < iw / 2 ? 255 : 0;
      data[i + 1] = y < ih / 2 ? 0 : 255;
      data[i + 2] = x < iw / 2 ? 0 : 255;
      data[i + 3] = 255;
    }
  }
  const img = new Image({ width: iw, height: ih, data });

  // The composite samples from the box's corner, so the transform carries
  // where in the image that corner is rather than where on the surface: at
  // x 2,200 and a fortieth of the size the latter was 88,000, past 16.16.
  ctx.save();
  ctx.translate(2225, 55);
  ctx.rotate(Math.PI / 2);
  ctx.translate(-2225, -55);
  ctx.drawImage(img, 2200, 40, 50, 30);
  ctx.restore();
  // and one too small for the transform to say: nothing, not a throw
  ctx.save();
  ctx.translate(2000, 55);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(img, 0, 0, 0.05, 0.03);
  ctx.restore();

  const image = await readPixels(ctx, W, H);
  assert.deepEqual(px(image, W, 2232, 38), [255, 0, 0], "the image's top-left, top-right on screen");
  assert.deepEqual(px(image, W, 2232, 72), [0, 0, 255], 'its top-right, bottom-right');
  assert.deepEqual(px(image, W, 2217, 38), [255, 255, 0], 'its bottom-left, top-left');
  assert.deepEqual(px(image, W, 2217, 72), [0, 255, 255], 'its bottom-right, bottom-left');
  assert.deepEqual(px(image, W, 2207, 55), [255, 255, 255], 'left of it');
  assert.deepEqual(px(image, W, 2203, 43), [255, 255, 255], 'where it was before the turn');
  for (let y = 50; y < 60; y++) {
    for (let x = 1995; x < 2005; x++) {
      assert.deepEqual(px(image, W, x, y), [255, 255, 255], `the tiny one, at ${x},${y}`);
    }
  }
  img.destroy();
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

test('SvgView: paint declared on the root <svg> reaches the shapes', async (t) => {
  if (skip) return t.skip(skip);
  const { pixmap, ctx } = freshCtx();

  // how lucide/feather/heroicons/tabler ship an outline icon: the shape names
  // no paint at all, it is all on the root element (issue #306)
  const view = new SvgView(null).setSvg(
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<circle cx="12" cy="12" r="9"/></svg>'
  );
  assert.equal(view.paintKind, 'mono');
  assert.equal(view.soloPaint, 'currentColor', 'the scan sees the root defer its colour');
  view.draw(ctx, 0, 0, 64, 64, { color: '#ff0000' });

  const image = await readPixels(ctx, 64, 64);
  // fill="none" from the root: the disc is a ring, not a black silhouette
  assert.deepEqual(px(image, 64, 32, 32), [255, 255, 255], 'circle interior is not filled');
  // stroke="currentColor" from the root, r=9/24 scaled to 64 -> ring top at y=8
  assert.deepEqual(px(image, 64, 32, 8), [255, 0, 0], 'ring drawn in the caller colour');
  assert.deepEqual(px(image, 64, 8, 32), [255, 0, 0], 'ring left side too');
  pixmap.destroy();
});

test('SvgView: display, visibility, a style opacity and a nested <svg>, as a browser draws them', async (t) => {
  if (skip) return t.skip(skip);
  const { pixmap, ctx } = freshCtx(200);

  // each drew an opaque red square at 8,8, the last at 0,0 rather than 10,10
  const square = (attrs) => `<rect ${attrs} x="8" y="8" width="24" height="24" fill="#cf222e"/>`;
  const docs = [
    square('display="none"'),
    square('style="display:none"'),
    square('visibility="hidden"'),
    square('style="opacity:.2"'),
    '<svg x="10" y="10" width="20" height="20"><rect width="20" height="20" fill="#cf222e"/></svg>'
  ];
  docs.forEach((body, i) =>
    new SvgView(null)
      .setSvg(`<svg width="40" height="40"><rect width="40" height="40" fill="#ddf4ff"/>${body}</svg>`)
      .draw(ctx, i * 40, 0)
  );

  const image = await readPixels(ctx, 200, 200);
  const back = [0xdd, 0xf4, 0xff];
  const red = [0xcf, 0x22, 0x2e];
  for (const i of [0, 1, 2]) assert.deepEqual(px(image, 200, i * 40 + 20, 20), back, `document ${i + 1} draws no square`);
  // a fifth of the red over the blue
  const faint = px(image, 200, 3 * 40 + 20, 20);
  back.forEach((c, k) => {
    const want = 0.2 * red[k] + 0.8 * c;
    assert.ok(Math.abs(faint[k] - want) <= 3, `faint square channel ${k}: ${faint[k]}, want ~${want}`);
  });
  assert.deepEqual(px(image, 200, 4 * 40 + 5, 5), back, 'nothing of the nested svg at its own 0,0');
  assert.deepEqual(px(image, 200, 4 * 40 + 12, 12), red, 'the nested svg is at 10,10');
  assert.deepEqual(px(image, 200, 4 * 40 + 28, 28), red, 'and 20 across');
  assert.deepEqual(px(image, 200, 4 * 40 + 32, 32), back);
  pixmap.destroy();
});

test('a gradient and a pattern drawn small far from the origin paint as they do near it', async (t) => {
  if (skip) return t.skip(skip);
  // Each style samples from where its own origin lands, so the server sees
  // the same transform at x 2,200 as at x 100; at a thirty-second of their
  // size they used to ask for 70,400, past what 16.16 carries
  // (test/style-origin.test.js runs every path; this is pixman sampling).
  const W = 2400;
  const H = 48;
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H);
  const g = ctx.createLinearGradient(0, 0, 4800, 1280);
  g.addColorStop(0, 'red');
  g.addColorStop(0.5, 'lime');
  g.addColorStop(1, 'blue');
  const tile = new Surface(app, { width: 160, height: 160 });
  tile.render((c) => {
    c.fillStyle = 'red';
    c.fillRect(0, 0, 80, 80);
    c.fillStyle = 'blue';
    c.fillRect(80, 80, 80, 80);
  });
  const pattern = ctx.createPattern(tile, 'repeat');
  const scene = (x) => {
    ctx.save();
    ctx.translate(x, 4);
    ctx.scale(1 / 32, 1 / 32);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 960, 1280);
    ctx.strokeStyle = g;
    ctx.lineWidth = 96;
    ctx.beginPath();
    ctx.moveTo(1120, 64);
    ctx.lineTo(1600, 1216);
    ctx.stroke();
    ctx.fillStyle = pattern;
    ctx.beginPath();
    ctx.arc(2400, 640, 576, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
  };
  scene(100);
  scene(2200);
  const near = await ctx.getImageData(90, 0, 110, H);
  const far = await ctx.getImageData(2190, 0, 110, H);
  let inked = 0;
  let differ = 0;
  for (let i = 0; i < near.data.length; i += 4) {
    if (near.data[i] !== 255 || near.data[i + 1] !== 255) inked++;
    if (near.data.slice(i, i + 3).join() !== far.data.slice(i, i + 3).join()) differ++;
  }
  assert.ok(inked > 1000, `the scene near the origin is painted (${inked} pixels)`);
  assert.equal(differ, 0, 'far from the origin it is painted the same');
  tile.destroy();
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

test('shadows: a wide blur keeps the same fraction of its colour here (#287)', async (t) => {
  if (skip) return t.skip(skip);
  // The one number issue #287 turned on: how *strong* a blurred shadow gets.
  // A shadow only reaches `shadowColor` where the shape casting it is wide
  // compared with the blur, so the interior of a 60x40 rect at sigma 15 is
  // 0.784 of full alpha and not 1 — and reading that as "the shadow is
  // missing" is what the issue did. The hermetic run asserts the same 0.784
  // against node-x11's JS server (test/shadow.test.js); this asserts Xorg
  // agrees, which is the claim the issue needed and nothing was checking.
  const { pixmap, ctx } = freshCtx(180);

  ctx.shadowColor = 'black';
  ctx.shadowBlur = 30;
  ctx.fillStyle = 'rgba(0, 0, 0, 0)'; // only the shadow paints
  ctx.fillRect(60, 50, 60, 40);

  const image = await readPixels(ctx, 180, 180);
  // black shadow on white: alpha is 1 - grey
  const alpha = 1 - px(image, 180, 90, 70)[0] / 255;
  assert.ok(
    Math.abs(alpha - 0.784) < 0.03,
    `the middle of the shadow is ${alpha.toFixed(3)} of the colour, expected ~0.784`
  );
  pixmap.destroy();
});

test('shadows: blurring shrunk coverage draws the same pixels here (#338)', async (t) => {
  if (skip) return t.skip(skip);
  // A wide blur is run on coverage shrunk by 2 or 4 and resolved back, which
  // trades three levels of 8-bit alpha for most of a first paint's server
  // time — and three is the number *here*, where pixman's bilinear works in
  // fixed point, against the two the JS server's exact arithmetic gives.
  // The hermetic run asserts the trade against node-x11's JS server; this
  // asserts that a real RENDER — where the resampling is pixman's bilinear
  // and not ours — agrees, because the whole scheme is the server's arithmetic
  // and none of it is visible from the client.
  const sigma = 21;
  const pad = 3 * sigma; // shadowReach: the blur's full spread, on all sides
  const width = 60 + 2 * pad;
  // tall enough that the middle row is 3 sigma clear of the rect's own top
  // and bottom, so the profile there is one edge's rather than a small
  // rect's two — which is what makes the CDF below the exact prediction
  const height = 160 + 2 * pad;

  const bake = (scale) => {
    const shape = new Surface(app, { width, height, format: 'a8' });
    shape.render((c) => {
      c.fillStyle = '#ffffff';
      c.fillRect(pad, pad, 60, 160);
    });
    return blurCoverage(shape, sigma, { scale });
  };
  const paint = async (coverage) => {
    const pixmap = app.createPixmap({ width, height, depth: 24 });
    const ctx = pixmap.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = 'black';
    ctx.drawImage(coverage, 0, 0);
    const image = await readPixels(ctx, width, height);
    coverage.destroy();
    pixmap.destroy();
    return image;
  };

  assert.equal(blurScale(sigma), 4, 'sigma 21 is worth a 4x shrink');
  const exact = await paint(bake(1));
  const scaled = await paint(bake(undefined));
  let worst = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      worst = Math.max(worst, Math.abs(px(exact, width, x, y)[0] - px(scaled, width, x, y)[0]));
    }
  }
  assert.ok(worst <= 3, `the shrunk blur differs by ${worst} of 255, expected 3 or less`);
  // and it is a blur, not a smear: the profile of the edge at x = pad still
  // follows the gaussian's CDF
  const coverage = (x) => 1 - px(scaled, width, x, height >> 1)[0] / 255;
  for (const [x, want] of [
    [pad - sigma, 0.159],
    [pad, 0.5],
    [pad + sigma, 0.841]
  ]) {
    const got = coverage(Math.round(x));
    assert.ok(
      Math.abs(got - want) < 0.03,
      `coverage at x=${x} is ${got.toFixed(3)}, expected ~${want}`
    );
  }
});
