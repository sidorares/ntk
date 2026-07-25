import Drawable from './drawable.js';

// GC fallback: free the server-side pixmap when the wrapper is collected
// without an explicit destroy()
const registry = new FinalizationRegistry(({ X, id }) => {
  X.FreePixmap(id);
  X.ReleaseID(id);
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
    this.X.FreePixmap(this.id);
    this.X.ReleaseID(this.id);
  }

  [Symbol.dispose]() {
    this.destroy();
  }
}
