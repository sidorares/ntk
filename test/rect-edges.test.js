// Rectangles at fractional positions, on the identity fast paths: fillRect,
// fillRects and clearRect put each edge on the nearest pixel boundary.
//
// The wire carries whole numbers, and it used to get them by truncating a
// rectangle's x and its width separately. Two rectangles that met at a
// fractional edge — the selection bands of two lines as tall as their face,
// 15.13px — then left a row of neither between them every seventh or eighth
// line, or covered one twice. And a rectangle crossing the surface's edge
// was cut a pixel differently from the same rectangle moved: a scroll's copy
// and a repaint disagreed about it.
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';

let app = null;
const W = 40;
const H = 200;
const LINE = 15.1328125;

before(async () => {
  const server = xserver.createServer({ width: 200, height: 300 });
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

/** the column at x = 10, top to bottom, as "r,g,b" strings */
async function column(ctx) {
  const img = await ctx.getImageData(0, 0, W, H);
  const out = [];
  for (let y = 0; y < H; y++) {
    const i = (y * W + 10) * 4;
    out.push(`${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`);
  }
  return out;
}

/** a translucent band per line, from `top`, each where the last one ended */
const bands = (top, n = 11) =>
  Array.from({ length: n }, (_, i) => [0, top + i * LINE, 30, LINE]);

for (const [name, draw] of [
  [
    'fillRect',
    (ctx, list) => {
      for (const [x, y, w, h] of list) ctx.fillRect(x, y, w, h);
    },
  ],
  ['fillRects', (ctx, list) => ctx.fillRects(list)],
]) {
  test(`${name}: bands that meet at fractional edges leave no row between them, and double none`, async () => {
    for (const top of [3.25, 10.5, 17.9]) {
      const ctx = freshCtx();
      ctx.fillStyle = 'rgba(0, 0, 255, 0.5)';
      draw(ctx, bands(top));
      const col = await column(ctx);
      const first = Math.round(top);
      const last = Math.round(top + 11 * LINE) - 1;
      const band = col[first];
      assert.notEqual(band, '255,255,255');
      for (let y = first; y <= last; y++) {
        assert.equal(col[y], band, `from ${top}: row ${y} is ${col[y]}, the band is ${band}`);
      }
      assert.equal(col[first - 1], '255,255,255', 'and nothing above the first band');
      assert.equal(col[last + 1], '255,255,255', 'or below the last');
    }
  });

  test(`${name}: a band across the surface's top edge is the same band moved`, async () => {
    // the bands from -40.3 are those from 59.7 a hundred rows up: the rows
    // both have on the surface agree
    const up = freshCtx();
    const down = freshCtx();
    for (const ctx of [up, down]) ctx.fillStyle = 'rgba(0, 0, 255, 0.5)';
    draw(up, bands(-40.3));
    draw(down, bands(59.7));
    const a = await column(up);
    const b = await column(down);
    for (let y = 0; y + 100 < H; y++) {
      assert.equal(a[y], b[y + 100], `row ${y}`);
    }
  });
}

test('clearRect rounds its edges the same way', async () => {
  const pixmap = app.createPixmap({ width: W, height: H, depth: 32 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, W, H);
  ctx.clearRect(0, 10.6, W, 5.2); // rows 11..15
  const img = await ctx.getImageData(0, 0, W, H);
  const alphaAt = (y) => img.data[(y * W + 10) * 4 + 3];
  assert.equal(alphaAt(10), 255);
  for (let y = 11; y < 16; y++) assert.equal(alphaAt(y), 0, `row ${y} cleared`);
  assert.equal(alphaAt(16), 255);
});
