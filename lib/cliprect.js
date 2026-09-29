// Geometry clipped to a rectangle, for what goes to the server in XRender's
// 16.16 fixed point: trapezoids and triangles. A coordinate past 32,767 there
// overflows the 32-bit word node-x11 writes it into, and the RangeError comes
// out of the paint that drew it. A box of a code block twenty thousand lines
// tall in a scroll pane was one, filled as a rounded rectangle.
//
// Only what reaches past what the wire can carry is clipped (`WIRE_REACH`):
// everything else goes out as it came, so a drawing that fits is sent exactly
// as before.

/**
 * How far from a picture's origin a coordinate may reach and still be
 * carried: half of what 16.16 fixed point and a 16-bit origin hold, so an
 * offset the size of a surface on top of it still fits. Geometry within it
 * goes to the server as it came, and the server clips it — cutting it here
 * costs more than that, and a zoomed graph has hundreds of edges a little
 * past the window every frame. Only geometry past it is cut.
 */
export const WIRE_REACH = 16384;

/** Whether every point of a flat `[x, y, …]` list is inside the rectangle. */
export function withinRect(pts, x0, y0, x1, y1) {
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i];
    const y = pts[i + 1];
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  }
  return true;
}

/**
 * A closed ring clipped to the rectangle (Sutherland–Hodgman), as a flat
 * `[x, y, …]` list, empty when nothing of it is inside. Clipping each ring of
 * a shape on its own keeps its fill, nonzero or even-odd, the same at every
 * point inside a convex region.
 */
export function clipRingToRect(pts, x0, y0, x1, y1) {
  let ring = pts;
  // each edge of the rectangle: which coordinate, which bound, which side
  for (const [axis, bound, keepAbove] of [
    [0, x0, true],
    [0, x1, false],
    [1, y0, true],
    [1, y1, false],
  ]) {
    const n = ring.length / 2;
    if (n === 0) break;
    const out = [];
    const inside = (i) =>
      keepAbove ? ring[i * 2 + axis] >= bound : ring[i * 2 + axis] <= bound;
    for (let i = 0; i < n; i++) {
      const j = (i + n - 1) % n; // the previous point
      const iin = inside(i);
      const jin = inside(j);
      if (iin !== jin) {
        // where the segment from j to i crosses the bound
        const a = ring[j * 2 + axis];
        const b = ring[i * 2 + axis];
        const t = (bound - a) / (b - a);
        const other = 1 - axis;
        const oa = ring[j * 2 + other];
        const ob = ring[i * 2 + other];
        const p = [0, 0];
        p[axis] = bound;
        p[other] = oa + (ob - oa) * t;
        out.push(p[0], p[1]);
      }
      if (iin) out.push(ring[i * 2], ring[i * 2 + 1]);
    }
    ring = out;
  }
  return ring;
}

/**
 * A flat list of triangles, six numbers each, with every one that reaches
 * past the rectangle clipped to it and cut back into triangles (a fan: what
 * is left of a triangle inside a rectangle is convex).
 */
export function clipTrianglesToRect(tris, x0, y0, x1, y1) {
  const out = [];
  for (let i = 0; i + 5 < tris.length; i += 6) {
    const tri = tris.slice(i, i + 6);
    if (withinRect(tri, x0, y0, x1, y1)) {
      out.push(...tri);
      continue;
    }
    const poly = clipRingToRect(tri, x0, y0, x1, y1);
    for (let k = 2; k * 2 + 1 < poly.length; k++) {
      out.push(
        poly[0],
        poly[1],
        poly[(k - 1) * 2],
        poly[(k - 1) * 2 + 1],
        poly[k * 2],
        poly[k * 2 + 1],
      );
    }
  }
  return out;
}

/**
 * A flat `[x, y, w, h, …]` list of rectangles on whole pixels and cut to
 * `[0, width) × [0, height)`, dropping the ones with nothing left: core X's
 * rectangles are 16 bits. The list itself when every rectangle is already
 * whole and on the surface.
 *
 * Each edge is rounded on its own. The wire truncates a rectangle's x and
 * its width separately, so two rectangles meeting at a fractional edge —
 * the selection bands of two lines whose height is the face's, 15.13px —
 * left a row of neither between them every seventh or eighth line, and one
 * that crossed the surface's edge was cut a pixel differently from the
 * same rectangle moved: a scroll's copy and a repaint disagreed. Rounded
 * edges meet whoever they are shared with, and move with a whole-pixel
 * shift.
 */
export function rectsOnSurface(flat, width, height) {
  let out = null;
  for (let i = 0; i + 3 < flat.length; i += 4) {
    const x = flat[i];
    const y = flat[i + 1];
    const w = flat[i + 2];
    const h = flat[i + 3];
    const whole =
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      Number.isInteger(w) &&
      Number.isInteger(h);
    const inside = x >= 0 && y >= 0 && x + w <= width && y + h <= height;
    if (whole && inside) {
      if (out) out.push(x, y, w, h);
      continue;
    }
    if (!out) out = flat.slice(0, i);
    const x0 = Math.max(Math.round(x), 0);
    const y0 = Math.max(Math.round(y), 0);
    const x1 = Math.min(Math.round(x + w), width);
    const y1 = Math.min(Math.round(y + h), height);
    if (x1 > x0 && y1 > y0) out.push(x0, y0, x1 - x0, y1 - y0);
  }
  return out ?? flat;
}
