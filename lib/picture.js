import { safeRelease } from './cleanup.js';

const registry = new FinalizationRegistry(({ Render, X, id }) => {
  safeRelease(X, () => {
    Render.FreePicture(id);
    X.ReleaseID(id);
  });
});

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
  }

  /**
   * Set the picture's filter — a *property of the picture*, not an operation
   * on its pixels. The server re-applies it every time the picture is
   * sampled, so the cost is per composite and forever, not once.
   *
   * That is what makes it right for resampling (`'bilinear'` under a
   * transform) and a trap for anything expensive: see `setBlurFilter`.
   */
  setFilter(name, params) {
    this.Render.SetPictureFilter(this.id, name, params);
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
