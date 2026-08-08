import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  Path2D,
  arcSegmentCount,
  parseSvgPath,
  flattenPath,
  transformCommands,
  polysContain,
  matApply,
  matInvert,
  matIsIdentity,
  matMultiply
} from '../lib/path.js';
import { trapArea, trapezoidize } from '../lib/trapezoid.js';

// helper: fill area of a path via the same pipeline the 2d context uses
function pathArea(path, m = null, rule = 'nonzero') {
  const polys = flattenPath(path._cmds, m).map((p) => p.pts);
  return trapArea(trapezoidize(polys, 0, 0, [], rule));
}

// ---------------------------------------------------------------------------
// matrices

test('matMultiply applies the right operand first (canvas order)', () => {
  const translate = [1, 0, 0, 1, 10, 0];
  const scale = [2, 0, 0, 2, 0, 0];
  // translate ∘ scale: point is scaled, then translated
  const m = matMultiply(translate, scale);
  assert.deepEqual(matApply(m, 1, 1), [12, 2]);
});

test('matInvert round-trips a point and rejects singular matrices', () => {
  const m = matMultiply([1, 0, 0, 1, 5, -3], [0, 1, -1, 0, 0, 0]); // rotate 90° then translate
  const inv = matInvert(m);
  const [x, y] = matApply(inv, ...matApply(m, 7, 11));
  assert.ok(Math.abs(x - 7) < 1e-9 && Math.abs(y - 11) < 1e-9);
  assert.equal(matInvert([0, 0, 0, 0, 1, 2]), null);
});

test('matIsIdentity', () => {
  assert.ok(matIsIdentity([1, 0, 0, 1, 0, 0]));
  assert.ok(!matIsIdentity([1, 0, 0, 1, 0.5, 0]));
});

// ---------------------------------------------------------------------------
// svg path parsing

test('parseSvgPath handles implicit repeats and relative commands', () => {
  const cmds = parseSvgPath('M10 10 20 10 l 0 10 H10 V10 z');
  assert.deepEqual(
    cmds.map((c) => c.type),
    ['M', 'L', 'L', 'L', 'L', 'Z']
  );
  assert.deepEqual(cmds[1], { type: 'L', x: 20, y: 10 }); // implicit lineto after M
  assert.deepEqual(cmds[2], { type: 'L', x: 20, y: 20 }); // relative l
  assert.deepEqual(cmds[3], { type: 'L', x: 10, y: 20 }); // H
  assert.deepEqual(cmds[4], { type: 'L', x: 10, y: 10 }); // V
});

test('parseSvgPath resolves smooth curves (S/T) with reflected control points', () => {
  const cmds = parseSvgPath('M0 0 C 10 0 20 10 30 10 S 50 20 60 10');
  assert.equal(cmds[2].type, 'C');
  // reflection of (20,10) around (30,10) is (40,10)
  assert.equal(cmds[2].x1, 40);
  assert.equal(cmds[2].y1, 10);

  const q = parseSvgPath('M0 0 Q 10 10 20 0 T 40 0');
  assert.equal(q[2].type, 'Q');
  assert.equal(q[2].x1, 30); // reflection of (10,10) around (20,0)
  assert.equal(q[2].y1, -10);
});

test('parseSvgPath converts arcs to cubics, including compact flags', () => {
  // half circle of radius 5: compact "011 0" packs both flags and the x
  const cmds = parseSvgPath('M0 0a5 5 0 011 0 0 10');
  // ... malformed input must not throw or loop; a well-formed variant:
  const arc = parseSvgPath('M0 0 A 5 5 0 0 1 0 10');
  assert.equal(arc[0].type, 'M');
  assert.ok(arc.slice(1).every((c) => c.type === 'C'));
  const last = arc[arc.length - 1];
  assert.ok(Math.abs(last.x - 0) < 1e-9 && Math.abs(last.y - 10) < 1e-9);
  assert.ok(Array.isArray(cmds)); // parser survived the compact form
});

test('parseSvgPath compact arc flags parse as single characters', () => {
  // "1 1 0 0 1" written compactly: flags are 0/1 single chars, so `0110`
  // would be wrong to read as one number
  const compact = parseSvgPath('M0 0A5 5 0 0150 0');
  const verbose = parseSvgPath('M0 0A5 5 0 0 1 50 0');
  assert.deepEqual(compact, verbose);
});

test('parseSvgPath zero-radius arc degrades to a line', () => {
  const cmds = parseSvgPath('M0 0 A 0 5 0 0 1 10 10');
  assert.deepEqual(cmds[1], { type: 'L', x: 10, y: 10 });
});

test('parseSvgPath ignores trailing garbage without throwing', () => {
  const cmds = parseSvgPath('M0 0 L10 0 !!!');
  assert.deepEqual(
    cmds.map((c) => c.type),
    ['M', 'L']
  );
});

// ---------------------------------------------------------------------------
// Path2D

test('Path2D records rect and computes exact area', () => {
  const p = new Path2D();
  p.rect(0, 0, 10, 5);
  assert.equal(pathArea(p), 50);
});

test('Path2D full circle area approximates πr²', () => {
  const p = new Path2D();
  p.arc(50, 50, 20, 0, Math.PI * 2);
  const area = pathArea(p);
  const exact = Math.PI * 400;
  // A flattened circle is the inscribed polygon on the chords the tolerance
  // allows, so its area is short of πr² by a knowable amount rather than an
  // arbitrary one: assert it is exactly the n-gon, with n from the same
  // formula the flattener uses. Since the chords are minimal now, this is
  // the largest deficit the 0.25px contract permits — ~1.6% at r=20.
  const n = arcSegmentCount(2 * Math.PI, 20);
  const ngon = 0.5 * n * 400 * Math.sin((2 * Math.PI) / n);
  assert.ok(Math.abs(area - ngon) < 1e-6, `${area} vs inscribed ${n}-gon ${ngon}`);
  assert.ok(area < exact, 'inscribed: never larger than the true circle');
  assert.ok(Math.abs(area - exact) / exact < 0.02, `${area} vs ${exact}`);
});

test('Path2D from SVG string equals the equivalent built path', () => {
  const fromSvg = new Path2D('M0 0 H10 V10 H0 Z');
  const built = new Path2D();
  built.moveTo(0, 0);
  built.lineTo(10, 0);
  built.lineTo(10, 10);
  built.lineTo(0, 10);
  built.closePath();
  assert.equal(pathArea(fromSvg), pathArea(built));
});

test('Path2D ellipse honors counterclockwise sweep normalization', () => {
  const half = new Path2D();
  half.ellipse(0, 0, 10, 10, 0, 0, Math.PI);
  half.closePath();
  const area = pathArea(half);
  // What this guards is the sweep: a wrong normalization yields ~0 or ~2x
  // the area, orders beyond this bound. The bound itself is set by the
  // flattener — a half circle at r=10 flattens to ~8 chords within the
  // 0.25px tolerance, and the inscribed polygon under-measures the disc by
  // a few percent.
  assert.ok(Math.abs(area - Math.PI * 50) / (Math.PI * 50) < 0.05);
});

test('Path2D arcTo rounds a corner (path stays connected)', () => {
  const p = new Path2D();
  p.moveTo(0, 0);
  p.lineTo(50, 0);
  p.arcTo(100, 0, 100, 50, 10);
  p.lineTo(100, 100);
  const polys = flattenPath(p._cmds);
  assert.equal(polys.length, 1); // single connected subpath
  const pts = polys[0].pts;
  assert.equal(pts[0], 0);
  assert.equal(pts[pts.length - 2], 100);
  assert.equal(pts[pts.length - 1], 100);
});

test('Path2D arcTo with collinear points degrades to lineTo', () => {
  const p = new Path2D();
  p.moveTo(0, 0);
  p.arcTo(10, 0, 20, 0, 5);
  assert.deepEqual(p._cmds[p._cmds.length - 1], { type: 'L', x: 10, y: 0 });
});

test('Path2D roundRect with radius 0 equals rect', () => {
  const a = new Path2D();
  a.roundRect(0, 0, 20, 10, 0);
  assert.equal(pathArea(a), 200);
});

test('Path2D roundRect area is less than the sharp rect', () => {
  const p = new Path2D();
  p.roundRect(0, 0, 20, 20, 5);
  const area = pathArea(p);
  // exact: 400 - (4 - π) * 25 ≈ 378.5
  const exact = 400 - (4 - Math.PI) * 25;
  assert.ok(Math.abs(area - exact) / exact < 0.01, `${area} vs ${exact}`);
});

test('Path2D addPath with a transform', () => {
  const unit = new Path2D();
  unit.rect(0, 0, 1, 1);
  const p = new Path2D();
  p.addPath(unit, [10, 0, 0, 5, 100, 100]);
  assert.equal(pathArea(p), 50);
});

test('Path2D copy constructor is independent of the source', () => {
  const a = new Path2D('M0 0 H10 V10 H0 Z');
  const b = new Path2D(a);
  b.rect(100, 100, 10, 10);
  assert.equal(pathArea(a), 100);
  assert.equal(pathArea(b), 200);
});

// ---------------------------------------------------------------------------
// flattening

test('flattenPath applies the transform before subdivision', () => {
  const p = new Path2D();
  p.arc(0, 0, 10, 0, Math.PI * 2);
  const area = pathArea(p, [2, 0, 0, 3, 0, 0]);
  const exact = Math.PI * 100 * 6; // scaled by 2*3
  assert.ok(Math.abs(area - exact) / exact < 0.01, `${area} vs ${exact}`);
});

test('flattenPath marks Z-closed subpaths and continues from the start', () => {
  const polys = flattenPath(parseSvgPath('M0 0 H10 V10 Z L0 20'));
  assert.equal(polys.length, 2);
  assert.equal(polys[0].closed, true);
  assert.equal(polys[1].closed, false);
  // the post-Z subpath starts at the subpath start point (0,0)
  assert.deepEqual(polys[1].pts.slice(0, 2), [0, 0]);
});

test('flattenPath subdivides curves adaptively (more points when scaled up)', () => {
  const p = new Path2D();
  p.moveTo(0, 0);
  p.bezierCurveTo(0, 10, 10, 10, 10, 0);
  const small = flattenPath(p._cmds)[0].pts.length;
  const big = flattenPath(p._cmds, [20, 0, 0, 20, 0, 0])[0].pts.length;
  assert.ok(big > small, `expected ${big} > ${small}`);
});

// A cubic whose handles point back down its own chord runs past an endpoint
// and returns. Its distance from the chord *line* can stay well inside the
// tolerance the whole way, so the perpendicular flatness test alone called it
// flat and emitted one chord — a chord that ends up traversed in the opposite
// direction to the curve. A fill never notices (the missed area is a sliver
// within tolerance); a stroke does, because the join to whatever comes next is
// then a ~180° cusp whose miter runs off to infinity (issue #233).
test('flattenPath does not collapse a cubic that doubles back', () => {
  const p = new Path2D();
  p.moveTo(23, 15.9);
  p.bezierCurveTo(22.5, 13.7, 12.8, 12, 14.3, 12);
  const pts = flattenPath(p._cmds)[0].pts;
  const n = pts.length;
  // the curve leaves along P2 -> P3 = (+1.5, 0); the last chord must agree
  const dx = pts[n - 2] - pts[n - 4];
  const dy = pts[n - 1] - pts[n - 3];
  assert.ok(dx * 1.5 + dy * 0 > 0, `last chord (${dx}, ${dy}) reverses the curve`);
  // and it must reach the curve's own extreme, x = 14.1426, not stop at 14.3
  let minX = Infinity;
  for (let i = 0; i < n; i += 2) minX = Math.min(minX, pts[i]);
  assert.ok(minX < 14.3, `flattened polyline never passes the endpoint (${minX})`);
});

test('flattenPath still spends no extra chords on ordinary curves', () => {
  // the overshoot test above must be free where nothing overshoots: a
  // straight cubic is one chord however its handles are spaced, and curves
  // keep the counts the flatness bound alone gives them
  const counts = [
    [[0, 0, 10, 0, 20, 0, 30, 0], 1], // collinear, evenly spaced
    [[0, 0, 30, 0, 0, 0, 30, 0], 1], // collinear, handles crossed but monotone
    [[0, 0, 0, 55.23, 44.77, 100, 100, 100], 16], // quarter circle, r=100
    [[0, 0, 50, 0, 0, 50, 50, 50], 14] // s-curve
  ];
  for (const [c, expected] of counts) {
    const p = new Path2D();
    p.moveTo(c[0], c[1]);
    p.bezierCurveTo(c[2], c[3], c[4], c[5], c[6], c[7]);
    const chords = flattenPath(p._cmds)[0].pts.length / 2 - 1;
    assert.equal(chords, expected, `${c}`);
  }
});

// ---------------------------------------------------------------------------
// fill rules

test('trapezoidize even-odd rule leaves a hole where windings agree', () => {
  const outer = [0, 0, 20, 0, 20, 20, 0, 20];
  const innerSameWinding = [5, 5, 15, 5, 15, 15, 5, 15];
  const nonzero = trapArea(trapezoidize([outer, innerSameWinding]));
  const evenodd = trapArea(trapezoidize([outer, innerSameWinding], 0, 0, [], 'evenodd'));
  assert.equal(nonzero, 400); // same winding: no hole
  assert.equal(evenodd, 300); // even-odd: hole regardless of winding
});

test('polysContain honors both fill rules', () => {
  const p = new Path2D();
  p.rect(0, 0, 20, 20);
  p.rect(5, 5, 10, 10);
  const polys = flattenPath(p._cmds);
  assert.equal(polysContain(polys, 10, 10, 'nonzero'), true);
  assert.equal(polysContain(polys, 10, 10, 'evenodd'), false);
  assert.equal(polysContain(polys, 2, 2, 'evenodd'), true);
  assert.equal(polysContain(polys, 30, 10, 'nonzero'), false);
});

// ---------------------------------------------------------------------------
// transformCommands

test('transformCommands maps every control point', () => {
  const cmds = parseSvgPath('M0 0 Q5 5 10 0 C 12 3 18 3 20 0');
  const moved = transformCommands(cmds, [1, 0, 0, 1, 100, 200]);
  assert.deepEqual(moved[0], { type: 'M', x: 100, y: 200 });
  assert.equal(moved[1].x1, 105);
  assert.equal(moved[1].y1, 205);
  assert.equal(moved[2].x2, 118);
  assert.equal(moved[2].y2, 203);
});
