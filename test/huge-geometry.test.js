// Geometry far larger than the surface it is drawn on. XRender takes
// trapezoids and triangles in 16.16 fixed point and core X takes rectangles
// in 16 bits, so a coordinate past 32,767 overflows the word node-x11 writes
// it into, and the RangeError came out of the paint. A box of a code block
// twenty thousand lines tall, in a scroll pane, was the case that found it:
// filled as a rounded rectangle, 380,000 pixels tall.
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { ScanlineRasterizer, createClient, StaticFontSource } from '../lib/index.js';
import { clipRingToRect, clipTrianglesToRect } from '../lib/cliprect.js';

let app = null;
const W = 120;
const H = 120;
const FAR = 200_000;

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

const at = (img, x, y) => {
  const i = (y * W + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
const isWhite = (p) => p[0] > 240 && p[1] > 240 && p[2] > 240;
const isBlack = (p) => p[0] < 15 && p[1] < 15 && p[2] < 15;

/** A rounded rectangle as a path, the way a box's background is one. */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/** Draw on both routes: the local rasterizer, and the server alone. */
async function eachRoute(draw) {
  const out = [];
  for (const rasterizer of [new ScanlineRasterizer(), null]) {
    app.rasterizer = rasterizer;
    const ctx = freshCtx();
    ctx.fillStyle = 'black';
    ctx.strokeStyle = 'black';
    draw(ctx);
    out.push(await ctx.getImageData(0, 0, W, H));
  }
  app.rasterizer = new ScanlineRasterizer();
  return out;
}

test('a rounded box far taller than the surface fills what the surface shows', async () => {
  for (const img of await eachRoute((ctx) => {
    roundRect(ctx, 10, -FAR, 100, 2 * FAR, 6);
    ctx.fill();
  })) {
    assert.ok(isBlack(at(img, 60, 0)), 'the top row is inside it');
    assert.ok(isBlack(at(img, 60, H - 1)), 'and so is the bottom one');
    assert.ok(isWhite(at(img, 5, 60)), 'left of it is not');
    assert.ok(isWhite(at(img, 115, 60)), 'nor right of it');
  }
});

test('a stroke far longer than the surface draws what the surface shows', async () => {
  for (const img of await eachRoute((ctx) => {
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(60, -FAR);
    ctx.lineTo(60, FAR);
    ctx.stroke();
  })) {
    assert.ok(isBlack(at(img, 60, 60)), 'the line crosses the middle');
    assert.ok(isWhite(at(img, 50, 60)), 'and is only as wide as it is');
  }
});

test('a clip path far larger than the surface clips to what it covers', async () => {
  for (const img of await eachRoute((ctx) => {
    roundRect(ctx, 10, -FAR, 100, 2 * FAR, 6);
    ctx.clip();
    ctx.fillRect(0, 0, W, H);
  })) {
    assert.ok(isBlack(at(img, 60, 60)), 'inside the clip');
    assert.ok(isWhite(at(img, 5, 60)), 'outside it');
  }
});

test('a rectangle far larger than the surface fills it', async () => {
  for (const img of await eachRoute((ctx) => {
    ctx.fillRect(10, -FAR, 100, 2 * FAR);
  })) {
    assert.ok(isBlack(at(img, 60, 60)));
    assert.ok(isWhite(at(img, 5, 60)));
  }
});

test('clipRingToRect keeps what is inside, and nothing of what is not', () => {
  const square = [-10, -10, 30, -10, 30, 30, -10, 30];
  const ring = clipRingToRect(square, 0, 0, 20, 20);
  const xs = ring.filter((_, i) => i % 2 === 0);
  const ys = ring.filter((_, i) => i % 2 === 1);
  assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [0, 20, 0, 20]);
  assert.deepEqual(clipRingToRect([100, 100, 110, 100, 105, 110], 0, 0, 20, 20), []);
  const inside = [1, 1, 5, 1, 3, 4];
  assert.deepEqual(clipRingToRect(inside, 0, 0, 20, 20), inside);
});

test('clipTrianglesToRect cuts a triangle that crosses into a fan inside', () => {
  const tris = clipTrianglesToRect([-10, 5, 30, 5, 10, 25], 0, 0, 20, 20);
  assert.ok(tris.length >= 6 && tris.length % 6 === 0);
  for (let i = 0; i < tris.length; i += 2) {
    assert.ok(tris[i] >= 0 && tris[i] <= 20 && tris[i + 1] >= 0 && tris[i + 1] <= 20);
  }
  assert.deepEqual(clipTrianglesToRect([1, 1, 5, 1, 3, 4], 0, 0, 20, 20), [1, 1, 5, 1, 3, 4]);
});

test('a batch of rectangles with one far larger than the surface fills them all', async () => {
  for (const img of await eachRoute((ctx) => {
    ctx.fillRects([
      [10, -FAR, 40, 2 * FAR],
      [70, 50, 20, 20]
    ]);
  })) {
    assert.ok(isBlack(at(img, 30, 60)), 'the tall one');
    assert.ok(isBlack(at(img, 80, 60)), 'the small one');
    assert.ok(isWhite(at(img, 60, 60)), 'and not between them');
  }
});

test('a shadowed rectangle far larger than the surface casts its shadow onto it', async () => {
  for (const img of await eachRoute((ctx) => {
    ctx.shadowColor = 'black';
    ctx.shadowBlur = 2;
    ctx.shadowOffsetX = 30;
    ctx.fillStyle = 'white';
    ctx.fillRect(10, -FAR, 40, 2 * FAR);
  })) {
    assert.ok(!isWhite(at(img, 65, 60)), 'the shadow, right of the white box');
  }
});

test('geometry a little past the surface goes as it came, and what misses it not at all', async () => {
  // The cut is for what the wire cannot carry. A zoomed graph has hundreds
  // of edges a few hundred pixels past the window every frame, and cutting
  // each one cost more than the server's own clipping of it.
  app.rasterizer = null;
  try {
    const ctx = freshCtx();
    const sent = [];
    const Triangles = ctx.Render.Triangles;
    ctx.Render.Triangles = function (...args) {
      sent.push(args[args.length - 1]);
      return Triangles.apply(this, args);
    };
    try {
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 3;
      ctx.beginPath();
      // a leg wholly left of the surface, then one across it
      ctx.moveTo(-400, 10);
      ctx.lineTo(-300, H / 2);
      ctx.lineTo(W + 400, H / 2);
      ctx.stroke();
    } finally {
      ctx.Render.Triangles = Triangles;
    }
    const tris = sent.flat();
    const xs = tris.filter((_, i) => i % 2 === 0);
    assert.ok(xs.length, 'the stroke went out as triangles');
    assert.ok(Math.min(...xs) < -250, `sent from x ${Math.min(...xs)}, not cut at the surface`);
    // and a triangle that does not reach the surface is not sent at all
    for (let i = 0; i < tris.length; i += 6) {
      const txs = [tris[i], tris[i + 2], tris[i + 4]];
      assert.ok(Math.max(...txs) >= -1, `a triangle wholly off the surface was sent: ${txs}`);
    }
    const image = await ctx.getImageData(0, 0, W, H);
    assert.ok(isBlack(at(image, W / 2, H / 2)), 'and it is drawn');
  } finally {
    app.rasterizer = new ScanlineRasterizer();
  }
});

// Canvas draws a rectangle with a negative width or height the other way,
// and draws nothing for one with a side that is not finite. X encodes a
// rectangle's size unsigned and its corner in 16 bits, so a negative size
// that reached the wire threw from inside the paint: `<Html>` found it, an
// underline whose run came out narrower than nothing, and left its
// document blank.

test('a rectangle with a negative size fills it the other way', async () => {
  for (const img of await eachRoute((ctx) => {
    ctx.fillRect(110, 20, -100, 20);
    // the far corner a million pixels right, the near one inside: what
    // came to the wire as x = 1,000,000 and w = -999,950
    ctx.fillRect(1_000_000, 70, -999_950, 20);
  })) {
    assert.ok(isBlack(at(img, 60, 30)), 'the first, drawn leftwards');
    assert.ok(isWhite(at(img, 5, 30)), 'from where it says');
    assert.ok(isBlack(at(img, 60, 80)), 'the second, to the edge');
    assert.ok(isWhite(at(img, 40, 80)), 'from its near corner');
  }
});

test('clearRect with a negative size, or past the surface, clears what it covers', async () => {
  for (const img of await eachRoute((ctx) => {
    ctx.fillRect(0, 0, W, H);
    ctx.clearRect(110, 10, -100, 20);
    ctx.clearRect(-FAR, 60, 2 * FAR, 20);
  })) {
    assert.ok(isWhite(at(img, 60, 20)), 'cleared leftwards');
    assert.ok(isBlack(at(img, 5, 20)), 'and only that far');
    assert.ok(isWhite(at(img, 60, 70)), 'the band far wider than the surface');
    assert.ok(isBlack(at(img, 60, 100)), 'and not below it');
  }
});

test('a rectangle with a side that is not finite draws nothing', async () => {
  for (const img of await eachRoute((ctx) => {
    ctx.fillRect(NaN, 0, 50, 50);
    ctx.fillRect(0, 0, Infinity, 50);
    ctx.fillRect(0, 0, 50, -Infinity);
    ctx.strokeRect(10, 10, NaN, 20);
    ctx.clearRect(0, 0, NaN, H);
  })) {
    assert.ok(isWhite(at(img, 25, 25)));
  }
});

// Dashing walks only the part of a path the surface can show and passes over
// the rest by its length (lib/dash.js): a dashed border round a box 380,000
// pixels tall was 95,000 dashes and 78 ms a stroke. What it draws has to be
// what a walk of the whole border draws, and a short stroke over the same
// stretch, started at the phase the border reaches it at, draws exactly that.

test('a dashed border round a box far taller than the surface is dashed in phase', async () => {
  const dashed = (ctx) => {
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
  };
  const border = await eachRoute((ctx) => {
    dashed(ctx);
    ctx.strokeRect(10, -FAR, 100, 2 * FAR);
  });
  const stretches = await eachRoute((ctx) => {
    dashed(ctx);
    // the right edge runs down from (110, -FAR), after the top's 100
    ctx.lineDashOffset = 100 + (FAR - 2);
    ctx.beginPath();
    ctx.moveTo(110, -2);
    ctx.lineTo(110, H + 2);
    ctx.stroke();
    // the left edge runs up from (10, FAR), after the top, the right and the
    // bottom
    ctx.lineDashOffset = 100 + 2 * FAR + 100 + (FAR - (H + 2));
    ctx.beginPath();
    ctx.moveTo(10, H + 2);
    ctx.lineTo(10, -2);
    ctx.stroke();
  });
  for (let route = 0; route < border.length; route++) {
    const img = border[route];
    assert.ok(isBlack(at(img, 110, 1)) || isBlack(at(img, 110, 8)), 'the right edge is dashed on the surface');
    assert.deepEqual(Buffer.from(img.data), Buffer.from(stretches[route].data), `route ${route}`);
  }
});

test('a pattern too fine to draw one dash at a time strokes solid, and promptly', async () => {
  const started = performance.now();
  for (const img of await eachRoute((ctx) => {
    ctx.setLineDash([1e-9, 1e-9]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(10, 60);
    ctx.lineTo(110, 60);
    ctx.stroke();
  })) {
    assert.ok(isBlack(at(img, 30, 60)) && isBlack(at(img, 90, 60)), 'a line where the dashes would be');
  }
  // it ran the heap out before
  assert.ok(performance.now() - started < 5000);
});
