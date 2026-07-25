import { safeRelease } from './cleanup.js';

const registry = new FinalizationRegistry(({ Render, X, id }) => {
  safeRelease(X, () => {
    Render.FreeGlyphSet(id);
    X.ReleaseID(id);
  });
});

export default class GlyphSet {
  constructor(app, format) {
    const X = app.X;
    this.X = X;
    this.display = app.display;
    this.Render = app.display.Render;
    this.id = X.AllocID();
    this.Render.CreateGlyphSet(this.id, format || this.Render.a8);
    this._glyphs = [];
    this._owned = true;
    registry.register(this, { Render: this.Render, X, id: this.id }, this);
  }

  addGlyphs(glyphs) {
    if (glyphs.length === 0) return;
    this.Render.AddGlyphs(this.id, glyphs);
    this._glyphs.push(...glyphs);
  }

  destroy() {
    if (!this._owned) return;
    this._owned = false;
    registry.unregister(this);
    safeRelease(this.X, () => {
      this.Render.FreeGlyphSet(this.id);
      this.X.ReleaseID(this.id);
    });
  }

  [Symbol.dispose]() {
    this.destroy();
  }
}
