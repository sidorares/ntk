// Trapezoidal decomposition of flattened closed polygons (non-zero winding
// by default, even-odd optionally), producing XRender AddTraps data.
//
// A horizontal slab sweep. Slab boundaries are the sorted unique vertex y
// coordinates, and where two edges cross inside a slab the slab is split at
// the crossing, so that within every slab the active edges keep one
// left-to-right order from top to bottom. Spans between them are then true
// trapezoids, and self-intersecting input — a pentagram, two crossed bars,
// overlapping composite-glyph contours — is filled exactly by its rule.
// Spans where the rule says "inside" become trapezoids; a span whose
// left/right edges continue through consecutive slabs is merged into a
// single tall trapezoid, which is what keeps the output at roughly one
// trapezoid per outline edge (plus a few per crossing).
//
// Crossings are found the way a Bentley-Ottmann sweep finds them: the first
// change of order below a line is always between two edges adjacent on it,
// so each step takes the earliest crossing of an adjacent pair whose order
// is reversed at the slab's bottom, cuts there and swaps the pair. Every
// swap removes one inversion of the bottom order, so the loop ends however
// the floats round. Differences within a hair of the input's magnitude —
// collinear edges, crossings right at a slab's top or bottom — are rounding,
// not geometry: they cause no split and cut no sliver.
//
// Output is the flat number list node-x11's Render.AddTraps expects:
// 6 values per trapezoid — top spanfix (left x, right x, y) then bottom
// spanfix (left x, right x, y), y-down, top.y < bottom.y.

/**
 * @param {Array<Array<number>>} polys closed polygons as flat [x0,y0,x1,y1,…]
 * @param {number} [dx] translation applied to every x
 * @param {number} [dy] translation applied to every y
 * @param {Array<number>} [out] existing array to append trapezoid data to
 * @param {'nonzero'|'evenodd'} [rule] fill rule (default non-zero winding)
 * @returns {Array<number>} `out`
 */
export function trapezoidize(polys, dx = 0, dy = 0, out = [], rule = 'nonzero') {
  const evenodd = rule === 'evenodd';
  // collect non-horizontal edges, normalized to y0 < y1 with winding dir
  const edges = [];
  let ys = [];
  // the largest coordinate magnitude, which sets the rounding noise
  let reach = 1;
  for (const poly of polys) {
    const n = poly.length / 2;
    for (let i = 0; i < n; ++i) {
      const j = (i + 1) % n;
      const ax = poly[i * 2] + dx;
      const ay = poly[i * 2 + 1] + dy;
      const bx = poly[j * 2] + dx;
      const by = poly[j * 2 + 1] + dy;
      if (ay === by) continue;
      const slope = (bx - ax) / (by - ay);
      edges.push(
        ay < by
          ? { x0: ax, y0: ay, y1: by, slope, dir: 1, xt: 0, xb: 0, xc: 0 }
          : { x0: bx, y0: by, y1: ay, slope, dir: -1, xt: 0, xb: 0, xc: 0 }
      );
      ys.push(ay, by);
      const m = Math.max(Math.abs(ax), Math.abs(ay), Math.abs(bx), Math.abs(by));
      if (m > reach) reach = m;
    }
  }
  if (edges.length === 0) return out;
  // ~256 ulps of the largest coordinate: far above what evaluating an edge
  // at a height rounds by, far below a 16.16 fixed-point step at any
  // coordinate that fits one
  const eps = reach * 2 ** -44;

  // a typed array sorts numerically without a comparator call per step
  ys = Float64Array.from(ys).sort();
  edges.sort((a, b) => a.y0 - b.y0);

  const active = [];
  let nextEdge = 0;
  // spans open from the previous slab, for vertical merging, and the ones
  // this slab opens: flat [leftEdge, rightEdge, index of the trap in `out`]
  // triples, two buffers that trade places every slab
  let prevSpans = [];
  let spans = [];

  for (let yi = 0; yi < ys.length - 1; ++yi) {
    const ya = ys[yi];
    const yb = ys[yi + 1];
    if (yb === ya) continue;

    // update the active edge list for this slab
    let kept = 0;
    for (let i = 0; i < active.length; ++i) {
      if (active[i].y1 > ya) active[kept++] = active[i];
    }
    active.length = kept;
    while (nextEdge < edges.length && edges[nextEdge].y0 <= ya) {
      if (edges[nextEdge].y1 > ya) active.push(edges[nextEdge]);
      nextEdge++;
    }
    if (active.length === 0) {
      prevSpans.length = 0;
      continue;
    }

    // x at slab top/bottom for each active edge; sort left-to-right just
    // below the top (edges leaving one point go by where they are headed)
    for (let i = 0; i < active.length; ++i) {
      const e = active[i];
      e.xt = e.x0 + (ya - e.y0) * e.slope;
      e.xb = e.x0 + (yb - e.y0) * e.slope;
    }
    // a slab holds a handful of edges, mostly in last slab's order: an
    // insertion sort, stable as Array#sort is, so the order is the same
    for (let i = 1; i < active.length; ++i) {
      const e = active[i];
      let j = i - 1;
      while (j >= 0 && (active[j].xt - e.xt || active[j].xb - e.xb) > 0) {
        active[j + 1] = active[j];
        --j;
      }
      active[j + 1] = e;
    }

    // cut the slab at each crossing, top to bottom; `y` is where the part
    // still to emit starts, and `xt` each edge's x there
    let y = ya;
    for (;;) {
      let yc = yb;
      let k = -1;
      for (let i = 0; i + 1 < active.length; ++i) {
        const a = active[i];
        const b = active[i + 1];
        // how far `a` ends up right of `b`, and how far left of it it starts
        const over = a.xb - b.xb;
        if (!(over > eps)) continue;
        const gap = b.xt - a.xt;
        const at = gap > 0 ? y + (yb - y) * (gap / (gap + over)) : y;
        if (at < yc) {
          yc = at;
          k = i;
        }
      }
      if (k < 0 || yc >= yb - eps) {
        emitSpans(active, y, yb, true, evenodd, prevSpans, spans, out);
        [prevSpans, spans] = [spans, prevSpans];
        break;
      }
      if (yc > y + eps) {
        for (let i = 0; i < active.length; ++i) {
          const e = active[i];
          e.xc = e.x0 + (yc - e.y0) * e.slope;
        }
        emitSpans(active, y, yc, false, evenodd, prevSpans, spans, out);
        [prevSpans, spans] = [spans, prevSpans];
        for (let i = 0; i < active.length; ++i) active[i].xt = active[i].xc;
        y = yc;
      }
      const a = active[k];
      active[k] = active[k + 1];
      active[k + 1] = a;
    }
  }
  return out;
}

/**
 * Emit a span per maximal interior interval of the slab `ya`..`yb`;
 * interiority is decided by the fill rule (non-zero winding, or crossing
 * parity for even-odd). Each edge is at `xt` at the top, and at the bottom
 * at `xb` when this is the `last` part of its vertex slab, else at `xc`. A
 * span bounded by the same two edges as one ending at `ya` extends that
 * trapezoid instead. The spans go into `spans`, emptied first, for the next
 * slab to merge with.
 */
function emitSpans(active, ya, yb, last, evenodd, prevSpans, spans, out) {
  spans.length = 0;
  let winding = 0;
  let crossings = 0;
  let left = null;
  for (let i = 0; i < active.length; ++i) {
    const e = active[i];
    const wasInside = evenodd ? (crossings & 1) === 1 : winding !== 0;
    winding += e.dir;
    crossings++;
    const isInside = evenodd ? (crossings & 1) === 1 : winding !== 0;
    if (!wasInside && isInside) {
      left = e;
    } else if (wasInside && !isInside && left) {
      const lb = last ? left.xb : left.xc;
      const rb = last ? e.xb : e.xc;
      // merge with a span from the previous slab bounded by the same edges
      let merged = false;
      for (let p = 0; p < prevSpans.length; p += 3) {
        const at = prevSpans[p + 2];
        if (prevSpans[p] === left && prevSpans[p + 1] === e && out[at + 5] === ya) {
          out[at + 3] = lb;
          out[at + 4] = rb;
          out[at + 5] = yb;
          spans.push(left, e, at);
          merged = true;
          break;
        }
      }
      if (!merged && (e.xt > left.xt || rb > lb)) {
        spans.push(left, e, out.length);
        out.push(left.xt, e.xt, ya, lb, rb, yb);
      }
      left = null;
    }
  }
}

/** area covered by a trapezoid list (useful for tests/diagnostics) */
export function trapArea(traps) {
  let area = 0;
  for (let i = 0; i < traps.length; i += 6) {
    const [tl, tr, ty, bl, br, by] = [
      traps[i], traps[i + 1], traps[i + 2], traps[i + 3], traps[i + 4], traps[i + 5]
    ];
    area += ((tr - tl + (br - bl)) / 2) * (by - ty);
  }
  return area;
}

/**
 * Trapezoids cut to the rectangle [x0, x1] × [y0, y1], with the coverage
 * inside it unchanged — the part of a mask that can show anything. A glyph
 * a million pixels high is a mask no X server will make and coordinates
 * past what 16.16 fixed point carries, and every pixel of it outside the
 * surface is a pixel rasterized for nothing.
 *
 * The cut is exact. Each trapezoid is clipped to the rows and then split
 * into bands where either edge crosses x0 or x1, so that within a band an
 * edge lies wholly on one side of each line: an edge outside the rectangle
 * becomes the vertical just past it, which covers the same pixels inside,
 * and a band with nothing inside is dropped.
 *
 * @param {Array<number>} traps AddTraps data, as `trapezoidize` makes it
 * @returns {Array<number>} the cut trapezoids, in the same coordinates
 */
export function clipTraps(traps, x0, y0, x1, y1) {
  const out = [];
  for (let i = 0; i < traps.length; i += 6) {
    const tl = traps[i];
    const tr = traps[i + 1];
    const ty = traps[i + 2];
    const bl = traps[i + 3];
    const br = traps[i + 4];
    const by = traps[i + 5];
    if (!(by > y0 && ty < y1 && by > ty)) continue;
    const top = Math.max(ty, y0);
    const bottom = Math.min(by, y1);
    // each edge's x at a height
    const left = (y) => tl + (bl - tl) * ((y - ty) / (by - ty));
    const right = (y) => tr + (br - tr) * ((y - ty) / (by - ty));
    const cuts = [top, bottom];
    for (const [a, b] of [
      [tl, bl],
      [tr, br]
    ]) {
      for (const x of [x0, x1]) {
        if ((a - x) * (b - x) >= 0) continue; // does not cross this line
        const y = ty + (by - ty) * ((x - a) / (b - a));
        if (y > top && y < bottom) cuts.push(y);
      }
    }
    cuts.sort((p, q) => p - q);
    for (let k = 0; k + 1 < cuts.length; k++) {
      const ya = cuts[k];
      const yb = cuts[k + 1];
      if (!(yb > ya)) continue;
      const mid = (ya + yb) / 2;
      const lm = left(mid);
      const rm = right(mid);
      if (lm >= x1 || rm <= x0) continue; // nothing of this band inside
      const inL = lm >= x0;
      const inR = rm <= x1;
      out.push(
        inL ? left(ya) : x0 - 1,
        inR ? right(ya) : x1 + 1,
        ya,
        inL ? left(yb) : x0 - 1,
        inR ? right(yb) : x1 + 1,
        yb
      );
    }
  }
  return out;
}
