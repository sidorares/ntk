import { connectionGone } from './cleanup.js';
import Clipboard from './clipboard.js';
import { CursorCache } from './cursor.js';
import { GLError, backendFor, glCapabilities, glError, nativeRefreshRate, resolveGLPolicy } from './gl.js';
import { chooseGLXConfig } from './glx.js';
import Picture from './picture.js';
import Pixmap from './pixmap.js';
import Region, { REGION_DOCS } from './region.js';
import { formatForDepth, parsePictFormats, visualDepths, visualFormats } from './pictformat.js';
import { DEFAULT_RASTER_POLICY, defaultRasterizer } from './rasterize.js';
import { dropShadowSurfaces } from './shadow.js';
import { sharedGlyphsFor } from './sharedglyphs.js';
import { ShmUploader } from './shm-upload.js';
import FontManager from './text/fontmanager.js';
import Window from './window.js';
import * as xevents from './events_map.js';

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
 * XFIXES is missing, so no server-side regions.
 *
 * Worth a sentence about who is likely reading it: every X.Org release since
 * 2004 and every XQuartz ship XFIXES, so a server without it is a deliberately
 * minimal one — an embedded/nested server, or node-x11's own pure-JS server,
 * which implements RENDER but not this. That is a fact about the display, not
 * about the call, which is why it carries a `code`: a host that can degrade
 * should branch on it rather than crash.
 *
 * @param {Error} [cause] whatever the extension query failed with
 */
function noXFixesError(cause) {
  const err = new Error(
    'ntk: the X server has no XFIXES extension, so it has no regions.\n' +
      '\n' +
      'Region clips (ctx.clipRegion), damage regions and window shapes all need it.\n' +
      'Rectangular and path clips do not — ctx.clip() is core RENDER and works\n' +
      'everywhere:\n' +
      '\n' +
      '    ctx.save();\n' +
      '    ctx.beginPath();\n' +
      '    ctx.rect(x, y, w, h);\n' +
      '    ctx.clip();\n' +
      '\n' +
      `${REGION_DOCS}`,
    cause ? { cause } : undefined
  );
  err.code = 'ERR_NTK_NO_XFIXES';
  return err;
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
    // Decide the shared-glyph question now, while the environment the app
    // was created under is what the caller sees: the kill switch and the
    // option are sampled once per connection, not per page. Constructing the
    // client costs no I/O — discovery waits for the first page to bind.
    sharedGlyphsFor(this);
    this._cursors = null;
    this._solidPictures = new Map();
    this._rasterizer = undefined;
    this._shm = undefined;
    this._extensionPromises = new Map();
    // extension event routing (see _routeExtensionEvents): server-assigned
    // event type code -> events_map.extension entry. Null until the first
    // extension with events is required, which is also when the client-level
    // listener that consults it is attached.
    this._extEvents = null;
    this._devicesPromise = null;
    // XFIXES, once something has asked for it (regions, `app.fixes()`). The
    // promise lives in _extensionPromises with the other extensions; the
    // resolved object is also kept here because a region clip has to be
    // installed synchronously, in request order with the drawing around it —
    // see RenderingContext2d#clipRegion.
    this._fixes = null;
    // The visual -> picture format table and the formats list it was built
    // from, read once out of node-x11's cached QueryPictFormats reply. Kept
    // resolved alongside the promise so that binding a picture, which happens
    // synchronously, can consult it without waiting (see pictFormats).
    this._pictFormats = null;
    this._pictFormatsPromise = null;
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
    // RandR's answer, or the native layer's where RandR has no usable one.
    // An implausible rate is treated as no answer, not clamped: XQuartz
    // synthesizes real timing for its canned mode list but fills the current
    // desktop-sized mode with dot_clock = width * height — exactly 1 Hz — so
    // the number that describes what is actually driving the panel has to
    // come from the OS (x11-dri >= 0.6.0, apple.refreshRate()).
    const plausible = (rate) => rate >= MIN_REFRESH_RATE && rate <= MAX_REFRESH_RATE;
    const settle = (rate) => {
      if (!plausible(rate)) rate = nativeRefreshRate();
      if (!rate || !plausible(rate)) return;
      this._refreshRate = rate;
      this._adoptFrameInterval(1000 / rate);
    };
    // A connection on its way out is one more "no rate to be had". The probe
    // is started lazily by the first window built on this connection, which
    // may be one adopted from an event still arriving as it closes — and
    // node-x11 throws synchronously at a request from then on, where the
    // event dispatch has no caller to catch it (issue #321).
    if (connectionGone(X)) return;
    X.require('randr', (err, R) => {
      if (err || !R) return settle(0);
      const root = this.display.screen[0].root;
      R.GetScreenResourcesCurrent(root, (resourcesError, resources) => {
        if (resourcesError || !resources?.crtcs?.length) return settle(0);
        const modes = new Map(resources.modeinfos.map((mode) => [mode.id, mode]));
        let pending = resources.crtcs.length;
        let best = 0;
        for (const crtc of resources.crtcs) {
          R.GetCrtcInfo(crtc, resources.config_timestamp, (crtcError, info) => {
            // a crtc with no mode is one that is switched off
            if (!crtcError && info) best = Math.max(best, modeRate(modes.get(info.mode)));
            if (--pending) return;
            settle(best);
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

  /**
   * Which OpenGL backend windows on this connection draw through, merged over
   * `DEFAULT_GL_POLICY` and overridden by `NTK_GL_POLICY` — see
   * docs/context-gles.md. The default is `'indirect'`.
   *
   * Recomputed rather than cached, so raising it at run time works the way
   * `rasterPolicy` does. A policy raised to `auto`/`direct` after connecting
   * has missed the probe `createClient` would have run for it, so one
   * `await app.glCapabilities()` is needed before a context is created.
   */
  get glPolicy() {
    return resolveGLPolicy(this.options);
  }

  /**
   * What GL this connection can really do: `{ direct, indirect, device,
   * reason }`, where `reason` is the coded error explaining a false `direct`
   * (see `GLError`). Asked once and cached.
   *
   * `createClient` warms this during the handshake whenever the policy could
   * choose the direct backend — that is what lets `getContext` pick one
   * synchronously afterwards.
   *
   * @returns {Promise<{direct: boolean, indirect: boolean,
   *   device: string|null, reason: Error|null}>}
   */
  glCapabilities() {
    return glCapabilities(this).then((caps) => {
      this._glCapsResolved = caps;
      return caps;
    });
  }

  /**
   * The node-x11 object for extension `name`, or `null` where the server has
   * none — asked once per connection, the absent answer included.
   *
   * node-x11 caches the `QueryExtension` reply itself since 4.0.1
   * ([node-x11#287](https://github.com/sidorares/node-x11/issues/287)), so a
   * repeated probe no longer costs a round trip even when the answer is
   * absent — "can this machine run a compositor?" is a question about what is
   * *not* there, and it used to pay for asking. This cache stays for what it
   * does beyond that: one promise per name, so concurrent callers share the
   * one query, `_routeExtensionEvents` runs once rather than per call, and an
   * absent extension answers `null` instead of an error.
   *
   * `name` is node-x11's module name (`'fixes'`, not `'XFIXES'`), and the
   * accessors below are the whole supported set. Deliberately not public: a
   * name that arrives misspelled resolves `null` forever, which is
   * indistinguishable from a server that does not have the extension.
   *
   * @param {string} name
   * @returns {Promise<object|null>}
   */
  _extension(name) {
    let pending = this._extensionPromises.get(name);
    if (!pending) {
      pending = new Promise((resolve) => {
        this.X.require(name, (err, ext) => {
          if (!err && ext) this._routeExtensionEvents(name, ext);
          resolve(err ? null : ext);
        });
      });
      this._extensionPromises.set(name, pending);
    }
    return pending;
  }

  /**
   * Give this extension's events names, and a route to the object they name.
   *
   * A non-generic extension event carries a server-assigned type code
   * (`firstEvent` + a fixed offset) and names its target under the field its
   * own protocol calls it — DamageNotify a `drawable`, ShapeNotify and the
   * XFIXES notifies a `window` — never under the `wid` node-x11 dispatches
   * per-window consumers by. So without this they reach the client's raw
   * `'event'` stream and nothing else (issue #290).
   *
   * Registered here, when the extension is first required through the
   * accessors above, because the type codes exist only once the server has
   * answered. From then on the listener below hands each one to the Window
   * or Pixmap it names — through `_deliverEvent`, so a window's coalescing
   * and frame pacing apply: `damage` unions its rectangles per paced frame
   * exactly as `expose` does. The lookup goes through `X.event_consumers`,
   * where every Window already sits for core dispatch and a Pixmap enrols
   * itself when given a listener (see lib/pixmap.js).
   */
  _routeExtensionEvents(module, ext) {
    const events = xevents.extension[module];
    if (!events || !ext.firstEvent || !ext.events) return;
    if (!this._extEvents) {
      this._extEvents = new Map();
      this.X.on('event', (ev) => {
        // by the server-assigned type code, which every extension event
        // carries since x11 4.0.0 (node-x11#284 — DamageNotify and a couple
        // of others used to name themselves without it). Only the codes this
        // table registered can match.
        const route = this._extEvents.get(ev.type);
        if (!route) return;
        const target = this.X.event_consumers[ev[route.target]];
        // a consumer that is not an ntk drawable (a caller's own) keeps
        // reading the raw client stream it always read
        if (typeof target?._deliverEvent !== 'function') return;
        const ntkev = route.translate(ev);
        ntkev.target = target;
        if (target instanceof Window) ntkev.window = target;
        target._deliverEvent(route.name, ntkev);
      });
    }
    for (const [key, spec] of Object.entries(events)) {
      const offset = ext.events[key];
      if (offset === undefined) continue;
      this._extEvents.set(ext.firstEvent + offset, spec);
    }
  }

  /**
   * The XInput extension, or `null` where the server has none — asked once
   * per connection.
   *
   * `ext.xi2` is `null` on a server that answers the extension query but
   * speaks XI1 only, and every XI2 request needs it, so callers check both.
   *
   * @returns {Promise<object|null>}
   */
  xinput() {
    return this._extension('xinput');
  }

  /**
   * The Composite extension, or `null` where the server has none: the
   * redirection half of a compositing manager — `RedirectSubwindows`,
   * `NameWindowPixmap`, `Get`/`ReleaseOverlayWindow`
   * (docs/app.md#extensions).
   *
   * `null` here is a live answer rather than a defensive one, and the one
   * worth branching on: XQuartz carries DAMAGE, XFIXES, SHAPE and RENDER but
   * no Composite at all, so this is where "can this machine run a
   * compositor?" is decided.
   *
   * @returns {Promise<object|null>}
   */
  composite() {
    return this._extension('composite');
  }

  /**
   * The DAMAGE extension, or `null` where the server has none: what turns
   * "this drawable changed" into an event, so a compositor repaints the
   * region a client drew into rather than the screen
   * (docs/app.md#extensions).
   *
   * @returns {Promise<object|null>}
   */
  damage() {
    return this._extension('damage');
  }

  /**
   * The XFIXES extension, or `null` where the server has none: server-side
   * regions and the algebra over them, which is how a damaged area becomes a
   * clip — `SetPictureClipRegion(ctx.picture.id, 0, 0, region)` narrows a 2d
   * context to one (docs/app.md#extensions).
   *
   * @returns {Promise<object|null>}
   */
  xfixes() {
    return this._extension('fixes');
  }

  /**
   * The SHAPE extension, or `null` where the server has none: non-rectangular
   * window bounding/clip/input shapes, which a compositor has to read to
   * paint a shaped client correctly (docs/app.md#extensions).
   *
   * @returns {Promise<object|null>}
   */
  shape() {
    return this._extension('shape');
  }

  /**
   * Every input device the server knows about, from XI2's `XIQueryDevice`:
   * `{deviceId, use, attachment, enabled, name, classes}`, the classes
   * describing each device's keys, buttons, valuators and scroll axes (see
   * node-x11's docs/ext/xinput.md). `[]` where there is no XI2.
   *
   * Cached, because it is what `Window.selectXI2` consults to find the
   * scroll axes behind a wheel delta and it must not cost a round trip per
   * event. The cache is dropped whenever a window with XI2 selected sees an
   * `XIDeviceChanged` — a master pointer's axes are those of whichever slave
   * moved last, so they change under it when the user picks up the mouse
   * after using the touchpad.
   *
   * @param {{refresh?: boolean}} [options]
   * @returns {Promise<object[]>}
   */
  inputDevices({ refresh = false } = {}) {
    if (refresh) this._devicesPromise = null;
    if (!this._devicesPromise) {
      this._devicesPromise = this.xinput().then((XI) => {
        if (!XI || !XI.xi2) return [];
        return new Promise((resolve) => {
          XI.XIQueryDevice(XI.AllDevices, (err, devices) => resolve(err ? [] : devices));
        });
      });
    }
    return this._devicesPromise;
  }

  /** selection/clipboard transfer: write()/read() text (docs/clipboard.md) */
  get clipboard() {
    if (!this._clipboard) this._clipboard = new Clipboard(this);
    return this._clipboard;
  }

  /**
   * The cross-process shared glyph cache client (docs/shared-glyphs.md), or
   * `null` when the feature is off — `createClient({ sharedGlyphs: false })`
   * or the `NTK_NO_SHARED_GLYPHS` environment kill switch. Purely lazy: the
   * accessor itself touches no server state; discovery (and the first app's
   * self-election as the display's glyph directory) happens when the first
   * glyph page binds.
   */
  get sharedGlyphs() {
    return sharedGlyphsFor(this);
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
   * The same question, asked of whichever backend `glPolicy` selects: what to
   * create a GL window with. Resolves with a `chooseGLXConfig` object plus
   * `backend` (`'direct'` or `'indirect'`) — pass `visual`/`depth` to
   * `createWindow` and the whole object to `wnd.getContext('opengl', config)`.
   *
   * The spec is GLX's attribute vocabulary either way, because a caller
   * should not have to write the request twice: `DEPTH_SIZE` becomes the
   * depth-buffer size of the direct backend's context (EGL on Linux, CGL on
   * macOS), and `ALPHA_SIZE` picks an ARGB visual there rather than an
   * fbconfig with an alpha channel. Direct needs no round trip to answer —
   * there are no fbconfigs in it, only a window the GPU draws for.
   *
   * @param {object} [spec] GLX attributes, e.g. `{ DEPTH_SIZE: 24 }`
   */
  async chooseGLConfig(spec = {}) {
    const caps = this._glCapsResolved ?? (await this.glCapabilities());
    const backend = backendFor(this);
    if (backend === 'off') throw caps.reason ?? new Error('ntk: no GL backend is available');
    if (backend !== 'direct') return { ...(await chooseGLXConfig(this, spec)), backend: 'indirect' };

    const screenNum = spec.screen ?? 0;
    const screen = this.display.screen[screenNum];
    const wantAlpha = (spec.ALPHA_SIZE ?? 0) > 0;
    const argb = wantAlpha ? this.findArgbVisual(screenNum) : null;
    if (wantAlpha && !argb) {
      throw glError(
        GLError.CONTEXT_FAILED,
        `direct rendering: screen ${screenNum} has no 32-bit visual, so a GL window cannot have an alpha channel`
      );
    }
    return {
      backend: 'direct',
      // which direct pipeline this connection runs: 'dri3' or 'appledri'
      flavor: caps.flavor,
      // depth 24 on the root visual needs no colormap of its own, which is
      // why an opaque GL window here is an ordinary window
      visual: argb?.visual ?? screen.root_visual,
      depth: argb?.depth ?? screen.root_depth,
      class: 4, // TrueColor; the only class these buffers can be read as
      doubleBuffer: true, // a swap chain, always
      depthSize: spec.DEPTH_SIZE ?? 16,
      screen: screenNum,
      fbconfig: null,
      device: caps.device,
      config: {}
    };
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

  /**
   * The RENDER picture formats this server publishes, and which one belongs
   * to each visual: `{ formats, byVisual }`.
   *
   * No round trip of ntk's own: node-x11 sends `QueryPictFormats` itself
   * while requiring RENDER — that is where its `rgb24`/`rgba32`/`a8` come
   * from — and since 4.0.0 it keeps the reply as `Render.pictFormats`. So
   * the answer is already here before anything can draw. `formats` is the
   * list as objects (`{ id, type, depth, redShift, redMask, ... }`);
   * `byVisual` is a `Map` from visual id to format id.
   *
   * @returns {Promise<{formats: Array<object>, byVisual: Map<number, number>}>}
   */
  pictFormats() {
    if (this._pictFormatsPromise) return this._pictFormatsPromise;
    this._pictFormatsPromise = new Promise((resolve, reject) => {
      const reply = this.display.Render?.pictFormats;
      if (!reply) {
        reject(new Error('ntk: this connection has no RENDER extension, so it has no picture formats'));
        return;
      }
      const formats = parsePictFormats(reply);
      this._pictFormats = {
        formats,
        byVisual: visualFormats(this.display, formats, reply)
      };
      resolve(this._pictFormats);
    });
    return this._pictFormatsPromise;
  }

  /**
   * The picture format a drawable on `visual` is read and written through.
   *
   * Depth is not enough to name a format and a visual is: a depth-16 visual
   * can be 5:6:5 or 5:5:5, a depth-24 one RGB or BGR, and 10:10:10:2 is 32
   * bits wide like 8:8:8:8. Anything drawing on a drawable it did not create
   * — a compositor holding another client's pixmap, an adopted or embedded
   * window — has to ask, or RENDER reads the channels wrong without ever
   * complaining (issue #295).
   *
   *   const attrs = await wnd.getAttributes();
   *   const format = await app.pictFormatFor(attrs.visual);
   *
   * `visual` may be an id or a handshake visual object. `depth` is the
   * fallback: where the server names no format for the visual — an indexed
   * visual, or one this connection was never told about — the standard
   * format for that depth is returned, which is what ntk used to assume
   * everywhere.
   *
   * @param {number|object} visual visual id, or `{ vid }`
   * @param {object} [options]
   * @param {number} [options.depth] the drawable's depth, for the fallback
   * @returns {Promise<number|undefined>} picture format id
   */
  async pictFormatFor(visual, { depth } = {}) {
    const id = typeof visual === 'object' && visual ? visual.vid : visual;
    try {
      await this.pictFormats();
    } catch {
      // a server that cannot answer leaves the fallback
    }
    return this._knownPictFormat(id, depth) ?? formatForDepth(this.display.Render, depth);
  }

  /**
   * The cached answer to `pictFormatFor`, or `undefined` when the table has
   * not arrived, names no format for this visual, or the visual does not
   * describe a drawable of this depth.
   *
   * That last one is the guard against handing RENDER a format it will
   * reject: a picture's format and its drawable's depth have to agree, and
   * the visual on hand is not always the drawable's own — a window's backing
   * pixmap is allocated at a depth ntk sometimes has to assume. Where they
   * disagree the depth is what the drawable really is, so the depth-based
   * format is what it gets.
   *
   * A picture is bound synchronously, in request order with the drawing
   * around it, so the format has to be available without a wait. Callers
   * fall back to the depth and re-bind once `pictFormats()` resolves.
   */
  _knownPictFormat(visual, depth) {
    if (!visual) return undefined;
    const id = visual >>> 0;
    const format = this._pictFormats?.byVisual.get(id);
    if (format === undefined) return undefined;
    // Depth 0 is not a depth: it is CopyFromParent, which ntk never resolved
    // because only the server did — and a window on that visual is of that
    // visual's depth by definition, so there is nothing to disagree with.
    if (depth) {
      this._visualDepths ??= visualDepths(this.display);
      if (this._visualDepths.get(id) !== depth) return undefined;
    }
    return format;
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
   * The XFIXES extension for this connection, loaded once and shared.
   *
   * Regions live here — the server-side rectangle sets X uses for damage,
   * window shapes and compositor bookkeeping — along with the requests that
   * combine them and the one that hangs a region on a Picture as its clip.
   *
   * The throwing spelling of `app.xfixes()`: same query, same cache, but a
   * server without XFIXES rejects with code `'ERR_NTK_NO_XFIXES'` instead of
   * resolving `null` — regions cannot degrade, so their absence is an error
   * here rather than an answer.
   *
   * @returns {Promise<object>} node-x11's XFIXES extension object
   */
  async fixes() {
    const ext = await this.xfixes();
    if (!ext) throw noXFixesError();
    this._fixes = ext;
    return ext;
  }

  /**
   * A server-side region of the given rectangles (`{ x, y, width, height }`
   * or ntk's own `{ x, y, w, h }`), empty by default.
   *
   * Async because XFIXES is loaded on first use; a second region costs one
   * request and no round trip. Free it with `destroy()` — or `using`, or let
   * the GC do it (docs/resource-management.md).
   *
   * @param {Array<object>} [rects]
   * @returns {Promise<Region>}
   */
  async createRegion(rects = []) {
    return new Region(this, await this.fixes(), rects);
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
    // shadow coverage is cached per connection for the same reason solids
    // are: the contexts that drew it are long gone (see lib/shadow.js)
    dropShadowSurfaces(this);
    // shared by every context that ever asked (see solidPicture), so their
    // lifetime is the connection's — context teardown must not free them
    for (const picture of this._solidPictures.values()) {
      picture.destroy();
      picture._sourcePixmap?.destroy();
    }
    this._solidPictures.clear();
    // GPU contexts are shared by every direct GL surface on this connection
    // (see renderingcontext_gles.js), so they outlive individual contexts and
    // are the connection's to release. Each holds an EGL display, a GBM device
    // and an open render node.
    if (this._glGpus) {
      for (const gpu of this._glGpus.values()) {
        try {
          gpu.destroy();
        } catch {
          // already torn down, or the driver is gone
        }
      }
      this._glGpus.clear();
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
