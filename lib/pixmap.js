import { safeRelease } from './cleanup.js';
import Drawable from './drawable.js';

// GC fallback: free the server-side pixmap when the wrapper is collected
// without an explicit destroy()
const registry = new FinalizationRegistry(({ X, id, releaseId }) => {
  safeRelease(X, () => {
    X.FreePixmap(id);
    if (releaseId) X.ReleaseID(id);
  });
});

/**
 * A GetGeometry reply in ntk's spelling (window.js has the window-shaped
 * twin). For a pixmap, `x`, `y` and `borderWidth` are always 0 — X reports
 * them anyway, and returning the same shape as `wnd.getGeometry()` keeps the
 * two interchangeable.
 */
function unpackGeometry(res) {
  return {
    x: res.xPos,
    y: res.yPos,
    width: res.width,
    height: res.height,
    depth: res.depth,
    borderWidth: res.borderWidth,
    root: res.windowid
  };
}

/**
 * Whether this connection's allocator handed out `id`. Owning an adopted
 * pixmap does not always mean the id was ours: XCompositeNameWindowPixmap
 * names a pixmap into an id the adopter allocated itself, but a pixmap made
 * by another client carries an id from that client's range. Only an id of
 * ours may go back into the pool on destroy — releasing a foreign one would
 * eventually make AllocID hand out an id the server refuses as not ours.
 */
function ownAllocation(display, id) {
  return ((id & ~display.resource_mask) >>> 0) === (display.resource_base >>> 0);
}

export default class Pixmap extends Drawable {
  constructor(app, args = {}) {
    super();
    this.app = app;
    const X = app.X;
    this.X = X;
    this.display = app.display;

    // A pixmap has no visual of its own — X gives it a depth and nothing
    // else. What its pixels mean is decided by whoever put them there, so a
    // pixmap holding a window's content (a backing store, a compositor's
    // NameWindowPixmap) is told which visual that was: it is what names the
    // picture format the pixels can be read through (issue #295). Left 0,
    // the format is picked from the depth as before.
    this.visualId = args.visual ?? 0;

    // `pixmap.ready` (see the getter): resolved as soon as this wrapper
    // knows its geometry — at the end of the constructor for a pixmap ntk
    // created or one adopted with its geometry declared, when GetGeometry
    // replies for one adopted by bare id
    this._readyPromiseResolve = null;
    this._readyPromise = new Promise((resolve) => {
      this._readyPromiseResolve = resolve;
    });
    this._adoptError = null;

    if (!args.id) {
      const parentId = args.parent ? args.parent.id : app.display.screen[0].root;
      this.depth = args.depth || 24;
      this.id = X.AllocID();
      X.CreatePixmap(this.id, parentId, this.depth, args.width, args.height);
      this.width = args.width;
      this.height = args.height;
      this._owned = true;
      this._releaseId = true;
      registry.register(this, { X, id: this.id, releaseId: true }, this);
      this._readyPromiseResolve(this);
    } else {
      this.id = args.id;
      // Nothing is defaulted for an adopted pixmap: what the caller declared
      // is recorded, and what they did not is asked of the server rather
      // than guessed — a depth invented here would pick the picture format
      // everything drawing on it reads the pixels through (issue #291).
      this.width = args.width;
      this.height = args.height;
      this.depth = args.depth;
      this._owned = !!args.own;
      this._releaseId = this._owned && ownAllocation(this.display, this.id);
      if (this._owned) {
        registry.register(this, { X, id: this.id, releaseId: this._releaseId }, this);
      }
      if (this.width !== undefined && this.height !== undefined && this.depth !== undefined) {
        this._readyPromiseResolve(this);
      } else {
        X.GetGeometry(this.id, (err, res) => {
          // A pixmap freed between the id reaching us and this request
          // reaching the server answers BadDrawable, and there is nothing to
          // record. `ready` still resolves — a wait that never ends is worse
          // than one that ends with `width` undefined — and `Pixmap.adopt`
          // is the form that turns this into a rejection.
          if (err) this._adoptError = err;
          else this._applyGeometry(unpackGeometry(res));
          this._readyPromiseResolve(this);
        });
      }
    }
  }

  /**
   * Adopt an existing pixmap id: ask the server for its geometry and depth,
   * and take responsibility for freeing it. This is the compositor's case —
   * XCompositeNameWindowPixmap hands back a pixmap the adopting client must
   * FreePixmap, and must re-adopt on every resize of the named window — but
   * any handover of a pixmap id works the same way.
   *
   * Rejects if the pixmap does not exist (already freed — for a compositor,
   * re-name the window and adopt the fresh id). Pass `own: false` to observe
   * a pixmap that stays another client's to free, `visual` to name the
   * visual its pixels are laid out in (see the constructor), and any of
   * `width`/`height`/`depth` already known — with all three declared no
   * round trip is made.
   */
  static async adopt(app, id, { own = true, ...args } = {}) {
    const pixmap = new Pixmap(app, { ...args, id, own });
    await pixmap.ready;
    if (pixmap._adoptError) {
      // there is nothing server-side to own, so the GC fallback must not
      // send a FreePixmap of its own to fail the same way
      pixmap._owned = false;
      registry.unregister(pixmap);
      throw new Error(
        `Pixmap.adopt: pixmap 0x${id.toString(16)} does not exist — it was freed ` +
          'between its id being obtained and this request. A compositor sees this ' +
          'when the named window was resized or destroyed: name it again and adopt ' +
          'the fresh id.',
        { cause: pixmap._adoptError }
      );
    }
    return pixmap;
  }

  /**
   * Resolves with this pixmap once its geometry and depth are known —
   * immediately for a pixmap ntk created or one adopted with `width`,
   * `height` and `depth` all declared, when the GetGeometry sent by the
   * constructor replies for one adopted by bare id. Never rejects: a pixmap
   * that was already gone resolves with `width` still `undefined`.
   */
  get ready() {
    return this._readyPromise;
  }

  /**
   * Ask the server about this pixmap now — `{ x, y, width, height, depth,
   * borderWidth, root }`, the same shape `wnd.getGeometry()` resolves with
   * (`x`, `y` and `borderWidth` are 0 for a pixmap). The reply is written
   * back to `width`/`height`/`depth`, and resolves `ready` if it was still
   * pending.
   */
  getGeometry() {
    return new Promise((resolve, reject) => {
      this.X.GetGeometry(this.id, (err, res) => {
        if (err) return reject(err);
        const geometry = unpackGeometry(res);
        this._applyGeometry(geometry);
        resolve(geometry);
      });
    });
  }

  /** Record a GetGeometry reply, and let anything waiting on it go. */
  _applyGeometry({ width, height, depth }) {
    this.width = width;
    this.height = height;
    this.depth = depth;
    this._readyPromiseResolve(this);
  }

  destroy() {
    if (!this._owned) return;
    this._owned = false;
    registry.unregister(this);
    safeRelease(this.X, () => {
      this.X.FreePixmap(this.id);
      if (this._releaseId) this.X.ReleaseID(this.id);
    });
  }

  [Symbol.dispose]() {
    this.destroy();
  }
}
