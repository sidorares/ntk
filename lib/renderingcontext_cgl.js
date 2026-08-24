// Direct rendering context, macOS/XQuartz flavor: OpenGL on the GPU through
// CGL, drawing straight into the window's WindowServer surface, which the
// server exports over the Apple-DRI extension (lib/appledri.js).
//
// The mirror image of the DRI3 flavor (lib/renderingcontext_gles.js): DRI3
// is client-allocates-and-pushes — GBM buffers travel to the server as
// dma-buf descriptors and are shown with Present — where Apple-DRI is
// server-exports-and-client-attaches:
//
//   this process                              X server (XQuartz)
//   ------------                              ------------------
//   apple.clientId()  --- AppleDRICreateSurface(win, cid) --->  exports the
//                     <-------------- key[2] ----------------   window's surface
//   ctx.attach(key)      (import surface + bind CGL context)
//   gl draws straight into the window's backing store
//   ctx.flush()          (CGLFlushDrawable — WindowServer composites)
//                     <--- AppleDRISurfaceNotify ------------   moved/resized/
//                                                               destroyed
//
// After attach, no pixels and no per-frame requests cross the X socket at
// all. The GL the context speaks is the same WebGL-shaped camelCase table
// the DRI3 flavor installs — the addon serves both from one `gl` object, and
// on Apple's GL (4.1 core on Metal, ES2-compatible) the same GLSL ES 1.00
// shaders compile unchanged — so draw code written against `gl.backend ===
// 'direct'` runs on either. See docs/context-gles.md#macos.
//
// Two structural differences from the GLES flavor, both consequences of the
// server owning the buffer:
//
//  - **The surface exists only while the physical (Quartz) window does**, so
//    setup is not synchronous: the CGL context is created in the
//    constructor (and `gl.*` works immediately — an unattached context
//    compiles shaders and renders to FBOs), but the attach waits for
//    MapNotify, and `SurfaceNotify(destroyed)` (unmap, frame recreated)
//    means export-and-attach again. `ready`/`canRender()` report it, and
//    the existing `onFrameAvailable` contract absorbs the wait.
//  - **No backpressure from the server**: `flush()` always succeeds
//    immediately, so a loop that draws whenever it can would spin at 100%
//    CPU. Rather than a second pacing model, the swap itself closes the
//    `canRender()` gate for one display period and a timer reopens it —
//    the same gate IdleNotify drives on Linux, so a draw loop written for
//    one flavor paces correctly on the other.

import { connectionGone } from './cleanup.js';
import Drawable from './drawable.js';
import { GLError, backendFor, glError, loadDriAddon } from './gl.js';

/** pacing fallback where the display's rate is not known (see App#frameInterval) */
const FALLBACK_FRAME_INTERVAL = 1000 / 60;

/**
 * The app-level uid -> context routes for AppleDRISurfaceNotify.
 *
 * The event is classic (not a GenericEvent, so `_setGenericEventSink` never
 * sees it), unsolicited (no mask to select), and names its surface by the
 * **uid** from the CreateSurface reply rather than by window id — so the
 * per-window `event_consumers` dispatch cannot route it either. One
 * client-level listener per connection, keyed by uid, is the whole scheme.
 */
function appleSurfaceRoutes(app) {
  if (app._appleSurfaces) return app._appleSurfaces;
  const routes = new Map();
  app._appleSurfaces = routes;
  app.X.on('event', (ev) => {
    if (ev.name !== 'AppleDRISurfaceNotify') return;
    routes.get(ev.arg)?._surfaceNotify(ev);
  });
  return routes;
}

class RenderingContextCGL {
  constructor(window, config = {}) {
    const app = window.app;
    const caps = app._glCapsResolved;
    if (!caps) {
      throw glError(
        GLError.CONTEXT_FAILED,
        "getContext('cgl') needs the direct-rendering probe to have answered, and it has not",
        `createClient() runs the probe during the handshake when glPolicy could pick the
direct backend, so a context can be created synchronously afterwards. Under the
default policy ('indirect') it does not run, and asking for this context by name
does not make it retroactive. Either:

  const app = await createClient({ glPolicy: 'auto' });   // probe at connect
  await app.glCapabilities();                             // or ask, once, later`
      );
    }
    if (!caps.direct) throw caps.reason;
    if (caps.flavor !== 'appledri') {
      throw glError(
        GLError.CONTEXT_FAILED,
        `this connection's direct backend is ${caps.flavor}, not Apple-DRI/CGL`,
        "getContext('opengl') is the backend-neutral name and picks the right flavor;\n'cgl' asks for this one by name and only exists on macOS/XQuartz."
      );
    }

    const dri = loadDriAddon();
    this.window = window;
    this.app = app;
    this.X = window.X;
    this.dri = dri;
    this.AppleDRI = caps.AppleDRI;
    /** which backend this is, for code that runs on either */
    this.backend = 'direct';
    /** which direct pipeline, for the curious ('dri3' on Linux) */
    this.flavor = 'appledri';
    this.error = null;

    const depth = window.depth || app.display.screen[0].root_depth || 24;
    if (depth !== 24 && depth !== 32) {
      throw glError(
        GLError.CONTEXT_FAILED,
        `direct rendering needs a 24- or 32-bit window, and this one is ${depth}-bit`,
        'Create the window with depth 24 (opaque) or 32 (per-pixel alpha, via\napp.findArgbVisual()).'
      );
    }
    this.depth = depth;
    this._screen = config.screen ?? 0;
    this._clientId = caps.appleClientId ?? dri.apple.clientId();

    // One CGL context per context object, not a shared one per app: a CGL
    // context can be attached to exactly one surface, and contexts are cheap
    // where EGL ones are not. The visible consequence is that GL resources
    // (programs, textures) are per-window on this flavor where the GLES one
    // shares them — key caches by the `gl` object identity and both are
    // covered (docs/context-gles.md#macos).
    try {
      this.ctx = new dri.apple.Context({
        depthSize: config.depthSize ?? config.DEPTH_SIZE ?? 16
      });
    } catch (err) {
      throw glError(
        GLError.CONTEXT_FAILED,
        `could not create a CGL context: ${err.message}`,
        null,
        err
      );
    }

    this._routes = appleSurfaceRoutes(app);
    this._uid = undefined;
    this._attached = false;
    this._pendingSurface = false;
    this._throttled = false;
    this._timer = null;
    this._frameWanted = null;
    this._destroyed = false;

    /**
     * Resolves once the window's surface has been exported and attached —
     * the whole path proven — and rejects with a coded error if it cannot
     * be. Settles only after the window is mapped: the physical Quartz
     * window has to exist before the server has a surface to export, so
     * `map()` first, then `await gl.ready`.
     */
    this.ready = new Promise((resolve, reject) => {
      this._settleReady = (err) => {
        this._settleReady = null;
        if (err) reject(err);
        else resolve(this);
      };
    });
    // a rejection nobody is listening for must not take the process down;
    // `error` is the other way to find out
    this.ready.catch(() => {});

    // GL entry points and constants, bound so that this context is the
    // current one when they run
    this._installGL();
    this.makeCurrent();

    // The attach dance: surface after MapNotify, again after a Destroyed
    // notify once the window is viewable again. `on('map')` also selects
    // StructureNotify where the window does not have it yet (adopted ids).
    this._onMap = () => {
      if (!this._attached && !this._pendingSurface) this._createSurface();
    };
    window.on('map', this._onMap);
    if (window._mapped) this._createSurface();
  }

  /**
   * Copy the addon's GL namespace onto this context.
   *
   * Same shape as the GLES flavor: every function is wrapped with a currency
   * check, because another context may have made itself current since the
   * last call here — `app._glCurrent` is one slot shared by every direct
   * context on the connection, whichever flavor.
   */
  _installGL() {
    const table = this.dri.gl;
    for (const key in table) {
      const value = table[key];
      if (typeof value !== 'function') {
        this[key] = value; // GL constants
        continue;
      }
      this[key] = (...args) => {
        if (this.app._glCurrent !== this) this._bind();
        return value(...args);
      };
    }
  }

  /**
   * Ask the server to export the window's surface, then attach to it.
   *
   * Called from MapNotify (the physical window now exists) and from the
   * SurfaceNotify(destroyed) recovery path. Attaching again on the same CGL
   * context replaces whatever surface it held.
   */
  _createSurface() {
    if (this._destroyed || this.error || this.window._destroyed || connectionGone(this.X)) return;
    this._pendingSurface = true;
    this.AppleDRI.CreateSurface(this._screen, this.window.id, this._clientId, (err, surf) => {
      this._pendingSurface = false;
      if (this._destroyed || this.window._destroyed) return;
      if (err) {
        return this._fail(
          glError(
            GLError.CONTEXT_FAILED,
            `Apple-DRI could not export a surface for this window: ${err.message}`,
            null,
            err
          )
        );
      }
      if (this._uid !== undefined) this._routes.delete(this._uid);
      this._uid = surf.uid;
      this._routes.set(surf.uid, this);
      try {
        this.ctx.attach(surf.key);
      } catch (attachErr) {
        return this._fail(
          glError(
            GLError.CONTEXT_FAILED,
            `could not attach the CGL context to the exported surface: ${attachErr.message}`,
            null,
            attachErr
          )
        );
      }
      this.app._glCurrent = this; // attach leaves the context current
      this._attached = true;
      this._settleReady?.(null);
      this._onFrameAvailable();
    });
    this.X.flush?.();
  }

  /** the app-level route target for this context's SurfaceNotify events */
  _surfaceNotify(ev) {
    if (this._destroyed || this.error) return;
    if (ev.kind === this.AppleDRI.NotifyKind.Changed) {
      // moved or resized under the surface: refresh the context's idea of it
      if (this._attached) {
        try {
          this.ctx.update();
        } catch {
          // a surface torn down between the event and now; the Destroyed
          // notify that follows is what handles it
        }
      }
      return;
    }
    // Destroyed: the Quartz window went away — unmapped, or its frame was
    // recreated. The context survives; the surface has to be exported and
    // attached again once there is a window to export.
    this._attached = false;
    if (this._uid !== undefined) {
      this._routes.delete(this._uid);
      this._uid = undefined;
    }
    if (this.window._mapped && !this._pendingSurface) this._createSurface();
    // not mapped: the 'map' listener picks it up when it is again
  }

  /**
   * Make this context current, and pick up a resize.
   *
   * Call it at the top of a frame, as on the GLES flavor. A size change
   * needs no new buffers here — the surface is the window's backing store
   * and tracks it — but the context has to be told to re-read the geometry.
   */
  makeCurrent() {
    if (this.error || this._destroyed || this.window._destroyed) return this;
    this._bind();
    const width = this.window.width;
    const height = this.window.height;
    if (width !== this._width || height !== this._height) {
      this._width = width;
      this._height = height;
      if (this._attached) {
        try {
          this.ctx.update();
        } catch {
          // surface gone; the Destroyed notify re-attaches
        }
      }
    }
    return this;
  }

  _bind() {
    if (this.error || this._destroyed) return;
    this.ctx.makeCurrent();
    this.app._glCurrent = this;
  }

  /**
   * Is a frame worth drawing right now?
   *
   * False until the surface is attached (nowhere to draw to), and false for
   * one display period after each swap (the pacing gate). `onFrameAvailable`
   * fires when either turns true.
   */
  canRender() {
    if (this.error || this._destroyed) return false;
    return this._attached && !this._throttled;
  }

  /** Called when `canRender()` became true again — attach settled, or the pacing gate reopened. */
  set onFrameAvailable(fn) {
    this._frameWanted = fn;
  }

  get onFrameAvailable() {
    return this._frameWanted;
  }

  _onFrameAvailable() {
    this._frameWanted?.();
  }

  /**
   * Show the frame just drawn (CGLFlushDrawable — the WindowServer
   * composites the surface; no X request is involved).
   *
   * Returns false when there is no attached surface yet or the pacing gate
   * is closed — the same contract as the GLES flavor's "every buffer is with
   * the server", and `onFrameAvailable` reopens it the same way.
   */
  SwapBuffers() {
    if (this.error || this._destroyed || this.window._destroyed) return false;
    if (!this._attached || this._throttled) return false;
    try {
      this.ctx.flush();
    } catch (err) {
      this._fail(glError(GLError.CONTEXT_FAILED, `CGL flush failed: ${err.message}`, null, err));
      return false;
    }
    // The pacing gate: flush() never blocks and the server sends no
    // done-with-it event, so an unthrottled loop would spin. Close the gate
    // for most of a display period; the timer reopens it and fires
    // onFrameAvailable, which is exactly what IdleNotify does on Linux.
    // Most of one rather than a full one because callers paced by
    // requestAnimationFrame already wait a display period of their own, and
    // a full gate in series with it would drop below display rate; at 3/4
    // the frame clock stays the pacer and this gate only stops the spin.
    // (ctx.setSwapInterval(1) — a blocking vsync'd flush — remains available
    // on the raw context for callers who want real vsync.)
    this._throttled = true;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._throttled = false;
      this._onFrameAvailable();
    }, (this.app.frameInterval ?? FALLBACK_FRAME_INTERVAL) * 0.75);
    return true;
  }

  swapBuffers() {
    return this.SwapBuffers();
  }

  /** The GL renderer string — "Apple M1 Pro" and the like, handy in bug reports. */
  get renderer() {
    try {
      return this.dri.gl.getString(this.dri.GL.RENDERER);
    } catch {
      return null;
    }
  }

  _fail(err) {
    if (this.error) return;
    this.error = err;
    this._settleReady?.(err);
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this.window.removeListener('map', this._onMap);
    if (this._uid !== undefined) {
      this._routes.delete(this._uid);
      this._uid = undefined;
    }
    // release the server's reference to the surface; with the window (or the
    // connection) already gone the server has done it for us
    if (!this.window._destroyed && !connectionGone(this.X)) {
      try {
        this.AppleDRI.DestroySurface(this._screen, this.window.id);
      } catch {
        // the connection is closing; the server frees everything with it
      }
    }
    if (this.app._glCurrent === this) this.app._glCurrent = null;
    try {
      this.ctx.destroy();
    } catch {
      // already torn down
    }
  }

  [Symbol.dispose]() {
    this.destroy();
  }
}

Drawable.renderingContextFactory['cgl'] = (window, config) => new RenderingContextCGL(window, config);

// The 'opengl' dispatcher was registered by renderingcontext_gles.js (which
// index.js imports first); this wrap slots the Apple flavor in ahead of it.
// The chain: appledri flavor -> this context; everything else -> the GLES
// module's dispatch, which handles dri3, indirect, off and not-yet-probed.
const dispatchBelow = Drawable.renderingContextFactory['opengl'];
Drawable.renderingContextFactory['opengl'] = (window, config) => {
  const app = window.app;
  if (backendFor(app) === 'direct' && app._glCapsResolved?.flavor === 'appledri') {
    return new RenderingContextCGL(window, config);
  }
  return dispatchBelow(window, config);
};

export default RenderingContextCGL;
