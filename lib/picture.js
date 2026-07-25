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

  setFilter(name, params) {
    this.Render.SetPictureFilter(this.id, name, params);
  }

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
