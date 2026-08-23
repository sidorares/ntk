import x11 from 'x11';

import App from './app.js';
import Clipboard from './clipboard.js';
import { BLANK_CURSOR, CursorCache, cursorNames, cursorShapes, resolveCursorShape } from './cursor.js';
import { DEFAULT_GL_POLICY, GLError, GL_MODES, resolveGLPolicy, wantsDirect } from './gl.js';
import { GLXError } from './glx.js';
import Window from './window.js';
import {
  FocusProxy,
  XEMBED,
  XEMBED_OPCODE_NAMES,
  XEmbedPlug,
  XEmbedSocket,
  decodeXEmbedInfo,
  encodeXEmbedInfo,
  readXEmbedInfo
} from './xembed.js';
import { decodeKey, groupForState } from './keyboard.js';
import Pixmap from './pixmap.js';
import Picture from './picture.js';
import Region from './region.js';
import { Image, decodeImage, loadImage } from './image.js';
import {
  ImageData,
  fromStraightRgba,
  packIcons,
  pixelLayout,
  toStraightRgba,
  unpackIcons
} from './imagedata.js';
import { Surface } from './surface.js';
import { Path2D, parseSvgPath } from './path.js';
import Font from './text/font.js';
import FontManager from './text/fontmanager.js';
import {
  FontconfigFontSource,
  StaticFontSource,
  createFontSource,
  defaultFontSource,
  setDefaultFontSource
} from './text/fontsource.js';
import {
  CoverageAccumulator,
  DEFAULT_RASTER_POLICY,
  ScanlineRasterizer,
  defaultRasterizer,
  setDefaultRasterizer
} from './rasterize.js';
import { DEFAULT_MASK_POLICY } from './maskcluster.js';
import { DEFAULT_SHAPE_POLICY } from './shapeglyphs.js';
import { DEFAULT_SHARED_GLYPHS_POLICY } from './glyphdirectory.js';
import { warmSharedGlyphs } from './text/glyphs.js';
import { TextLayout } from './text/layout.js';
import SvgView from './widgets/svgview.js';
import { cssColor, cssColorStraight, premultiply } from './color.js';

// rendering context modules register themselves on Drawable. The direct one
// comes last on purpose: it wraps the 'opengl' factory the indirect one just
// registered, so that the backend-neutral name can dispatch on glPolicy.
import './renderingcontext_x11.js';
import { CanvasGradient, CanvasPattern } from './renderingcontext_2d.js';
import './renderingcontext_opengl.js';
import './renderingcontext_gles.js';

// One socket write per frame instead of one per request (x11 >= 3.6). A frame
// is emitted in one synchronous run of _runFrame() and ends with the frame
// fence's GetInputFocus, which x11 flushes on because it expects a reply — so
// the batch goes out at the frame boundary without ntk flushing anything by
// hand. 64 KB holds a heavy frame (a 72 KB frame is 2 writes, a typical one
// is 1); the client's own gates — the size cap, a 5 ms age limit and a flush
// before the event loop polls — bound how long anything can wait, so this
// cannot delay a frame or a reply. `bufferRequests: false` opts out.
const DEFAULT_BUFFER_REQUESTS = { maxSize: 64 * 1024 };

/**
 * Connect to the X server and resolve with an App.
 *
 *   const app = await createClient();
 *
 * The legacy node-style callback is still supported:
 *
 *   createClient((err, app) => { ... });
 *
 * @param {object} [options] passed through to x11.createClient
 *   (e.g. { display: ':1' }); ntk additionally understands
 *   { fontSource } — where fonts come from: a FontSource, `'system'` (the
 *   default, fontconfig via fc-match), or a font spec naming the faces the
 *   app itself ships — `'/app/fonts'`, `'./Inter.ttf'`, `[bytes]`,
 *   `{ fonts, alias }` — which is what an environment without fontconfig
 *   needs, since ntk ships no fonts (see docs/fonts.md) —
 *   { rasterizer, rasterPolicy } — where small fills and strokes are
 *   rasterized, and the thresholds for that choice (see docs/context-2d.md) —
 *   { glxVisual } — a visual id for getContext('opengl') to use instead of
 *   querying the server for one —
 *   { glPolicy } — which OpenGL backend to draw through: `'indirect'` (the
 *   default, indirect GLX), `'auto'` (direct rendering where it is available),
 *   `'direct'` or `'off'`; an object sets the direct backend's knobs too (see
 *   docs/context-gles.md) — and
 *   { onXError } — called with X protocol errors no request callback
 *   claimed (default: console.warn) —
 *   { sharedGlyphs } — the cross-process shared glyph cache
 *   (docs/shared-glyphs.md): on by default, `false` turns it off (as does
 *   the `NTK_NO_SHARED_GLYPHS` environment variable), an object sets the
 *   directory-side budget (`{ budgetBytes }`).
 *   x11's { bufferRequests } defaults to a 64 KB output buffer here, which
 *   makes a frame one socket write; pass false to write per request.
 * @param {function} [callback] optional node-style callback
 * @returns {Promise<App>}
 */
export function createClient(options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }

  const x11Options = { ...(options || {}) };
  if (x11Options.bufferRequests === undefined) x11Options.bufferRequests = DEFAULT_BUFFER_REQUESTS;

  const promise = new Promise((resolve, reject) => {
    // Resolve the font spec here rather than lazily in `app.fonts`, so a
    // missing directory is a rejected connect instead of a surprise inside
    // the first paint. Inside the executor so it rejects rather than throws
    // synchronously, which keeps the legacy callback form working. The
    // caller's options object is copied, never mutated.
    const appOptions = options ? { ...options } : {};
    if (appOptions.fontSource != null) {
      appOptions.fontSource = createFontSource(appOptions.fontSource);
    } else {
      // An app without a fontSource of its own resolves the process default
      // lazily, at first text layout — too late for the fontconfig source's
      // async fc-match prewarm to hide the ~50ms spawn (issue #182). Touch
      // the default now, while the connection handshake runs; only touch,
      // so a later setDefaultFontSource still takes effect.
      defaultFontSource();
    }
    // Same reasoning for the GL backend: a policy that names no real mode is
    // a rejected connect, not an exception thrown from inside a connection
    // callback later on — and asking now means a bad NTK_GL_POLICY is caught
    // even by an app that never mentions GL.
    const glPolicy = resolveGLPolicy(appOptions);

    x11.createClient(x11Options, (error, display) => {
      if (error) return reject(error);

      display.client.require('glx', (glxError, GLX) => {
        display.client.require('render', (renderError, Render) => {
          if (renderError) return reject(renderError);
          // preload Render and GLX; GLX is optional ( indirect GLX is often
          // disabled on modern servers )
          display.Render = Render;
          // x11 >= 3.3.0 clamps an out-of-range colour component and warns
          // once per connection; under NTK_STRICT_COLORS it throws instead,
          // which is how `npm test` catches a colour that reaches XRender
          // unpremultiplied (r, g or b above alpha) rather than silently
          // rendering too bright.
          if (process.env.NTK_STRICT_COLORS) Render.strictColors = true;
          display.GLX = glxError ? null : GLX;

          const app = new App(display, appOptions);
          // Build the visual -> picture format table (issue #295) now: a
          // picture is bound synchronously, so the table has to be here
          // before anything draws rather than fetched at the first paint.
          // It costs the connection nothing and no wait — node-x11 asked
          // `QueryPictFormats` itself while requiring RENDER and kept the
          // reply, so this only reads it. A server that cannot
          // answer leaves every format picked from the depth, as before.
          app.pictFormats().catch(() => null);
          // RENDER requires the client to declare its version before using
          // requests beyond 0.0, and the reply is what gates them afterwards
          // — CreateSolidFill needs 0.10 (see App#solidPicture). 0.11 is the
          // last published protocol revision.
          Render.QueryVersion(0, 11, (versionError, version) => {
            Render.version = versionError ? [0, 0] : version;

            const X = display.client;
            X.keycode2keysyms = {};

            function updateKeyboardMapping(min, max) {
              if (max <= min) return;
              X.GetKeyboardMapping(min, max - min, (err, list) => {
                if (err) return;
                for (let i = 0; i < list.length; ++i) X.keycode2keysyms[i + min] = list[i].slice();
              });
            }

            X.on('event', (ev) => {
              // MappingNotify
              if (ev.type === 34) {
                updateKeyboardMapping(ev.firstKeyCode, ev.firstKeyCode + ev.count);
              }
            });
            updateKeyboardMapping(display.min_keycode, display.max_keycode);

            // Under a policy that could pick the direct backend, find out
            // during the handshake whether it can: two extension queries,
            // running alongside the round trips already in flight here, so
            // that getContext() can choose a backend synchronously later.
            // Nothing to do under the default policy, which is why the common
            // case pays nothing for this.
            if (!wantsDirect(glPolicy)) return resolve(app);
            app.glCapabilities().then(
              () => resolve(app),
              // a probe that throws is a probe that found nothing, and GL is
              // not what the connection is for
              () => resolve(app)
            );
          });
        });
      });
    });
  });

  if (callback) {
    promise.then(
      (app) => callback(null, app),
      (err) => callback(err)
    );
  }
  return promise;
}

export {
  App,
  Clipboard,
  Window,
  // XEmbed (docs/xembed.md): also available as `ntk/xembed`
  XEmbedSocket,
  XEmbedPlug,
  FocusProxy,
  XEMBED,
  XEMBED_OPCODE_NAMES,
  encodeXEmbedInfo,
  decodeXEmbedInfo,
  readXEmbedInfo,
  BLANK_CURSOR,
  CursorCache,
  cursorNames,
  cursorShapes,
  resolveCursorShape,
  Pixmap,
  Picture,
  // server-side XFIXES regions (docs/context-2d.md#region-clips):
  // app.createRegion(rects) makes one, ctx.clipRegion(region) clips to it
  Region,
  Surface,
  // fill/stroke styles the 2d context hands back (docs/context-2d.md) —
  // exported for `instanceof`, not to be constructed directly
  CanvasGradient,
  CanvasPattern,
  Image,
  ImageData,
  pixelLayout,
  toStraightRgba,
  fromStraightRgba,
  packIcons,
  unpackIcons,
  decodeImage,
  loadImage,
  Path2D,
  parseSvgPath,
  Font,
  FontManager,
  FontconfigFontSource,
  StaticFontSource,
  createFontSource,
  defaultFontSource,
  setDefaultFontSource,
  CoverageAccumulator,
  ScanlineRasterizer,
  defaultRasterizer,
  setDefaultRasterizer,
  DEFAULT_RASTER_POLICY,
  DEFAULT_MASK_POLICY,
  DEFAULT_SHAPE_POLICY,
  // cross-process shared glyphs (docs/shared-glyphs.md): the directory-side
  // budget, and the prewarm that makes a first paint of already-shared text
  // rasterize and upload nothing
  DEFAULT_SHARED_GLYPHS_POLICY,
  warmSharedGlyphs,
  TextLayout,
  SvgView,
  cssColor,
  cssColorStraight,
  premultiply,
  decodeKey,
  groupForState,
  // the `code` on a failed GL setup: branch on it rather than on the message
  GLXError,
  // the same, for the direct backend, plus what glPolicy accepts
  GLError,
  GL_MODES,
  DEFAULT_GL_POLICY
};
export default { createClient };
