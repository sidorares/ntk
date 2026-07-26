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
   *   when glxinfo can't be shelled out to) }
   */
  constructor(display, options = {}) {
    this.display = display;
    this.X = display.client;
    this.options = options;
    this._fonts = null;
  }

  /** the text API entry point: font matching/loading, shaping, layout */
  get fonts() {
    if (!this._fonts) this._fonts = new FontManager({ source: this.options.fontSource });
    return this._fonts;
  }

  createWindow(args) {
    return new Window(this, args);
  }

  rootWindow() {
    return new Window(this, { id: this.display.screen[0].root });
  }

  createPixmap(args) {
    return new Pixmap(this, args);
  }

  // flush pending requests and close the connection
  close() {
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
