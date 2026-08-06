// Arc-aware flattening (issue #213): a cubic that came from an arc is
// subdivided from the arc's own geometry — the fewest equal chords the
// tolerance allows — instead of by bisecting the cubic, which could only
// land on powers of two and overshot by up to 2x.
//
// The contract under test is two-sided: the polyline must stay within the
// tolerance of the true arc (quality), and must not spend more chords than
// the formula requires (the point of the change). Pure unit tests, no X.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FLATTEN_TOLERANCE,
  Path2D,
  arcSegmentCount,
  ellipseSegments,
  flattenPath,
  transformCommands
} from '../lib/path.js';

/** distance from a point to a segment */
function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(px - ax, py - ay);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(px - bx, py - by);
  const t = c1 / c2;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/**
 * Worst distance from a densely sampled ellipse arc to the polyline — the
 * measurement the tolerance is a promise about. The ellipse is given in the
 * same centre-plus-axis-vectors form the arc tag uses, so a transformed
 * expectation is expressed by transforming the axes.
 */
function maxDeviation(pts, { cx, cy, ux, uy, vx, vy, t0, t1 }, samples = 4000) {
  let worst = 0;
  for (let i = 0; i <= samples; i++) {
    const t = t0 + ((t1 - t0) * i) / samples;
    const px = cx + ux * Math.cos(t) + vx * Math.sin(t);
    const py = cy + uy * Math.cos(t) + vy * Math.sin(t);
    let best = Infinity;
    for (let j = 0; j + 3 < pts.length; j += 2) {
      const d = distToSegment(px, py, pts[j], pts[j + 1], pts[j + 2], pts[j + 3]);
      if (d < best) best = d;
    }
    if (best > worst) worst = best;
  }
  return worst;
}

/** flatten a quarter arc of radius r (top-left corner orientation) */
function quarterArc(r, m = null, tol = FLATTEN_TOLERANCE) {
  const seg = ellipseSegments(r, r, r, r, 0, Math.PI, Math.PI * 1.5);
  const cmds = [{ type: 'M', x: seg.start.x, y: seg.start.y }, ...seg.cmds];
  const polys = flattenPath(cmds, m, tol);
  return polys.length ? polys[0].pts : [];
}

// --------------------------------------------------------------- the formula

test('arcSegmentCount is the sagitta formula, with the degenerate cases safe', () => {
  // a chord spanning θ misses a circle of radius R by R(1 - cos(θ/2)); the
  // returned count must be the fewest whose sagitta fits the tolerance
  for (const r of [2, 4, 8, 16, 32, 64, 128, 256]) {
    for (const sweep of [Math.PI / 2, Math.PI, 2 * Math.PI]) {
      const n = arcSegmentCount(sweep, r, 0.25);
      const sagitta = (k) => r * (1 - Math.cos(sweep / k / 2));
      assert.ok(sagitta(n) <= 0.25 + 1e-12, `r=${r} n=${n} does not fit`);
      assert.ok(n === 1 || sagitta(n - 1) > 0.25, `r=${r} n=${n} is not minimal`);
    }
  }
  // tolerance at or above the diameter: one chord is enough by definition
  assert.equal(arcSegmentCount(2 * Math.PI, 0.1, 0.25), 1);
  // degenerate inputs never produce NaN, Infinity or 0 segments
  assert.equal(arcSegmentCount(0, 10, 0.25), 1);
  assert.equal(arcSegmentCount(Math.PI, 0, 0.25), 1);
  assert.ok(Number.isInteger(arcSegmentCount(Math.PI, 10, 0)));
  assert.ok(arcSegmentCount(Math.PI, 10, 0) > 0);
});

// ------------------------------------------------------- deviation conformance

test('flattened arcs stay inside the tolerance at every radius', () => {
  for (const r of [2, 3, 4, 6, 8, 12, 16, 32, 64, 128, 256]) {
    const pts = quarterArc(r);
    const dev = maxDeviation(pts, {
      cx: r, cy: r, ux: r, uy: 0, vx: 0, vy: r,
      t0: Math.PI, t1: Math.PI * 1.5
    });
    assert.ok(dev <= FLATTEN_TOLERANCE + 1e-9, `r=${r} deviates ${dev}`);
  }
});

test('and spend exactly the chords the formula asks for — no power-of-two rounding', () => {
  for (const r of [4, 8, 16, 32, 64, 128, 256]) {
    const segs = quarterArc(r).length / 2 - 1;
    const want = arcSegmentCount(Math.PI / 2, r);
    assert.equal(segs, want, `r=${r}`);
  }
  // the counts recursive bisection could never produce, spot-checked
  assert.equal(quarterArc(64).length / 2 - 1, 9);
  assert.equal(quarterArc(128).length / 2 - 1, 13);
  assert.equal(quarterArc(256).length / 2 - 1, 18);
});

test('a coarser tolerance buys coarser chords', () => {
  const fine = quarterArc(64, null, 0.05).length;
  const coarse = quarterArc(64, null, 1).length;
  assert.ok(coarse < fine, `${coarse} vs ${fine}`);
  // and each still honours what it promised
  for (const tol of [0.05, 0.25, 1]) {
    const dev = maxDeviation(quarterArc(64, null, tol), {
      cx: 64, cy: 64, ux: 64, uy: 0, vx: 0, vy: 64,
      t0: Math.PI, t1: Math.PI * 1.5
    });
    assert.ok(dev <= tol + 1e-9, `tol ${tol} deviates ${dev}`);
  }
});

// ------------------------------------------------------------------- endpoints

test('endpoints are the command endpoints, bit-identical', () => {
  // the flattened arc must start and end exactly where the lowering said,
  // or a corner stops meeting the straight edge it joins
  const r = 37;
  const seg = ellipseSegments(r, r, r, r, 0, Math.PI, Math.PI * 1.5);
  const pts = quarterArc(r);
  assert.equal(pts[0], seg.start.x);
  assert.equal(pts[1], seg.start.y);
  const last = seg.cmds[seg.cmds.length - 1];
  assert.equal(pts[pts.length - 2], last.x);
  assert.equal(pts[pts.length - 1], last.y);
});

test('a roundRect corner still meets its straight edges exactly', () => {
  const p = new Path2D();
  p.roundRect(10, 20, 100, 60, 16);
  const pts = flattenPath(p._cmds)[0].pts;
  // every point is inside the box, and the extremes touch its edges exactly
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    minX = Math.min(minX, pts[i]);
    maxX = Math.max(maxX, pts[i]);
    minY = Math.min(minY, pts[i + 1]);
    maxY = Math.max(maxY, pts[i + 1]);
  }
  assert.equal(minX, 10);
  assert.equal(minY, 20);
  assert.equal(maxX, 110);
  assert.equal(maxY, 80);
});

test('an SVG arc keeps the endpoint its data asked for', () => {
  // svgArcCommands snaps the last cubic onto the requested endpoint; the
  // arc route must not undo that by re-evaluating the parameterization
  const p = new Path2D('M10 80 A 45 45 0 0 1 100 80');
  const pts = flattenPath(p._cmds)[0].pts;
  assert.equal(pts[0], 10);
  assert.equal(pts[1], 80);
  assert.equal(pts[pts.length - 2], 100);
  assert.equal(pts[pts.length - 1], 80);
});

// ------------------------------------------------------------------ transforms

test('the tag survives a baked transform, and the tolerance is device-space', () => {
  // scaling up must buy more chords, because the tolerance is in output
  // pixels and the arc got bigger on screen
  const plain = quarterArc(8).length / 2 - 1;
  const scaled = flattenPath(
    transformCommands(
      [
        { type: 'M', x: 0, y: 8 },
        ...ellipseSegments(8, 8, 8, 8, 0, Math.PI, Math.PI * 1.5).cmds
      ],
      [8, 0, 0, 8, 0, 0]
    )
  )[0].pts;
  const scaledSegs = scaled.length / 2 - 1;
  assert.equal(scaledSegs, arcSegmentCount(Math.PI / 2, 64));
  assert.ok(scaledSegs > plain, `${scaledSegs} vs ${plain}`);
  // and it is still an arc of radius 64, within tolerance
  const dev = maxDeviation(scaled, {
    cx: 64, cy: 64, ux: 64, uy: 0, vx: 0, vy: 64,
    t0: Math.PI, t1: Math.PI * 1.5
  });
  assert.ok(dev <= FLATTEN_TOLERANCE + 1e-9, `deviates ${dev}`);
});

test('flattening through a matrix matches flattening the baked commands', () => {
  const m = [1.5, 0.4, -0.3, 2, 30, 12]; // rotation + non-uniform scale + shear
  const cmds = [
    { type: 'M', x: 0, y: 10 },
    ...ellipseSegments(10, 10, 10, 10, 0, Math.PI, Math.PI * 1.5).cmds
  ];
  const viaMatrix = flattenPath(cmds, m)[0].pts;
  const viaBaked = flattenPath(transformCommands(cmds, m))[0].pts;
  assert.equal(viaMatrix.length, viaBaked.length);
  for (let i = 0; i < viaMatrix.length; i++) {
    assert.ok(Math.abs(viaMatrix[i] - viaBaked[i]) < 1e-9, `at ${i}`);
  }
});

test('a sheared or non-uniformly scaled arc stays within tolerance', () => {
  // the tag transforms exactly under any affine — the axis vectors go
  // through the linear part — so shear is a first-class case, not a bail-out
  const m = [2.5, 0.8, -1.2, 0.7, 5, 5];
  const cmds = [
    { type: 'M', x: 0, y: 20 },
    ...ellipseSegments(20, 20, 20, 20, 0, Math.PI, Math.PI * 1.5).cmds
  ];
  const pts = flattenPath(cmds, m)[0].pts;
  // the image ellipse: centre and axes through the same map
  const lin = (x, y) => [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
  const [ux, uy] = lin(20, 0);
  const [vx, vy] = lin(0, 20);
  const dev = maxDeviation(pts, {
    cx: m[0] * 20 + m[2] * 20 + m[4],
    cy: m[1] * 20 + m[3] * 20 + m[5],
    ux, uy, vx, vy,
    t0: Math.PI, t1: Math.PI * 1.5
  });
  assert.ok(dev <= FLATTEN_TOLERANCE + 1e-9, `deviates ${dev}`);
});

test('an eccentric ellipse is bounded by its major axis', () => {
  const seg = ellipseSegments(0, 0, 100, 6, 0, 0, Math.PI * 2);
  const pts = flattenPath([
    { type: 'M', x: seg.start.x, y: seg.start.y },
    ...seg.cmds
  ])[0].pts;
  const dev = maxDeviation(pts, {
    cx: 0, cy: 0, ux: 100, uy: 0, vx: 0, vy: 6,
    t0: 0, t1: Math.PI * 2
  });
  assert.ok(dev <= FLATTEN_TOLERANCE + 1e-9, `deviates ${dev}`);
  // rotating it is an isometry: the same chord count, the same deviation
  const rot = ellipseSegments(0, 0, 100, 6, 0.7, 0, Math.PI * 2);
  const rotated = flattenPath([
    { type: 'M', x: rot.start.x, y: rot.start.y },
    ...rot.cmds
  ])[0].pts;
  assert.equal(rotated.length, pts.length);
});

test('a cubic spliced away from its arc start falls back to bisection', () => {
  // the arc route draws chords of the arc, which is only the curve the
  // caller meant if the path is standing at the arc's start. A path built
  // by hand from someone else's commands is not, and must still get a
  // smooth curve from where it is — the cubic's own geometry.
  const seg = ellipseSegments(0, 0, 40, 40, 0, 0, Math.PI / 2);
  const spliced = flattenPath([{ type: 'M', x: -30, y: -70 }, ...seg.cmds]);
  const pts = spliced[0].pts;
  assert.equal(pts[0], -30);
  assert.equal(pts[1], -70);
  // the endpoint is still the command's
  const last = seg.cmds[seg.cmds.length - 1];
  assert.ok(Math.abs(pts[pts.length - 2] - last.x) < 1e-9);
  assert.ok(Math.abs(pts[pts.length - 1] - last.y) < 1e-9);
  // it is the bezier, not a chord fan from the far-away start: every point
  // after the first sits near the cubic's hull, not on the arc's circle
  const onArc = (x, y) => Math.abs(Math.hypot(x, y) - 40) < 1e-6;
  assert.ok(!onArc(pts[2], pts[3]), 'second point is not an arc sample');
});

// -------------------------------------------------------- untagged curves

test('a hand-built bezier still takes the adaptive route', () => {
  // nothing here came from an arc, so there is no tag and bisection applies
  const p = new Path2D();
  p.moveTo(0, 0);
  p.bezierCurveTo(0, 100, 100, 100, 100, 0);
  const pts = flattenPath(p._cmds)[0].pts;
  assert.ok(pts.length > 4, 'the curve was subdivided');
  assert.equal(p._cmds[1].arc, undefined, 'no tag on a plain bezier');
  // and the endpoints are still exact
  assert.equal(pts[pts.length - 2], 100);
  assert.equal(pts[pts.length - 1], 0);
});

test('Path2D copies share tags without letting a transform leak back', () => {
  const src = new Path2D();
  src.arc(0, 0, 10, 0, Math.PI);
  const before = { ...src._cmds[1].arc };
  const moved = new Path2D();
  moved.addPath(src, [2, 0, 0, 2, 100, 100]);
  assert.deepEqual(src._cmds[1].arc, before, 'the source tag is untouched');
  assert.equal(moved._cmds[1].arc.ux, 20, 'the copy carries the scaled axis');
  assert.equal(moved._cmds[1].arc.cx, 100);
});
