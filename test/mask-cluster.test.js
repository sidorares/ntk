// clusterBoxes: the partition behind "one path's pieces, a few masks"
// (issue #264). The properties the 2d context leans on are structural, so
// they are checked here rather than through pixels:
//
//   - every cluster box is disjoint from every other. Two boxes that shared
//     a pixel would composite it twice, which a translucent colour shows as
//     a seam, and would break the winding argument a fill rule rests on.
//   - overlapping pieces always land in the same cluster, whatever order
//     they arrive in.
//   - a cut is only taken when it saves more mask area than the extra mask
//     pass costs, and never more of them than the cap allows.
//
// Pure: no X server, no display.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_MASK_POLICY, clusterBoxes } from '../lib/maskcluster.js';

const area = (b) => b.w * b.h;
const total = (cs) => cs.reduce((n, c) => n + area(c), 0);

function overlaps(a, b) {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  );
}

/** every invariant the context relies on, for any input */
function checkPartition(boxes, clusters) {
  for (let i = 0; i < clusters.length; ++i) {
    for (let j = i + 1; j < clusters.length; ++j) {
      assert.ok(
        !overlaps(clusters[i], clusters[j]),
        `clusters ${i} and ${j} share a pixel: ${JSON.stringify(clusters[i])} ${JSON.stringify(clusters[j])}`
      );
    }
  }
  const seen = new Set();
  for (const c of clusters) {
    for (const i of c.items) {
      assert.ok(!seen.has(i), `piece ${i} is in two clusters`);
      seen.add(i);
      const b = boxes[i];
      assert.ok(
        b.x >= c.x && b.y >= c.y && b.x + b.w <= c.x + c.w && b.y + b.h <= c.y + c.h,
        `piece ${i} is outside its cluster box`
      );
    }
  }
  assert.equal(seen.size, boxes.length, 'every piece is in a cluster');
  // overlapping pieces must share a cluster
  const clusterOf = new Map();
  clusters.forEach((c, ci) => c.items.forEach((i) => clusterOf.set(i, ci)));
  for (let i = 0; i < boxes.length; ++i) {
    for (let j = i + 1; j < boxes.length; ++j) {
      if (!overlaps(boxes[i], boxes[j])) continue;
      assert.equal(clusterOf.get(i), clusterOf.get(j), `overlapping ${i}/${j} were split`);
    }
  }
}

const dot = (x, y, s = 12) => ({ x, y, w: s, h: s });

test('no pieces, one piece', () => {
  assert.deepEqual(clusterBoxes([]), []);
  const one = clusterBoxes([dot(10, 10)]);
  assert.equal(one.length, 1);
  assert.deepEqual(one[0], { x: 10, y: 10, w: 12, h: 12, items: [0] });
});

test('pieces that span the box are left as one mask', () => {
  // four long diagonals across 1000x700: each one already needs most of the
  // box, so there is nothing a cut could save
  const boxes = [
    { x: 0, y: 0, w: 1000, h: 700 },
    { x: 0, y: 0, w: 990, h: 690 },
    { x: 10, y: 10, w: 990, h: 690 },
    { x: 5, y: 300, w: 995, h: 400 }
  ];
  const clusters = clusterBoxes(boxes);
  assert.equal(clusters.length, 1, 'batching them wins, so nothing is split');
  checkPartition(boxes, clusters);
});

test('scattered dots are split, and the mask area collapses', () => {
  const boxes = [];
  for (let i = 0; i < 24; ++i) boxes.push(dot((i % 6) * 180, Math.floor(i / 6) * 180));
  const union = { x: 0, y: 0, w: 912, h: 552 };
  const clusters = clusterBoxes(boxes);
  checkPartition(boxes, clusters);
  assert.ok(clusters.length > 1, `${clusters.length} clusters`);
  assert.ok(
    total(clusters) < area(union) / 8,
    `mask area ${total(clusters)} against ${area(union)} for one box`
  );
});

test('a cut has to pay for the mask pass it costs', () => {
  // two dots 40px apart: the box around both is 52x12, and cutting it saves
  // 336 pixels — far less than a mask pass is worth
  const boxes = [dot(0, 0), dot(40, 0)];
  assert.equal(clusterBoxes(boxes).length, 1);
  // the same pair with a tiny minSaving does split
  const split = clusterBoxes(boxes, { ...DEFAULT_MASK_POLICY, minSaving: 100 });
  assert.equal(split.length, 2);
  checkPartition(boxes, split);
});

test('maxMasks caps the split, keeping the most valuable cuts', () => {
  const boxes = [];
  for (let i = 0; i < 40; ++i) boxes.push(dot(i * 200, i * 100));
  const one = area(clusterBoxes(boxes, { maxMasks: 1 })[0]);
  const capped = clusterBoxes(boxes, { ...DEFAULT_MASK_POLICY, maxMasks: 4 });
  assert.equal(capped.length, 4);
  checkPartition(boxes, capped);
  const uncapped = clusterBoxes(boxes);
  assert.ok(uncapped.length > 4, `${uncapped.length} clusters uncapped`);
  assert.ok(total(capped) > total(uncapped), 'fewer masks cover more area');
  assert.ok(total(capped) < one / 4, 'but far less than one box over all of it');
});

test('one mask is what maxMasks: 1 and an infinite minSaving both give', () => {
  const boxes = [dot(0, 0), dot(900, 700), dot(400, 20)];
  for (const policy of [{ maxMasks: 1 }, { minSaving: Infinity }]) {
    const clusters = clusterBoxes(boxes, { ...DEFAULT_MASK_POLICY, ...policy });
    assert.equal(clusters.length, 1);
    assert.deepEqual(
      { x: clusters[0].x, y: clusters[0].y, w: clusters[0].w, h: clusters[0].h },
      { x: 0, y: 0, w: 912, h: 712 }
    );
    assert.deepEqual(clusters[0].items.slice().sort(), [0, 1, 2]);
  }
});

test('the invariants hold over random scatters, overlaps included', () => {
  let seed = 20240264;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let round = 0; round < 60; ++round) {
    const n = 1 + Math.floor(rand() * 40);
    const boxes = [];
    for (let i = 0; i < n; ++i) {
      // sizes and positions that guarantee plenty of both overlaps and gaps
      const w = 4 + Math.floor(rand() * 120);
      const h = 4 + Math.floor(rand() * 120);
      boxes.push({
        x: Math.floor(rand() * 900),
        y: Math.floor(rand() * 600),
        w,
        h
      });
    }
    checkPartition(boxes, clusterBoxes(boxes));
    checkPartition(boxes, clusterBoxes(boxes, { minSaving: 1, maxMasks: 64 }));
  }
});
