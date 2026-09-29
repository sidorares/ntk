// Trapezoidal decomposition of flattened closed polygons (non-zero winding
// by default, even-odd optionally), producing XRender AddTraps data.
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
 * @param {'nonzero'|'evenodd'} [rule] fill rule (default non-zero winding)
 * @returns {Array<number>} `out`
 */
export function trapezoidize(polys, dx = 0, dy = 0, out = [], rule = 'nonzero') {
  const evenodd = rule === 'evenodd';
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

    // emit a span per maximal interior interval; interiority is decided by
    // the fill rule (non-zero winding, or crossing parity for even-odd)
    const spans = [];
    let winding = 0;
    let crossings = 0;
    let left = null;
    for (const e of active) {
      const wasInside = evenodd ? (crossings & 1) === 1 : winding !== 0;
      winding += e.dir;
      crossings++;
      const isInside = evenodd ? (crossings & 1) === 1 : winding !== 0;
      if (!wasInside && isInside) {
        left = e;
      } else if (wasInside && !isInside && left) {
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
