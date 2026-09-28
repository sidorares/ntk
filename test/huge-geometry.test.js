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
