// Direct rendering context: OpenGL ES 2 on the GPU, frames delivered to the
// server as dma-buf descriptors over DRI3 + Present (lib/glswapchain.js).
//
// The API is WebGL-shaped and camelCase — `gl.createShader`, `gl.drawElements`
// — because that is what the addon's ES 2 binding exposes and what anyone
// writing shaders already knows. It is *not* the same API as the indirect GLX
// context, whose OpenGL 1.x commands are PascalCase and whose pipeline has no
// shaders at all; the two backends are honestly different rather than one
// pretending to be the other. Cross-backend code branches on `gl.backend`
// ('direct' or 'indirect') — see docs/context-gles.md.
//
// Setup is synchronous, which is the point: creating the GPU context and its
// buffers needs the DRM device and nothing from the X server, so `gl.*` works
// on the line after `getContext`. Only *presenting* needs the server, and
// `ready` is what reports whether that works — it resolves when the first
// buffer has been imported by the server, which is the moment the whole path
// is proven.

import Drawable from './drawable.js';
import { GLError, backendFor, glError, loadDriAddon } from './gl.js';
import { GLSwapchain } from './glswapchain.js';

/**
 * One GPU context per app and pixel format, not one per surface.
 *
 * An EGL context is expensive (a device, a GBM device, a display, a config
 * scan) and every surface in an app wants the same one; sharing it also means
 * textures and programs are shared between surfaces, as they are between
 * canvases in a browser tab. The cost is that exactly one surface is current
 * at a time, which `_bind` takes care of.
 */
function sharedGpu(app, dri, { format, depthSize, devicePath }) {
  const key = `${format}|${depthSize}|${devicePath ?? ''}`;
  const cache = (app._glGpus ??= new Map());
  const existing = cache.get(key);
  if (existing) return existing;
  let gpu;
  try {
    gpu = new dri.Gpu({ format, depthSize, ...(devicePath ? { devicePath } : {}) });
  } catch (err) {
    throw glError(
      GLError.CONTEXT_FAILED,
      `could not create a GPU context on ${devicePath ?? 'the default render node'}: ${err.message}`,
      null,
      err
    );
  }
  cache.set(key, gpu);
  return gpu;
}

class RenderingContextGLES {
  constructor(window, config = {}) {
    const app = window.app;
    const caps = app._glCapsResolved;
    if (!caps) {
      throw glError(
        GLError.CONTEXT_FAILED,
        "getContext('gles') needs the direct-rendering probe to have answered, and it has not",
        `createClient() runs the probe during the handshake when glPolicy could pick the
direct backend, so a context can be created synchronously afterwards. Under the
default policy ('indirect') it does not run, and asking for this context by name
does not make it retroactive. Either:

  const app = await createClient({ glPolicy: 'auto' });   // probe at connect
  await app.glCapabilities();                             // or ask, once, later`
      );
    }
    if (!caps.direct) throw caps.reason;

    const dri = loadDriAddon();
    this.window = window;
    this.app = app;
    this.X = window.X;
    this.dri = dri;
    /** which backend this is, for code that runs on either */
    this.backend = 'direct';
    this.error = null;

    // The buffer format has to match how the server will read the pixmap, and
    // that is the window's depth: 24 is XRGB (opaque), 32 is ARGB (the
    // compositor blends the alpha). A window created without an explicit depth
    // has the root's.
    const depth = window.depth || app.display.screen[0].root_depth || 24;
    if (depth !== 24 && depth !== 32) {
      throw glError(
        GLError.CONTEXT_FAILED,
        `direct rendering needs a 24- or 32-bit window, and this one is ${depth}-bit`,
        'Create the window with depth 24 (opaque) or 32 (per-pixel alpha, via\napp.findArgbVisual()).'
      );
    }
    this.depth = depth;

    const policy = app.glPolicy;
    this.gpu = sharedGpu(app, dri, {
      format: depth === 32 ? dri.FORMAT.ARGB8888 : dri.FORMAT.XRGB8888,
      depthSize: config.depthSize ?? config.DEPTH_SIZE ?? 16,
      devicePath: policy.devicePath ?? caps.device
    });

    this.swapchain = new GLSwapchain({
      window,
      gpu: this.gpu,
      dri,
      DRI3: caps.DRI3,
      Present: caps.Present,
      depth,
      policy
    });
    window._setGenericEventSink(caps.Present.majorOpcode, this.swapchain);

    /**
     * Resolves once a frame's buffer has been accepted by the server — the
     * whole path proven, not just the parts on this side of the socket — and
     * rejects with a coded error if it cannot be. Nothing needs to await it
     * before drawing; it is how a caller decides to show a fallback instead.
     */
    this.ready = new Promise((resolve, reject) => {
      this.swapchain.onValidated = (err) => {
        if (err) {
          this.error = err;
          reject(err);
        } else resolve(this);
      };
    });
    // a rejection nobody is listening for must not take the process down;
    // `error` and the onError hook are the other ways to find out
    this.ready.catch(() => {});
    this.swapchain.onReady = () => this._onFrameAvailable();
    this._frameWanted = null;

    // GL entry points and constants, bound so that whichever surface this
    // context owns is the current one when they run
    this._installGL();
    this.makeCurrent();
    // settle `ready` now rather than on the first frame — see validate()
    this.swapchain.validate();
  }

  /**
   * Copy the addon's ES 2 namespace onto this context.
   *
   * Every function is wrapped with the currency check rather than documented
   * as the caller's job: the shared context means another surface may have
   * been current since the last call here, and a GL call against the wrong
   * surface draws into the wrong window. The check is one comparison against
   * a field — next to a native call, it does not register.
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
   * Make this context's surface current, sizing it to the window first.
   *
   * Call it at the top of a frame: that is where a resize can be honoured
   * without throwing away a half-drawn one.
   */
  makeCurrent() {
    if (this.error || this._destroyed || this.window._destroyed) return this;
    const width = this.window.width;
    const height = this.window.height;
    if (width !== this._width || height !== this._height) {
      this._width = width;
      this._height = height;
      this._surface = null; // a new size is a new generation
    }
    this._bind();
    return this;
  }

  _bind() {
    if (this.error || this._destroyed) return;
    if (!this._surface) {
      this._surface = this.swapchain.surfaceFor(this._width ?? this.window.width, this._height ?? this.window.height);
    }
    this.gpu.makeCurrent(this._surface);
    this.app._glCurrent = this;
  }

  /**
   * Is a frame worth drawing right now?
   *
   * False when every buffer is still with the server. Drawing anyway is not
   * wrong, only wasted: the swap that followed would have nowhere to go.
   * `onFrameAvailable` is the other half — it fires when this turns true.
   */
  canRender() {
    return this.swapchain.canRender();
  }

  /** Called when `canRender()` became true again after a swap was refused. */
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
   * Show the frame just drawn.
   *
   * Named as the indirect context names it, so a draw loop can end the same
   * way on either backend; `swapBuffers` is the same call under the spelling
   * the rest of this API uses. Returns false when the frame could not be
   * shown yet — see `canRender`.
   */
  SwapBuffers() {
    if (this.error || this._destroyed || this.window._destroyed) return false;
    const sent = this.swapchain.swap();
    // A resize seen only now still gets picked up: the next frame binds a
    // generation at the new size. Checked after the swap so the frame that was
    // drawn at the old size is the one that goes out.
    if (this.window.width !== this._width || this.window.height !== this._height) {
      this._surface = null;
    }
    return sent;
  }

  swapBuffers() {
    return this.SwapBuffers();
  }

  /** The GL renderer string, once there is a context — handy in bug reports. */
  get renderer() {
    try {
      return this.dri.gl.getString(this.dri.GL.RENDERER);
    } catch {
      return null;
    }
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.swapchain.destroy();
    this.window._setGenericEventSink(0, null);
    if (this.app._glCurrent === this) {
      this.app._glCurrent = null;
      try {
        this.gpu.makeCurrent(null);
      } catch {
        // the context is going away regardless
      }
    }
    this._surface = null;
    // the Gpu itself is shared and outlives this context (App#close frees it)
  }

  [Symbol.dispose]() {
    this.destroy();
  }
}

Drawable.renderingContextFactory['gles'] = (window, config) => new RenderingContextGLES(window, config);

// `getContext('opengl')` is the backend-neutral name: it is what the indirect
// context registered before there was a choice, and what code that does not
// care should keep asking for. The policy decides which one it gets, and the
// default policy is still the indirect one, so nothing changes under an app
// that has not opted in.
const indirectFactory = Drawable.renderingContextFactory['opengl'];
Drawable.renderingContextFactory['opengl'] = (window, config) => {
  const app = window.app;
  const backend = backendFor(app);
  if (backend === 'direct') return new RenderingContextGLES(window, config);
  if (backend === 'off') {
    const caps = app._glCapsResolved;
    throw (
      caps?.reason ??
      glError(GLError.DISABLED, "glPolicy is 'off', so getContext('opengl') has no backend to use")
    );
  }
  // null: the policy could pick direct, but the probe has not answered — a
  // policy raised after connecting. 'direct' must not quietly become the other
  // backend, because the whole point of asking for it by name is that the draw
  // code only speaks ES 2.
  if (backend === null) {
    if (app.glPolicy.mode === 'direct') {
      throw glError(
        GLError.CONTEXT_FAILED,
        "glPolicy is 'direct' but the direct-rendering probe has not answered, so there is no context to give you",
        'The probe runs inside createClient() when the policy is set there. A policy\n' +
          'raised afterwards needs one `await app.glCapabilities()` first.'
      );
    }
    console.warn(
      "ntk: glPolicy is 'auto' but the direct-rendering probe has not answered yet, so " +
        "getContext('opengl') is using indirect GLX. Pass glPolicy to createClient(), or " +
        'await app.glCapabilities() before creating the context.'
    );
  }
  return indirectFactory(window, config);
};

export default RenderingContextGLES;
