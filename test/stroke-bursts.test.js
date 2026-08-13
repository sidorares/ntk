// What a stroke hands the server, on polylines that double back exactly.
//
// A dense polyline with same-x bursts — several consecutive points sharing
// one x and differing in y, the natural shape of a stream appending a few
// samples per timestamp — is full of exact 180° reversals. The guard that
// cuts a run at joins the extruder cannot be trusted with judged a reversal
// by the sign of √(la·lb) + a·b, which at an exact double-back is pure
// cancellation: about half the time it rounds to a few positive ulps
// instead of 0, and cross is exactly 0 there, so the miter-escape test
// stayed quiet as well. The reversal then reached extrude-polyline, which
// normalizes the zero-length tangent of a hairpin into NaN join vertices.
// The wire encodes NaN as 0, so a real server renders wedges radiating from
// the window origin — while the in-process server quietly drops the
// poisoned triangles, which is why these tests assert on the uploaded
// triangle lists themselves and not only on pixels (issue #259).
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';

let app = null;
const W = 440;
const H = 260;

before(async () => {
  const server = xserver.createServer({ width: 600, height: 400 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  app = await createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
  app.shapePolicy = { maxRadius: 0 };
});

after(async () => {
  if (app) await app.close();
});

/**
 * Draw on a white pixmap with every triangle upload recorded — both the
 * direct Render.Triangles route and the coverage-mask route — and return a
 * pixel reader, the inked bounds, and the recorded coordinate lists.
 */
async function render(draw) {
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'black';
  const lists = [];
  const Render = ctx.Render;
  const origTriangles = Render.Triangles;
  Render.Triangles = function (...args) {
    lists.push(args[6]);
    return origTriangles.apply(this, args);
  };
  const origUpload = ctx._uploadCoverage;
  ctx._uploadCoverage = function (spec, ...rest) {
    if (spec && spec.triangles) lists.push(spec.triangles);
    return origUpload.call(this, spec, ...rest);
  };
  try {
    draw(ctx);
  } finally {
    Render.Triangles = origTriangles;
  }
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
  return { at, box, lists };
}

/** every coordinate that reached an upload is finite, and some did */
function assertFiniteUpload(lists, what) {
  let coords = 0;
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      if (!Number.isFinite(list[i])) {
        assert.fail(`${what}: uploaded coordinate ${i} is ${list[i]}`);
      }
    }
    coords += list.length;
  }
  assert.ok(coords > 0, `${what}: the stroke uploaded no triangles`);
}

/** the ink lies inside `hull` grown by `slack`, in whole pixels */
function assertBounded(box, hull, slack, what) {
  assert.ok(box, `${what}: nothing was drawn`);
  const [x0, y0, x1, y1] = hull;
  const ok =
    box.x0 >= Math.floor(x0 - slack) - 1 &&
    box.y0 >= Math.floor(y0 - slack) - 1 &&
    box.x1 <= Math.ceil(x1 + slack) + 1 &&
    box.y1 <= Math.ceil(y1 + slack) + 1;
  assert.ok(
    ok,
    `${what}: ink [${box.x0}, ${box.y0}, ${box.x1}, ${box.y1}] leaves ` +
      `[${x0}, ${y0}, ${x1}, ${y1}] by more than ${slack}`
  );
}

function hullOf(pts) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

// ------------------------------------------------------- the reported stream

// The issue's chart: 1300 points, three per x step, y jittered — every
// interior vertex of a triplet is an exact vertical hairpin whenever the
// jitter changes direction. Deterministic minstd jitter in place of the
// issue's Math.random().
const COLS = 433;
function burstPoints() {
  let seed = 424242;
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const pts = [];
  const band = new Map(); // pixel column -> y extent of the samples in it
  let phase = 0;
  for (let i = 0; i < 1300; i++) {
    phase += 0.02;
    const x = 20 + (Math.floor(i / 3) / COLS) * 400;
    const y = 240 - ((35 + 25 * Math.sin(phase) + rand() * 8) / 100) * 200;
    pts.push([x, y]);
    const cx = Math.round(x);
    const b = band.get(cx);
    if (b) {
      b.min = Math.min(b.min, y);
      b.max = Math.max(b.max, y);
    } else {
      band.set(cx, { min: y, max: y });
    }
  }
  return { pts, band };
}

function strokeBursts(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}

test('a same-x burst stream strokes to finite wire geometry, gap-free', async () => {
  const { pts, band } = burstPoints();
  const { at, box, lists } = await render((ctx) => {
    ctx.lineWidth = 1.5;
    strokeBursts(ctx, pts);
  });
  assertFiniteUpload(lists, 'miter 1.5');
  // no spikes: everything within the samples' box plus the miter allowance
  assertBounded(box, hullOf(pts), (10 * 1.5) / 2, 'miter 1.5');
  // no gaps: every sample column keeps ink near its own samples — a NaN
  // join dropped anywhere would take its neighbouring segments with it
  const missing = [];
  for (const [cx, b] of band) {
    let inked = false;
    const y0 = Math.max(0, Math.floor(b.min) - 4);
    const y1 = Math.min(H - 1, Math.ceil(b.max) + 4);
    for (let y = y0; y <= y1 && !inked; y++) inked = at(cx, y) < 220;
    if (!inked) missing.push(cx);
  }
  assert.deepEqual(missing, [], 'columns left without ink');
});

test('with bevel and round joins, a wider pen, and dashes', async () => {
  const { pts } = burstPoints();
  const hull = hullOf(pts);
  for (const join of ['bevel', 'round']) {
    const { box, lists } = await render((ctx) => {
      ctx.lineWidth = 1.5;
      ctx.lineJoin = join;
      strokeBursts(ctx, pts);
    });
    assertFiniteUpload(lists, join);
    assertBounded(box, hull, 0.75 + 1, join);
  }
  const wide = await render((ctx) => {
    ctx.lineWidth = 8;
    strokeBursts(ctx, pts);
  });
  assertFiniteUpload(wide.lists, 'miter 8');
  assertBounded(wide.box, hull, (10 * 8) / 2, 'miter 8');
  // dashes re-enter the extruder as separate open runs
  const dashed = await render((ctx) => {
    ctx.lineWidth = 1.5;
    ctx.setLineDash([7, 3]);
    strokeBursts(ctx, pts);
  });
  assertFiniteUpload(dashed.lists, 'dashed');
  assertBounded(dashed.box, hull, (10 * 1.5) / 2, 'dashed');
});

test('the clipped composition of the issue stays inside its clip', async () => {
  const { pts } = burstPoints();
  const { at, lists } = await render((ctx) => {
    ctx.beginPath();
    ctx.rect(20, 120, 200, 80);
    ctx.clip();
    ctx.lineWidth = 1.5;
    strokeBursts(ctx, pts);
  });
  assertFiniteUpload(lists, 'clipped');
  let inside = false;
  for (let y = 121; y < 199 && !inside; y++) {
    for (let x = 21; x < 219 && !inside; x++) inside = at(x, y) < 220;
  }
  assert.ok(inside, 'the clip window shows no stroke at all');
  // the samples continue to the right of and below the clip; none of that
  // ink may appear — and neither may anything else outside the box
  assert.equal(at(230, 160), 255, 'ink past the right clip edge');
  assert.equal(at(100, 210), 255, 'ink below the clip');
  assert.equal(at(2, 2), 255, 'ink at the origin corner');
});

// ------------------------------------------------------ minimal double-backs

// Literal coordinates chosen so the two segments are bit-exactly
// antiparallel and √(la·lb) + a·b rounds to a few positive ulps: each of
// these reached the extruder before the fix. Probes sit on the doubled-back
// span — the reversal vertex, the middle, the free end.
const DOUBLEBACKS = [
  [
    'vertical',
    [
      [60, 40],
      [60, 50.00804101489859],
      [60, 40.188162322243755]
    ],
    [
      [60, 49],
      [60, 45],
      [60, 41]
    ]
  ],
  [
    'horizontal',
    [
      [40, 60],
      [50.14186743094673, 60],
      [46.08275369558612, 60]
    ],
    [
      [49, 60],
      [48, 60],
      [47, 60]
    ]
  ],
  [
    'diagonal',
    [
      [40, 90],
      [59.53585669935488, 70.46414330064512],
      [47.436760585492834, 82.56323941450717]
    ],
    [
      [59, 70],
      [53, 76],
      [47, 82]
    ]
  ]
];

test('an exact double-back keeps its ink, at every join', async () => {
  for (const [name, pts, probes] of DOUBLEBACKS) {
    for (const join of ['miter', 'bevel', 'round']) {
      const { at, box, lists } = await render((ctx) => {
        ctx.lineWidth = 1.5;
        ctx.lineJoin = join;
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        ctx.lineTo(pts[1][0], pts[1][1]);
        ctx.lineTo(pts[2][0], pts[2][1]);
        ctx.stroke();
      });
      assertFiniteUpload(lists, `${name} ${join}`);
      // a reversal is past every miter limit, so no join may spike
      assertBounded(box, hullOf(pts), 0.75 + 1, `${name} ${join}`);
      for (const [x, y] of probes) {
        assert.ok(at(x, y) < 200, `${name} ${join}: no ink at ${x},${y}`);
      }
    }
  }
});

test('caps still apply to a run cut at a reversal', async () => {
  const [, pts] = DOUBLEBACKS[0];
  for (const cap of ['square', 'round']) {
    const { at, box, lists } = await render((ctx) => {
      ctx.lineWidth = 1.5;
      ctx.lineCap = cap;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      ctx.lineTo(pts[1][0], pts[1][1]);
      ctx.lineTo(pts[2][0], pts[2][1]);
      ctx.stroke();
    });
    assertFiniteUpload(lists, `cap ${cap}`);
    assertBounded(box, hullOf(pts), 0.75 + 0.75 + 1, `cap ${cap}`);
    // the free start at (60, 40) grows its cap upward; butt would leave
    // the row above it white
    assert.ok(at(60, 39) < 230, `cap ${cap}: no cap past the start point`);
  }
});

test('a closed loop with a burst edge stays finite and bounded', async () => {
  // the loop is cut at the middle of its first edge, so the y values are
  // chosen against that seam: the join at the second vertex is an exact
  // double-back that leaked the old cut test and made the extruder emit NaN
  const { box, lists } = await render((ctx) => {
    ctx.lineWidth = 4;
    ctx.lineJoin = 'bevel';
    ctx.beginPath();
    ctx.moveTo(100, 60);
    ctx.lineTo(100, 111.18229209966132);
    ctx.lineTo(100, 62.9954113088306);
    ctx.lineTo(160, 60);
    ctx.closePath();
    ctx.stroke();
  });
  assertFiniteUpload(lists, 'closed loop');
  assertBounded(box, [100, 60, 160, 111.2], 2 + 1, 'closed loop');
});
