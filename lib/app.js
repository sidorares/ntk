import Clipboard from './clipboard.js';
import { CursorCache } from './cursor.js';
import { chooseGLXConfig } from './glx.js';
import Picture from './picture.js';
import Pixmap from './pixmap.js';
import { DEFAULT_RASTER_POLICY, defaultRasterizer } from './rasterize.js';
import { ShmUploader } from './shm-upload.js';
import FontManager from './text/fontmanager.js';
import Window from './window.js';

/**
 * The highest predefined atom id in the core protocol, `XA_WM_TRANSIENT_FOR`.
 *
 * Atoms 1 to 68 are named by the protocol itself, so every server agrees on
 * them and no server ever frees them. Anything above is interned at runtime
 * and belongs to the connection that asked for it — see `_isolateAtoms`.
 */
const PREDEFINED_ATOM_MAX = 68;

/**
 * Frame interval used before the display has been asked, in ms — and the one
 * kept on a server that cannot answer.
 */
const DEFAULT_FRAME_INTERVAL = 16;

/**
 * The range a refresh rate has to fall in to be paced against, in Hz. Below
 * this a display is not something a UI should be throttled to, and above it
 * the numbers are not describing a display at all.
 */
const MIN_REFRESH_RATE = 20;
const MAX_REFRESH_RATE = 1000;

/**
 * A RandR mode's vertical refresh rate in Hz, or 0 when it does not describe
 * one.
 *
 * `dot_clock / (h_total * v_total)`, with the two flags that make a frame
 * something other than one pass down the mode, exactly as xrandr computes it:
 * an interlaced mode paints half the lines per pass, a doublescan mode paints
 * each line twice.
 *
 * The zero check is not defensive: a virtual output has no pixel clock to
 * report and Xvfb — which is what CI runs against — fills all three fields
 * with zeroes, so the arithmetic yields NaN rather than a rate.
 */
function modeRate(mode) {
  if (!mode || !mode.dot_clock || !mode.h_total || !mode.v_total) return 0;
  let vTotal = mode.v_total;
  if (mode.modeflags & 0x10) vTotal /= 2; // Interlace
  if (mode.modeflags & 0x20) vTotal *= 2; // DoubleScan
  return mode.dot_clock / (mode.h_total * vTotal);
}

/**
 * A connection to an X server. Owns the underlying node-x11 client
 * (`app.X`) and acts as a factory for windows and pixmaps.
 */
export default class App {
  /**
   * @param {object} display node-x11 display
   * @param {object} [options] environment hooks: { fontSource — a FontSource
   *   or a font spec (see text/fontsource.js); `createClient` resolves a spec
   *   before it gets here, so a hand-built App may pass either —
   *   rasterizer and rasterPolicy (see rasterize.js),
   *   glxVisual (visual id for getContext('opengl') instead of querying the
   *   server for one) }
   */
  constructor(display, options = {}) {
    // ntk decodes property payloads and atom lists with little-endian
    // readers. That is not an assumption about the host: node-x11 declares a
    // byte order in its connection hello (`display.byte_order`, 0 LSBFirst /
    // 1 MSBFirst, x11 >= 3.4) and then encodes every request LSBFirst
    // regardless — so on a big-endian host the declared order and the actual
    // encoding disagree and the connection is garbage from its first
    // request, well before anything reaches us. Say so, rather than
    // rendering nonsense. (An older x11 leaves the field undefined, which
    // reads as LSBFirst and is right everywhere node-x11 currently works.)
    if (display.byte_order) {
      throw new Error(
        'ntk: this X connection is MSBFirst (big-endian); node-x11 encodes requests ' +
          'LSBFirst only, so the connection cannot be used'
      );
    }
    this.display = display;
    this.X = display.client;
    this.options = options;
    this._isolateAtoms();
    this._fonts = null;
    this._clipboard = null;
    this._cursors = null;
    this._solidPictures = new Map();
    this._rasterizer = undefined;
    this._shm = undefined;
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

  /**
   * Give this connection an atom table of its own.
   *
   * node-x11 hands every client the *same* table object — `this.atoms =
   * stdatoms` in xcore, assigned rather than copied — and `InternAtom`
   * answers out of it without a round trip when the name is already there.
   * So an id interned on one connection is handed to every other connection
   * in the process, which have never asked the server for it.
   *
   * That is safe only while something keeps the server alive. An X server
   * frees every atom it holds when its **last** client disconnects, and
   * hands the same ids out again to whatever is interned next. A process
   * that opens connections in sequence — a test suite, a tool that runs a
   * few apps, anything under Xvfb with no window manager holding the server
   * open — therefore writes properties with ids the server has forgotten.
   * The visible half of that is `BadAtom` on a `ChangeProperty` naming an
   * atom the app never chose; the quiet half is worse, because once the id
   * has been reissued to a different name the write lands under *that* atom
   * and no error is reported at all.
   *
   * Keeping only the predefined atoms is what makes the copy correct: ids 1
   * to 68 are fixed by the core protocol, identical on every server, and
   * never freed. Everything above that has to be interned per connection,
   * which now happens because this table starts without it. Within one
   * connection the caching still works, and it is still correct, because a
   * live connection is exactly what stops the server resetting.
   */
  _isolateAtoms() {
    const shared = this.X.atoms;
    if (!shared) return;
    const own = {};
    const names = {};
    for (const [name, id] of Object.entries(shared)) {
      if (id > PREDEFINED_ATOM_MAX) continue;
      own[name] = id;
      names[id] = name;
    }
    this.X.atoms = own;
    this.X.atom_names = names;
  }

  /**
   * The fastest refresh rate any active output is running at, in Hz, or
   * `null` until the display has been asked — and on a server with no RandR
   * or no mode worth pacing to.
   *
   * The fastest rather than the one this or that window is on, because what
   * it feeds is a rate *ceiling* (see `frameInterval`), and a window paced
   * faster than its own monitor is bounded by the next gate along rather than
   * drawing more than anyone can see. Tracking which output every window
   * overlaps would cost a per-window RandR lookup plus change tracking, to
   * make a ceiling slightly tighter.
   */
  get refreshRate() {
    if (this._refreshProbe === undefined) this._probeRefreshRate();
    return this._refreshRate ?? null;
  }

  /**
   * The frame interval windows on this connection take by default, in ms:
   * the display's own period rather than a guess, so an animation loop on a
   * 165Hz output is not held to the 62.5fps a hardcoded 16 implies. `null`
   * until the probe has answered; windows created before then start on the
   * default and adopt this when it lands.
   *
   * A window that presents takes its rate from the display directly and needs
   * none of this — see docs/window.md "What ends a frame". This is what the
   * fence clock paces to, which is every window on a server without Present,
   * and every window before its first frames have been shown.
   */
  get frameInterval() {
    const rate = this.refreshRate;
    return rate ? 1000 / rate : null;
  }

  /**
   * Ask RandR what the outputs are running at, once per connection, in the
   * background.
   *
   * Not on the connect path: `createClient` is already four round trips deep
   * and this is three more, for something no window needs before its first
   * frame. Failures are silent by design — every one of them means "no rate
   * to be had", which is exactly what the default covers.
   */
  _probeRefreshRate() {
    this._refreshProbe = null; // in progress; only ever started once
    const X = this.X;
    X.require('randr', (err, R) => {
      if (err || !R) return;
      const root = this.display.screen[0].root;
      R.GetScreenResourcesCurrent(root, (resourcesError, resources) => {
        if (resourcesError || !resources?.crtcs?.length) return;
        const modes = new Map(resources.modeinfos.map((mode) => [mode.id, mode]));
        let pending = resources.crtcs.length;
        let best = 0;
        for (const crtc of resources.crtcs) {
          R.GetCrtcInfo(crtc, resources.config_timestamp, (crtcError, info) => {
            // a crtc with no mode is one that is switched off
            if (!crtcError && info) best = Math.max(best, modeRate(modes.get(info.mode)));
            if (--pending) return;
            if (best < MIN_REFRESH_RATE || best > MAX_REFRESH_RATE) return;
            this._refreshRate = best;
            this._adoptFrameInterval(1000 / best);
          });
        }
      });
    });
  }

  /** hand the measured default to the windows that are still on the guess */
  _adoptFrameInterval(ms) {
    for (const wnd of Window._cacheFor(this).values()) wnd._adoptDefaultFrameInterval(ms);
  }

  /** the text API entry point: font matching/loading, shaping, layout */
  get fonts() {
    if (!this._fonts) this._fonts = new FontManager({ source: this.options.fontSource });
    return this._fonts;
  }

  /**
   * The Rasterizer small fills and strokes go through instead of the server's
   * trapezoid path (see lib/rasterize.js and docs/context-2d.md). Defaults to
   * the process-wide default; `createClient({ rasterizer: null })` sends every
   * drawing to the server.
   */
  get rasterizer() {
    if (this._rasterizer === undefined) {
      this._rasterizer =
        'rasterizer' in this.options ? this.options.rasterizer : defaultRasterizer();
    }
    return this._rasterizer;
  }

  set rasterizer(value) {
    this._rasterizer = value;
  }

  /**
   * The MIT-SHM upload helper: large PutImage/GetImage traffic (images,
   * putImageData, getImageData) travels through shared memory on a local
   * connection instead of the socket, and falls back to core requests
   * everywhere else. Resolved lazily; availability follows node-x11's `shm`
   * connection option (unset = on where possible, `false`/`'off'` = disabled).
   * See lib/shm-upload.js and docs/context-2d.md.
   */
  get shm() {
    if (this._shm === undefined) {
      this._shm = new ShmUploader(this);
      this._shm.resolve(() => {}); // probe availability in the background
    }
    return this._shm;
  }

  /** thresholds for that decision, merged over DEFAULT_RASTER_POLICY */
  get rasterPolicy() {
    return this.options.rasterPolicy
      ? { ...DEFAULT_RASTER_POLICY, ...this.options.rasterPolicy }
      : DEFAULT_RASTER_POLICY;
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

  /**
   * Find a 32-bit TrueColor visual with an alpha channel, for per-pixel
   * transparent windows (ARGB). Returns `{ visual, depth: 32 }` — pass
   * these to `createWindow()` together with `backgroundPixel: 0`. Returns
   * `null` when the server has no such visual (XQuartz, for example).
   *
   * The compositor blends the window's alpha channel automatically; no
   * Composite extension calls or EWMH properties are needed from the client.
   * Without a running compositor, transparent regions render black.
   */
  findArgbVisual(screen = 0) {
    const depths = this.display.screen[screen].depths;
    const visuals = depths?.[32];
    if (!visuals) return null;
    for (const [id, visual] of Object.entries(visuals)) {
      if (visual.class === 4) return { visual: Number(id), depth: 32 };
    }
    return null;
  }

  rootWindow(screen = 0) {
    return new Window(this, { id: this.display.screen[screen].root });
  }

  /**
   * Release a pointer or keyboard frozen by a synchronous grab (X
   * AllowEvents). A window manager grabs buttons on client windows with
   * `pointerMode: 0` so it sees the press first; this decides what happens
   * to it:
   *
   *   'replay'  — hand the event back to the client as if we never saw it
   *               (click-to-focus: raise the window, let the click through)
   *   'async'   — thaw, keeping the event for ourselves
   *   'sync'    — thaw for one more event, then freeze again
   *
   * The keyboard and both-devices variants carry their X names.
   *
   * @param {string|number} [mode] one of the names above, or a raw X mode
   * @param {number} [time] CurrentTime by default
   */
  allowEvents(mode = 'replay', time = 0) {
    const MODES = {
      async: 0, // AsyncPointer
      sync: 1, // SyncPointer
      replay: 2, // ReplayPointer
      async_keyboard: 3,
      sync_keyboard: 4,
      replay_keyboard: 5,
      async_both: 6,
      sync_both: 7
    };
    const value = typeof mode === 'number' ? mode : MODES[mode];
    if (value === undefined) throw new Error(`ntk: unknown AllowEvents mode '${mode}'`);
    this.X.AllowEvents(value, time);
    return this;
  }

  createPixmap(args) {
    return new Pixmap(this, args);
  }

  /**
   * A repeating source Picture of one colour, for compositing. Components
   * are 0..1 floats, premultiplied by alpha.
   *
   * Cached per connection, not per context: colours a context uses are the
   * app's palette, and `Surface.render` builds a context per call — a
   * per-context cache made every render recreate its fill colours
   * server-side. Nothing evicts; a solid is a few dozen bytes on the server
   * and an app cycles through few colours. Freed in `close()`.
   *
   * On RENDER >= 0.10 a solid is one CreateSolidFill request; an older
   * server (or a hand-built App that skipped the version handshake in
   * `createClient`) gets a 1x1 repeat pixmap, which composites identically.
   */
  solidPicture(r, g, b, a) {
    const key = `${r}|${g}|${b}|${a}`;
    let p = this._solidPictures.get(key);
    if (p) return p;

    const Render = this.display.Render;
    const [major, minor] = Render.version || [0, 0];
    if (major > 0 || minor >= 10) {
      const pid = this.X.AllocID();
      Render.CreateSolidFill(pid, r, g, b, a);
      p = new Picture(this, { id: pid });
    } else {
      const pixmap = this.createPixmap({ depth: 32, width: 1, height: 1 });
      const pid = this.X.AllocID();
      Render.CreatePicture(pid, pixmap.id, Render.rgba32, { repeat: 1 });
      Render.FillRectangles(Render.PictOp.Src, pid, [r, g, b, a], [0, 0, 1, 1]);
      p = new Picture(this, { id: pid });
      p._sourcePixmap = pixmap; // keep the 1x1 pixmap alive alongside the picture
    }
    this._solidPictures.set(key, p);
    return p;
  }

  // flush pending requests and close the connection
  close() {
    if (this._cursors) {
      this._cursors.dispose();
      this._cursors = null;
    }
    if (this._shm) {
      this._shm.dispose();
      this._shm = undefined;
    }
    // shared by every context that ever asked (see solidPicture), so their
    // lifetime is the connection's — context teardown must not free them
    for (const picture of this._solidPictures.values()) {
      picture.destroy();
      picture._sourcePixmap?.destroy();
    }
    this._solidPictures.clear();
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
