import Clipboard from './clipboard.js';
import { CursorCache } from './cursor.js';
import { chooseGLXConfig } from './glx.js';
import Pixmap from './pixmap.js';
import FontManager from './text/fontmanager.js';
import Window from './window.js';

/**
 * A connection to an X server. Owns the underlying node-x11 client
 * (`app.X`) and acts as a factory for windows and pixmaps.
 */
export default class App {
  /**
   * @param {object} display node-x11 display
   * @param {object} [options] environment hooks: { fontSource (see
   *   text/fontsource.js), glxVisual (visual id for getContext('opengl')
   *   instead of querying the server for one) }
   */
  constructor(display, options = {}) {
    this.display = display;
    this.X = display.client;
    this.options = options;
    this._fonts = null;
    this._clipboard = null;
    this._cursors = null;
    // node-x11 emits X errors it cannot route to a request callback as
    // 'error' on the client — from inside its packet parser. With no
    // listener that emit throws and the parser never re-arms, silently
    // wedging the connection (every later reply is dropped). Benign races
    // (e.g. a request landing after its window was destroyed) become a
    // warning instead; pass { onXError } to handle them yourself.
    this.X.on('error', (err) => {
      if (this.options.onXError) this.options.onXError(err);
      else console.warn(`ntk: unhandled X error: ${err.message} (opcode ${err.majorOpcode}, seq ${err.seq})`);
    });
  }

  /** the text API entry point: font matching/loading, shaping, layout */
  get fonts() {
    if (!this._fonts) this._fonts = new FontManager({ source: this.options.fontSource });
    return this._fonts;
  }

  /** selection/clipboard transfer: write()/read() text (docs/clipboard.md) */
  get clipboard() {
    if (!this._clipboard) this._clipboard = new Clipboard(this);
    return this._clipboard;
  }

  /** per-connection cache of X11 cursor-font cursors (see lib/cursor.js) */
  get cursors() {
    if (!this._cursors) this._cursors = new CursorCache(this);
    return this._cursors;
  }

  createWindow(args) {
    return new Window(this, args);
  }

  /**
   * Allocate a colormap for `visual` (X CreateColormap, alloc None — the
   * only legal value for the TrueColor visuals we use). Windows created
   * with an explicit `visual` get one of these automatically.
   * @returns {number} the colormap id
   */
  createColormap(visual, screen = 0) {
    const mid = this.X.AllocID();
    this.X.CreateColormap(mid, this.display.screen[screen].root, visual, 0);
    return mid;
  }

  /**
   * Pick a GLX-capable visual (docs/context-opengl.md). Resolves with
   * `{ visual, depth, class, doubleBuffer, depthSize, fbconfig, screen }` —
   * pass `visual`/`depth` to `createWindow` and the whole object to
   * `wnd.getContext('opengl', config)`.
   * @param {object} [spec] GLX attributes, e.g.
   *   `{ DEPTH_SIZE: 24, DOUBLEBUFFER: true, ALPHA_SIZE: 8 }`
   */
  chooseGLXConfig(spec) {
    return chooseGLXConfig(this, spec);
  }

  rootWindow() {
    return new Window(this, { id: this.display.screen[0].root });
  }

  createPixmap(args) {
    return new Pixmap(this, args);
  }

  // flush pending requests and close the connection
  close() {
    if (this._cursors) {
      this._cursors.dispose();
      this._cursors = null;
    }
    return new Promise((resolve) => this.X.close(resolve));
  }

  async [Symbol.asyncDispose]() {
    await this.close();
  }

  // sync variant: terminates without waiting for a flush round-trip
  [Symbol.dispose]() {
    this.X.terminate();
  }
}
