import Picture from './picture.js';
import Pixmap from './pixmap.js';

/**
 * An offscreen drawing surface: a pixmap, its Picture, and enough of the
 * `Image` shape that `ctx.drawImage` takes it as a source.
 *
 *   const surface = new Surface(app, { width: 20, height: 20 });
 *   surface.render((ctx) => icon.draw(ctx, 0, 0, 20, 20));
 *   ctx.drawImage(surface, x, y);            // one server-side composite
 *
 * The point is drawing something once and compositing it many times. An
 * `Image` already does that for decoded PNG/JPEG pixels uploaded from the
 * client; a Surface is the same contract for pixels drawn *by* the server,
 * so nothing crosses the wire but the composite.
 *
 * ### Coverage surfaces
 *
 * `format: 'a8'` makes a surface that stores coverage instead of colour.
 * Drawn through `drawImage` it acts as a mask for the current `fillStyle`,
 * so one rendered copy of a monochrome drawing serves every colour it is
 * ever asked for — the trick the glyph cache already runs on text, applied
 * to arbitrary drawings. See `SvgView.paintKind` for deciding when a drawing
 * qualifies.
 *
 * ### Lifetime
 *
 * `destroy()` frees the pixmap and the picture; both of those carry their own
 * finalizers, so a dropped surface still releases. `render()` builds a
 * context, hands it over, and
 * destroys it again, which keeps the steady-state cost of a surface to two
 * server objects — a context is much heavier than it looks, and holding one
 * per surface is what issue #156 is about.
 */
export class Surface {
  constructor(app, { width, height, format = 'argb32' } = {}) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error('Surface: width and height must be positive integers');
    }
    if (format !== 'argb32' && format !== 'a8') {
      throw new Error(`Surface: unknown format ${JSON.stringify(format)} (argb32 or a8)`);
    }
    this.app = app;
    this.width = width;
    this.height = height;
    this.format = format;
    this.depth = format === 'a8' ? 8 : 32;

    this.pixmap = new Pixmap(app, { depth: this.depth, width, height });
    this._picture = new Picture(app, {
      drawable: this.pixmap,
      format: format === 'a8' ? app.display.Render.a8 : app.display.Render.rgba32
    });
    // a fresh pixmap's contents are undefined per the protocol, so a surface
    // that is only partly drawn would otherwise composite server garbage
    this.clear();
  }

  /** bytes of server-side storage — what a cache budgets against */
  get bytes() {
    return this.width * this.height * (this.depth === 8 ? 1 : 4);
  }

  /** The server-side Picture, on the app this surface belongs to. Mirrors
   * `Image.picture(app)` so `drawImage` can take either without asking which
   * it has. */
  picture(app) {
    if (app && app !== this.app) {
      throw new Error('Surface: belongs to a different X connection');
    }
    return this._picture;
  }

  /** reset every pixel to fully transparent */
  clear() {
    const R = this.app.display.Render;
    R.FillRectangles(R.PictOp.Src, this._picture.id, [0, 0, 0, 0], [0, 0, this.width, this.height]);
    return this;
  }

  /**
   * Draw into the surface through a 2d context, in surface-local coordinates
   * where (0, 0) is its top-left corner.
   *
   * The context is created for the call and destroyed after it, so a surface
   * kept in a cache holds no context of its own. Callers doing many draws
   * into the same surface should `getContext('2d')` once and destroy it
   * themselves instead.
   */
  render(fn) {
    const ctx = this.getContext('2d');
    try {
      fn(ctx);
    } finally {
      ctx.destroy();
    }
    return this;
  }

  /** a rendering context on the backing pixmap — the caller owns it, and
   * owes it a `destroy()` */
  getContext(name, ...args) {
    return this.pixmap.getContext(name, ...args);
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._picture.destroy();
    this.pixmap.destroy();
  }

  [Symbol.dispose]() {
    this.destroy();
  }
}

export default Surface;
