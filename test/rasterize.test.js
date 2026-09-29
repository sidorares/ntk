import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rasterizePath, rasterizePolys, rasterizeTriangles } from '../lib/rasterize.js';

const square = (x0, y0, size) => [
  { type: 'M', x: x0, y: y0 },
  { type: 'L', x: x0 + size, y: y0 },
  { type: 'L', x: x0 + size, y: y0 + size },
  { type: 'L', x: x0, y: y0 + size },
  { type: 'Z' }
];

test('empty path rasterizes to null', () => {
  assert.equal(rasterizePath([]), null);
  assert.equal(rasterizePath([{ type: 'M', x: 1, y: 1 }, { type: 'Z' }]), null);
});

test('axis-aligned square is fully covered', () => {
  const bm = rasterizePath(square(0, 0, 16));
  assert.equal(bm.height, 16);
  assert.equal(bm.left, 0);
  assert.equal(bm.top, 0);
  // stride is padded to 4 bytes
  assert.equal(bm.width % 4, 0);

  // interior pixels are fully opaque
  for (let y = 1; y < 15; ++y) {
    for (let x = 1; x < 15; ++x) {
      assert.equal(bm.data[y * bm.width + x], 255, `pixel ${x},${y}`);
    }
  }
  // padding pixels beyond the outline are transparent
  for (let y = 0; y < bm.height; ++y) {
    for (let x = 16; x < bm.width; ++x) {
      assert.equal(bm.data[y * bm.width + x], 0);
    }
  }
});

test('square with a hole (non-zero winding)', () => {
  // outer clockwise, inner counter-clockwise -> hole
  const commands = [
    ...square(0, 0, 20).slice(0, -1),
    { type: 'M', x: 5, y: 5 },
    { type: 'L', x: 5, y: 15 },
    { type: 'L', x: 15, y: 15 },
    { type: 'L', x: 15, y: 5 },
    { type: 'Z' }
  ];
  const bm = rasterizePath(commands);
  // inside the hole
  assert.equal(bm.data[10 * bm.width + 10], 0);
  // in the ring between outer and inner
  assert.equal(bm.data[2 * bm.width + 2], 255);
});

test('negative coordinates produce left/top offsets', () => {
  const bm = rasterizePath(square(-8, -12, 10));
  assert.equal(bm.left, -8);
  assert.equal(bm.top, -12);
  assert.equal(bm.height, 10);
});

test('curves are flattened with antialiased edges', () => {
  // a circle-ish shape from two cubic arcs
  const commands = [
    { type: 'M', x: 0, y: 10 },
    { type: 'C', x1: 0, y1: -3.3, x2: 20, y2: -3.3, x: 20, y: 10 },
    { type: 'C', x1: 20, y1: 23.3, x2: 0, y2: 23.3, x: 0, y: 10 },
    { type: 'Z' }
  ];
  const bm = rasterizePath(commands);
  // center opaque
  assert.equal(bm.data[10 * bm.width + 10], 255);
  // at least some partially covered pixels on the curve boundary
  const partial = [...bm.data].filter((v) => v > 0 && v < 255);
  assert.ok(partial.length > 0, 'expected antialiased boundary pixels');
});

// A pixel's coverage cannot depend on how far the grid reaches past it. An
// edge crossing the grid's left or right border had each row's span squashed
// into the grid, which spread the part beyond over the pixels the rest
// crossed: a triangle poking past the right edge left its last column at a
// tenth of its coverage, and a polygon across either border came out up to
// 210 levels off. The same shapes on a grid reaching far past them on both
// sides are the answer, pixel for pixel.

test('coverage inside the grid does not depend on how far past it the grid reaches', () => {
  const W = 64;
  const H = 48;
  const PAD = 300;
  let seed = 3;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const inside = (narrow, wide) => {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const a = narrow[y * W + x];
        const b = wide[y * (W + 2 * PAD) + x + PAD];
        if (a !== b) return `(${x}, ${y}): ${a} against ${b}`;
      }
    }
    return null;
  };
  for (let k = 0; k < 400; k++) {
    // shapes anywhere around the grid, most of them across a border
    const pts = [];
    for (let i = 0, n = 3 + Math.floor(rnd() * 5); i < n; i++) {
      pts.push(rnd() * (W + 160) - 80, rnd() * (H + 20) - 10);
    }
    const polys = inside(rasterizePolys([pts], W, H), rasterizePolys([pts], W + 2 * PAD, H, 'nonzero', { dx: PAD }));
    assert.equal(polys, null, `polygon ${JSON.stringify(pts)}: ${polys}`);
    const tris = pts.slice(0, 6);
    const soup = inside(rasterizeTriangles(tris, W, H), rasterizeTriangles(tris, W + 2 * PAD, H, { dx: PAD }));
    assert.equal(soup, null, `triangle ${JSON.stringify(tris)}: ${soup}`);
  }
});

test('an edge far outside the grid is passed over, not walked row by row', () => {
  // a fill under a transform that put it a trillion pixels away: `y0 | 0`
  // wrapped negative past 2^31, and the row loop ran billions of times
  const started = performance.now();
  const far = [5, 5, 60, 5, 60, 1e18, 5, 3e12];
  // wholly below the grid, starting between 2^31 and 2^32, where `| 0`
  // wraps to minus 1.29 billion
  const below = [5, 3e9, 60, 3e9, 60, 3.5e9];
  const out = rasterizePolys([far, below, [1e15, 2e15, 3e15, 2e15, 2e15, 4e15], [NaN, 1, 5, 9, 1, NaN]], 64, 48);
  assert.ok(performance.now() - started < 1000, 'promptly');
  // the part of the first polygon inside the grid still fills
  assert.equal(out[20 * 64 + 30], 255);
  assert.equal(out[2 * 64 + 30], 0);
});
