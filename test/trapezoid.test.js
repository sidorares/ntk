import assert from 'node:assert/strict';
import { test } from 'node:test';

import { trapArea, trapezoidize } from '../lib/trapezoid.js';

// polygons are flat [x0,y0, x1,y1, ...], y-down

test('rectangle produces a single merged trapezoid with exact area', () => {
  const traps = trapezoidize([[0, 0, 10, 0, 10, 5, 0, 5]]);
  assert.equal(traps.length, 6);
  assert.equal(trapArea(traps), 50);
  const [tl, tr, ty, bl, br, by] = traps;
  assert.ok(ty < by, 'top spanfix comes first (y-down)');
  assert.deepEqual([tl, tr, ty, bl, br, by], [0, 10, 0, 0, 10, 5]);
});

test('triangle area is exact', () => {
  const traps = trapezoidize([[0, 0, 10, 0, 5, 10]]);
  assert.equal(trapArea(traps), 50);
});

test('donut: hole with opposite winding is subtracted', () => {
  const traps = trapezoidize([
    [0, 0, 20, 0, 20, 20, 0, 20], // outer, clockwise
    [5, 15, 15, 15, 15, 5, 5, 5] // inner, counter-clockwise
  ]);
  assert.equal(trapArea(traps), 300); // 400 - 100
});

test('overlapping same-winding contours fill the union once (non-zero rule)', () => {
  const traps = trapezoidize([
    [0, 0, 10, 0, 10, 10, 0, 10],
    [5, 5, 15, 5, 15, 15, 5, 15]
  ]);
  assert.equal(trapArea(traps), 175); // union, not 200
});

test('translation offsets are applied', () => {
  const traps = trapezoidize([[0, 0, 4, 0, 4, 4, 0, 4]], 100, 50);
  assert.deepEqual(traps, [100, 104, 50, 100, 104, 54]);
});

test('degenerate input yields no trapezoids', () => {
  assert.deepEqual(trapezoidize([]), []);
  assert.deepEqual(trapezoidize([[0, 0, 10, 0]]), []); // horizontal line
  assert.deepEqual(trapezoidize([[0, 0, 0, 10]]), []); // zero-width sliver
});

test('appends into a provided output array', () => {
  const out = [1, 2, 3, 4, 5, 6];
  trapezoidize([[0, 0, 2, 0, 2, 2, 0, 2]], 0, 0, out);
  assert.equal(out.length, 12);
});

test('adjacent slabs sharing edges merge (output stays near one trap per edge)', () => {
  // staircase-free convex polygon: a hexagon has 6 edges, expect few traps
  const hex = [10, 0, 20, 5, 20, 15, 10, 20, 0, 15, 0, 5];
  const traps = trapezoidize([hex]);
  assert.ok(traps.length / 6 <= 4, `expected <=4 traps for a hexagon, got ${traps.length / 6}`);
  // shoelace area of the hexagon
  let area = 0;
  for (let i = 0; i < hex.length; i += 2) {
    const j = (i + 2) % hex.length;
    area += hex[i] * hex[j + 1] - hex[j] * hex[i + 1];
  }
  area = Math.abs(area) / 2;
  assert.ok(Math.abs(trapArea(traps) - area) < 1e-9, `${trapArea(traps)} != ${area}`);
});
