// Where a stroke is allowed to put ink.
//
// A stroke of a path is the path swept by the pen, so it cannot reach further
// than half a line width from the path itself — plus, at a miter join, the
// miter, which `miterLimit` bounds at `miterLimit * lineWidth / 2`. A bezier
// lies inside the convex hull of its four control points, so the hull plus
// that slack bounds the whole drawing, whatever the curve does inside it.
//
// Two independent defects broke that bound (issue #233), and both are here:
//
// - flattening judged a cubic by its distance from its chord's *line*, so a
//   piece whose handles point back down the chord — hugging the line while
//   overshooting an endpoint and coming back — was emitted as a single chord
//   running the other way. The join to the next segment then read as a ~180°
//   cusp that the path does not have.
// - the extruder closes the inner side of every join at the intersection of
//   the two inner offsets, which is r/cos(φ/2) from the vertex and runs away
//   as the turn φ approaches a reversal. It emits that point under every join
//   style — `bevel` bevels the outer side and keeps it — so neither the join
//   style nor the miter limit bounded the spike.
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';

let app = null;
const W = 260;
const H = 120;

before(async () => {
  const server = xserver.createServer({ width: 400, height: 200 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  app = await createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
  app.shapePolicy = { maxRadius: 0 };
});

after(async () => {
  if (app) await app.close();
});

/** draw on a white pixmap and return a pixel reader plus the inked bounds */
async function render(draw) {
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'black';
  draw(ctx);
  const img = await ctx.getImageData(0, 0, W, H);
  pixmap.destroy();
  const at = (x, y) => img.data[(y * W + x) * 4];
  let box = null;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (at(x, y) > 200) continue; // white, or nearly
      if (!box) box = { x0: x, y0: y, x1: x, y1: y };
      box.x0 = Math.min(box.x0, x);
      box.y0 = Math.min(box.y0, y);
      box.x1 = Math.max(box.x1, x);
      box.y1 = Math.max(box.y1, y);
    }
  }
  return { at, box };
}

/**
 * Assert the ink lies inside `hull` grown by `slack`, in whole pixels: a
 * pixel is inked when the curve passes anywhere through it, so the box is
 * allowed the pixel the boundary lands in, and one more for antialiasing.
 */
function assertInside(box, hull, slack, what) {
  assert.ok(box, `${what}: nothing was drawn`);
  const [x0, y0, x1, y1] = hull;
  const lo = (v, limit) => v >= Math.floor(limit - slack) - 1;
  const hi = (v, limit) => v <= Math.ceil(limit + slack) + 1;
  const ok =
    lo(box.x0, x0) && lo(box.y0, y0) && hi(box.x1, x1) && hi(box.y1, y1);
  assert.ok(
    ok,
    `${what}: ink [${box.x0}, ${box.y0}, ${box.x1}, ${box.y1}] leaves ` +
      `[${x0}, ${y0}, ${x1}, ${y1}] by more than ${slack}`
  );
}

// --------------------------------------------------------- the reported path

// six cubics whose control points all lie in a 30x18 box, from react-x11's
// password-field scribble mask. The stroke of it reached x = 77.
const START = { x: 7.7, y: 15.7 };
const SCRIBBLE = [
  { c1x: 8.6, c1y: 14.1, c2x: 13.6, c2y: 8.2, x: 13.0, y: 5.9 },
  { c1x: 12.5, c1y: 3.7, c2x: 2.8, c2y: 2.0, x: 4.3, y: 2.0 },
  { c1x: 5.9, c1y: 2.5, c2x: 20.4, c2y: 7.2, x: 22.3, y: 8.8 },
  { c1x: 24.1, c1y: 10.5, c2x: 16.1, c2y: 10.9, x: 15.4, y: 12.1 },
  { c1x: 14.8, c1y: 13.3, c2x: 16.9, c2y: 16.0, x: 18.4, y: 15.9 },
  { c1x: 20.0, c1y: 15.2, c2x: 23.7, c2y: 9.0, x: 24.8, y: 7.7 }
];
// the control points' own bounding box, offset by the (10, 10) the path is
// drawn at — the smallest box the six cubics are guaranteed to stay inside
const SCRIBBLE_HULL = [12.8, 12.0, 34.8, 25.9];

function scribble(ctx, scale = 1) {
  ctx.beginPath();
  ctx.moveTo((10 + START.x) * scale, (10 + START.y) * scale);
  for (const s of SCRIBBLE) {
    ctx.bezierCurveTo(
      (10 + s.c1x) * scale,
      (10 + s.c1y) * scale,
      (10 + s.c2x) * scale,
      (10 + s.c2y) * scale,
      (10 + s.x) * scale,
      (10 + s.y) * scale
    );
  }
  ctx.stroke();
}

test('a small scribble of beziers stays inside its control points', async () => {
  for (const scale of [1, 2]) {
    for (const lw of [0.5, 1, 1.5, 3]) {
      for (const join of ['round', 'bevel']) {
        const { box } = await render((ctx) => {
          ctx.lineWidth = lw;
          ctx.lineCap = 'round';
          ctx.lineJoin = join;
          scribble(ctx, scale);
        });
        assertInside(
          box,
          SCRIBBLE_HULL.map((v) => v * scale),
          lw / 2,
          `scale ${scale} lineWidth ${lw} ${join}`
        );
      }
    }
  }
});

test('and inside the miter limit when the joins are mitered', async () => {
  // a miter may legitimately overshoot, by up to miterLimit * lineWidth / 2 —
  // the spike was 28 times that at lineWidth 1.5, and grew with the width
  for (const lw of [0.5, 1, 1.5, 3]) {
    for (const miterLimit of [10, 2]) {
      const { box } = await render((ctx) => {
        ctx.lineWidth = lw;
        ctx.lineJoin = 'miter';
        ctx.miterLimit = miterLimit;
        scribble(ctx);
      });
      assertInside(
        box,
        SCRIBBLE_HULL,
        (miterLimit * lw) / 2,
        `lineWidth ${lw} miterLimit ${miterLimit}`
      );
    }
  }
});

// ------------------------------------------------------------------ hairpins

// A cusp is legal geometry, and the sharper the turn the further the inner
// join runs: these are the same defect reached without any bezier at all.
const HAIRPINS = [
  ['lineTo, doubling back', [40, 60, 160, 60], (ctx) => {
    ctx.moveTo(40, 60);
    ctx.lineTo(160, 60);
    ctx.lineTo(41, 60.5);
  }],
  ['a cusped cubic', [40, 60, 130, 61], (ctx) => {
    // both handles run 120px right, so the curve turns back at
    // 40 + 0.75 * 120 — well short of the control points
    ctx.moveTo(40, 60);
    ctx.bezierCurveTo(160, 60, 160, 61, 40, 61);
  }],
  ['a tight curl', [30, 20, 90, 45], (ctx) => {
    // control-point hull, which the curve stays well inside
    ctx.moveTo(60, 45);
    ctx.bezierCurveTo(90, 20, 30, 20, 62, 45);
  }]
];

test('a hairpin does not throw a spike, at any width or join', async () => {
  for (const [name, hull, path] of HAIRPINS) {
    for (const lw of [1.5, 6, 14]) {
      for (const join of ['round', 'bevel', 'miter']) {
        const { box } = await render((ctx) => {
          ctx.lineWidth = lw;
          ctx.lineJoin = join;
          ctx.beginPath();
          path(ctx);
          ctx.stroke();
        });
        // a reversal is past every miter limit, so even 'miter' bevels here
        assertInside(box, hull, lw / 2, `${name}: lineWidth ${lw} ${join}`);
      }
    }
  }
});

// --------------------------------------------- what the join must still draw

// Cutting the run at an escaping join hands the outer side of that join back
// to us. These pin what it draws, on a corner short enough to take the cut:
// two 3px segments at a right angle under a 20px pen (the inner corner would
// be 10px past both of them).
function corner(ctx) {
  ctx.beginPath();
  ctx.moveTo(60, 40);
  ctx.lineTo(63, 40);
  ctx.lineTo(63, 43);
  ctx.stroke();
}

test('a mitered corner keeps its point, however short the segments', async () => {
  const { at } = await render((ctx) => {
    ctx.lineWidth = 20;
    ctx.lineJoin = 'miter';
    corner(ctx);
  });
  // outer corner: (63, 40) + (10, -10)
  assert.equal(at(72, 31), 0, 'the miter tip is missing');
  assert.equal(at(74, 29), 255, 'and does not extend past it');
});

test('a bevelled corner cuts the same point off', async () => {
  const { at } = await render((ctx) => {
    ctx.lineWidth = 20;
    ctx.lineJoin = 'bevel';
    corner(ctx);
  });
  assert.equal(at(72, 31), 255, 'the tip is not bevelled away');
  // the bevel runs from (63, 30) to (73, 40); just inside it is inked
  assert.equal(at(66, 34), 0, 'the bevel itself is missing');
});

test('the inner corner stops where the segments do', async () => {
  // The two 3px segments cover x in [60, 63] and y in [40, 43] respectively,
  // so under a 20px pen the ink is those two bands, plus the disk a round
  // join puts on the vertex — which is still within 10px of the path. The
  // join used to close the inner side at (53, 50) instead: 10px past the end
  // of both segments, and 14 from the vertex.
  for (const join of ['miter', 'bevel', 'round']) {
    const { at } = await render((ctx) => {
      ctx.lineWidth = 20;
      ctx.lineJoin = join;
      corner(ctx);
    });
    assert.equal(at(55, 48), 255, `${join}: ink past both segments' ends`);
    // the bands themselves are intact
    assert.equal(at(61, 48), 0, `${join}: the first segment's band is short`);
    assert.equal(at(56, 41), 0, `${join}: the second segment's band is short`);
  }
});
