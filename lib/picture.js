import { safeRelease } from './cleanup.js';

const registry = new FinalizationRegistry(({ Render, X, id }) => {
  safeRelease(X, () => {
    Render.FreePicture(id);
    X.ReleaseID(id);
  });
});

/** RENDER's identity transform, row-major as `SetPictureTransform` takes it. */
export const IDENTITY_TRANSFORM = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const NO_PARAMS = Object.freeze([]);

/**
 * The picture an `Image` or a `Surface` keeps for ntk's own draws, without
 * putting it back as stored (`picture(app)` does that): `drawImage` reads it
 * through and leaves its state for the next draw to set
 * (docs/context-2d.md#how-an-image-is-read).
 */
export const OWN_PICTURE = Symbol('ntk.ownPicture');

export default class Picture {
  constructor(app, args = {}) {
    const X = app.X;
    this.X = X;
    this.Render = app.display.Render;
    this.display = app.display;

    if (typeof args.id === 'undefined') {
      this.id = X.AllocID();
      this.format = args.format || this.Render.rgb24;
      this.Render.CreatePicture(this.id, args.drawable.id, this.format, args);
    } else {
      this.id = args.id;
    }
    this._owned = true;
    registry.register(this, { Render: this.Render, X, id: this.id }, this);
    // How the server reads the picture — its transform, filter and repeat —
    // as last set through the methods below, so a draw that needs what is
    // there already sends nothing. Flipping them is not free: a filter
    // changed and changed back around every composite cost Xwayland's glamor
    // 36 ms over 256 composites where the composites took 0.6, and a
    // transform put back to identity after each cost pixman 7.
    this._transform = IDENTITY_TRANSFORM;
    this._filter = 'nearest';
    this._filterParams = NO_PARAMS;
    this._repeat = args.repeat ?? 0;
    // Whether what the picture is read through now is what a draw left
    // (`_readThrough`) rather than what was set on it: the one `_settle`
    // puts back. A filter hung on a surface to be drawn through stays.
    this._leftByDraw = false;
  }

  /**
   * Set the picture's filter — a *property of the picture*, not an operation
   * on its pixels. The server re-applies it every time the picture is
   * sampled, so the cost is per composite and forever, not once.
   *
   * That is what makes it right for resampling (`'bilinear'` under a
   * transform) and a trap for anything expensive: see `setBlurFilter`.
   *
   * Nothing is sent when the picture has this filter already.
   */
  setFilter(name, params = NO_PARAMS) {
    this._leftByDraw = false;
    if (name === this._filter && sameNumbers(params, this._filterParams)) return;
    this.Render.SetPictureFilter(this.id, name, params);
    this._filter = name;
    this._filterParams = params.length ? params.slice() : NO_PARAMS;
  }

  /**
   * Set the transform the picture is read through: nine numbers, row-major,
   * taking a destination point to the source point read for it, as RENDER's
   * `SetPictureTransform` has them. Nothing is sent when it is the one the
   * picture has.
   */
  setTransform(m) {
    this._leftByDraw = false;
    if (sameNumbers(m, this._transform)) return;
    this.Render.SetPictureTransform(this.id, m);
    this._transform = sameNumbers(m, IDENTITY_TRANSFORM) ? IDENTITY_TRANSFORM : m.slice();
  }

  /** Set how the picture is read past its edge — RENDER's `repeat`: 0 none,
   * 1 normal, 2 pad, 3 reflect. Nothing is sent when it is so already. */
  setRepeat(repeat) {
    this._leftByDraw = false;
    if (repeat === this._repeat) return;
    this.Render.ChangePicture(this.id, { repeat });
    this._repeat = repeat;
  }

  /**
   * Read as stored: no transform, the `nearest` filter and no repeat — how a
   * composite takes the pixels themselves. What a picture is left as by a
   * draw that read it some other way is put back here, and only what differs
   * is sent.
   */
  plain() {
    this.setTransform(IDENTITY_TRANSFORM);
    this.setFilter('nearest');
    this.setRepeat(0);
    return this;
  }

  /** A draw reading the picture through these, and leaving them for the
   * next draw to set (docs/context-2d.md#how-an-image-is-read). */
  _readThrough(transform, filter, repeat) {
    this.setTransform(transform);
    this.setFilter(filter);
    this.setRepeat(repeat);
    this._leftByDraw = true;
  }

  /** Put back what a draw left, and nothing that was set on the picture:
   * what `Image.picture(app)` and `Surface.picture(app)` hand out, and what a
   * draw that reads the pixels as they are reads. */
  _settle() {
    if (this._leftByDraw) this.plain();
    return this;
  }

  /**
   * Hang a k×k gaussian `convolution` on the picture.
   *
   * **This re-convolves on every composite** — it is a filter, so the server
   * runs the whole kernel each time the picture is drawn, and the pixels
   * never change on the client's side of the wire. A picture blurred once and
   * then composited each frame pays k² multiply-accumulates per pixel per
   * frame: at radius 61 over 489×134 that is 244M per draw, which is a 1.6s
   * hover on XQuartz and a 9s window repaint (issue #335).
   *
   * Reach for it when the blur really is per-draw and small. To blur
   * something *once* and composite the result cheaply afterwards — a drop
   * shadow, a cached soft edge — bake it instead with `blurCoverage` from
   * ntk's entry point: two separable 1d passes (2k multiplies per pixel, not
   * k²), run once, leaving a surface with the blur in its pixels and no
   * filter of its own. See docs/surface.md#baking-a-blur.
   */
  setBlurFilter(radius, sigma) {
    if (radius === 0) {
      return this.setFilter('convolution', [1, 1, 1]);
    }
    if (!sigma) sigma = radius / 2;
    if (radius % 2 === 0) radius++;
    const params = [radius, radius, ...gaussianKernel(radius, sigma)];
    this.setFilter('convolution', params);
  }

  destroy() {
    if (!this._owned) return;
    this._owned = false;
    registry.unregister(this);
    safeRelease(this.X, () => {
      this.Render.FreePicture(this.id);
      this.X.ReleaseID(this.id);
    });
  }

  /**
   * Stop tracking without sending FreePicture. Used when the server already
   * destroyed the picture implicitly — pictures on a *window* are freed by
   * the server when the window is destroyed (RENDER spec); a later explicit
   * FreePicture would raise BadPicture. Pixmap-backed pictures don't need
   * this (pixmap storage is refcounted).
   */
  forget() {
    if (!this._owned) return;
    this._owned = false;
    registry.unregister(this);
    safeRelease(this.X, () => this.X.ReleaseID(this.id));
  }

  [Symbol.dispose]() {
    this.destroy();
  }
}

function sameNumbers(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// normalized 2d gaussian, row-major size x size
function gaussianKernel(size, sigma) {
  const kernel = new Array(size * size);
  const center = (size - 1) / 2;
  let sum = 0;
  for (let y = 0; y < size; ++y) {
    for (let x = 0; x < size; ++x) {
      const v = Math.exp(-((x - center) ** 2 + (y - center) ** 2) / (2 * sigma * sigma));
      kernel[y * size + x] = v;
      sum += v;
    }
  }
  return kernel.map((v) => v / sum);
}
