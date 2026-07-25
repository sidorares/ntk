// Trapezoidal decomposition of flattened closed polygons (non-zero winding),
// producing XRender AddTraps data.
//
// A horizontal slab sweep: slab boundaries are the sorted unique vertex y
// coordinates, so edges never cross inside a slab (self-intersecting input —
// e.g. overlapping composite-glyph contours — degrades gracefully to a
// near-correct fill instead of failing). Spans where the winding number is
// non-zero become trapezoids; a span whose left/right edges continue through
// consecutive slabs is merged into a single tall trapezoid, which is what
// keeps the output at roughly one trapezoid per outline edge.
//
// Output is the flat number list node-x11's Render.AddTraps expects:
// 6 values per trapezoid — top spanfix (left x, right x, y) then bottom
// spanfix (left x, right x, y), y-down, top.y < bottom.y.

/**
 * @param {Array<Array<number>>} polys closed polygons as flat [x0,y0,x1,y1,…]
 * @param {number} [dx] translation applied to every x
 * @param {number} [dy] translation applied to every y
 * @param {Array<number>} [out] existing array to append trapezoid data to
 * @returns {Array<number>} `out`
 */
export function trapezoidize(polys, dx = 0, dy = 0, out = []) {
  // collect non-horizontal edges, normalized to y0 < y1 with winding dir
  const edges = [];
  const ys = [];
  for (const poly of polys) {
    const n = poly.length / 2;
    for (let i = 0; i < n; ++i) {
      const j = (i + 1) % n;
      const ax = poly[i * 2] + dx;
      const ay = poly[i * 2 + 1] + dy;
      const bx = poly[j * 2] + dx;
      const by = poly[j * 2 + 1] + dy;
      if (ay === by) continue;
      edges.push(
        ay < by
          ? { x0: ax, y0: ay, x1: bx, y1: by, dir: 1, xa: 0, xb: 0 }
          : { x0: bx, y0: by, x1: ax, y1: ay, dir: -1, xa: 0, xb: 0 }
      );
      ys.push(ay, by);
    }
  }
  if (edges.length === 0) return out;

  ys.sort((a, b) => a - b);
  edges.sort((a, b) => a.y0 - b.y0);

  const active = [];
  let nextEdge = 0;
  // spans open from the previous slab, for vertical merging:
  // { l: leftEdge, r: rightEdge, at: index of the trap in `out` }
  let prevSpans = [];

  for (let yi = 0; yi < ys.length - 1; ++yi) {
    const ya = ys[yi];
    const yb = ys[yi + 1];
    if (yb === ya) continue;

    // update the active edge list for this slab
    for (let i = active.length - 1; i >= 0; --i) {
      if (active[i].y1 <= ya) active.splice(i, 1);
    }
    while (nextEdge < edges.length && edges[nextEdge].y0 <= ya) {
      if (edges[nextEdge].y1 > ya) active.push(edges[nextEdge]);
      nextEdge++;
    }
    if (active.length === 0) {
      prevSpans = [];
      continue;
    }

    // x at slab top/bottom for each active edge; sort left-to-right
    for (const e of active) {
      const inv = (e.x1 - e.x0) / (e.y1 - e.y0);
      e.xa = e.x0 + (ya - e.y0) * inv;
      e.xb = e.x0 + (yb - e.y0) * inv;
    }
    active.sort((a, b) => a.xa + a.xb - (b.xa + b.xb));

    // non-zero winding: emit a span per maximal interior interval
    const spans = [];
    let winding = 0;
    let left = null;
    for (const e of active) {
      const was = winding;
      winding += e.dir;
      if (was === 0 && winding !== 0) {
        left = e;
      } else if (was !== 0 && winding === 0 && left) {
        // merge with a span from the previous slab bounded by the same edges
        let merged = false;
        for (const p of prevSpans) {
          if (p.l === left && p.r === e && out[p.at + 5] === ya) {
            out[p.at + 3] = left.xb;
            out[p.at + 4] = e.xb;
            out[p.at + 5] = yb;
            spans.push(p);
            merged = true;
            break;
          }
        }
        if (!merged && (e.xa > left.xa || e.xb > left.xb)) {
          spans.push({ l: left, r: e, at: out.length });
          out.push(left.xa, e.xa, ya, left.xb, e.xb, yb);
        }
        left = null;
      }
    }
    prevSpans = spans;
  }
  return out;
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
