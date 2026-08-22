import { safeRelease } from './cleanup.js';

const registry = new FinalizationRegistry(({ Render, X, id }) => {
  safeRelease(X, () => {
    Render.FreeGlyphSet(id);
    X.ReleaseID(id);
  });
});

export default class GlyphSet {
  constructor(app, format) {
    this._bind(app);
    this.Render.CreateGlyphSet(this.id, format || this.Render.a8);
    this._register();
  }

  /**
   * A new id for an existing glyphset — RENDER `ReferenceGlyphSet`. XIDs are
   * display-global, so `gsid` may name a set another connection created; the
   * server refcounts, and the underlying set stays alive as long as any
   * reference to it does — including across its creator's disconnect. That
   * is what a cross-process glyph cache stands on (docs/shared-glyphs.md).
   * `destroy()` drops only this alias.
   *
   * @param {App} app
   * @param {number} gsid existing glyphset XID, ours or another client's
   * @returns {GlyphSet}
   */
  static referenceTo(app, gsid) {
    const gs = Object.create(GlyphSet.prototype);
    gs._bind(app);
    gs.Render.ReferenceGlyphSet(gs.id, gsid);
    gs._register();
    return gs;
  }

  _bind(app) {
    this.X = app.X;
    this.display = app.display;
    this.Render = app.display.Render;
    this.id = this.X.AllocID();
  }

  _register() {
    this._owned = true;
    registry.register(this, { Render: this.Render, X: this.X, id: this.id }, this);
  }

  addGlyphs(glyphs) {
    if (glyphs.length === 0) return;
    this.Render.AddGlyphs(this.id, glyphs);
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
