import x11 from 'x11';

import App from './app.js';
import Clipboard from './clipboard.js';
import { CursorCache, cursorShapes, resolveCursorShape } from './cursor.js';
import Window from './window.js';
import Pixmap from './pixmap.js';
import Picture from './picture.js';
import { Image, decodeImage, loadImage } from './image.js';
import { Path2D, parseSvgPath } from './path.js';
import Font from './text/font.js';
import FontManager from './text/fontmanager.js';
import {
  FontconfigFontSource,
  StaticFontSource,
  defaultFontSource,
  setDefaultFontSource
} from './text/fontsource.js';
import { TextLayout } from './text/layout.js';
import HtmlView from './widgets/htmlview.js';
import SvgView from './widgets/svgview.js';
import MarkdownView from './widgets/markdownview.js';
import TexView, { configureTex, layoutTex, TexBox } from './widgets/tex.js';
import { tokenize as highlightCode } from './widgets/highlight.js';

// rendering context modules register themselves on Drawable
import './renderingcontext_x11.js';
import './renderingcontext_2d.js';
import './renderingcontext_opengl.js';

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
 *   { fontSource } — a pluggable system-font lookup (see docs/fonts.md) —
 *   { glxVisual } — a visual id for getContext('opengl') to use instead of
 *   querying the server for one — and
 *   { onXError } — called with X protocol errors no request callback
 *   claimed (default: console.warn)
 * @param {function} [callback] optional node-style callback
 * @returns {Promise<App>}
 */
export function createClient(options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }

  const promise = new Promise((resolve, reject) => {
    x11.createClient(options || {}, (error, display) => {
      if (error) return reject(error);

      display.client.require('glx', (glxError, GLX) => {
        display.client.require('render', (renderError, Render) => {
          if (renderError) return reject(renderError);
          // preload Render and GLX; GLX is optional ( indirect GLX is often
          // disabled on modern servers )
          display.Render = Render;
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

          resolve(new App(display, options || {}));
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
  CursorCache,
  cursorShapes,
  resolveCursorShape,
  Pixmap,
  Picture,
  Image,
  decodeImage,
  loadImage,
  Path2D,
  parseSvgPath,
  Font,
  FontManager,
  FontconfigFontSource,
  StaticFontSource,
  defaultFontSource,
  setDefaultFontSource,
  TextLayout,
  HtmlView,
  SvgView,
  MarkdownView,
  TexView,
  TexBox,
  layoutTex,
  configureTex,
  highlightCode
};
// the yoga-layout instance ntk lays HtmlView out with — downstream layout
// consumers (e.g. the react-x11 renderer) must share it to avoid loading a
// second WASM copy with potentially mismatched enums
export { default as Yoga } from 'yoga-layout';
export default { createClient };
