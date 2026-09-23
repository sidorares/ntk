// The arithmetic of a drop shadow — the policy, the gaussian a `shadowBlur`
// asks for, how far it reaches and the scale it is blurred at — with no
// surface and no X connection in it (shadow.js has those).
//
// Its own module so that a renderer drawing shadows some other way can size
// them the way this package does without loading the X11 client that the
// surfaces need: react-x11's Cocoa, Windows and Wayland backends ask how far
// a box shadow reaches here, and nothing else of ntk's. Exported as
// `ntk/shadow-math`; shadow.js re-exports every name, so nothing that
// imported them from there or from the package root changes.

/**
 * Shadow policy — the cost ceilings, per app via `app.shadowPolicy`
 * (partial objects are merged over the defaults). See docs/context-2d.md.
 *
 * - `cacheBytes` — LRU budget for retained shadow coverage per connection.
 *   Keyed by (text, font, blur) for text; least-recently-drawn surfaces are
 *   destroyed server-side once the total goes over.
 * - `maxSigma` — the widest gaussian actually run. The kernel is 6σ+1 wide,
 *   the request carries every tap, and the server multiplies each of them
 *   per pixel per pass, so an unbounded `shadowBlur` is an unbounded
 *   request and an unbounded stall. Past this the blur stops widening.
 * - `maxPixels` — the largest coverage surface built for one shadow. Beyond
 *   it the shadow is dropped rather than turning one drawing into a
 *   multi-megabyte allocation; the drawing itself is unaffected.
 * - `scaleSigma` — the σ a reduced-scale blur is not allowed to fall below.
 *   A gaussian carries no detail finer than about σ/2 px, so a wide one does
 *   not need full resolution to resolve it: past twice this, coverage is
 *   shrunk by the largest power of two that keeps σ/scale at or above it,
 *   blurred there, and resolved back — `scale` off the kernel and `scale²`
 *   off the area, which is where a first paint's time goes (issue #338).
 *   What the shrink costs is set by that reduced σ and not by the ratio: 4
 *   holds the difference from an exact blur inside three levels of 8-bit
 *   alpha, where 3 is worth four levels and 2 is worth seven.
 * - `maxScale` — how far the shrink may go whatever the floor allows, so a
 *   `maxSigma`-wide blur cannot resample its way down to a thumbnail.
 *   `maxScale: 1` blurs everything at full resolution, which is what 8.6
 *   did, and is the setting for a caller that needs the exact kernel.
 */
export const DEFAULT_SHADOW_POLICY = {
  cacheBytes: 4 << 20,
  maxSigma: 32,
  maxPixels: 8 << 20,
  scaleSigma: 4,
  maxScale: 4
};

/** the policy for one app, merged over the defaults */
export function shadowPolicyOf(app) {
  return app?.shadowPolicy
    ? { ...DEFAULT_SHADOW_POLICY, ...app.shadowPolicy }
    : DEFAULT_SHADOW_POLICY;
}

/**
 * The gaussian a `shadowBlur` asks for.
 *
 * `shadowBlur` is a **diameter**, not a radius: the canvas spec says a
 * shadow is blurred by a gaussian whose standard deviation is half of it.
 * Getting this wrong is invisible until someone compares against a browser,
 * so it is one line with a test on it — `shadowBlur: 8` must be σ = 4 here
 * exactly as it is in Chrome and Firefox.
 *
 * Clamped to the policy's `maxSigma`, which is the only place a shadow
 * silently stops matching a browser; the cap is chosen so that no shadow a
 * UI actually draws reaches it.
 */
export function shadowSigma(blur, policy = DEFAULT_SHADOW_POLICY) {
  const sigma = blur / 2;
  return sigma > policy.maxSigma ? policy.maxSigma : sigma;
}

/**
 * How far the blur spreads coverage, in pixels — the kernel's half-width,
 * and therefore the padding every coverage surface needs on each side.
 *
 * Truncating a gaussian at 3σ leaves 0.3% of its weight outside, which is
 * below one step of the 8-bit coverage it is convolving.
 */
export function shadowReach(sigma) {
  return sigma > 0 ? Math.ceil(sigma * 3) : 0;
}

/**
 * A normalized 1d gaussian, `2 * reach + 1` taps wide.
 *
 * Normalizing the *truncated* kernel rather than the ideal one is what keeps
 * a flat interior at full coverage: a shadow under an opaque box must stay
 * opaque in the middle, and a kernel summing to 0.997 would leave it at 254.
 */
export function gaussianKernel1d(sigma, reach = shadowReach(sigma)) {
  const values = new Array(reach * 2 + 1);
  let sum = 0;
  for (let i = -reach; i <= reach; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    values[i + reach] = v;
    sum += v;
  }
  for (let i = 0; i < values.length; i++) values[i] /= sum;
  return values;
}

/**
 * The scale a blur of this sigma is run at: 1, 2 or 4 by default, meaning
 * "shrink the coverage by this much, blur at `sigma / scale`, resolve back".
 *
 * A gaussian is a low-pass filter — it carries nothing finer than about σ/2
 * px — so resolving a wide one at full resolution spends most of its time on
 * detail the result cannot hold. Shrinking first takes `scale` off the
 * kernel and `scale²` off the area it runs over: at σ 21 over 552×396, k = 4
 * turns 55.5M multiply-accumulates into 0.9M, which on a software-RENDER
 * server (XQuartz) is most of a first paint (issue #338).
 *
 * The scale is a power of two so that each shrink is an exact 2×2 average,
 * and it is capped both by `maxScale` and by the σ floor `scaleSigma`, which
 * is what keeps the reduced blur wide enough to still be a gaussian — the
 * difference from an exact blur is set by that reduced σ, and stays inside
 * three levels of 8-bit alpha at the 4 the policy defaults to. σ under
 * `2 * scaleSigma` gets 1: below that the two resampling composites cost
 * more than the kernel they save.
 *
 * Exported for a caller that draws its own shapes and can therefore skip the
 * shrink entirely: draw the shape into a surface `1 / scale` the size (its
 * padding scaled with it), blur at `sigma / scale`, and composite through a
 * `1 / scale` picture transform. See docs/surface.md#baking-a-blur.
 */
export function blurScale(sigma, policy = DEFAULT_SHADOW_POLICY) {
  const floor = policy.scaleSigma ?? DEFAULT_SHADOW_POLICY.scaleSigma;
  const max = policy.maxScale ?? DEFAULT_SHADOW_POLICY.maxScale;
  if (!(sigma > 0) || !(floor > 0) || !(max > 1)) return 1;
  let scale = 1;
  while (scale * 2 <= max && sigma / (scale * 2) >= floor) scale *= 2;
  return scale;
}
