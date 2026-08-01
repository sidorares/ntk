// Pure-JS coverage rasterization: outlines and polygons in, 8-bit alpha out.
//
// Two consumers, one algorithm:
//
//   rasterizePath()   glyph outlines -> a8 bitmap for XRender AddGlyphs
//   rasterizePolys()  device-space path/stroke geometry -> a8 coverage mask,
//                     uploaded by the 2d context instead of asking the server
//                     to rasterize trapezoids (see routeRaster below)
//
// The algorithm is signed-area accumulation, the one font-rs and
// stb_truetype v2 use. Each edge deposits the exact area it sweeps through
// every pixel row it crosses into a float accumulator; a prefix sum along the
// row turns those deltas into winding-weighted coverage. There is no
// supersampling and no per-scanline crossing sort — coverage is analytic, so
// the result is closer to a reference rasterizer than 4x4 supersampling was,
// at a fraction of the cost (~25 microseconds for a 20px icon against ~600).

/**
 * Antialiased coverage accumulator over a width x height pixel grid.
 *
 * Geometry is in y-down device space with the grid's top-left at (0, 0);
 * callers translate into that space through the `dx`/`dy` arguments. Add as
 * many polygons as the drawing needs, then read the result with `toAlpha`.
 */
export class CoverageAccumulator {
  /**
   * @param {number} width
   * @param {number} height
   */
  constructor(width, height) {
    this.width = width;
    this.height = height;
    // one column of slack: an edge that ends exactly on the right border
    // deposits its last fraction one cell past the last pixel
    this.stride = width + 2;
    this.acc = new Float32Array(this.stride * height);
  }

  /** forget accumulated coverage, keeping the buffer (reuse across draws) */
  reset() {
    this.acc.fill(0);
    return this;
  }

  /**
   * Accumulate one directed edge. Horizontal edges contribute nothing and
   * are skipped; everything else deposits `dy * direction` of signed area,
   * split across the pixels the edge passes through.
   */
  edge(ax, ay, bx, by) {
    if (ay === by) return;
    let dir = 1;
    let x0 = ax;
    let y0 = ay;
    let x1 = bx;
    let y1 = by;
    if (ay > by) {
      dir = -1;
      x0 = bx;
      y0 = by;
      x1 = ax;
      y1 = ay;
    }
    const { width, stride, acc, height } = this;
    const dxdy = (x1 - x0) / (y1 - y0);
    let x = x0;
    if (y0 < 0) {
      // enter the grid at row 0 rather than accumulating rows nobody reads
      x -= y0 * dxdy;
      y0 = 0;
    }
    const rowEnd = Math.min(height, Math.ceil(y1));
    for (let y = y0 | 0; y < rowEnd; ++y) {
      const line = y * stride;
      const dy = Math.min(y + 1, y1) - Math.max(y, y0);
      const xnext = x + dxdy * dy;
      const d = dy * dir;
      // the row's x span, clamped into the grid — geometry outside the
      // bitmap piles its coverage onto the border column, which is what a
      // clipped fill should look like
      let xa = x < xnext ? x : xnext;
      let xb = x < xnext ? xnext : x;
      if (xa < 0) xa = 0;
      else if (xa > width) xa = width;
      if (xb < 0) xb = 0;
      else if (xb > width) xb = width;

      const xaFloor = Math.floor(xa);
      const x0i = xaFloor | 0;
      const xbCeil = Math.ceil(xb);
      const x1i = xbCeil | 0;
      if (x1i <= x0i + 1) {
        // the whole span sits inside one pixel: split by the midpoint
        const xmf = 0.5 * (xa + xb) - xaFloor;
        acc[line + x0i] += d - d * xmf;
        acc[line + x0i + 1] += d * xmf;
      } else {
        // trapezoidal split across the pixels the span crosses
        const s = 1 / (xb - xa);
        const x0f = xa - xaFloor;
        const a0 = 0.5 * s * (1 - x0f) * (1 - x0f);
        const x1f = xb - xbCeil + 1;
        const am = 0.5 * s * x1f * x1f;
        acc[line + x0i] += d * a0;
        if (x1i === x0i + 2) {
          acc[line + x0i + 1] += d * (1 - a0 - am);
        } else {
          const a1 = s * (1.5 - x0f);
          acc[line + x0i + 1] += d * (a1 - a0);
          for (let xi = x0i + 2; xi < x1i - 1; ++xi) acc[line + xi] += d * s;
          const a2 = a1 + (x1i - x0i - 3) * s;
          acc[line + x1i - 1] += d * (1 - a2 - am);
        }
        acc[line + x1i] += d * am;
      }
      x = xnext;
    }
  }

  /**
   * Accumulate a closed polygon.
   * @param {ArrayLike<number>} pts flat [x0,y0,x1,y1,…]; the closing edge is implied
   * @param {number} [dx] translation applied to every x
   * @param {number} [dy] translation applied to every y
   */
  polygon(pts, dx = 0, dy = 0) {
    const n = pts.length;
    if (n < 6) return this;
    let px = pts[n - 2] + dx;
    let py = pts[n - 1] + dy;
    for (let i = 0; i < n; i += 2) {
      const x = pts[i] + dx;
      const y = pts[i + 1] + dy;
      this.edge(px, py, x, y);
      px = x;
      py = y;
    }
    return this;
  }

  /**
   * Accumulate a triangle soup as a *union*: every triangle is wound the same
   * way before it is added, so overlapping triangles reinforce rather than
   * cancel and the clamped non-zero result is their union. This is what a
   * stroke needs — extruded segments, caps and joins overlap constantly, and
   * accumulating them without normalization would punch holes at the seams.
   *
   * @param {ArrayLike<number>} tris flat x,y pairs, three points per triangle
   */
  triangles(tris, dx = 0, dy = 0) {
    for (let i = 0; i + 5 < tris.length; i += 6) {
      const ax = tris[i] + dx;
      const ay = tris[i + 1] + dy;
      let bx = tris[i + 2] + dx;
      let by = tris[i + 3] + dy;
      let cx = tris[i + 4] + dx;
      let cy = tris[i + 5] + dy;
      const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (area === 0) continue;
      if (area < 0) {
        const tx = bx;
        const ty = by;
        bx = cx;
        by = cy;
        cx = tx;
        cy = ty;
      }
      this.edge(ax, ay, bx, by);
      this.edge(bx, by, cx, cy);
      this.edge(cx, cy, ax, ay);
    }
    return this;
  }

  /**
   * Integrate the accumulator into 8-bit coverage.
   *
   * @param {Uint8Array|Buffer} [out] destination, `stride * height` bytes
   * @param {'nonzero'|'evenodd'} [rule] fill rule
   * @param {number} [stride] destination row stride (defaults to width; the
   *   X wire format wants rows padded to 4 bytes)
   */
  toAlpha(out, rule = 'nonzero', stride = this.width) {
    const { width, height, acc } = this;
    const dst = out ?? new Uint8Array(stride * height);
    const evenodd = rule === 'evenodd';
    for (let y = 0; y < height; ++y) {
      let sum = 0;
      const line = y * this.stride;
      const orow = y * stride;
      for (let x = 0; x < width; ++x) {
        sum += acc[line + x];
        let c = sum < 0 ? -sum : sum;
        if (evenodd) {
          // fold the winding number through a triangle wave: 0,1,2,3 ->
          // 0,1,0,1 with the fractional parts still antialiased
          c %= 2;
          if (c > 1) c = 2 - c;
        } else if (c > 1) {
          c = 1;
        }
        dst[orow + x] = (c * 255 + 0.5) | 0;
      }
    }
    return dst;
  }
}

/**
 * Rasterize closed polygons into an 8-bit coverage bitmap.
 *
 * @param {Array<ArrayLike<number>>} polys flat [x0,y0,…] polygons, device space
 * @param {number} width
 * @param {number} height
 * @param {'nonzero'|'evenodd'} [rule]
 * @param {object} [opts] { dx, dy, out, stride }
 * @returns {Uint8Array|Buffer} `width * height` bytes (or `stride * height`)
 */
export function rasterizePolys(polys, width, height, rule = 'nonzero', opts = {}) {
  const { dx = 0, dy = 0, out, stride = width } = opts;
  const acc = new CoverageAccumulator(width, height);
  for (const p of polys) acc.polygon(p, dx, dy);
  return acc.toAlpha(out, rule, stride);
}

/**
 * Rasterize a triangle soup into an 8-bit coverage bitmap, unioning overlaps
 * (see CoverageAccumulator#triangles).
 */
export function rasterizeTriangles(tris, width, height, opts = {}) {
  const { dx = 0, dy = 0, out, stride = width } = opts;
  const acc = new CoverageAccumulator(width, height);
  acc.triangles(tris, dx, dy);
  return acc.toAlpha(out, 'nonzero', stride);
}

/**
 * Glyph outlines -> a8 bitmap for XRender AddGlyphs.
 *
 * @param {Array} commands path commands ({type: M|L|Q|C|Z, x, y, x1, y1, x2, y2})
 *   in y-down pixel coordinates with the origin at the glyph baseline
 * @param {number} [_ss] ignored; kept so callers that used to ask for a
 *   supersampling factor keep working. Coverage is analytic now, so there is
 *   no quality/speed dial to turn.
 * @returns {{width, height, left, top, data: Buffer}|null}
 *   left/top are offsets of the bitmap's top-left corner relative to the
 *   glyph origin (left is typically small, top is typically negative —
 *   above the baseline). `width` is the row stride, padded to 4 bytes as the
 *   AddGlyphs wire format requires. Returns null for empty outlines.
 */
export function rasterizePath(commands, _ss) {
  const polys = flatten(commands);
  if (polys.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i += 2) {
      if (poly[i] < minX) minX = poly[i];
      if (poly[i] > maxX) maxX = poly[i];
      if (poly[i + 1] < minY) minY = poly[i + 1];
      if (poly[i + 1] > maxY) maxY = poly[i + 1];
    }
  }

  const left = Math.floor(minX);
  const top = Math.floor(minY);
  const width = Math.ceil(maxX) - left;
  const height = Math.ceil(maxY) - top;
  if (width <= 0 || height <= 0) return null;

  const stride = (width + 3) & ~3;
  const data = Buffer.alloc(stride * height);
  rasterizePolys(polys, width, height, 'nonzero', { dx: -left, dy: -top, out: data, stride });
  return { width: stride, height, left, top, data };
}

// flatten M/L/Q/C/Z commands into closed polygons [x0,y0, x1,y1, ...]
// (shared with the vector/trapezoid glyph path — see lib/trapezoid.js)
export function flatten(commands) {
  const polys = [];
  let cur = null;
  let x = 0;
  let y = 0;

  const finish = () => {
    if (cur && cur.length >= 6) polys.push(cur);
    cur = null;
  };

  for (const c of commands) {
    switch (c.type) {
      case 'M':
        finish();
        cur = [c.x, c.y];
        x = c.x;
        y = c.y;
        break;
      case 'L':
        cur.push(c.x, c.y);
        x = c.x;
        y = c.y;
        break;
      case 'Q': {
        const [x0, y0] = [x, y];
        const steps = curveSteps(x0, y0, c.x1, c.y1, c.x, c.y);
        for (let i = 1; i <= steps; ++i) {
          const t = i / steps;
          const mt = 1 - t;
          cur.push(
            mt * mt * x0 + 2 * mt * t * c.x1 + t * t * c.x,
            mt * mt * y0 + 2 * mt * t * c.y1 + t * t * c.y
          );
        }
        x = c.x;
        y = c.y;
        break;
      }
      case 'C': {
        const [x0, y0] = [x, y];
        const steps = curveSteps(x0, y0, c.x1, c.y1, c.x, c.y, c.x2, c.y2);
        for (let i = 1; i <= steps; ++i) {
          const t = i / steps;
          const mt = 1 - t;
          cur.push(
            mt * mt * mt * x0 + 3 * mt * mt * t * c.x1 + 3 * mt * t * t * c.x2 + t * t * t * c.x,
            mt * mt * mt * y0 + 3 * mt * mt * t * c.y1 + 3 * mt * t * t * c.y2 + t * t * t * c.y
          );
        }
        x = c.x;
        y = c.y;
        break;
      }
      case 'Z':
        finish();
        break;
    }
  }
  finish();
  return polys;
}

function curveSteps(...coords) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < coords.length; i += 2) {
    minX = Math.min(minX, coords[i]);
    maxX = Math.max(maxX, coords[i]);
    minY = Math.min(minY, coords[i + 1]);
    maxY = Math.max(maxY, coords[i + 1]);
  }
  const size = Math.max(maxX - minX, maxY - minY);
  return Math.min(24, Math.max(3, Math.ceil(size / 3)));
}

// ---------------------------------------------------------------------------
// the pluggable seam
//
// A Rasterizer answers one question — "give me the coverage of this geometry
// on a width x height grid" — and the 2d context uploads the answer as an a8
// mask. Everything downstream (globalAlpha, clip, composite op, gradient and
// solid sources) is unchanged, because what we hand the server is *coverage*,
// not colour.
//
// Rasterizer interface (duck-typed):
//
//   rasterize(job) -> Uint8Array | Buffer | null
//     `job` is { polys, triangles, width, height, rule, dx, dy }:
//     - exactly one of `polys` (closed polygons, filled by `rule`) and
//       `triangles` (a stroke's triangle soup, unioned regardless of rule)
//     - `dx`/`dy` must be *added to every coordinate*. Geometry arrives in
//       device space and the grid covers the drawing's bounding box, so the
//       offset is what maps one to the other. It is passed rather than
//       pre-applied because pre-applying means copying every point of every
//       path on every frame, which is the cost this whole route exists to
//       avoid.
//     Return `width * height` bytes of 8-bit coverage, row-major and
//     unpadded, or null to decline — declining routes the drawing back to
//     the server's trapezoid path, so a partial implementation is safe.
//     A rasterizer that only handles, say, non-zero fills can return null
//     for everything else and stay correct.

/** the in-repo rasterizer: CoverageAccumulator, no dependencies */
export class ScanlineRasterizer {
  rasterize({ polys, triangles, width, height, rule, dx = 0, dy = 0 }) {
    const acc = new CoverageAccumulator(width, height);
    if (triangles) acc.triangles(triangles, dx, dy);
    else for (const p of polys) acc.polygon(p, dx, dy);
    return acc.toAlpha(undefined, triangles ? 'nonzero' : rule);
  }
}

let _defaultRasterizer = null;

/** the process-wide default Rasterizer */
export function defaultRasterizer() {
  if (!_defaultRasterizer) _defaultRasterizer = new ScanlineRasterizer();
  return _defaultRasterizer;
}

/**
 * Replace the process-wide default Rasterizer. Affects every app created
 * afterwards without an explicit one. Pass null to send every drawing to the
 * server, which is the behaviour ntk had before local rasterization.
 */
export function setDefaultRasterizer(rasterizer) {
  _defaultRasterizer = rasterizer;
}

/**
 * When a drawing is cheaper to rasterize here and upload than to hand the
 * server as trapezoids.
 *
 * Coverage upload costs one byte per pixel of the bounding box and grows with
 * *area*; the trapezoid path costs per-request overhead plus 40 bytes per
 * trapezoid and grows with *geometric complexity*. So the threshold is a
 * ratio, not a size — measured against XQuartz with two shapes that bracket
 * the range (a rounded rectangle at 14-79 trapezoids, a stroked icon at
 * 181-1053), local rasterization wins whenever `area / edges` is under ~150
 * and loses above ~220, consistently for both.
 *
 * - `maxArea` — at or below this bounding-box area, always local. No shape
 *   measured lost here, so small drawings never pay for the check.
 * - `bytesPerEdge` — above that, local while `area <= bytesPerEdge * edges`.
 *   Edge count is free (we just flattened the path); trapezoid count would
 *   be a better predictor but costs a trapezoidize to learn.
 * - `maxBytes` — never upload more coverage than this in one go.
 */
export const DEFAULT_RASTER_POLICY = {
  maxArea: 64 * 64,
  bytesPerEdge: 150,
  maxBytes: 1 << 20
};

/**
 * @returns {'local'|'server'} where a drawing of this size and complexity
 *   should be rasterized
 */
export function routeRaster(width, height, edges, policy = DEFAULT_RASTER_POLICY) {
  const area = width * height;
  if (area <= 0 || area > policy.maxBytes) return 'server';
  if (area <= policy.maxArea) return 'local';
  return area <= policy.bytesPerEdge * edges ? 'local' : 'server';
}
