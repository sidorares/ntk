// A stroke's dashes, walked as far as the surface can show them
// (lib/dash.js). What has to hold is that nothing drawn moves: a walk of the
// whole path is the walk it always was, pinned below to what it gave before
// the view was added, and a walk culled to a view draws inside it what the
// whole walk draws there. What changes is the cost of what is not drawn.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_BOUNDARIES, dashPolyline } from '../lib/dash.js';

const round = (res) =>
  JSON.parse(JSON.stringify(res, (k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v)));

test('a walk of the whole path is the walk it was', () => {
  // each answer as the walk gave it before the view was added
  assert.deepEqual(round(dashPolyline([[0, 0], [20, 0]], false, [4, 4], 2)), {
    runs: [
      [[0, 0], [2, 0]],
      [[6, 0], [10, 0]],
      [[14, 0], [18, 0]]
    ],
    closedLoop: false
  });
  assert.deepEqual(
    round(dashPolyline([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], true, [3, 2], 0)),
    {
      runs: [
        [[0, 0], [3, 0]],
        [[5, 0], [8, 0]],
        [[10, 0], [10, 3]],
        [[10, 5], [10, 8]],
        [[10, 10], [7, 10]],
        [[5, 10], [2, 10]],
        [[0, 10], [0, 7]],
        [[0, 5], [0, 2]]
      ],
      closedLoop: false
    }
  );
  assert.deepEqual(round(dashPolyline([[0, 0], [7, 5], [2, 11]], false, [5, 0], 1.5)), {
    runs: [
      [[0, 0], [2.848067, 2.034334]],
      [[2.848067, 2.034334], [6.916735, 4.940525]],
      [[6.916735, 4.940525], [7, 5], [3.864585, 8.762498]],
      [[3.864585, 8.762498], [2, 11]]
    ],
    closedLoop: false
  });
});

test('a walk culled to a view draws inside it what the whole walk draws', () => {
  const W = 200;
  const H = 150;
  const view = [-6, -6, W + 6, H + 6];
  // what is drawn on the surface: each run's segments cut to it. The culled
  // walk ends and begins runs out of sight, where the whole walk runs on, so
  // runs are compared by what of them the surface has — to a millionth of a
  // pixel, since a run begun at the view's edge is interpolated there.
  const cut = (ax, ay, bx, by) => {
    let t0 = 0;
    let t1 = 1;
    const dx = bx - ax;
    const dy = by - ay;
    for (const [p, q] of [[-dx, ax], [dx, W - ax], [-dy, ay], [dy, H - ay]]) {
      if (p === 0) {
        if (q < 0) return null;
        continue;
      }
      const t = q / p;
      if (p < 0) {
        if (t > t1) return null;
        t0 = Math.max(t0, t);
      } else {
        if (t < t0) return null;
        t1 = Math.min(t1, t);
      }
    }
    return t1 > t0 ? [ax + dx * t0, ay + dy * t0, ax + dx * t1, ay + dy * t1] : null;
  };
  const onSurface = (res) => {
    const out = [];
    for (const run of res.runs) {
      for (let i = 1; i < run.length; i++) {
        const piece = cut(run[i - 1][0], run[i - 1][1], run[i][0], run[i][1]);
        if (piece && Math.hypot(piece[2] - piece[0], piece[3] - piece[1]) > 1e-3) out.push(piece);
      }
    }
    const key = (p) => p.map((v) => Math.round(v * 100)).join(',');
    return out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  };
  const same = (a, b) =>
    a.length === b.length && a.every((p, i) => p.every((v, k) => Math.abs(v - b[i][k]) < 1e-6));
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const patterns = [[4, 4], [1, 2], [5, 0], [0, 3], [10, 5, 2, 5], [7.3, 1.1], [3, 3, 0, 3], [100, 3]];
  for (let k = 0; k < 2000; k++) {
    const far = k % 2 === 0;
    const pts = [];
    for (let i = 0, n = 2 + Math.floor(rnd() * 6); i < n; i++) {
      const x = Math.round((rnd() * (far ? 4000 : 300) - (far ? 2000 : 50)) * 4) / 4;
      const y = Math.round((rnd() * (far ? 4000 : 250) - (far ? 2000 : 50)) * 4) / 4;
      if (pts.length && pts.at(-1)[0] === x && pts.at(-1)[1] === y) continue;
      pts.push([x, y]);
    }
    if (pts.length < 2) continue;
    const closed = k % 3 === 0;
    if (closed) pts.push([pts[0][0], pts[0][1]]);
    const pattern = patterns[k % patterns.length];
    const offset = [0, 1, 2.5, -3, 100, 1e5, 7.77][k % 7];
    const whole = dashPolyline(pts, closed, pattern, offset);
    const culled = dashPolyline(pts, closed, pattern, offset, view);
    const context = JSON.stringify({ pts, closed, pattern, offset });
    assert.equal(culled.closedLoop, whole.closedLoop, context);
    assert.ok(same(onSurface(culled), onSurface(whole)), context);
  }
});

test('the dashes of a path far longer than the view cost what the view shows', () => {
  const view = [-4, -4, 304, 304];
  const whole = dashPolyline([[-500000, 50], [500000, 50]], false, [2, 2], 0);
  const culled = dashPolyline([[-500000, 50], [500000, 50]], false, [2, 2], 0, view);
  assert.equal(whole, null, 'the whole walk is 500,000 dashes: past the cap, so solid');
  assert.ok(culled.runs.length <= 80, `the view's: ${culled.runs.length}`);
  // and the phase the view starts at is the whole walk's: 500,000 - 4 is a
  // whole number of periods, so a dash starts at the view's edge
  assert.deepEqual(round(culled.runs[0]), [[-4, 50], [-2, 50]]);
});

test('a pattern too fine to draw one dash at a time is drawn solid', () => {
  assert.equal(dashPolyline([[0, 0], [100, 0]], false, [1e-9, 1e-9], 0), null);
  // 100 pixels of a 0.001-pixel period, two boundaries each
  assert.ok((100 / 1e-3) * 2 > MAX_BOUNDARIES);
  assert.equal(dashPolyline([[0, 0], [100, 0]], false, [5e-4, 5e-4], 0, [-2, -2, 102, 102]), null);
  // and a pattern the view makes few enough of is dashed
  assert.equal(dashPolyline([[0, 0], [100, 0]], false, [1, 1], 0).runs.length, 50);
});
