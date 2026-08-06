// Joins on closed subpaths.
//
// extrude-polyline treats every polyline as open: it butt-extrudes both
// ends and emits no join between them. A closed loop is handed to it with
// the seam point at both ends, so whichever vertex the subpath started on
// got no join — a stroked rectangle came out with three square corners and
// a notched one, the notch a quarter of the line width square. The fix cuts
// the loop in the middle of a straight edge instead, where the two ends are
// collinear and meet exactly and every real vertex is interior.
//
// What that buys is testable without knowing anything about the internals:
// a shape with 4-fold symmetry must *render* with 4-fold symmetry, because
// the seam can only be in one place. Everything here forces the polygon
// route (shapePolicy maxRadius 0) — the rounded-rect glyph fast path of
// issue #211 emits recognized boxes as rectangles and never reaches this
// code.
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';

let app = null;
const W = 120;
const H = 120;
const CX = 60; // the centre of every shape below, on a pixel boundary
const CY = 60;

before(async () => {
  const server = xserver.createServer({ width: 200, height: 200 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  app = await createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
  app.shapePolicy = { maxRadius: 0 };
});

after(async () => {
  if (app) await app.close();
});

function freshCtx() {
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'black';
  return ctx;
}

async function render(draw) {
  const ctx = freshCtx();
  draw(ctx);
  const img = await ctx.getImageData(0, 0, W, H);
  return (x, y) => img.data[(y * W + x) * 4];
}

/**
 * Worst difference between the image and itself rotated a quarter turn
 * about (CX, CY).
 *
 * Pixel (x, y) covers the square centred on (x + 0.5, y + 0.5), so its
 * image under the rotation is pixel (CX + y - CY, CX + CY - x - 1) — the
 * -1 being the half-pixel offset on both axes. Leave it out and every
 * symmetric shape reads as asymmetric by a row, which is a much louder
 * result than any real defect.
 */
function asymmetry(at) {
  let worst = 0;
  let where = null;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const rx = CX + (y - CY);
      const ry = CX + CY - x - 1;
      if (rx < 0 || ry < 0 || rx >= W || ry >= H) continue;
      const d = Math.abs(at(x, y) - at(rx, ry));
      if (d > worst) {
        worst = d;
        where = `${x},${y} vs ${rx},${ry}`;
      }
    }
  }
  return { worst, where };
}

/** the square every case below strokes: (20, 20) to (100, 100) */
function square(ctx) {
  ctx.beginPath();
  ctx.moveTo(20, 20);
  ctx.lineTo(100, 20);
  ctx.lineTo(100, 100);
  ctx.lineTo(20, 100);
  ctx.closePath();
  ctx.stroke();
}

// ------------------------------------------------------ the reported defect

test('all four corners of a stroked rect render identically', async () => {
  // the bug as reported: strokeRect(5, 5, 30, 20) at lineWidth 2 left the
  // outer corner at (4, 4) white while the other three were solid
  for (const lw of [2, 4, 8]) {
    const at = await render((ctx) => {
      ctx.lineWidth = lw;
      ctx.strokeRect(20, 20, 80, 80);
    });
    const half = lw / 2;
    const lo = 20 - half;
    const hi = 100 + half - 1;
    const corners = [
      ['top-left', at(lo, lo)],
      ['top-right', at(hi, lo)],
      ['bottom-left', at(lo, hi)],
      ['bottom-right', at(hi, hi)]
    ];
    for (const [name, value] of corners) {
      assert.equal(value, 0, `lineWidth ${lw}: ${name} outer corner is not inked`);
    }
  }
});

test('and the whole square is symmetric, at every width and join', async () => {
  for (const join of ['miter', 'bevel']) {
    for (const lw of [1, 2, 5, 12]) {
      const at = await render((ctx) => {
        ctx.lineWidth = lw;
        ctx.lineJoin = join;
        square(ctx);
      });
      const { worst, where } = asymmetry(at);
      // 1 is antialiasing rounding on the two axes; a missing join is a
      // whole corner, which reads as 255 minus its edge coverage
      assert.ok(worst <= 1, `${join} lineWidth ${lw}: asymmetry ${worst} at ${where}`);
    }
  }
});

test('a closed subpath has no ends, so lineCap cannot change it', async () => {
  // The spec gives caps to the ends of open subpaths; a closed one has
  // none. This used to matter in the worst way: 'square' extended the two
  // seam ends outward and papered over the missing join, so the defect
  // reproduced with the default cap and hid under that one.
  const images = {};
  for (const cap of ['butt', 'square', 'round']) {
    const at = await render((ctx) => {
      ctx.lineWidth = 6;
      ctx.lineCap = cap;
      square(ctx);
    });
    const { worst, where } = asymmetry(at);
    assert.ok(worst <= 1, `cap ${cap}: asymmetry ${worst} at ${where}`);
    images[cap] = at;
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      assert.equal(images.square(x, y), images.butt(x, y), `square cap differs at ${x},${y}`);
      assert.equal(images.round(x, y), images.butt(x, y), `round cap differs at ${x},${y}`);
    }
  }
});

test('translucency does not double-ink where the loop was cut', async () => {
  // The seam is where the two ends of the extrusion meet. If they
  // overlapped rather than abutted, a translucent stroke would show it as
  // a darker patch — and the patch would break the symmetry.
  for (const draw of [
    (ctx) => {
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.lineWidth = 8;
      square(ctx);
    },
    (ctx) => {
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 8;
      square(ctx);
    }
  ]) {
    const at = await render(draw);
    const { worst, where } = asymmetry(at);
    assert.ok(worst <= 1, `asymmetry ${worst} at ${where}`);
    // and it really is half-inked, not fully
    assert.ok(at(20, 60) > 100 && at(20, 60) < 160, `edge value ${at(20, 60)}`);
  }
});

test('dashes keep the property, split or not', async () => {
  // a dashed loop is extruded as open runs, which never had the defect —
  // except when the pattern leaves the loop whole, which takes the closed
  // path again
  for (const dash of [
    [8, 8], // divides the perimeter: many open runs
    [1000, 0] // never splits: one closed loop
  ]) {
    const at = await render((ctx) => {
      ctx.lineWidth = 4;
      ctx.setLineDash(dash);
      square(ctx);
    });
    const { worst, where } = asymmetry(at);
    assert.ok(worst <= 1, `dash ${dash}: asymmetry ${worst} at ${where}`);
  }
});

test('an open subpath still gets its caps, and no phantom join', async () => {
  // the fix must not close what the caller left open: three sides of the
  // square, stroked with square caps, must still be capped at both ends
  const at = await render((ctx) => {
    ctx.lineWidth = 6;
    ctx.lineCap = 'square';
    ctx.beginPath();
    ctx.moveTo(20, 20);
    ctx.lineTo(100, 20);
    ctx.lineTo(100, 100);
    ctx.stroke();
  });
  // the square cap extends the free end half a line width past (20, 20)
  assert.equal(at(18, 20), 0, 'start cap extends past the first point');
  assert.equal(at(15, 20), 255, 'but only by half the line width');
  // the corner it does have is square
  assert.equal(at(102, 22), 0, 'the real corner is joined');
  // and the side the path never drew stays blank
  assert.equal(at(20, 60), 255, 'the open side is not stroked');
});

// -------------------------------------------------------------- curved loops

test('closed curves are symmetric too, up to the arc lowering', async () => {
  // A stroked circle and rounded rect are closed loops as well, and the
  // seam used to cost them the same join. What is left after the fix is a
  // different and much smaller effect that predates it: the extrusion of a
  // flattened arc is not bit-symmetric at the quadrant boundaries where
  // the lowering's cubics meet, which shows as a few alpha steps there —
  // nowhere near the seam. The bound catches a returning seam defect,
  // which was 50-70 steps before the fix.
  for (const [name, draw] of [
    ['circle', (ctx) => {
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(CX, CY, 40, 0, Math.PI * 2);
      ctx.closePath();
      ctx.stroke();
    }],
    ['roundRect', (ctx) => {
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.roundRect(20, 20, 80, 80, 16);
      ctx.stroke();
    }]
  ]) {
    const at = await render(draw);
    const { worst, where } = asymmetry(at);
    assert.ok(worst <= 16, `${name}: asymmetry ${worst} at ${where}`);
  }
});
