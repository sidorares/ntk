import { safeRelease } from './cleanup.js';
import Drawable from './drawable.js';

// GC fallback: free the server-side pixmap when the wrapper is collected
// without an explicit destroy()
const registry = new FinalizationRegistry(({ X, id }) => {
  safeRelease(X, () => {
    X.FreePixmap(id);
    X.ReleaseID(id);
  });
});

export default class Pixmap extends Drawable {
  constructor(app, args = {}) {
    super();
    this.app = app;
    const X = app.X;
    this.X = X;
    this.display = app.display;

    const parentId = args.parent ? args.parent.id : app.display.screen[0].root;
    this.depth = args.depth || 24;
    // A pixmap has no visual of its own — X gives it a depth and nothing
    // else. What its pixels mean is decided by whoever put them there, so a
    // pixmap holding a window's content (a backing store, a compositor's
    // NameWindowPixmap) is told which visual that was: it is what names the
    // picture format the pixels can be read through (issue #295). Left 0,
    // the format is picked from the depth as before.
    this.visualId = args.visual ?? 0;

    if (!args.id) {
      this.id = X.AllocID();
      X.CreatePixmap(this.id, parentId, this.depth, args.width, args.height);
      this.width = args.width;
      this.height = args.height;
      this._owned = true;
      registry.register(this, { X, id: this.id }, this);
    } else {
      this.id = args.id;
      this._owned = false;
    }
  }

  destroy() {
    if (!this._owned) return;
    this._owned = false;
    registry.unregister(this);
    safeRelease(this.X, () => {
      this.X.FreePixmap(this.id);
      this.X.ReleaseID(this.id);
    });
  }

  [Symbol.dispose]() {
    this.destroy();
  }
}
