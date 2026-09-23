// Drop shadows for the 2d context (issue #272): the blur, the surfaces it
// runs on, and the cache that keeps a redrawn shadow from being rebuilt.
//
// The drawing itself lives in renderingcontext_2d.js — everything here is
// the part with no X connection in it (the kernel maths) or the part every
// shadowed operation shares (the coverage surfaces and their budget).
//
// ## How a shadow is drawn
//
// A shadow is the drawing's *coverage*, blurred, offset, and painted in one
// colour. Coverage is what an `a8` Surface holds and what XRender composites
// a solid through, so the whole thing is three server-side steps:
//
//   1. draw the shape into a padded a8 surface — white on transparent, so
//      every pixel is its own alpha
//   2. blur it: two convolution passes, horizontal then vertical
//   3. composite the result as a mask, with `shadowColor` as the source
//
// The padding in (1) is not optional. A convolution samples outside the
// picture, where RepeatNone reads transparent, so a shape drawn flush to the
// surface edge ends in a straight line where the kernel ran out of pixels.
// `reach` is how far coverage can spread, and every surface carries it on
// all four sides.
//
// ## Why two passes
//
// A gaussian is separable, and that is the difference between a shadow you
// can animate and one you cannot: a k-wide 2d kernel costs k² multiplies per
// pixel where two 1d passes cost 2k. At `shadowBlur: 30` that is 8281 against
// 182. RENDER has no separable-convolution filter, but it does not need one —
// two `convolution` filters and two composites are the same thing, and the
// second pass leaves a surface with the blur already in its pixels, so the
// cached copy composites as a plain mask rather than re-running a kernel on
// every frame.
//
// ## Why a wide one runs small
//
// Two passes still cost `2 * taps * w * h`, and both grow with sigma: the
// ten shadows on react-x11's configurator come to 118M multiply-accumulates,
// which is 596ms of a first paint on software RENDER, and 73% of it is two
// wide ones (issue #338). A gaussian carries no detail finer than about σ/2
// px, so that work is spent resolving what the result cannot hold — past
// σ 8 the coverage is shrunk by 2 or 4 first, blurred at `sigma / scale`,
// and resolved back, which is `scale` off the kernel and `scale²` off the
// area for a difference of three levels of 8-bit alpha at worst.
// `blurScale` picks it, `scaleSigma` / `maxScale` bound it, and the surface
// that comes back is the size it always was, still with no filter on it.
//
// ## What of this is public
//
// The bake and the maths around it — `blurCoverage`, `blurScale`,
// `shadowSigma`, `shadowReach`, `gaussianKernel1d` and
// `DEFAULT_SHADOW_POLICY` — are re-exported from `lib/index.js` (issues
// #335 and #338). A toolkit that draws its own shapes (react-x11 paints a
// `<box>`'s `boxShadow` itself, because the rounded rect is a path it
// already has and the result goes through its own paint cache) needs exactly
// this and nothing else: the alternative on the public surface,
// `picture().setBlurFilter()`, sets a k×k filter that the server re-runs on
// *every* composite, which is invisible until someone profiles a real
// display. The surfaces and the cache below stay private —
// they are the 2d context's bookkeeping, not a primitive.
import { Surface } from './surface.js';

import {
  DEFAULT_SHADOW_POLICY,
  blurScale,
  gaussianKernel1d,
  shadowPolicyOf,
  shadowReach,
  shadowSigma
} from './shadowmath.js';

// the arithmetic lives in shadowmath.js, which carries no surface; these
// were defined here, and every name stays importable from here
export {
  DEFAULT_SHADOW_POLICY,
  blurScale,
  gaussianKernel1d,
  shadowPolicyOf,
  shadowReach,
  shadowSigma
};

/**
 * The smallest a shrunk coverage surface is allowed to get on either side.
 *
 * Nothing a shadow builds comes near it — a blur wide enough to be scaled at
 * all pads by 24px a side — but `blurCoverage` takes any a8 surface, and a
 * hand-built sliver shrunk to a couple of pixels would come back as a smear
 * rather than a blur.
 */
const MIN_SCALED_SIDE = 16;

/** the scale `blurCoverage` will actually use: the policy's (or the
 * caller's), snapped down to a power of two and to what the surface can be
 * shrunk to without losing its shape */
function resolveScale(shape, sigma, requested) {
  const wanted =
    requested === undefined ? blurScale(sigma, shadowPolicyOf(shape.app)) : requested;
  let scale = 2 ** Math.floor(Math.log2(wanted));
  const side = Math.min(shape.width, shape.height);
  while (scale > 1 && side / scale < MIN_SCALED_SIDE) scale /= 2;
  return scale;
}

/**
 * Shrink coverage by exactly 2, server-side, destroying the input.
 *
 * The transform maps a destination pixel centre to `2 * (i + 0.5)` in the
 * source, which lands the bilinear sample exactly between two texels in each
 * axis: the 2×2 box average, with no weight of the original left out. Which
 * is why the scale is a power of two — one bilinear tap of a 4× shrink would
 * sample every fourth texel and simply not see the pixels in between.
 */
function halveCoverage(surface, R) {
  const width = Math.max(1, Math.ceil(surface.width / 2));
  const height = Math.max(1, Math.ceil(surface.height / 2));
  const small = new Surface(surface.app, { width, height, format: 'a8' });
  const picture = surface.picture();
  picture.setFilter('bilinear');
  R.SetPictureTransform(picture.id, [2, 0, 0, 0, 2, 0, 0, 0, 1]);
  R.Composite(R.PictOp.Src, picture.id, 0, small.picture().id, 0, 0, 0, 0, 0, 0, width, height);
  surface.destroy();
  return small;
}

/**
 * Resolve shrunk coverage back to `width` × `height`, destroying the input.
 *
 * Bilinear again, and this is where the error of the whole scheme lives: the
 * blurred coverage is reconstructed linearly between samples `scale` px
 * apart, and what a straight line misses between two samples of a gaussian
 * goes as the curvature there — `1 / σ'²`, in the reduced surface's own
 * sigma. So the bound is a property of the σ the blur ran at, which is what
 * `scaleSigma` pins: three alpha levels at σ' 4, seven at σ' 2 (measured
 * against Xorg; a server whose bilinear rounds less is a level better).
 *
 * It happens once, into an ordinary surface: what comes back carries no
 * filter and no transform, so every composite of it afterwards is a plain
 * mask, exactly as it was before the shrink existed.
 */
function expandCoverage(small, width, height, scale, R) {
  const out = new Surface(small.app, { width, height, format: 'a8' });
  const picture = small.picture();
  picture.setFilter('bilinear');
  R.SetPictureTransform(picture.id, [1 / scale, 0, 0, 0, 1 / scale, 0, 0, 0, 1]);
  R.Composite(R.PictOp.Src, picture.id, 0, out.picture().id, 0, 0, 0, 0, 0, 0, width, height);
  small.destroy();
  return out;
}

/** the two separable passes themselves, at whatever scale they are run —
 * `shape` in, blurred copy out, input destroyed */
function bakeBlur(shape, sigma, R) {
  const { app, width, height } = shape;
  const kernel = gaussianKernel1d(sigma);
  const scratch = new Surface(app, { width, height, format: 'a8' });
  const out = new Surface(app, { width, height, format: 'a8' });

  const pass = (src, dst, params) => {
    src.picture().setFilter('convolution', params);
    // Src, not Over: each pass replaces the destination, which was cleared
    // to transparent on creation. Over would accumulate the sharp copy's
    // coverage under the blurred one and give the shadow a hard core.
    R.Composite(R.PictOp.Src, src.picture().id, 0, dst.picture().id, 0, 0, 0, 0, 0, 0, width, height);
  };
  pass(shape, scratch, [kernel.length, 1, ...kernel]);
  pass(scratch, out, [1, kernel.length, ...kernel]);

  shape.destroy();
  scratch.destroy();
  return out;
}

/**
 * Blur an a8 coverage surface, returning a new one holding the result.
 *
 * The input is destroyed: a caller has no use for the sharp copy afterwards,
 * and leaving it alive would double what the cache is holding. The output
 * carries no filter of its own, so compositing it is an ordinary masked
 * composite no matter how wide the blur was.
 *
 * Public, and the reason is that half of it: a *filter* is re-applied by the
 * server on every composite, so a caller who blurs a picture with
 * `setBlurFilter` and then caches it re-runs the kernel per frame — 244M
 * multiply-accumulates for one 489×134 shadow at σ 10 (issue #335). This
 * bakes instead. `shape` must be a coverage surface with the blur's reach as
 * padding on all four sides, or the result ends in a straight line where the
 * kernel ran out of pixels; see docs/surface.md.
 *
 * A wide blur does not run at full resolution. Past σ 8 the coverage is
 * shrunk by a power of two, blurred at `sigma / scale` and resolved back —
 * `scale³` off the work, for a difference of at most three levels of 8-bit
 * alpha (issue #338). `scale` overrides that: `{ scale: 1 }` is the exact
 * path 8.6 took, and a larger one is snapped down to a power of two. Which
 * scale the policy picks is `blurScale(sigma)`; the size of what comes back
 * never changes with it.
 */
export function blurCoverage(shape, sigma, { scale } = {}) {
  if (!(sigma > 0) || !Number.isFinite(sigma)) {
    throw new Error(
      `blurCoverage: sigma must be a finite number above 0, got ${sigma}. ` +
        'A canvas blur radius is a diameter, not a sigma — pass ' +
        'shadowSigma(blur), which halves it and applies the policy cap. ' +
        'σ = 0 is no blur at all: composite the coverage as it is.'
    );
  }
  if (shape.format !== 'a8') {
    throw new Error(
      `blurCoverage: needs a coverage surface, got format ${JSON.stringify(shape.format)}. ` +
        "Draw the shape into new Surface(app, { width, height, format: 'a8' }) — " +
        'the blur runs on alpha, so an argb32 surface would lose its colour.'
    );
  }
  if (scale !== undefined && (!Number.isFinite(scale) || scale < 1)) {
    throw new Error(
      `blurCoverage: scale must be a finite number of 1 or more, got ${scale}. ` +
        'It is how much the coverage is shrunk before the blur runs on it, ' +
        'so 1 is "blur at full resolution"; anything else is snapped down to ' +
        'a power of two. Leave it out to take the scale from the app\'s ' +
        'shadowPolicy (scaleSigma / maxScale).'
    );
  }
  const R = shape.app.display.Render;
  const { width, height } = shape;
  const k = resolveScale(shape, sigma, scale);
  if (k === 1) return bakeBlur(shape, sigma, R);

  let small = shape;
  for (let step = k; step > 1; step /= 2) small = halveCoverage(small, R);
  return expandCoverage(bakeBlur(small, sigma / k, R), width, height, k, R);
}

/**
 * A shadow's coverage, from the cache when it has been seen before.
 *
 * `build()` returns the finished (blurred) surface, or null when there is
 * nothing to draw. A null `key` means "not cacheable" — the geometry has no
 * short name, as a path's does not — and the caller owns the surface it gets
 * back. With a key, the cache owns it and the caller must not destroy it.
 *
 * Cached on the app rather than the context because contexts are short-lived
 * (`Surface.render` builds one per call) while a shadow is a property of the
 * drawing, which outlives them — the same reason `solidPicture` and the
 * glyph pages live there.
 */
export function cachedShadow(app, key, build) {
  if (key === null) return build();
  const cache = (app._shadowSurfaces ??= new Map());
  const hit = cache.get(key);
  if (hit) {
    // Map iteration order is insertion order — re-insert to mark recent
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const surface = build();
  if (!surface) return null;
  cache.set(key, surface);
  trimShadowSurfaces(app, shadowPolicyOf(app), surface);
  return surface;
}

/**
 * Evict least-recently-drawn shadow coverage until the cache fits its
 * budget. `keep` is never evicted: it is the surface the caller is about to
 * composite, and a budget smaller than one shadow must not free it mid-draw.
 */
export function trimShadowSurfaces(app, policy = shadowPolicyOf(app), keep = null) {
  const cache = app._shadowSurfaces;
  if (!cache) return;
  let total = 0;
  for (const surface of cache.values()) total += surface.bytes;
  for (const [key, surface] of cache) {
    if (total <= policy.cacheBytes) break;
    if (surface === keep) continue;
    cache.delete(key);
    total -= surface.bytes;
    surface.destroy();
  }
}

/** free every cached shadow surface — connection teardown */
export function dropShadowSurfaces(app) {
  const cache = app._shadowSurfaces;
  if (!cache) return;
  for (const surface of cache.values()) surface.destroy();
  cache.clear();
}
