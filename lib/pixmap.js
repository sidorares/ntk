import { safeRelease } from './cleanup.js';
import Drawable from './drawable.js';
import { extensionEventNames } from './events_map.js';

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

    // Extension events name their drawable, and a DAMAGE object can watch a
    // pixmap, so routing (see App#_routeExtensionEvents) looks the target up
    // in `X.event_consumers` — where windows already live. A pixmap enrols
    // only when someone listens, because the entry is a strong reference:
    // enrolling every pixmap would pin them all past the GC fallback above.
    // A listening pixmap therefore stays until destroy(), which is also what
    // removes it from the table.
    this.on('newListener', (name) => {
      if (extensionEventNames.has(name) && X.event_consumers) {
        X.event_consumers[this.id] = this;
      }
    });
  }

  destroy() {
    if (this.X.event_consumers?.[this.id] === this) delete this.X.event_consumers[this.id];
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
