// A stroke's dash pattern, walked along its path as far as the surface can
// show it.
//
// Walking a pattern costs a run for every dash: the path's length over the
// pattern's. A dashed border round a box 380,000 pixels tall — a code block
// in a scroll pane — was 95,000 runs and 78 ms a stroke for the handful the
// surface shows, and a pattern a billionth of a pixel long ran the heap out.
//
// So each segment is walked only where it lies inside `view`: the surface,
// grown by what a join or a cap can reach past a point. Everywhere else the
// pattern is advanced by the length passed, arithmetically, which leaves
// every dash that is drawn where a walk of the whole path puts it. A run is
// ended where its segment leaves the view and begun again where one comes
// back, both out of sight. And where what is left would still be more than
// `MAX_BOUNDARIES` dashes, the stroke is drawn solid, as Skia draws one past
// its kMaxDashCount: dashes that fine are a tone, not a pattern.

/** Past this many dash boundaries in what the surface shows, the stroke is
 *  drawn solid instead. */
export const MAX_BOUNDARIES = 100000;

// the part of a segment inside the view, as parameters along it (Liang-
// Barsky): written here rather than returned, since the walk asks once a
// segment and an array a segment is garbage a stroke
let clipFrom = 0;
let clipTo = 1;

/** Whether segment a→b meets `view` ([x0, y0, x1, y1]), and if so the part of
 *  it that does in `clipFrom`..`clipTo`. */
function clipSegment(ax, ay, bx, by, view) {
  const [x0, y0, x1, y1] = view;
  if (ax >= x0 && ax <= x1 && ay >= y0 && ay <= y1 && bx >= x0 && bx <= x1 && by >= y0 && by <= y1) {
    clipFrom = 0;
    clipTo = 1;
    return true;
  }
  const dx = bx - ax;
  const dy = by - ay;
  clipFrom = 0;
  clipTo = 1;
  // each edge of the view as p·t ≤ q
  if (!clipEdge(-dx, ax - x0) || !clipEdge(dx, x1 - ax) || !clipEdge(-dy, ay - y0) || !clipEdge(dy, y1 - ay)) {
    return false;
  }
  return clipTo > clipFrom;
}

/** Narrow `clipFrom`..`clipTo` to where p·t ≤ q; false where nothing is left. */
function clipEdge(p, q) {
  if (p === 0) return q >= 0; // parallel to this edge: inside it or not at all
  const t = q / p;
  if (p < 0) {
    if (t > clipTo) return false;
    if (t > clipFrom) clipFrom = t;
  } else {
    if (t < clipFrom) return false;
    if (t < clipTo) clipTo = t;
  }
  return true;
}

/**
 * Split a device-space polyline into dash "on" runs by arc length.
 *
 * `pts` is [[x, y], ...] with no consecutive duplicates; for closed subpaths
 * the closing point is already appended, and the pattern continues around the
 * loop as one uninterrupted walk. Returns null when the pattern cannot
 * produce gaps (all-zero), or would make more than `MAX_BOUNDARIES` of them
 * in what the view shows — stroke it solid — otherwise { runs, closedLoop }:
 * `runs` is a list of [[x, y], ...] open polylines (caps apply to each),
 * `closedLoop` marks a closed subpath the pattern never split — stroke it
 * closed, with no caps.
 *
 * `view` is [x0, y0, x1, y1], outside which nothing drawn can be seen; null
 * walks the whole path.
 */
export function dashPolyline(pts, closed, pattern, offset, view = null) {
  const n = pattern.length;
  let total = 0;
  for (const d of pattern) total += d;
  if (!(total > 0)) return null;

  // what the walk would visit, and so how many boundaries it would make
  let visible = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const len = Math.hypot(bx - ax, by - ay);
    if (!view) visible += len;
    else if (clipSegment(ax, ay, bx, by, view)) visible += len * (clipTo - clipFrom);
  }
  if ((visible / total) * n > MAX_BOUNDARIES) return null;

  // starting phase: offset into the pattern, wrapped into [0, total)
  let phase = offset % total;
  if (phase < 0) phase += total;
  let idx = 0;
  while (phase > 0 && phase >= pattern[idx]) {
    phase -= pattern[idx];
    idx = (idx + 1) % n;
  }

  let on = idx % 2 === 0; // even entries are "on", odd are gaps
  const startedOn = on;
  let toggled = false;
  let remain = pattern[idx] - phase;

  // Move along the pattern by `d` without drawing. A boundary is crossed
  // only once `d` is past it, as the walk below crosses one.
  const advance = (d) => {
    if (d <= remain) {
      remain -= d;
      return;
    }
    d -= remain;
    idx = (idx + 1) % n;
    on = !on;
    toggled = true;
    // whole periods leave the entry where it was, and `on` too where the
    // pattern has an even number of entries, as canvas makes it
    const periods = Math.floor(d / total);
    d -= periods * total;
    if (n % 2 === 1 && periods % 2 === 1) on = !on;
    while (d > pattern[idx]) {
      d -= pattern[idx];
      idx = (idx + 1) % n;
      on = !on;
    }
    remain = pattern[idx] - d;
  };

  const runs = [];
  let cur = null;
  // whether the first run starts at the path's start and the last ends at
  // its end: only then does a closed path's seam join them
  let openedAtStart = false;
  let openAtEnd = false;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let from = 0;
    let to = 1;
    if (view) {
      if (!clipSegment(a[0], a[1], b[0], b[1], view)) {
        if (cur) runs.push(cur);
        cur = null;
        advance(segLen);
        continue;
      }
      from = clipFrom;
      to = clipTo;
    }
    if (from > 0) {
      if (cur) runs.push(cur);
      cur = null;
      advance(segLen * from);
    }
    let px = from > 0 ? a[0] + (b[0] - a[0]) * from : a[0];
    let py = from > 0 ? a[1] + (b[1] - a[1]) * from : a[1];
    const ex = to < 1 ? a[0] + (b[0] - a[0]) * to : b[0];
    const ey = to < 1 ? a[1] + (b[1] - a[1]) * to : b[1];
    if (on && !cur) {
      cur = [from > 0 ? [px, py] : a];
      if (i === 1 && from === 0) openedAtStart = true;
    }
    let len = to < 1 || from > 0 ? Math.hypot(ex - px, ey - py) : segLen;
    while (len > remain) {
      // cross a dash boundary inside this segment
      const t = len > 0 ? remain / len : 0;
      const bx = px + (ex - px) * t;
      const by = py + (ey - py) * t;
      if (on) {
        cur.push([bx, by]);
        runs.push(cur);
        cur = null;
      } else {
        cur = [[bx, by]];
      }
      on = !on;
      toggled = true;
      px = bx;
      py = by;
      len = Math.hypot(ex - px, ey - py);
      idx = (idx + 1) % n;
      remain = pattern[idx];
    }
    remain -= len;
    if (on) cur.push(to < 1 ? [ex, ey] : b);
    if (to < 1) {
      if (cur) runs.push(cur);
      cur = null;
      advance(segLen * (1 - to));
    }
  }
  if (cur) {
    runs.push(cur);
    openAtEnd = true;
  }

  if (closed && !toggled) return { runs, closedLoop: startedOn };
  // closed subpath with dashes on both sides of the seam: merge the last
  // run into the first so no caps appear at the seam
  if (closed && openedAtStart && openAtEnd && runs.length > 1) {
    const last = runs.pop();
    runs[0] = last.concat(runs[0].slice(1));
  }
  return { runs, closedLoop: false };
}
