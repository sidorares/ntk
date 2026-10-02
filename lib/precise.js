// RENDER's Precise rasterization, done here: the a8 coverage an X server
// draws for a Triangles or AddTraps request, computed on this side of the
// wire from the same numbers.
//
// A mask is rasterized either here or by the server (routeRaster in
// rasterize.js). The analytic ScanlineRasterizer and the server's point
// sampling come out a few levels apart at every edge, so whenever the same
// pixels were drawn by different routes in different passes — a stroke cut
// to the runs inside a clip against the whole of it, a stroke drawn straight
// to the destination against the same stroke through the mask — a partial
// repaint and a full one disagreed (issue #462). With this as the local
// rasterizer they cannot: both routes are one function of the wire geometry,
// and the route is a question of cost alone.
//
// RENDER's default poly-mode is Precise, and the protocol defines it
// (renderproto, "Polygon Rasterization"): for an 8-bit alpha, a regular grid
// 17 samples wide and 15 high, centred in the pixel; each trapezoid or
// triangle is Add-combined into the mask. 17 × 15 = 255, so a pixel's alpha
// is its count of covered samples. pixman implements it, and pixman is what
// rasterizes Triangles, Trapezoids and AddTraps in fb (Xvfb, XQuartz) and in
// glamor (Xorg's modesetting driver, Xwayland). This is a port of pixman's
// code — pixman_edge_init and _step, pixman_sample_ceil_y and _floor_y,
// rasterize_edges_8, triangle_to_trapezoids — down to its rounding. pixman
// sits up to one 16.16 unit off the spec's sample positions, and its edge
// step leaves the error term alone when a step carries nothing; matching it
// is matching the servers, so both are kept. Measured byte-identical against
// XQuartz on 300 random drawings, 24.5 M pixels.
//
// One liberty, which changes no byte: pixman adds each trapezoid into the
// mask a sample row at a time with a saturating add. Every count it adds is
// non-negative, so the saturating sum is the plain sum clamped once. Each
// sample row's span goes into a difference array instead — four cells,
// however wide the span — and each pixel row is integrated and clamped at
// the end.
//
// The input is the wire's integers. `fixed16` is what a coordinate becomes
// in a request, and the 2d context sends coordinates already on that grid
// (`snapFixed16`), so that the conversion node-x11 applies has nothing left
// to round.

import { trapezoidize } from './trapezoid.js';

// the sample grid for an 8-bit alpha, as pixman-private.h derives it
const STEP_Y_SMALL = 4369; // 65536 / 15
const STEP_Y_BIG = 4370; // 65536 - 14 * STEP_Y_SMALL
const Y_FRAC_FIRST = 2185; // STEP_Y_BIG / 2
const Y_FRAC_LAST = 63351; // Y_FRAC_FIRST + 14 * STEP_Y_SMALL
const STEP_X_SMALL = 3855; // 65536 / 17
const X_FRAC_FIRST = 1928; // (65536 - 16 * STEP_X_SMALL) / 2
const N_X_FRAC = 17;

/**
 * A coordinate as the 16.16 fixed-point int32 a request carries: truncated
 * toward zero, as node-x11 converts. Every coordinate the 2d context sends
 * is in reach of the int32 (lib/cliprect.js's WIRE_REACH).
 */
export function fixed16(v) {
  return Math.trunc(v * 65536) | 0;
}

/**
 * The nearest coordinate toward zero that 16.16 holds exactly. Sending this
 * rather than `v` makes the request's integer `fixed16(v)` however the
 * client library converts — node-x11's `parseInt(v * 65536)` reads a tiny
 * product's exponent notation, so 4e-11 became 4 where it should be 0.
 */
export function snapFixed16(v) {
  return Math.trunc(v * 65536) / 65536;
}

// C's integer division, which truncates toward zero, exact for |a| < 2^53.
// A float quotient can land on the wrong side of an integer, so the
// remainder settles it.
function idiv(a, b) {
  let q = Math.trunc(a / b);
  const r = a - q * b;
  if (a >= 0) {
    if (r < 0) q--;
    else if (r >= b) q++;
  } else if (r > 0) q++;
  else if (r <= -b) q--;
  return q;
}

// pixman's DIV: division rounding toward -infinity, for b > 0
function floorDiv(a, b) {
  return a < 0 ? idiv(a - b + 1, b) : idiv(a, b);
}

/** pixman_sample_ceil_y: the first sample row at or below y */
function sampleCeilY(y) {
  let f = y & 0xffff;
  let i = y - f;
  f = floorDiv(f - Y_FRAC_FIRST + (STEP_Y_SMALL - 1), STEP_Y_SMALL) * STEP_Y_SMALL + Y_FRAC_FIRST;
  if (f > Y_FRAC_LAST) {
    if (i >> 16 === 0x7fff) {
      f = 0xffff;
    } else {
      f = Y_FRAC_FIRST;
      i += 65536;
    }
  }
  return (i | f) | 0;
}

/** pixman_sample_floor_y: the last sample row strictly above y */
function sampleFloorY(y) {
  let f = y & 0xffff;
  let i = y - f;
  f = floorDiv(f - 1 - Y_FRAC_FIRST, STEP_Y_SMALL) * STEP_Y_SMALL + Y_FRAC_FIRST;
  if (f < Y_FRAC_FIRST) {
    if (i >> 16 === -32768) {
      f = 0;
    } else {
      f = Y_FRAC_LAST;
      i -= 65536;
    }
  }
  return (i | f) | 0;
}

// pixman_edge_t, as eight int32 fields
const X = 0;
const E = 1;
const DY = 2;
const SIGNDX = 3;
const STEPX_SMALL = 4;
const DX_SMALL = 5;
const STEPX_BIG = 6;
const DX_BIG = 7;
const left = new Int32Array(8);
const right = new Int32Array(8);

/**
 * pixman_edge_init followed by its pixman_edge_step to `yStart`: the edge
 * from (xTop, yTop) down to (xBot, yBot), placed on its first sample row.
 */
function edgeInit(edge, yStart, xTop, yTop, xBot, yBot) {
  const dx = (xBot - xTop) | 0;
  const dy = (yBot - yTop) | 0;
  let x = xTop;
  let e = 0;
  let stepx = 0;
  let signdx = 0;
  let rem = 0;
  if (dy) {
    // Plain float divisions truncate exactly here. A quotient of integers
    // whose dividend is below 2^45 sits at least 1/dy from any integer it
    // is not, and a double holds it to within (dividend / dy) · 2^-52, far
    // closer than that. The step from the line's top below, whose dividend
    // can pass 2^53, keeps idiv.
    if (dx >= 0) {
      signdx = 1;
      stepx = Math.trunc(dx / dy);
      rem = dx - stepx * dy;
      e = -dy;
    } else {
      signdx = -1;
      stepx = -Math.trunc(-dx / dy);
      rem = -dx + stepx * dy;
    }
    // _pixman_edge_multi_init for the small and the big step; n is at most
    // 4370, so every product here is exact in a double
    let ne = STEP_Y_SMALL * rem;
    let sx = (STEP_Y_SMALL * stepx) | 0;
    if (ne > 0) {
      const nx = Math.trunc(ne / dy);
      ne -= nx * dy;
      sx = (sx + nx * signdx) | 0;
    }
    edge[STEPX_SMALL] = sx;
    edge[DX_SMALL] = ne;
    ne = STEP_Y_BIG * rem;
    sx = (STEP_Y_BIG * stepx) | 0;
    if (ne > 0) {
      const nx = Math.trunc(ne / dy);
      ne -= nx * dy;
      sx = (sx + nx * signdx) | 0;
    }
    edge[STEPX_BIG] = sx;
    edge[DX_BIG] = ne;
  }

  // pixman_edge_step(e, yStart - yTop). Its products are 64-bit in C and
  // pass 2^53 for a tall edge entering the grid far below its top, so past
  // that they are done in BigInt.
  const n = (yStart - yTop) | 0;
  const step = n * stepx;
  x = Number.isSafeInteger(step)
    ? (x + step) | 0
    : Number(BigInt.asIntN(32, BigInt(x) + BigInt(n) * BigInt(stepx)));
  const carry = n * rem;
  if (Number.isSafeInteger(carry) && Number.isSafeInteger(e + carry + dy)) {
    const ne = e + carry;
    if (n >= 0) {
      if (ne > 0) {
        const nx = idiv(ne + dy - 1, dy) | 0;
        e = (ne - nx * dy) | 0;
        x = (x + nx * signdx) | 0;
      }
    } else if (ne <= -dy) {
      const nx = idiv(-ne, dy) | 0;
      e = (ne + nx * dy) | 0;
      x = (x - nx * signdx) | 0;
    }
  } else {
    const ne = BigInt(e) + BigInt(n) * BigInt(rem);
    const bdy = BigInt(dy);
    if (n >= 0) {
      if (ne > 0n) {
        const nx = BigInt.asIntN(32, (ne + bdy - 1n) / bdy);
        e = Number(BigInt.asIntN(32, ne - nx * bdy));
        x = (x + Number(nx) * signdx) | 0;
      }
    } else if (ne <= -bdy) {
      const nx = BigInt.asIntN(32, -ne / bdy);
      e = Number(BigInt.asIntN(32, ne + nx * bdy));
      x = (x - Number(nx) * signdx) | 0;
    }
  }
  edge[X] = x;
  edge[E] = e;
  edge[DY] = dy;
  edge[SIGNDX] = signdx;
}

// RENDER_SAMPLES_X for every fraction of a pixel: how many of a pixel's 17
// sample columns lie left of an edge that crosses it there
const SAMPLES_X = new Uint8Array(65536);
for (let f = 0; f < 65536; f++) SAMPLES_X[f] = ((f + X_FRAC_FIRST) / STEP_X_SMALL) | 0;

/**
 * rasterize_edges_8 between `left` and `right`, from sample row `t` to `b`
 * inclusive, into the difference array `acc` (rows `stride` apart).
 *
 * A span adds 17 - ls to the pixel it starts in, 17 to each pixel after, rs
 * to the pixel it ends in and nothing past it: the difference of two steps,
 * each two cells of `acc`. While an edge stays in one pixel from sample row
 * to sample row, as a steep one does for all fifteen, its two cells are
 * summed here and written once.
 */
function addSpans(acc, stride, width, t, b) {
  let y = t;
  let row = (y >> 16) * stride;
  let lx = left[X];
  let le = left[E];
  const ldy = left[DY];
  const lsign = left[SIGNDX];
  const lsxs = left[STEPX_SMALL];
  const ldxs = left[DX_SMALL];
  const lsxb = left[STEPX_BIG];
  const ldxb = left[DX_BIG];
  let rx = right[X];
  let re = right[E];
  const rdy = right[DY];
  const rsign = right[SIGNDX];
  const rsxs = right[STEPX_SMALL];
  const rdxs = right[DX_SMALL];
  const rsxb = right[STEPX_BIG];
  const rdxb = right[DX_BIG];
  // pixman clips the span to the image: from 0, and to the last pixel of
  // the row taken whole. Both are what an unclipped span would add there.
  const lastX = (width << 16) - 1;
  // each edge's step not yet written: the pixel it is in (-1 for none), and
  // what it adds to that cell and to the next
  let lPixel = -1;
  let lAt = 0;
  let lPast = 0;
  let rPixel = -1;
  let rAt = 0;
  let rPast = 0;
  // an edge's step carries one more unit of x when its error term passes
  // zero: computed, not branched on, since a slope's carries come in no
  // pattern a branch predictor can learn
  let c = 0;
  for (;;) {
    const l = lx < 0 ? 0 : lx;
    const r = rx >> 16 >= width ? lastX : rx;
    if (r > l) {
      const li = l >> 16;
      const ls = SAMPLES_X[l & 0xffff];
      if (li !== lPixel) {
        if (lPixel >= 0) {
          acc[row + lPixel] += lAt;
          acc[row + lPixel + 1] += lPast;
        }
        lPixel = li;
        lAt = 0;
        lPast = 0;
      }
      lAt += N_X_FRAC - ls;
      lPast += ls;
      const ri = r >> 16;
      const rs = SAMPLES_X[r & 0xffff];
      if (ri !== rPixel) {
        if (rPixel >= 0) {
          acc[row + rPixel] -= rAt;
          acc[row + rPixel + 1] -= rPast;
        }
        rPixel = ri;
        rAt = 0;
        rPast = 0;
      }
      rAt += N_X_FRAC - rs;
      rPast += rs;
    }
    if (y === b) break;
    if ((y & 0xffff) !== Y_FRAC_LAST) {
      le = (le + ldxs) | 0;
      c = -le >>> 31;
      le = (le - c * ldy) | 0;
      lx = (lx + lsxs + c * lsign) | 0;
      re = (re + rdxs) | 0;
      c = -re >>> 31;
      re = (re - c * rdy) | 0;
      rx = (rx + rsxs + c * rsign) | 0;
      y = (y + STEP_Y_SMALL) | 0;
    } else {
      le = (le + ldxb) | 0;
      c = -le >>> 31;
      le = (le - c * ldy) | 0;
      lx = (lx + lsxb + c * lsign) | 0;
      re = (re + rdxb) | 0;
      c = -re >>> 31;
      re = (re - c * rdy) | 0;
      rx = (rx + rsxb + c * rsign) | 0;
      y = (y + STEP_Y_BIG) | 0;
      // the pixel row is done: write what it left pending
      if (lPixel >= 0) {
        acc[row + lPixel] += lAt;
        acc[row + lPixel + 1] += lPast;
        lPixel = -1;
      }
      if (rPixel >= 0) {
        acc[row + rPixel] -= rAt;
        acc[row + rPixel + 1] -= rPast;
        rPixel = -1;
      }
      row += stride;
    }
  }
  if (lPixel >= 0) {
    acc[row + lPixel] += lAt;
    acc[row + lPixel + 1] += lPast;
  }
  if (rPixel >= 0) {
    acc[row + rPixel] -= rAt;
    acc[row + rPixel + 1] -= rPast;
  }
}

/** the first sample row of a band from `top`, inside the grid */
function firstRow(top) {
  return sampleCeilY(top < 0 ? 0 : top);
}

/** the last sample row of a band to `bottom`, inside a grid `height` high */
function lastRow(bottom, height) {
  return sampleFloorY(bottom >> 16 >= height ? (height << 16) - 1 : bottom);
}

/**
 * pixman_rasterize_trapezoid: a pixman_trapezoid_t — top and bottom, each
 * side a line through two points — already offset into the grid
 */
function addTrapezoid(acc, stride, width, height, top, bottom, l1x, l1y, l2x, l2y, r1x, r1y, r2x, r2y) {
  if (l1y === l2y || r1y === r2y || !(bottom > top)) return;
  const t = firstRow(top);
  const b = lastRow(bottom, height);
  if (b < t) return;
  if (l1y <= l2y) edgeInit(left, t, l1x, l1y, l2x, l2y);
  else edgeInit(left, t, l2x, l2y, l1x, l1y);
  if (r1y <= r2y) edgeInit(right, t, r1x, r1y, r2x, r2y);
  else edgeInit(right, t, r2x, r2y, r1x, r1y);
  addSpans(acc, stride, width, t, b);
}

// whether b is clockwise of a about ref in y-down space, as pixman asks it
function clockwise(refX, refY, ax, ay, bx, by) {
  const adx = ax - refX;
  const ady = ay - refY;
  const bdx = bx - refX;
  const bdy = by - refY;
  const p = bdy * adx;
  const q = ady * bdx;
  if (Number.isSafeInteger(p) && Number.isSafeInteger(q)) return p - q < 0;
  return BigInt(bdy) * BigInt(adx) - BigInt(ady) * BigInt(bdx) < 0n;
}

/**
 * Add a Triangles request's triangles — float device coordinates, six per
 * triangle — to the grid, each split into two trapezoids as
 * triangle_to_trapezoids does.
 */
function addTriangles(acc, stride, width, height, tris, dx, dy) {
  const xo = dx * 65536;
  const yo = dy * 65536;
  for (let i = 0; i + 5 < tris.length; i += 6) {
    let tx = (fixed16(tris[i]) + xo) | 0;
    let ty = (fixed16(tris[i + 1]) + yo) | 0;
    let lx = (fixed16(tris[i + 2]) + xo) | 0;
    let ly = (fixed16(tris[i + 3]) + yo) | 0;
    let rx = (fixed16(tris[i + 4]) + xo) | 0;
    let ry = (fixed16(tris[i + 5]) + yo) | 0;
    let s;
    // the topmost point first, ties to the left; then left before right
    if (ty === ly ? tx > lx : ty > ly) {
      s = lx; lx = tx; tx = s;
      s = ly; ly = ty; ty = s;
    }
    if (ty === ry ? tx > rx : ty > ry) {
      s = rx; rx = tx; tx = s;
      s = ry; ry = ty; ty = s;
    }
    if (clockwise(tx, ty, rx, ry, lx, ly)) {
      s = rx; rx = lx; lx = s;
      s = ry; ry = ly; ly = s;
    }
    // down from the top to the higher of the other two, then on to the
    // lower, with the side that turned there continuing along the third edge
    const mid = ry < ly ? ry : ly;
    addTrapezoid(acc, stride, width, height, ty, mid, tx, ty, lx, ly, tx, ty, rx, ry);
    if (ry < ly) addTrapezoid(acc, stride, width, height, ry, ly, tx, ty, lx, ly, rx, ry, lx, ly);
    else addTrapezoid(acc, stride, width, height, ly, ry, lx, ly, rx, ry, tx, ty, rx, ry);
  }
}

/**
 * Add an AddTraps request's trapezoids — float device coordinates, six per
 * trapezoid: top left, right, y, then bottom left, right, y — to the grid,
 * as pixman_add_traps does.
 */
function addTraps(acc, stride, width, height, traps, dx, dy) {
  const xo = dx * 65536;
  const yo = dy * 65536;
  for (let i = 0; i + 5 < traps.length; i += 6) {
    const topY = (fixed16(traps[i + 2]) + yo) | 0;
    const botY = (fixed16(traps[i + 5]) + yo) | 0;
    const t = firstRow(topY);
    const b = lastRow(botY, height);
    if (b < t) continue;
    const tl = (fixed16(traps[i]) + xo) | 0;
    const tr = (fixed16(traps[i + 1]) + xo) | 0;
    const bl = (fixed16(traps[i + 3]) + xo) | 0;
    const br = (fixed16(traps[i + 4]) + xo) | 0;
    edgeInit(left, t, tl, topY, bl, botY);
    edgeInit(right, t, tr, topY, br, botY);
    addSpans(acc, stride, width, t, b);
  }
}

/**
 * Each row's running sum, clamped: the saturating adds, all at once. The
 * cells are zeroed as they are read, so the accumulator is ready for the
 * next mask without a pass of its own.
 */
function integrate(acc, stride, width, height) {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    const from = y * stride;
    const to = y * width;
    for (let x = 0; x < width; x++) {
      sum += acc[from + x];
      acc[from + x] = 0;
      out[to + x] = sum > 255 ? 255 : sum;
    }
    // the slack cells past the row, which a span ending at its last pixel
    // writes and nothing reads
    acc[from + width] = 0;
    acc[from + width + 1] = 0;
  }
  return out;
}

// One accumulator for every mask, grown to the largest asked for: masks are
// rasterized one at a time, and allocating a fresh one each time was a
// tenth of the cost of a wall of small icons, in the garbage collector.
let scratch = new Int32Array(0);

function accumulator(cells) {
  if (scratch.length < cells) scratch = new Int32Array(Math.max(cells, scratch.length * 2));
  return scratch;
}

/**
 * A Rasterizer (docs/context-2d.md) whose masks are the ones the X server
 * draws from the same geometry: `triangles` exactly as the 2d context sends
 * them with Triangles, `polys` trapezoidized exactly as it sends them with
 * AddTraps. A drawing gets the same bytes whichever side rasterizes it.
 *
 * `dx`/`dy` are whole pixels, which is all the 2d context passes; anything
 * else is declined, and goes to the server.
 */
export class PreciseRasterizer {
  rasterize({ polys, triangles, width, height, rule, dx = 0, dy = 0 }) {
    if (!Number.isInteger(dx) || !Number.isInteger(dy)) return null;
    // one cell of slack: a span ending in the last column clears the cell
    // past it
    const stride = width + 2;
    const acc = accumulator(stride * height);
    if (triangles) addTriangles(acc, stride, width, height, triangles, dx, dy);
    else addTraps(acc, stride, width, height, trapezoidize(polys, 0, 0, [], rule), dx, dy);
    return integrate(acc, stride, width, height);
  }
}
