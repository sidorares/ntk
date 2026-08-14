// Splitting one drawing's coverage mask into a few, when its pieces are
// scattered (issue #264).
//
// A fill or stroke rasterizes coverage into one a8 mask sized to the
// drawing's ink bounding box, and that mask costs width x height whatever
// the coverage inside it is. For one shape the bound is right. For a path
// holding N disjoint subpaths the bound is their *union*, so batching N
// draws into one path trades N small masks for one big one — which wins
// when the pieces span the box anyway (long edges of a graph) and loses
// badly when they do not (its handle dots): at 1100x700, 735 batched edge
// strokes cost 3.9 MB -> 1.3 MB of mask and 53% less frame time, while 19
// edges plus 40 small discs batched the same way cost ~0.75 MB *more* and
// 40% more frame time than drawing them singly.
//
// Rather than leave that cliff to every caller, the boxes go through here
// first and the mask is emitted once per cluster. The partition is by gaps
// only: a cut is legal where nothing straddles it, which is what keeps
// every cluster box disjoint from every other. Disjoint boxes are what make
// the split invisible — no pixel is composited twice (a translucent colour
// would blend twice at any overlap), and the winding number a fill asks for
// is unchanged, because a closed subpath contributes nothing to the winding
// of a point outside its own box.
//
// Cutting is not free: each extra mask is a few more requests. So a cut has
// to pay for itself in mask area, and the cheapest useful unit of area is
// the policy's `minSaving`. That single rule bounds the outcome from both
// sides — every cut removes at least `minSaving` pixels of mask, so the
// number of clusters can never exceed the union area divided by it.

/**
 * When one drawing's mask is worth splitting into several.
 *
 * - `minSaving` — mask pixels a cut has to remove to be worth the extra
 *   mask pass it costs. 64x64 is the same "small enough not to think about"
 *   box `DEFAULT_RASTER_POLICY.maxArea` uses: below it, an extra pass is
 *   dearer than the area it would save.
 * - `maxMasks` — hard cap on clusters per drawing, so a pathological path
 *   (thousands of scattered dots) cannot turn one drawing into thousands of
 *   request groups. Cuts are taken most-valuable-first, so the cap keeps the
 *   ones that matter.
 *
 * `{ maxMasks: 1 }` — or `minSaving: Infinity` — disables the split, which
 * is what a composite op that writes outside its coverage gets.
 */
export const DEFAULT_MASK_POLICY = {
  minSaving: 64 * 64,
  maxMasks: 32
};

/** the policy for one app, merged over the defaults */
export function maskPolicyOf(app) {
  return app.maskPolicy
    ? { ...DEFAULT_MASK_POLICY, ...app.maskPolicy }
    : DEFAULT_MASK_POLICY;
}

const area = (b) => b.w * b.h;

/** The smallest {x, y, w, h} box holding both of two boxes. */
export function unionBox(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y
  };
}

function unionOf(boxes, order) {
  let out = { ...boxes[order[0]] };
  for (let i = 1; i < order.length; ++i) out = unionBox(out, boxes[order[i]]);
  return out;
}

/**
 * The most valuable gap cut of one group along one axis, or null when the
 * group has no gap on it.
 *
 * `order` is the group's members sorted by that axis' start. A cut between
 * members i and i+1 is legal only where nothing straddles it — the next box
 * has to start at or past the far edge of every box before it, which for a
 * union box is just its own far edge. What the cut is worth is the mask area
 * it removes: the parent box less the two halves.
 */
function bestGap(boxes, order, box, axis) {
  const n = order.length;
  const start = axis === 'x' ? 'x' : 'y';
  const size = axis === 'x' ? 'w' : 'h';

  // suffix[i] is the union box of order[i..n-1]; the prefix is carried
  // along the scan below
  const suffix = new Array(n);
  suffix[n - 1] = { ...boxes[order[n - 1]] };
  for (let i = n - 2; i >= 0; --i) {
    suffix[i] = unionBox(boxes[order[i]], suffix[i + 1]);
  }

  let best = null;
  let prefix = { ...boxes[order[0]] };
  for (let i = 0; i + 1 < n; ++i) {
    if (i > 0) prefix = unionBox(prefix, boxes[order[i]]);
    const next = boxes[order[i + 1]];
    if (next[start] < prefix[start] + prefix[size]) continue; // straddled
    const saving = area(box) - area(prefix) - area(suffix[i + 1]);
    if (!best || saving > best.saving) {
      best = { axis, at: i, saving, left: prefix, right: suffix[i + 1] };
    }
  }
  return best;
}

/** a group of pieces, its box, and the best cut available to it */
function makeNode(boxes, byX, byY, box) {
  const node = { box: box ?? unionOf(boxes, byX), byX, byY, split: null };
  if (byX.length > 1) {
    const x = bestGap(boxes, byX, node.box, 'x');
    const y = bestGap(boxes, byY, node.box, 'y');
    node.split = !x ? y : !y || x.saving >= y.saving ? x : y;
  }
  return node;
}

/** the two halves of `node`, each with its own next-best cut */
function splitNode(boxes, node) {
  const { axis, at, left, right } = node.split;
  const cut = axis === 'x' ? node.byX : node.byY;
  const other = axis === 'x' ? node.byY : node.byX;
  const inLeft = new Set(cut.slice(0, at + 1));
  // the other axis' order survives the filter, so neither half is re-sorted
  const leftOther = other.filter((i) => inLeft.has(i));
  const rightOther = other.filter((i) => !inLeft.has(i));
  const leftCut = cut.slice(0, at + 1);
  const rightCut = cut.slice(at + 1);
  return axis === 'x'
    ? [
        makeNode(boxes, leftCut, leftOther, left),
        makeNode(boxes, rightCut, rightOther, right)
      ]
    : [
        makeNode(boxes, leftOther, leftCut, left),
        makeNode(boxes, rightOther, rightCut, right)
      ];
}

/**
 * Partition one drawing's pieces into mask clusters.
 *
 * @param {Array<{x, y, w, h}>} boxes one integer box per piece — a fill's
 *   subpaths, a stroke's islands of triangles — already clamped to the
 *   surface. Boxes may overlap; overlapping ones always end up in the same
 *   cluster.
 * @param {{minSaving: number, maxMasks: number}} [policy]
 * @returns {Array<{x, y, w, h, items: number[]}>} clusters, each with the
 *   indices of the pieces it holds. Cluster boxes are pairwise disjoint,
 *   and their union is the union of `boxes`.
 */
export function clusterBoxes(boxes, policy = DEFAULT_MASK_POLICY) {
  const n = boxes.length;
  if (!n) return [];
  // merged here as well as in maskPolicyOf, so that a partial policy from a
  // direct caller ({ maxMasks: 1 }) cannot silently zero the other field
  const { minSaving, maxMasks: cap } = { ...DEFAULT_MASK_POLICY, ...policy };
  const maxMasks = Math.max(1, cap | 0);
  const all = boxes.map((_, i) => i);
  if (n === 1 || maxMasks === 1 || !(minSaving < Infinity)) {
    return [{ ...unionOf(boxes, all), items: all }];
  }

  const byX = all.slice().sort((a, b) => boxes[a].x - boxes[b].x || a - b);
  const byY = all.slice().sort((a, b) => boxes[a].y - boxes[b].y || a - b);
  const nodes = [makeNode(boxes, byX, byY)];
  // most-valuable cut first, so a maxMasks cap keeps the cuts that matter
  while (nodes.length < maxMasks) {
    let pick = -1;
    let best = minSaving;
    for (let i = 0; i < nodes.length; ++i) {
      const split = nodes[i].split;
      if (split && split.saving >= best) {
        best = split.saving;
        pick = i;
      }
    }
    if (pick < 0) break;
    const [a, b] = splitNode(boxes, nodes[pick]);
    nodes[pick] = a;
    nodes.push(b);
  }
  return nodes.map((node) => ({ ...node.box, items: node.byX }));
}
