import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ScanlineRasterizer } from '../lib/rasterize.js';
import { clipTraps, trapArea, trapezoidize } from '../lib/trapezoid.js';
import { crossingPoints, filledArea, PENTAGRAM, xBars } from './helpers/self-crossing.js';

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

// ------------------------------------------------- self-intersecting input
//
// Two edges that cross between vertex heights used to share a slab, so a
// span between them was a trapezoid with its sides crossed: the fill was
// wrong wherever a drawing took the server's route — a pentagram's arms
// went missing at 300 px that were there at 60. What the trapezoids cover is
// checked against helpers/self-crossing.js, which shares nothing with them.

const SELF_CROSSING = {
  pentagram: [PENTAGRAM.map((v) => v * 3 + 2)],
  bowtie: [[10, 10, 190, 190, 190, 10, 10, 190]],
  '×': xBars(110, 110, 190, 24)
};

/** every trapezoid's left side stays left of its right one, top and bottom */
function assertUncrossed(traps, what, tol = 1e-9) {
  for (let i = 0; i < traps.length; i += 6) {
    const [tl, tr, ty, bl, br, by] = traps.slice(i, i + 6);
    assert.ok(ty < by, `${what}: trapezoid ${i / 6} has rows ${ty}..${by}`);
    assert.ok(
      tl <= tr + tol && bl <= br + tol,
      `${what}: trapezoid ${i / 6} is crossed: ${traps.slice(i, i + 6)}`
    );
  }
}

/** the trapezoids' coverage of a w × h grid, rasterized as quads */
function trapCoverage(traps, width, height) {
  const polys = [];
  for (let i = 0; i < traps.length; i += 6) {
    const [tl, tr, ty, bl, br, by] = traps.slice(i, i + 6);
    polys.push([tl, ty, tr, ty, br, by, bl, by]);
  }
  return new ScanlineRasterizer().rasterize({ polys, rule: 'nonzero', width, height });
}

test('a self-intersecting polygon is cut at its crossings and filled by its rule', () => {
  const W = 304;
  const H = 304;
  for (const [name, polys] of Object.entries(SELF_CROSSING)) {
    for (const rule of ['nonzero', 'evenodd']) {
      const what = `${name} ${rule}`;
      const traps = trapezoidize(polys, 0, 0, [], rule);
      assertUncrossed(traps, what);
      const area = filledArea(polys, rule);
      assert.ok(
        Math.abs(trapArea(traps) - area) < 1e-9 * area,
        `${what}: area ${trapArea(traps)}, want ${area}`
      );

      // Pixel by pixel against the polygon rasterized directly. That is
      // exact except where a crossing puts winding 0 and 2 in one pixel:
      // there its signed areas cancel or clamp, so those few pixels are held
      // to the area the rule fills of them instead.
      const got = trapCoverage(traps, W, H);
      const direct = new ScanlineRasterizer().rasterize({ polys, rule, width: W, height: H });
      const want = direct.slice();
      for (const [cx, cy] of crossingPoints(polys)) {
        for (let y = Math.floor(cy) - 2; y <= cy + 2; y++) {
          for (let x = Math.floor(cx) - 2; x <= cx + 2; x++) {
            if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) >= 2) continue;
            want[y * W + x] = Math.round(filledArea(polys, rule, x, y, x + 1, y + 1) * 255);
          }
        }
      }
      const off = got.findIndex((v, i) => Math.abs(v - want[i]) > 1);
      assert.equal(
        off,
        -1,
        `${what}: pixel ${off % W},${Math.floor(off / W)} is ${got[off]}, want ${want[off]}`
      );
    }
  }
});

test('random self-intersecting polygons: the trapezoids cover exactly what the rule fills', () => {
  let seed = 23;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let k = 0; k < 300; k++) {
    const polys = [];
    for (let p = 0, n = 1 + Math.floor(rnd() * 3); p < n; p++) {
      const poly = [];
      for (let v = 0, m = 3 + Math.floor(rnd() * 8); v < m; v++) {
        poly.push(rnd() * 400 - 150, rnd() * 400 - 150);
      }
      polys.push(poly);
    }
    const rule = k % 2 ? 'evenodd' : 'nonzero';
    const traps = trapezoidize(polys, 0, 0, [], rule);
    assertUncrossed(traps, `case ${k}`, 1e-6);
    const want = filledArea(polys, rule);
    assert.ok(
      Math.abs(trapArea(traps) - want) < 1e-9 * Math.max(1, want),
      `case ${k}: ${trapArea(traps)} vs ${want}`
    );
  }
});

test('crossings that rounding makes awkward still fill exactly', () => {
  const bars = (n) =>
    Array.from({ length: n }, (_, i) => {
      // a thin bar through (200, 200), one every 180/n degrees
      const a = (i * Math.PI) / n + 0.1;
      const [c, s] = [Math.cos(a), Math.sin(a)];
      return [
        [-190, -3],
        [190, -3],
        [190, 3],
        [-190, 3]
      ].flatMap(([x, y]) => [200 + x * c - y * s, 200 + x * s + y * c]);
    });
  const cases = {
    // 480 crossings packed around one point, many pairs at close heights
    'asterisk of 16 bars': bars(16),
    // the bowtie's crossing sits exactly at the height of a triangle's vertex
    'crossing at a vertex height': [[0, 0, 100, 100, 100, 0, 0, 100], [40, 50, 60, 50, 50, 60]],
    // a bowtie 1000 wide and 0.002 high: a hair of y is a long way in x
    'near-horizontal crossing': [[0, 0, 1000, 0.002, 1000, 0, 0, 0.002]],
    'pentagram at 1e-6': [PENTAGRAM.map((v) => v * 1e-6)],
    'pentagram at 1e12': [PENTAGRAM.map((v) => v * 1e12)]
  };
  for (const [name, polys] of Object.entries(cases)) {
    for (const rule of ['nonzero', 'evenodd']) {
      const traps = trapezoidize(polys, 0, 0, [], rule);
      const want = filledArea(polys, rule);
      assert.ok(
        Math.abs(trapArea(traps) - want) < 1e-9 * want,
        `${name} ${rule}: area ${trapArea(traps)}, want ${want}`
      );
    }
  }
});

test('edges that only run together are not cut where rounding says they cross', () => {
  // Collinear edges evaluated at a height disagree by an ulp or two either
  // way. A cut there would be a sliver and break the merge of the slabs
  // around it, so every trapezoid still starts and ends at a vertex height.
  let seed = 5;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let k = 0; k < 500; k++) {
    // a parallelogram and copies of it slid along its slanted sides
    const [x, y] = [rnd() * 300 - 100, rnd() * 300 - 100];
    const [w, h, slant] = [1 + rnd() * 100, 1 + rnd() * 200, rnd() * 6 - 3];
    const par = [x, y, x + w, y, x + w + slant * h, y + h, x + slant * h, y + h];
    const polys = [par];
    for (let c = 0, n = 1 + Math.floor(rnd() * 3); c < n; c++) {
      const t = rnd() * h * 0.9;
      polys.push(par.map((v, i) => (i % 2 ? v + t : v + slant * t)));
    }
    const heights = new Set(polys.flatMap((p) => p.filter((_, i) => i % 2)));
    const traps = trapezoidize(polys, 0, 0, [], k % 2 ? 'evenodd' : 'nonzero');
    for (let i = 0; i < traps.length; i += 6) {
      assert.ok(
        heights.has(traps[i + 2]) && heights.has(traps[i + 5]),
        `case ${k}: cut at ${traps[i + 2]}..${traps[i + 5]}`
      );
    }
  }
});

// The area of each trapezoid inside a rectangle, the long way: the
// trapezoid as a polygon, clipped edge by edge (Sutherland–Hodgman), its area
// by the shoelace formula. Nothing shared with clipTraps. A trapezoid whose
// edges cross — trapezoidize no longer makes them, but clipTraps takes any —
// is covered where the left edge is left of the right one, which is what
// RENDER fills, so it is split at the crossing and the other part left out.
function areaInside(traps, x0, y0, x1, y1) {
  let total = 0;
  for (let i = 0; i < traps.length; i += 6) {
    const [tl, tr, ty, bl, br, by] = traps.slice(i, i + 6);
    const polys = [];
    if ((tl - tr) * (bl - br) < 0) {
      const t = (tl - tr) / (tl - tr - (bl - br));
      const cross = [tl + t * (bl - tl), ty + t * (by - ty)];
      if (tl < tr) polys.push([[tl, ty], [tr, ty], cross]);
      else polys.push([cross, [br, by], [bl, by]]);
    } else if (tl <= tr && bl <= br) {
      polys.push([[tl, ty], [tr, ty], [br, by], [bl, by]]);
    }
    for (const poly of polys) total += polygonAreaInside(poly, x0, y0, x1, y1);
  }
  return total;
}

function polygonAreaInside(polygon, x0, y0, x1, y1) {
  let poly = polygon;
  for (const [inside, cross] of [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]]
  ]) {
    const next = [];
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k];
      const b = poly[(k + 1) % poly.length];
      if (inside(a)) {
        next.push(a);
        if (!inside(b)) next.push(cross(a, b));
      } else if (inside(b)) {
        next.push(cross(a, b));
      }
    }
    poly = next;
    if (poly.length < 3) return 0;
  }
  let twice = 0;
  for (let k = 0; k < poly.length; k++) {
    const [ax, ay] = poly[k];
    const [bx, by] = poly[(k + 1) % poly.length];
    twice += ax * by - bx * ay;
  }
  return Math.abs(twice) / 2;
}

test('clipTraps keeps exactly the coverage inside the rectangle', () => {
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let k = 0; k < 400; k++) {
    const polys = [];
    for (let p = 0, n = 1 + Math.floor(rnd() * 3); p < n; p++) {
      const poly = [];
      for (let v = 0, m = 3 + Math.floor(rnd() * 6); v < m; v++) {
        poly.push(rnd() * 400 - 150, rnd() * 400 - 150);
      }
      polys.push(poly);
    }
    const traps = trapezoidize(polys, 0, 0, [], k % 2 ? 'evenodd' : 'nonzero');
    const x0 = rnd() * 100 - 20;
    const y0 = rnd() * 100 - 20;
    const x1 = x0 + 1 + rnd() * 120;
    const y1 = y0 + 1 + rnd() * 120;
    const cut = clipTraps(traps, x0, y0, x1, y1);
    const want = areaInside(traps, x0, y0, x1, y1);
    const got = areaInside(cut, x0, y0, x1, y1);
    assert.ok(Math.abs(got - want) < 1e-6 * Math.max(1, want), `case ${k}: ${got} vs ${want}`);
    // and nothing of what is left reaches further than the pixel past it
    for (let i = 0; i < cut.length; i += 6) {
      for (const x of [cut[i], cut[i + 1], cut[i + 3], cut[i + 4]]) {
        assert.ok(x >= x0 - 1 && x <= x1 + 1, `case ${k}: x ${x}`);
      }
      assert.ok(cut[i + 2] >= y0 && cut[i + 5] <= y1 && cut[i + 2] < cut[i + 5], `case ${k}: rows`);
    }
  }
});

test('clipTraps brings a glyph a trillion pixels across down to the rectangle', () => {
  // a slanted stroke of a glyph at 1e12 px: its corners are far past what
  // 16.16 fixed point carries, and the part on the surface is what is kept
  const traps = [-1e12, -1e12 + 5e11, -1e12, -1e12 + 2e12, -1e12 + 2.5e12, 1e12];
  const cut = clipTraps(traps, 0, 0, 100, 60);
  assert.ok(cut.length > 0);
  assert.ok(cut.every((v) => Math.abs(v) <= 101), `coordinates: ${cut}`);
  assert.ok(Math.abs(areaInside(cut, 0, 0, 100, 60) - areaInside(traps, 0, 0, 100, 60)) < 1e-3);
});
