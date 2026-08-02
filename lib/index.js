import x11 from 'x11';

import App from './app.js';
import Clipboard from './clipboard.js';
import { BLANK_CURSOR, CursorCache, cursorNames, cursorShapes, resolveCursorShape } from './cursor.js';
import Window from './window.js';
import { loadLayout } from './yoga.js';
import { decodeKey, groupForState } from './keyboard.js';
import Pixmap from './pixmap.js';
import Picture from './picture.js';
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
import { TextLayout } from './text/layout.js';
import HtmlView from './widgets/htmlview.js';
import SvgView from './widgets/svgview.js';
import MarkdownView from './widgets/markdownview.js';
import TexView, { configureTex, layoutTex, TexBox } from './widgets/tex.js';
import { tokenize as highlightCode } from './widgets/highlight.js';
import { cssColorStraight, premultiply } from './color.js';
import { cssColor, cssLength } from './widgets/css.js';

// rendering context modules register themselves on Drawable
import './renderingcontext_x11.js';
import './renderingcontext_2d.js';
import './renderingcontext_opengl.js';

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
 *   querying the server for one — and
 *   { onXError } — called with X protocol errors no request callback
 *   claimed (default: console.warn).
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

  // the layout engine's WASM loads alongside the connection, so widgets are
  // usable synchronously by the time the App exists (see lib/yoga.js)
  const layout = loadLayout();

  const connecting = new Promise((resolve, reject) => {
    // Resolve the font spec here rather than lazily in `app.fonts`, so a
    // missing directory is a rejected connect instead of a surprise inside
    // the first paint. Inside the executor so it rejects rather than throws
    // synchronously, which keeps the legacy callback form working. The
    // caller's options object is copied, never mutated.
    const appOptions = options ? { ...options } : {};
    if (appOptions.fontSource != null) appOptions.fontSource = createFontSource(appOptions.fontSource);

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

          resolve(new App(display, appOptions));
        });
      });
    });
  });

  const promise = Promise.all([connecting, layout]).then(([app]) => app);

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
  BLANK_CURSOR,
  CursorCache,
  cursorNames,
  cursorShapes,
  resolveCursorShape,
  Pixmap,
  Picture,
  Surface,
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
  TextLayout,
  HtmlView,
  SvgView,
  MarkdownView,
  TexView,
  TexBox,
  layoutTex,
  configureTex,
  highlightCode,
  cssColor,
  cssColorStraight,
  premultiply,
  cssLength,
  decodeKey,
  groupForState
};
// The layout engine ntk lays HtmlView out with — downstream layout consumers
// (e.g. the react-x11 renderer) must import it from here rather than from
// `yoga-layout`, or they get a second WASM instance whose Nodes cannot be
// mixed with ntk's. Its enum constants are readable as soon as ntk is
// imported; `Node`/`Config` need the WASM, which `createClient()` loads —
// `loadLayout()` is there for widgets used without an App.
export { default as Yoga, loadLayout, layoutLoaded } from './yoga.js';
export default { createClient };
