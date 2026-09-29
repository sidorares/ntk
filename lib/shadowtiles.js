// The blurred shadow of a rectangle, a rounded rectangle, or a rectangle
// with a rounded hole in it, drawn from a tile made once instead of blurred
// on every fill. No X connection in here: the plan and the pixels, which
// the 2d context composites (renderingcontext_2d.js) and react-x11's
// CoreGraphics and Direct2D contexts composite the same way. Exported as
// `ntk/shadow-tiles`.
//
// A gaussian over a shape costs its area times its width, and a shadowed
// fill paid it on every fill — on XQuartz's software RENDER, a header's
// `box-shadow: inset 0 0 100px` repainted by a scroll's exposed strip was
// the difference between 51 and 31 frames a second, and CoreGraphics spent
// 130 to 380 ms on one at 2x. None of it is a fact about where the shape
// is or how long its sides are: a rounded rectangle's shadow is the same
// all along its straight edges, so it is enough to make it once for a
// rectangle only just long enough to have a straight part, and to stretch
// that part to the length asked for.
//
// So a tile holds the shadow of a shape's *corners* — the shape shortened,
// on each axis that has room, to three pixels of straight edge — and is
// drawn as up to nine pieces: the corners as they are, the straight pixel
// between them stretched. Three rather than one because a filtered stretch
// reads a pixel either side of the one it stretches, and a piece's
// neighbours in the tile are straight edge too. The tile is named by the
// corners, the blur and whether there is a hole — never by where the shape
// is, how big it is past its corners, or what part of it a paint reaches —
// so every box in a document with the same shadow shares one, and a scroll
// that exposes a strip of one draws a strip of it.
//
// The pixels are made here, not by blurring on a server or a GPU: the
// shape's coverage, row by row, then a gaussian in two passes, at the
// canvas σ — half the blur (HTML, "shadows"; CSS Backgrounds 3, 7.1.1) —
// with no `maxSigma` cap, since a wide blur's cost here is bounded by the
// scale it is made at. A gaussian carries nothing finer than about σ/2, so
// past σ 8 the tile is made at a half, a quarter, … of the size and scaled
// up as it is drawn, as `blurCoverage` does: a 400-pixel blur's tile is a
// hundred kilobytes rather than twenty megabytes.

import { normalizeRadii } from './path.js';
import { gaussianKernel1d } from './shadowmath.js';

export { normalizeRadii };

/** The σ, in tile pixels, below which a tile is not made any smaller —
 *  the policy's `scaleSigma`: at 4 the scaled blur stays within a few
 *  levels of 8-bit alpha of the exact one. */
const MIN_TILE_SIGMA = 4;

/** How far a tile may be scaled down, whatever the blur. */
const MAX_TILE_SCALE = 16;

/**
 * The most pixels one tile may have. A shape that is all corner on both
 * axes — an ellipse spelled as a `roundRect` — has nothing to stretch, and
 * its tile is the size of the shape; past this it is not made, and the
 * shadow is drawn as it was before tiles.
 */
export const MAX_TILE_PIXELS = 1 << 20;

/** Sub-rows each tile row's coverage is sampled on; the blur smooths the
 *  rest. Along a row coverage is exact. */
const SUBROWS = 8;

/** How much smaller than the shape its tile is made, for a blur. */
export function tileScale(blur) {
  const sigma = blur / 2;
  let k = 1;
  while (k * 2 <= MAX_TILE_SCALE && sigma / (k * 2) >= MIN_TILE_SIGMA) k *= 2;
  return k;
}

/**
 * One axis of a tile: which of its pixels are drawn where. With room for a
 * straight part, three segments — the features before it, at scale; one
 * tile pixel of it, stretched; the features after it, at scale — and the
 * amount the tile's shape is shorter than the real one. Without, the whole
 * axis at scale.
 *
 * `lo`/`hi` are the outer shape's edges and `nearLo`/`nearHi` how far in
 * from each it stops being straight — the outer corners, and where there is
 * a hole its edge and corners — in whole device pixels; `reach` is how far
 * the blur spreads, a whole number of tile pixels of `k` device pixels.
 */
function planAxis(lo, hi, nearLo, nearHi, reach, k) {
  const origin = lo - reach;
  const flatFrom = lo + nearLo + reach;
  const flatTo = hi - nearHi - reach;
  if (flatTo - flatFrom >= 4 * k) {
    // the stretched pixel `at`, with a straight pixel either side of it
    const at = Math.ceil((flatFrom - origin) / k) + 1;
    const cut = flatTo - origin - (at + 2) * k;
    const size = Math.ceil((hi + reach - cut - origin) / k);
    return {
      origin,
      size,
      cut,
      segments: [
        [0, at, origin, origin + at * k],
        [at, at + 1, origin + at * k, origin + (at + 1) * k + cut],
        [at + 1, size, origin + (at + 1) * k + cut, origin + size * k + cut],
      ],
    };
  }
  const size = Math.ceil((hi - lo + 2 * reach) / k);
  return {
    origin,
    size,
    cut: 0,
    segments: [[0, size, origin, origin + size * k]],
  };
}

/** A number as part of a key, to the 256th of a pixel. */
const q = (v) => Math.round(v * 256) / 256;

/**
 * Where a shadow's tile comes from and how it is drawn, or null where it
 * would be too big to keep. `outer` and `inner` are
 * `{ x0, y0, x1, y1, corners }` in whole device pixels, `corners` the four
 * `{ x, y }` radii from top left, clockwise (`normalizeRadii`); `inner`,
 * when there is one, lies inside `outer`, and the shadow is the one the
 * frame between them casts — an inset box shadow's. The shadow's offset is
 * already in both, and `blur` is the canvas `shadowBlur`, in device pixels.
 *
 * `pieces` are `[sx, sy, sw, sh, dx, dy, dw, dh]` — tile pixels in, device
 * pixels out — and cover the shadow's whole reach once, except a frame's
 * middle, which lies inside the hole by more than the blur reaches and has
 * nothing in it. `key` names the tile's pixels: two plans with one key
 * draw from one tile.
 */
export function planShadowTiles(outer, inner, blur) {
  const k = tileScale(blur);
  const sigma = blur / 2 / k;
  const reachK = Math.ceil(3 * sigma);
  const reach = reachK * k;
  const oc = outer.corners;
  let nearL = Math.max(oc[0].x, oc[3].x);
  let nearR = Math.max(oc[1].x, oc[2].x);
  let nearT = Math.max(oc[0].y, oc[1].y);
  let nearB = Math.max(oc[3].y, oc[2].y);
  if (inner) {
    const ic = inner.corners;
    nearL = Math.max(nearL, inner.x0 - outer.x0 + Math.max(ic[0].x, ic[3].x));
    nearR = Math.max(nearR, outer.x1 - inner.x1 + Math.max(ic[1].x, ic[2].x));
    nearT = Math.max(nearT, inner.y0 - outer.y0 + Math.max(ic[0].y, ic[1].y));
    nearB = Math.max(nearB, outer.y1 - inner.y1 + Math.max(ic[3].y, ic[2].y));
  }
  const ax = planAxis(outer.x0, outer.x1, nearL, nearR, reach, k);
  const ay = planAxis(outer.y0, outer.y1, nearT, nearB, reach, k);
  if (ax.size * ay.size > MAX_TILE_PIXELS) return null;

  // the tile's own shape, in tile pixels: the real one shortened by the
  // cut on each stretched axis — every edge past the cut moves back by it
  const toTile = (r) => ({
    x0: (r.x0 - ax.origin) / k,
    y0: (r.y0 - ay.origin) / k,
    x1: (r.x1 - ax.cut - ax.origin) / k,
    y1: (r.y1 - ay.cut - ay.origin) / k,
    corners: r.corners.map((c) => ({ x: c.x / k, y: c.y / k })),
  });
  const shape = { outer: toTile(outer), inner: inner ? toTile(inner) : null };

  const middle = (axis, i) => axis.segments.length === 3 && i === 1;
  const pieces = [];
  ay.segments.forEach(([ty0, ty1, dy0, dy1], j) => {
    ax.segments.forEach(([tx0, tx1, dx0, dx1], i) => {
      if (inner && middle(ax, i) && middle(ay, j)) return;
      if (!(dx1 > dx0 && dy1 > dy0)) return;
      pieces.push([tx0, ty0, tx1 - tx0, ty1 - ty0, dx0, dy0, dx1 - dx0, dy1 - dy0]);
    });
  });

  const geometry = (r) =>
    r
      ? [r.x0, r.y0, r.x1, r.y1, ...r.corners.flatMap((c) => [c.x, c.y])].map(q).join(',')
      : '';
  return {
    key: `${blur}|${ax.size}x${ay.size}|${geometry(shape.outer)}|${geometry(shape.inner)}`,
    k,
    sigma,
    reach: reachK,
    width: ax.size,
    height: ay.size,
    shape,
    pieces,
    bounds: {
      x: ax.origin,
      y: ay.origin,
      width: ax.segments.at(-1)[3] - ax.origin,
      height: ay.segments.at(-1)[3] - ay.origin,
    },
  };
}

/** The x extent of a rounded rectangle along the line `y`, or null where
 *  the line misses it. A corner is rounded only with both radii. */
function spanAt(r, y) {
  if (!(y >= r.y0 && y < r.y1)) return null;
  const [tl, tr, br, bl] = r.corners;
  // how far a corner's ellipse reaches across, `d` above or below its
  // centre, as a fraction of its horizontal radius
  const across = (d, ry) => {
    const t = d / ry;
    return Math.sqrt(Math.max(0, 1 - t * t));
  };
  let left = r.x0;
  let right = r.x1;
  if (tl.x > 0 && tl.y > 0 && y < r.y0 + tl.y) {
    left = r.x0 + tl.x * (1 - across(r.y0 + tl.y - y, tl.y));
  } else if (bl.x > 0 && bl.y > 0 && y > r.y1 - bl.y) {
    left = r.x0 + bl.x * (1 - across(y - (r.y1 - bl.y), bl.y));
  }
  if (tr.x > 0 && tr.y > 0 && y < r.y0 + tr.y) {
    right = r.x1 - tr.x * (1 - across(r.y0 + tr.y - y, tr.y));
  } else if (br.x > 0 && br.y > 0 && y > r.y1 - br.y) {
    right = r.x1 - br.x * (1 - across(y - (r.y1 - br.y), br.y));
  }
  return right > left ? [left, right] : null;
}

/** Add `weight` times the coverage of the span `[a, b)` to a row. */
function addSpan(row, width, a, b, weight) {
  const from = Math.max(0, a);
  const to = Math.min(width, b);
  if (!(to > from)) return;
  const i0 = Math.floor(from);
  const i1 = Math.ceil(to) - 1;
  if (i0 === i1) {
    row[i0] += (to - from) * weight;
    return;
  }
  row[i0] += (i0 + 1 - from) * weight;
  for (let i = i0 + 1; i < i1; i++) row[i] += weight;
  row[i1] += (to - i1) * weight;
}

/**
 * The tile's coverage before the blur: how much of each tile pixel the
 * shape covers — the outer shape less the hole — 0..1, row-major.
 */
export function shadowCoverage(plan) {
  const { width, height, shape } = plan;
  const out = new Float32Array(width * height);
  const weight = 1 / SUBROWS;
  for (let y = 0; y < height; y++) {
    const row = out.subarray(y * width, (y + 1) * width);
    for (let s = 0; s < SUBROWS; s++) {
      const at = y + (s + 0.5) / SUBROWS;
      const span = spanAt(shape.outer, at);
      if (!span) continue;
      addSpan(row, width, span[0], span[1], weight);
      const hole = shape.inner && spanAt(shape.inner, at);
      if (hole) addSpan(row, width, hole[0], hole[1], -weight);
    }
  }
  return out;
}

/** A gaussian of the tile's σ over `values`, rows then columns, in place.
 *  Outside the tile is nothing, which its padding of `reach` makes true. */
function blurTile(values, width, height, sigma, reach) {
  const kernel = gaussianKernel1d(sigma, reach);
  const line = new Float32Array(Math.max(width, height));
  for (let y = 0; y < height; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) line[x] = values[base + x];
    for (let x = 0; x < width; x++) {
      let sum = 0;
      const from = Math.max(0, x - reach);
      const to = Math.min(width - 1, x + reach);
      for (let t = from; t <= to; t++) sum += line[t] * kernel[t - x + reach];
      values[base + x] = sum;
    }
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) line[y] = values[y * width + x];
    for (let y = 0; y < height; y++) {
      let sum = 0;
      const from = Math.max(0, y - reach);
      const to = Math.min(height - 1, y + reach);
      for (let t = from; t <= to; t++) sum += line[t] * kernel[t - y + reach];
      values[y * width + x] = sum;
    }
  }
}

/** The tile's blurred coverage, 0..1, row-major. */
export function shadowTileCoverage(plan) {
  const values = shadowCoverage(plan);
  blurTile(values, plan.width, plan.height, plan.sigma, plan.reach);
  return values;
}

/** The tile as an `a8` coverage surface stores it: one byte a pixel,
 *  rows unpadded. */
export function shadowTileAlpha(plan) {
  const values = shadowTileCoverage(plan);
  const out = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out[i] = v > 0 ? Math.round(Math.min(1, v) * 255) : 0;
  }
  return out;
}

/**
 * The tile in a colour, as straight RGBA — for a surface that has no
 * coverage format to composite through a colour. `rgba` is 0..1 each.
 */
export function rasterShadowTile(plan, rgba) {
  const values = shadowTileCoverage(plan);
  const [r, g, b, a] = rgba;
  const R = Math.round(r * 255);
  const G = Math.round(g * 255);
  const B = Math.round(b * 255);
  const out = new Uint8Array(values.length * 4);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!(v > 0)) continue;
    const o = i * 4;
    out[o] = R;
    out[o + 1] = G;
    out[o + 2] = B;
    out[o + 3] = Math.round(Math.min(1, v) * a * 255);
  }
  return out;
}
