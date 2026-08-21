import { safeRelease } from './cleanup.js';

export const REGION_DOCS = 'https://github.com/sidorares/ntk/blob/master/docs/context-2d.md#region-clips';

const registry = new FinalizationRegistry(({ fixes, X, id }) => {
  safeRelease(X, () => {
    fixes.DestroyRegion(id);
    X.ReleaseID(id);
  });
});

/**
 * One rectangle in the form XFIXES wants, from either spelling.
 *
 * ntk's own boxes are `{ x, y, w, h }` — that is what `_clipRect()` and the
 * damage rectangles a window reports look like — and the protocol's are
 * `{ x, y, width, height }`. Taking both means a region can be built out of
 * boxes ntk handed the caller without a translation step whose only job is
 * to rename two fields.
 */
function toRect(r) {
  const width = r.width ?? r.w;
  const height = r.height ?? r.h;
  if (!Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new TypeError(`ntk: region rectangle needs finite x/y/width/height, got ${JSON.stringify(r)}`);
  }
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(width), height: Math.round(height) };
}

const toRects = (rects) => (rects || []).map(toRect);

/**
 * The id of an XFIXES region, given a `Region`, a raw id, or anything else
 * carrying one (`{ id }`). Regions are ids on the wire, so a caller who made
 * one through node-x11 directly can still hand it to `ctx.clipRegion()`.
 */
export function regionId(value) {
  const id = typeof value === 'number' ? value : value?.id;
  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError(
      `ntk: expected an XFIXES region (app.createRegion(...)) or its id, got ${JSON.stringify(value)}`
    );
  }
  return id;
}

/**
 * A server-side XFIXES region: a set of rectangles the X server keeps and
 * combines for you, with no round trip per operation.
 *
 * Regions are how X describes a non-rectangular area — damage from an
 * expose, a window's SHAPE, the area a compositor has left to paint after
 * subtracting the windows in front. `ctx.clipRegion(region)` clips a 2d
 * context to one (docs/context-2d.md).
 *
 * Build one with `await app.createRegion(rects)`; the await is the XFIXES
 * extension being loaded on first use, not a round trip per region.
 * Everything after that is asynchronous in the X sense — requests go out and
 * nothing waits — except `fetch()`, which is a reply.
 */
export default class Region {
  /**
   * Not called directly: `app.createRegion(rects)` loads XFIXES first and is
   * the supported way in.
   *
   * @param {App} app
   * @param {object} fixes the XFIXES extension, as `app.fixes()` resolves it
   * @param {Array<object>} [rects] `{ x, y, width, height }` or `{ x, y, w, h }`
   */
  constructor(app, fixes, rects = []) {
    this.app = app;
    this.X = app.X;
    this.fixes = fixes;
    this.id = this.X.AllocID();
    this.fixes.CreateRegion(this.id, toRects(rects));
    this._owned = true;
    registry.register(this, { fixes, X: this.X, id: this.id }, this);
  }

  /** Replace the contents with this rectangle list. */
  set(rects) {
    this.fixes.SetRegion(this.id, toRects(rects));
    return this;
  }

  /** Replace the contents with another region's. */
  copyFrom(other) {
    this.fixes.CopyRegion(regionId(other), this.id);
    return this;
  }

  /** Move by (dx, dy). */
  translate(dx, dy) {
    this.fixes.TranslateRegion(this.id, Math.round(dx), Math.round(dy));
    return this;
  }

  /** Keep only what is also in `other`. In place. */
  intersect(other) {
    this.fixes.IntersectRegion(this.id, regionId(other), this.id);
    return this;
  }

  /** Add everything in `other`. In place. */
  union(other) {
    this.fixes.UnionRegion(this.id, regionId(other), this.id);
    return this;
  }

  /**
   * Remove everything in `other`. In place — and the operation a compositor
   * runs once per window, painting front to back and taking each window's
   * shape out of what is left for the ones behind it.
   */
  subtract(other) {
    this.fixes.SubtractRegion(this.id, regionId(other), this.id);
    return this;
  }

  /**
   * Read the region back: `{ extents, rectangles }`, each rectangle
   * `{ x, y, width, height }`. The one round trip in the class — regions are
   * meant to be combined server-side, so reach for this to inspect or to
   * test, not inside a paint loop.
   *
   * @returns {Promise<{extents: object, rectangles: Array<object>}>}
   */
  fetch() {
    return new Promise((resolve, reject) => {
      this.fixes.FetchRegion(this.id, (err, region) => (err ? reject(err) : resolve(region)));
    });
  }

  /** Free the region server-side. Idempotent. */
  destroy() {
    if (!this._owned) return;
    this._owned = false;
    registry.unregister(this);
    safeRelease(this.X, () => {
      this.fixes.DestroyRegion(this.id);
      this.X.ReleaseID(this.id);
    });
  }

  [Symbol.dispose]() {
    this.destroy();
  }
}
