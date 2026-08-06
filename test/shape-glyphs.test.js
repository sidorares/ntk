// The rounded-rect fast path (issue #211): fill/stroke of an axis-aligned
// rounded rect lowers to corner glyphs + FillRectangles instead of polygon
// rasterization. The route must be invisible where it claims parity, must
// bail to the polygon path for everything outside its conditions, and must
// emit exactly the request sequence it promises (that is the perf contract).
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, Path2D, StaticFontSource } from '../lib/index.js';
import {
  TL,
  TR,
  BL,
  BR,
  orientCorner,
  rasterizeCornerMaster,
  roundRectBandRects
} from '../lib/shapeglyphs.js';

let app = null;
const W = 200;
const H = 160;

before(async () => {
  const server = xserver.createServer({ width: 320, height: 240 });
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

/** run `draw` twice — fast path on, then forced off — and read both back */
async function bothRoutes(draw) {
  app.shapePolicy = null;
  const fast = freshCtx();
  draw(fast);
  const fastImg = await fast.getImageData(0, 0, W, H);
  app.shapePolicy = { maxRadius: 0 };
  const slow = freshCtx();
  draw(slow);
  const slowImg = await slow.getImageData(0, 0, W, H);
  app.shapePolicy = null;
  return { fast, slow, fastImg, slowImg };
}

/** worst per-channel difference and the positions of every differing pixel */
function diff(a, b) {
  let max = 0;
  const spots = [];
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const i = (py * W + px) * 4;
      let d = 0;
      for (let ch = 0; ch < 3; ch++) {
        const dd = Math.abs(a.data[i + ch] - b.data[i + ch]);
        if (dd > d) d = dd;
      }
      if (d > 0) {
        spots.push({ px, py, d });
        if (d > max) max = d;
      }
    }
  }
  return { max, spots };
}

const at = (img, x, y) => {
  const i = (y * W + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

// ------------------------------------------------------------------ the tag

test('Path2D: roundRect tags the path, any other verb clears it', () => {
  const p = new Path2D();
  p.roundRect(10, 20, 100, 50, 8);
  assert.ok(p._roundRect, 'tag present after roundRect');
  assert.equal(p._roundRect.x, 10);
  assert.equal(p._roundRect.w, 100);
  assert.equal(p._roundRect.radii[0].x, 8);

  p.lineTo(0, 0);
  assert.equal(p._roundRect, null, 'a later verb clears the tag');

  const q = new Path2D();
  q.moveTo(1, 1);
  q.roundRect(10, 20, 100, 50, 8);
  assert.equal(q._roundRect, null, 'a preceding verb prevents the tag');

  const zero = new Path2D();
  zero.roundRect(5, 5, 20, 10, 0);
  assert.ok(zero._roundRect, 'radius 0 still tags (rect lowering)');
  assert.equal(zero._roundRect.radii[0].x, 0);

  const copy = new Path2D(p);
  assert.equal(copy._roundRect, null, 'copy carries the (cleared) tag state');
  const copy2 = new Path2D(zero);
  assert.ok(copy2._roundRect, 'copy carries a live tag');
});

test('normalizeRadii rides the tag: oversized radii are scaled', () => {
  const p = new Path2D();
  p.roundRect(0, 0, 20, 20, 100); // scaled down to 10
  assert.equal(p._roundRect.radii[0].x, 10);
});

// ------------------------------------------------------- geometry helpers

test('roundRectBandRects: uniform radii produce the classic three bands', () => {
  const c = { tlw: 8, tlh: 8, trw: 8, trh: 8, blw: 8, blh: 8, brw: 8, brh: 8 };
  const rects = roundRectBandRects(10, 20, 100, 50, c);
  assert.deepEqual(rects, [
    18, 20, 84, 8, // top band, between the top corner boxes
    10, 28, 100, 34, // middle band, full width
    18, 62, 84, 8 // bottom band
  ]);
});

test('roundRectBandRects: a pill (r = h/2) has no middle band', () => {
  const c = { tlw: 12, tlh: 12, trw: 12, trh: 12, blw: 12, blh: 12, brw: 12, brh: 12 };
  const rects = roundRectBandRects(0, 0, 60, 24, c);
  assert.deepEqual(rects, [
    12, 0, 36, 12,
    12, 12, 36, 12
  ]);
});

test('roundRectBandRects: per-corner radii cut bands at every box edge', () => {
  const c = { tlw: 4, tlh: 4, trw: 8, trh: 8, blw: 16, blh: 16, brw: 0, brh: 0 };
  const rects = roundRectBandRects(0, 0, 100, 60, c);
  // every rect stays inside the box and none overlaps a corner box
  let area = 0;
  for (let i = 0; i < rects.length; i += 4) {
    const [x, y, w, h] = rects.slice(i, i + 4);
    assert.ok(x >= 0 && y >= 0 && x + w <= 100 && y + h <= 60);
    area += w * h;
  }
  // total partition area: box minus the corner boxes
  assert.equal(area, 100 * 60 - 4 * 4 - 8 * 8 - 16 * 16);
});

// ------------------------------------------------- mirrored corner bitmaps

test('orientCorner: the four corners are exact mirror images', () => {
  const master = rasterizeCornerMaster('fill', 10, 10, 0);
  const tl = orientCorner(master, TL);
  const tr = orientCorner(master, TR);
  const bl = orientCorner(master, BL);
  const br = orientCorner(master, BR);
  const { w, h, stride } = master;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      assert.equal(tr[y * stride + x], tl[y * stride + (w - 1 - x)]);
      assert.equal(bl[y * stride + x], tl[(h - 1 - y) * stride + x]);
      assert.equal(br[y * stride + x], tl[(h - 1 - y) * stride + (w - 1 - x)]);
    }
  }
  // and the quarter disc looks like one: full inside, empty outside
  assert.equal(tl[(h - 1) * stride + (w - 1)], 255, 'inner corner covered');
  assert.equal(tl[0], 0, 'outer corner empty');
});

test('stroke master: a quarter ring open at the band cut lines', () => {
  const r = 8;
  const bw = 2;
  const master = rasterizeCornerMaster('stroke', r, r, bw);
  const { w, stride, data } = master;
  assert.equal(w, Math.ceil(r + bw / 2));
  // at the box bottom edge the band leaves through columns [0, bw): heavy
  // coverage there (the outer arc grazes the very corner, so not exactly
  // 255), and empty just inside the ring
  assert.ok(data[(w - 1) * w] > 200, `band exit covered (${data[(w - 1) * w]})`);
  assert.ok(data[(w - 1) * w + bw + 1] < 16, 'inside the ring is empty');
  // the ring's middle: on the diagonal at distance r from the centre
  const mid = Math.round(r + bw / 2 - r / Math.SQRT2);
  assert.ok(data[mid * w + mid] > 200, 'ring ink on the diagonal');
  assert.equal(data[0], 0, 'outside the outer arc is empty');
  // stride padded for the wire
  assert.equal(stride % 4, 0);
});

// ------------------------------------------------------------- fill parity

const FILL_CASES = [
  ['uniform r=10 opaque', (ctx) => {
    ctx.fillStyle = '#3366cc';
    ctx.beginPath();
    ctx.roundRect(10, 10, 130, 70, 10);
    ctx.fill();
  }],
  ['uniform r=16 translucent', (ctx) => {
    ctx.fillStyle = 'rgba(0,160,0,0.5)';
    ctx.beginPath();
    ctx.roundRect(10, 10, 130, 70, 16);
    ctx.fill();
  }],
  ['r=3 small box', (ctx) => {
    ctx.fillStyle = 'black';
    ctx.beginPath();
    ctx.roundRect(30, 30, 40, 28, 3);
    ctx.fill();
  }],
  ['pill r=h/2', (ctx) => {
    ctx.fillStyle = '#aa3377';
    ctx.beginPath();
    ctx.roundRect(50, 45, 60, 24, 12);
    ctx.fill();
  }],
  ['per-corner [4,8,16,0]', (ctx) => {
    ctx.fillStyle = '#aa3377';
    ctx.beginPath();
    ctx.roundRect(10, 10, 130, 70, [4, 8, 16, 0]);
    ctx.fill();
  }],
  ['elliptical rx=14 ry=6', (ctx) => {
    ctx.fillStyle = '#2266aa';
    ctx.beginPath();
    ctx.roundRect(10, 10, 130, 70, [{ x: 14, y: 6 }]);
    ctx.fill();
  }],
  ['radius 0 (rect lowering)', (ctx) => {
    ctx.fillStyle = 'rgba(20,20,120,0.6)';
    ctx.beginPath();
    ctx.roundRect(15, 15, 90, 40, 0);
    ctx.fill();
  }],
  ['globalAlpha folded', (ctx) => {
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = 'rgba(200,30,30,0.8)';
    ctx.beginPath();
    ctx.roundRect(20, 20, 100, 60, 8);
    ctx.fill();
    ctx.globalAlpha = 1;
  }],
  ['Path2D under translation', (ctx) => {
    const p = new Path2D();
    p.roundRect(0, 0, 80, 50, 9);
    ctx.fillStyle = '#118844';
    ctx.translate(30, 40);
    ctx.fill(p);
    ctx.resetTransform();
  }],
  ['translate-only default path', (ctx) => {
    ctx.translate(25, 35);
    ctx.fillStyle = '#448811';
    ctx.beginPath();
    ctx.roundRect(0, 0, 90, 55, 7);
    ctx.fill();
    ctx.resetTransform();
  }]
];

for (const [name, draw] of FILL_CASES) {
  test(`fill parity: ${name}`, async () => {
    const { fast, slow, fastImg, slowImg } = await bothRoutes(draw);
    assert.ok(fast.shapeStats.hits >= 1, 'fast run took the fast path');
    assert.equal(slow.shapeStats.hits, 0, 'forced run stayed on the polygon route');
    const { max, spots } = diff(fastImg, slowImg);
    // The corner bitmap flattens/rasterizes the same lowered arc as the
    // polygon route, but in glyph-local coordinates rather than at the
    // device position; float rounding in the flattener and accumulator can
    // shift a chord split, which shows as a few alpha steps on antialiased
    // arc pixels. Interior and band pixels agree exactly.
    assert.ok(max <= 4, `max channel diff ${max} at ${JSON.stringify(spots.slice(0, 3))}`);
  });
}

// ----------------------------------------------------------- stroke parity

const STROKE_CASES = [
  // [name, draw, corner boxes for locating allowed diffs: {x,y,w,h,r,bw}]
  ['r=8 bw=2', { x: 20, y: 20, w: 110, h: 50, r: 8, bw: 2 }],
  ['r=6 bw=1 half-integer path', { x: 30.5, y: 30.5, w: 89, h: 29, r: 6, bw: 1 }],
  ['r=12 bw=4', { x: 20, y: 20, w: 110, h: 60, r: 12, bw: 4 }],
  ['pill r=12 bw=2', { x: 40, y: 40, w: 100, h: 24, r: 12, bw: 2 }]
];

for (const [name, g] of STROKE_CASES) {
  test(`stroke parity: ${name}`, async () => {
    const draw = (ctx) => {
      ctx.strokeStyle = 'rgba(160,30,30,0.85)';
      ctx.lineWidth = g.bw;
      ctx.beginPath();
      ctx.roundRect(g.x, g.y, g.w, g.h, g.r);
      ctx.stroke();
    };
    const { fast, slow, fastImg, slowImg } = await bothRoutes(draw);
    assert.equal(fast.shapeStats.hits, 1);
    assert.equal(slow.shapeStats.hits, 0);
    const { max, spots } = diff(fastImg, slowImg);
    // The ring glyph rasterizes the *true* stroke band (outer and inner
    // arcs lowered exactly); the polygon route approximates the band by
    // extruding the flattened centerline, whose chords and miters deviate
    // from the true arcs by up to the flattening tolerance. A quarter-pixel
    // slice of coverage is ~64 alpha steps, and everything beyond a single
    // quantization step must sit on the curved corners — the straight bands
    // are integer rectangles on both routes, give or take the one alpha
    // step the extrusion's arc-to-line transition vertex can bleed past
    // the cut line.
    assert.ok(max <= 64, `max channel diff ${max}`);
    const X0 = g.x - g.bw / 2;
    const Y0 = g.y - g.bw / 2;
    const K = Math.ceil(g.r + g.bw / 2);
    const outW = g.w + g.bw;
    const outH = g.h + g.bw;
    for (const s of spots) {
      if (s.d <= 1) continue;
      const inCornerBox =
        (s.px < X0 + K || s.px >= X0 + outW - K) &&
        (s.py < Y0 + K || s.py >= Y0 + outH - K);
      assert.ok(
        inCornerBox,
        `diff outside corner boxes at ${s.px},${s.py} (d=${s.d})`
      );
    }
  });
}

test('strokeRect lowers to four rectangles and squares every corner', async () => {
  app.shapePolicy = null;
  const ctx = freshCtx();
  ctx.strokeStyle = 'black';
  ctx.lineWidth = 2;
  ctx.strokeRect(10, 10, 60, 40);
  assert.equal(ctx.shapeStats.hits, 1);
  const img = await ctx.getImageData(0, 0, W, H);
  // outer corners of the band: all four painted alike (the polygon route
  // historically notched the seam corner; the lowering must not)
  assert.deepEqual(at(img, 9, 9), [0, 0, 0]);
  assert.deepEqual(at(img, 70, 9), [0, 0, 0]);
  assert.deepEqual(at(img, 9, 49), [0, 0, 0]);
  assert.deepEqual(at(img, 70, 49), [0, 0, 0]);
  // inside stays untouched
  assert.deepEqual(at(img, 40, 30), [255, 255, 255]);
});

test('roundRect stroke with r=0 takes the rectangle lowering too', async () => {
  app.shapePolicy = null;
  const ctx = freshCtx();
  ctx.strokeStyle = 'black';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(10, 10, 60, 40, 0);
  ctx.stroke();
  assert.equal(ctx.shapeStats.hits, 1);
  assert.deepEqual(ctx.shapeStats.misses, {});
});

// ----------------------------------------------------- clip interaction

test('fill parity under a rectangular clip', async () => {
  const draw = (ctx) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(30, 30, 60, 30);
    ctx.clip();
    ctx.fillStyle = '#cc3366';
    ctx.beginPath();
    ctx.roundRect(20, 20, 100, 60, 10);
    ctx.fill();
    ctx.restore();
  };
  const { fast, fastImg, slowImg } = await bothRoutes(draw);
  assert.equal(fast.shapeStats.hits, 1);
  const { max } = diff(fastImg, slowImg);
  assert.ok(max <= 2, `max diff ${max}`);
  // and the clip actually clipped: outside pixels stayed white
  assert.deepEqual(at(fastImg, 25, 25), [255, 255, 255]);
  assert.deepEqual(at(fastImg, 95, 45), [255, 255, 255]);
});

test('a non-rectangular clip falls back (clip-mask miss)', async () => {
  app.shapePolicy = null;
  const ctx = freshCtx();
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(10, 10);
  ctx.lineTo(150, 30);
  ctx.lineTo(60, 120);
  ctx.closePath();
  ctx.clip();
  ctx.fillStyle = 'black';
  ctx.beginPath();
  ctx.roundRect(20, 20, 100, 60, 10);
  ctx.fill();
  ctx.restore();
  assert.equal(ctx.shapeStats.hits, 0);
  assert.equal(ctx.shapeStats.misses['clip-mask'], 1);
});

// ------------------------------------------------------- bail-out reasons

test('conditions the fast path must not take, each counted by reason', async () => {
  app.shapePolicy = null;
  const ctx = freshCtx();

  const grad = ctx.createLinearGradient(0, 0, 100, 0);
  grad.addColorStop(0, 'red');
  grad.addColorStop(1, 'blue');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(10, 10, 100, 60, 8);
  ctx.fill();
  assert.equal(ctx.shapeStats.misses.gradient, 1, 'gradient fill');

  ctx.fillStyle = 'black';
  ctx.rotate(0.3);
  ctx.beginPath();
  ctx.roundRect(10, 10, 100, 60, 8);
  ctx.fill();
  ctx.resetTransform();
  assert.equal(ctx.shapeStats.misses.transform, 1, 'rotated CTM at record time');

  ctx.beginPath();
  ctx.roundRect(10.5, 10, 100, 60, 8);
  ctx.fill();
  assert.equal(ctx.shapeStats.misses.fractional, 1, 'fractional box');

  ctx.beginPath();
  ctx.roundRect(10, 10, 100, 60, 8);
  ctx.globalCompositeOperation = 'xor';
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  assert.equal(ctx.shapeStats.misses['composite-op'], 1, 'non-Over op');

  ctx.strokeStyle = 'black';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 2]);
  ctx.beginPath();
  ctx.roundRect(10, 10, 100, 60, 8);
  ctx.stroke();
  ctx.setLineDash([]);
  assert.equal(ctx.shapeStats.misses.dashes, 1, 'dashed stroke');

  // a 1px stroke on integer coordinates is a genuine two-row 50% band
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(10, 10, 100, 60, 8);
  ctx.stroke();
  assert.equal(ctx.shapeStats.misses.fractional, 2, 'integer-path 1px stroke');

  app.shapePolicy = { maxRadius: 4 };
  ctx.beginPath();
  ctx.roundRect(10, 10, 100, 60, 8);
  ctx.fill();
  assert.equal(ctx.shapeStats.misses['radius-cap'], 1, 'radius above the cap');
  app.shapePolicy = null;

  assert.equal(ctx.shapeStats.hits, 0, 'none of these took the fast path');
});

// -------------------------------------------------- the request sequence

test('steady state: one card is 4 requests, no rasterization, no upload', async () => {
  app.shapePolicy = null;
  const ctx = freshCtx();
  const card = (x, y) => {
    ctx.fillStyle = '#f0f0f4';
    ctx.beginPath();
    ctx.roundRect(x, y, 130, 70, 10);
    ctx.fill();
    ctx.strokeStyle = '#333344';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y + 0.5, 129, 69, 10);
    ctx.stroke();
  };
  // warm up: glyph uploads, solid pictures, GCs
  card(10, 10);
  await app.X.sync();

  // seq_num counts requests (pack_stream.stats.packets counts buffer
  // writes, several per glyph request)
  const before = app.X.seq_num;
  card(20, 60);
  const emitted = app.X.seq_num - before;
  await app.X.sync();
  // CompositeGlyphs + FillRectangles for the fill, the same pair for the
  // border — the sequence the design promises. No AddGlyphs (cache hit),
  // no AddTraps, no PutImage.
  assert.equal(emitted, 4);
  assert.equal(ctx.shapeStats.hits, 2 * 2);
  assert.deepEqual(ctx.shapeStats.misses, {});
});

test('first use of a radius uploads glyphs once (two AddGlyphs batches)', async () => {
  app.shapePolicy = null;
  // reset the page so this test owns the cache state
  if (app._shapeGlyphPage) {
    app._shapeGlyphPage.destroy();
    app._shapeGlyphPage = null;
  }
  const ctx = freshCtx();
  ctx.fillStyle = '#123456';
  // touch the solid picture so its CreateSolidFill is out of the way
  ctx.fillRect(0, 0, 1, 1);
  await app.X.sync();
  const before = app.X.seq_num;
  ctx.beginPath();
  ctx.roundRect(10, 10, 80, 50, 13);
  ctx.fill();
  const first = app.X.seq_num - before;
  ctx.beginPath();
  ctx.roundRect(30, 70, 90, 60, 13);
  ctx.fill();
  const second = app.X.seq_num - before - first;
  await app.X.sync();
  // first draw: CreateGlyphSet + AddGlyphs + CompositeGlyphs + FillRectangles
  assert.equal(first, 4);
  // second draw of the same radius: glyphs cached
  assert.equal(second, 2);
});

// ------------------------------------------------------- cache behaviour

test('the cache budget bounds uploads via page reset, drawing stays right', async () => {
  app.shapePolicy = { cacheBytes: 2048 };
  if (app._shapeGlyphPage) {
    app._shapeGlyphPage.destroy();
    app._shapeGlyphPage = null;
  }
  const ctx = freshCtx();
  // an adversarial animated-radius load: every draw a new radius
  for (let r = 4; r < 40; r++) {
    ctx.fillStyle = 'black';
    ctx.beginPath();
    ctx.roundRect(10, 10, 100, 90, r);
    ctx.fill();
    const page = app._shapeGlyphPage;
    if (page) assert.ok(page.bytes <= 2048 + 4 * 40 * 40, `bytes ${page.bytes}`);
  }
  // after all the churn, a fresh draw through the (possibly reset) page
  // still renders correctly
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'black';
  ctx.beginPath();
  ctx.roundRect(10, 10, 100, 90, 20);
  ctx.fill();
  app.shapePolicy = null;
  const img = await ctx.getImageData(0, 0, W, H);
  assert.deepEqual(at(img, 60, 55), [0, 0, 0], 'box filled');
  assert.deepEqual(at(img, 11, 11), [255, 255, 255], 'corner rounded');
  assert.deepEqual(at(img, 60, 11), [0, 0, 0], 'top edge filled');
});

// --------------------------------------------- rendered mirror symmetry

test('the four rendered corners of a box are pixel-exact mirrors', async () => {
  app.shapePolicy = null;
  const ctx = freshCtx();
  ctx.fillStyle = 'black';
  ctx.beginPath();
  ctx.roundRect(10, 10, 100, 80, 15);
  ctx.fill();
  const img = await ctx.getImageData(0, 0, W, H);
  // sample the corner boxes: TL (10..25, 10..25) must mirror TR/BL/BR
  for (let dy = 0; dy < 15; dy++) {
    for (let dx = 0; dx < 15; dx++) {
      const tl = at(img, 10 + dx, 10 + dy);
      assert.deepEqual(at(img, 109 - dx, 10 + dy), tl, `TR mirror at ${dx},${dy}`);
      assert.deepEqual(at(img, 10 + dx, 89 - dy), tl, `BL mirror at ${dx},${dy}`);
      assert.deepEqual(at(img, 109 - dx, 89 - dy), tl, `BR mirror at ${dx},${dy}`);
    }
  }
});
