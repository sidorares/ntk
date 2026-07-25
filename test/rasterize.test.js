import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rasterizePath } from '../lib/rasterize.js';

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
