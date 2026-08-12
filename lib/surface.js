import Picture from './picture.js';
import Pixmap from './pixmap.js';
import { safeRelease } from './cleanup.js';

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

  /**
   * Scroll the pixels of `src` (surface coordinates, `{x, y, width, height}`)
   * by (dx, dy) in place, server-side: one CopyArea of the band that
   * survives the shift, in place of the caller re-drawing everything that
   * merely moved. Returns true when the copy was issued; false means
   * "nothing survives the shift here", and the caller repaints `src` exactly
   * as it would have without this method — every refusal is the status quo.
   *
   * Refused when the delta is fractional (a sub-pixel shift changes every
   * pixel, so there is nothing to copy), when it is zero, when nothing of
   * `src` survives the shift after clamping to the surface, or on a
   * destroyed surface.
   *
   * This is `Window#scrollRegion` for a retained offscreen surface, minus
   * the damage bookkeeping a pixmap does not have: the caller draws the
   * exposed strip and composites as usual. The overlapping self-copy is
   * fully defined — pixmap contents cannot be occluded, and the server
   * fetches the source region before storing. The copy goes out with a
   * shared graphicsExposures: 0 GC — one per app and depth, created on
   * first use and released with the connection, where a default GC would
   * emit a NoExposure event per copy — and in-order with the caller's
   * follow-up drawing of the exposed strip on the same connection.
   */
  copyWithin(src, dx, dy) {
    if (this._destroyed) return false;
    if (!Number.isInteger(dx) || !Number.isInteger(dy) || (dx === 0 && dy === 0)) return false;
    const x0 = Math.max(0, Math.floor(src.x));
    const y0 = Math.max(0, Math.floor(src.y));
    const x1 = Math.min(this.width, Math.ceil(src.x + src.width));
    const y1 = Math.min(this.height, Math.ceil(src.y + src.height));
    // the band that survives: dest = clamped src ∩ (clamped src + delta)
    const dstX0 = Math.max(x0, x0 + dx);
    const dstY0 = Math.max(y0, y0 + dy);
    const dstX1 = Math.min(x1, x1 + dx);
    const dstY1 = Math.min(y1, y1 + dy);
    if (dstX1 <= dstX0 || dstY1 <= dstY0) return false;
    const X = this.app.X;
    // a GC is valid for any drawable of its depth on the screen, so one per
    // app and depth serves every surface — the upload-GC pattern in image.js
    const gcs = (this.app._surfaceCopyGC ??= {});
    safeRelease(X, () => {
      let gc = gcs[this.depth];
      if (!gc) {
        gc = gcs[this.depth] = X.AllocID();
        X.CreateGC(gc, this.pixmap.id, { graphicsExposures: 0 });
      }
      X.CopyArea(
        this.pixmap.id,
        this.pixmap.id,
        gc,
        dstX0 - dx,
        dstY0 - dy,
        dstX0,
        dstY0,
        dstX1 - dstX0,
        dstY1 - dstY0
      );
    });
    return true;
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
