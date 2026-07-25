// Minimal pure-JS scanline rasterizer for glyph outlines.
//
// Takes path commands in y-down pixel coordinates with the origin at the
// glyph baseline (produced by Font.rasterize from fontkit outlines) and
// produces an antialiased 8-bit alpha bitmap suitable for XRender
// AddGlyphs. Non-zero winding rule, 4x4 supersampling.

const SS = 4; // supersampling factor per axis

/**
 * @param {Array} commands path commands ({type: M|L|Q|C|Z, x, y, x1, y1, x2, y2})
 * @returns {{width, height, left, top, data: Buffer}|null}
 *   left/top are offsets of the bitmap's top-left corner relative to the
 *   glyph origin (left is typically small, top is typically negative —
 *   above the baseline). Returns null for empty outlines (e.g. space).
 */
export function rasterizePath(commands) {
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

  // pad rows to 4 bytes as required by the AddGlyphs wire format
  const stride = (width + 3) & ~3;
  const coverage = new Uint16Array(stride * height);

  // closed edges in supersampled bitmap space
  const edges = [];
  for (const poly of polys) {
    const n = poly.length / 2;
    for (let i = 0; i < n; ++i) {
      const j = (i + 1) % n;
      const x0 = (poly[i * 2] - left) * SS;
      const y0 = (poly[i * 2 + 1] - top) * SS;
      const x1 = (poly[j * 2] - left) * SS;
      const y1 = (poly[j * 2 + 1] - top) * SS;
      if (y0 !== y1) edges.push([x0, y0, x1, y1]);
    }
  }

  const crossings = [];
  for (let row = 0; row < height * SS; ++row) {
    const y = row + 0.5;
    crossings.length = 0;
    for (const [x0, y0, x1, y1] of edges) {
      if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
        const x = x0 + ((y - y0) * (x1 - x0)) / (y1 - y0);
        crossings.push([x, y1 > y0 ? 1 : -1]);
      }
    }
    crossings.sort((a, b) => a[0] - b[0]);

    let winding = 0;
    let spanStart = 0;
    const py = (row / SS) | 0;
    for (const [x, dir] of crossings) {
      if (winding === 0) spanStart = x;
      winding += dir;
      if (winding === 0) {
        // fill supersample cells whose centers are inside [spanStart, x)
        const from = Math.max(0, Math.ceil(spanStart - 0.5));
        const to = Math.min(width * SS - 1, Math.floor(x - 0.5));
        for (let cell = from; cell <= to; ++cell) {
          coverage[py * stride + ((cell / SS) | 0)]++;
        }
      }
    }
  }

  const data = Buffer.alloc(stride * height);
  const full = SS * SS;
  for (let i = 0; i < coverage.length; ++i) {
    const c = coverage[i];
    data[i] = c >= full ? 255 : ((c * 255) / full) | 0;
  }

  return { width: stride, height, left, top, data };
}

// flatten M/L/Q/C/Z commands into closed polygons [x0,y0, x1,y1, ...]
function flatten(commands) {
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
