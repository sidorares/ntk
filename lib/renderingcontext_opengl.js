import Drawable from './drawable.js';

// Indirect GLX rendering context exposing an OpenGL 1.4-style api.
// Note: many modern X servers ship with indirect GLX disabled — see README.
class RenderingContextOpenGL {
  constructor(window, visual) {
    // TODO: use glx api to query the best visual instead of shelling out
    if (typeof visual === 'undefined') visual = window.app?.options?.glxVisual;
    if (typeof visual === 'undefined') {
      // lazy builtin lookup: browser bundles must not depend on child_process
      const cp = globalThis.process?.getBuiltinModule?.('node:child_process');
      if (!cp) {
        throw new Error(
          "getContext('opengl'): no visual id — pass one explicitly or via createClient({ glxVisual }) when glxinfo cannot be run"
        );
      }
      visual = parseInt(cp.execSync('glxinfo -i -b').toString(), 10);
    }

    const X = window.X;
    const GLX = window.display.GLX;
    this.window = window;

    const ctx = X.AllocID();
    GLX.CreateContext(ctx, visual, 0, 0, 0);
    GLX.MakeCurrent(window.id, ctx, 0, () => {});

    const gl = GLX.renderPipeline(ctx);
    for (const key in gl) {
      if (key === 'SwapBuffers') continue;
      const val = gl[key];
      this[key] = typeof val === 'function' ? val.bind(gl) : val;
    }

    const windowId = window.id;
    this.SwapBuffers = () => gl.SwapBuffers.call(gl, windowId);

    this.CreateGLXPixmap = (pixmapId) => {
      const glxpixmapId = X.AllocID();
      GLX.CreateGLXPixmap(0, visual, pixmapId, glxpixmapId);
      return glxpixmapId;
    };
    this.BindTexImage = (pixmap, buffer) => {
      GLX.BindTexImage(ctx, pixmap, buffer);
    };
  }
}

// register context
Drawable.renderingContextFactory['opengl'] = (window, visual) =>
  new RenderingContextOpenGL(window, visual);

export default RenderingContextOpenGL;
