// Self-intersecting polygons, and what filling them covers worked out the
// slow way, sharing nothing with lib/: every pair of edges is intersected
// directly, and the filled length of a horizontal line is integrated between
// consecutive events.

/** MDN's fill-rule example: one contour, crossing itself five times */
export const PENTAGRAM = [50, 0, 21, 90, 98, 35, 2, 35, 79, 90];

/** an "×": two `len` by `width` bars about (cx, cy), rotated ±45° */
export function xBars(cx, cy, len, width) {
  return [Math.PI / 4, -Math.PI / 4].map((a) => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [
      [-len / 2, -width / 2],
      [len / 2, -width / 2],
      [len / 2, width / 2],
      [-len / 2, width / 2]
    ].flatMap(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
  });
}

function edgesOf(polys) {
  const edges = [];
  for (const p of polys) {
    for (let i = 0; i < p.length; i += 2) {
      const j = (i + 2) % p.length;
      edges.push([p[i], p[i + 1], p[j], p[j + 1]]);
    }
  }
  return edges;
}

/** where two edges cross inside both of them */
function crossing([ax, ay, bx, by], [cx, cy, dx, dy]) {
  const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (d === 0) return null;
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d;
  if (!(t > 0 && t < 1 && u > 0 && u < 1)) return null;
  return [ax + t * (bx - ax), ay + t * (by - ay)];
}

/** every point where two edges of `polys` cross, as [x, y] */
export function crossingPoints(polys) {
  const edges = edgesOf(polys);
  const points = [];
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const p = crossing(edges[i], edges[j]);
      if (p) points.push(p);
    }
  }
  return points;
}

/**
 * The area `rule` fills of `polys` inside the rectangle [x0, x1] × [y0, y1]
 * (everywhere, by default). Between consecutive heights at which a vertex
 * sits, two edges cross or an edge crosses x0 or x1, every filled interval
 * of a horizontal line moves linearly and stays on its side of the
 * rectangle's, so the filled length is linear in y and the midpoint rule
 * is exact.
 */
export function filledArea(polys, rule, x0 = -Infinity, y0 = -Infinity, x1 = Infinity, y1 = Infinity) {
  const edges = edgesOf(polys).filter((e) => e[1] !== e[3]);
  const events = [];
  for (const [ax, ay, bx, by] of edges) {
    events.push(ay, by);
    for (const x of [x0, x1]) {
      if ((ax - x) * (bx - x) < 0) events.push(ay + ((by - ay) * (x - ax)) / (bx - ax));
    }
  }
  for (const p of crossingPoints(polys)) events.push(p[1]);
  const ys = [...new Set(events.filter((y) => y > y0 && y < y1))];
  if (y0 > -Infinity) ys.push(y0);
  if (y1 < Infinity) ys.push(y1);
  ys.sort((a, b) => a - b);
  let area = 0;
  for (let k = 0; k + 1 < ys.length; k++) {
    const y = (ys[k] + ys[k + 1]) / 2;
    const hits = [];
    for (const [ax, ay, bx, by] of edges) {
      if ((ay < y && by > y) || (by < y && ay > y)) {
        hits.push([ax + ((bx - ax) * (y - ay)) / (by - ay), ay < by ? 1 : -1]);
      }
    }
    hits.sort((a, b) => a[0] - b[0]);
    let winding = 0;
    let length = 0;
    for (let i = 0; i + 1 < hits.length; i++) {
      winding += hits[i][1];
      const inside = rule === 'evenodd' ? (i & 1) === 0 : winding !== 0;
      if (inside) length += Math.max(0, Math.min(hits[i + 1][0], x1) - Math.max(hits[i][0], x0));
    }
    area += length * (ys[k + 1] - ys[k]);
  }
  return area;
}
