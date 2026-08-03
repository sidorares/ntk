import Drawable from './drawable.js';
import { GLXError, chooseGLXConfig, createContext, glxErrorReport } from './glx.js';

// Indirect GLX rendering context exposing an OpenGL 1.4-style api.
// Note: many modern X servers ship with indirect GLX disabled — see README.
//
// Setting up a context is asynchronous by protocol: the visual has to be
// discovered (GetFBConfigs) and, above all, GLX Render requests carry the
// *context tag* the server returns from MakeCurrent — not the context XID.
// The api stays synchronous by queueing GL calls until the tag arrives and
// replaying them in order; `await gl.ready` waits for the setup instead.
class RenderingContextOpenGL {
  constructor(window, config) {
    const X = window.X;
    const GLX = window.display.GLX;
    if (!GLX) {
      const err = new Error(
        `getContext('opengl'): ${process.env.DISPLAY || 'the X server'} does not have the GLX extension, so it cannot do OpenGL at all`
      );
      err.code = GLXError.NO_EXTENSION;
      throw err;
    }

    this.window = window;
    this.X = X;
    this.GLX = GLX;
    /** the MakeCurrent context tag every Render request carries; 0 until ready */
    this.contextTag = 0;
    /** the GLX context XID */
    this.contextId = 0;
    /** the config chosen (or passed in), see app.chooseGLXConfig */
    this.config = null;
    this.visual = 0;
    this.error = null;

    // GL commands land here until the tag is known, then in the real
    // pipeline. renderPipeline() issues no traffic, so a throwaway one is a
    // safe source of the method names and GL constants.
    let pipeline = null;
    const queue = [];
    const template = GLX.renderPipeline(0);
    for (const key in template) {
      if (typeof template[key] !== 'function') {
        this[key] = template[key];
        continue;
      }
      this[key] = (...args) => {
        if (pipeline) return pipeline[key](...args);
        queue.push([key, args]);
      };
    }

    // SwapBuffers swaps the owning window
    const swapBuffers = this.SwapBuffers;
    this.SwapBuffers = () => swapBuffers(window.id);

    const afterReady = (fn) => {
      if (this.contextTag) return fn();
      this.ready.then(fn, () => {});
    };

    this.CreateGLXPixmap = (pixmapId) => {
      const glxpixmapId = X.AllocID();
      afterReady(() => GLX.CreateGLXPixmap(0, this.visual, pixmapId, glxpixmapId));
      return glxpixmapId;
    };
    this.BindTexImage = (pixmap, buffer, attribs) => {
      afterReady(() => GLX.BindTexImage(this.contextTag, pixmap, buffer, attribs));
    };
    this.ReleaseTexImage = (pixmap, buffer) => {
      afterReady(() => GLX.ReleaseTexImage(this.contextTag, pixmap, buffer));
    };

    /** resolves with this context once it is current, rejects on failure */
    this.ready = (async () => {
      const cfg = await this._resolveConfig(config);
      this.config = cfg;
      this.visual = cfg.visual;
      if (window.visual && window.visual !== cfg.visual) {
        console.warn(
          `ntk: getContext('opengl') is using visual 0x${cfg.visual.toString(16)} on a window created with visual 0x${window.visual.toString(16)} — create the window with the visual from app.chooseGLXConfig()`
        );
      }

      const ctx = X.AllocID();
      this.contextId = ctx;
      // CreateContext first, and on its own: it is the request a server with
      // indirect GLX disabled rejects, and going on to MakeCurrent would bury
      // that under a GLXBadContext about the context that was never created
      await createContext(GLX, ctx, cfg).catch((err) => {
        this.contextId = 0; // nothing to destroy
        throw err;
      });
      const tag = await new Promise((resolve, reject) => {
        GLX.MakeCurrent(window.id, ctx, 0, (err, contextTag) => {
          if (!err) return resolve(contextTag);
          const failed = new Error(`GLX MakeCurrent failed: ${err.message}`);
          failed.code = GLXError.CONTEXT_FAILED;
          failed.cause = err;
          reject(failed);
        });
      });

      this.contextTag = tag;
      pipeline = GLX.renderPipeline(tag);
      for (const [key, args] of queue) pipeline[key](...args);
      queue.length = 0;
      return this;
    })();

    this.ready.catch((err) => {
      this.error = err;
      queue.length = 0;
      console.warn(glxErrorReport(err));
    });
  }

  // an explicit config object or visual id wins; otherwise ask the server
  // for one, preferring a config for the visual the window already has
  async _resolveConfig(config) {
    if (config && typeof config === 'object') {
      if (!config.visual)
        throw new Error("getContext('opengl'): config has no visual — use app.chooseGLXConfig()");
      return config;
    }
    const app = this.window.app;
    const visual = config ?? app?.options?.glxVisual;
    if (visual) return chooseGLXConfig(app, { visual });
    const screen = app.display.screen[0];
    return chooseGLXConfig(app, {
      preferVisual: this.window.visual || screen.root_visual
    });
  }

  /** release the context (the window keeps its drawable) */
  destroy() {
    if (!this.contextId) return;
    const { GLX } = this;
    const ctx = this.contextId;
    const tag = this.contextTag;
    this.contextId = 0;
    this.contextTag = 0;
    if (tag) GLX.MakeCurrent(0, 0, tag, () => {});
    GLX.DestroyContext(ctx);
  }

  [Symbol.dispose]() {
    this.destroy();
  }
}

// register context
Drawable.renderingContextFactory['opengl'] = (window, config) => new RenderingContextOpenGL(window, config);

export default RenderingContextOpenGL;
