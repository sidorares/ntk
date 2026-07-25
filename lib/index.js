import x11 from 'x11';

import App from './app.js';
import Window from './window.js';
import Pixmap from './pixmap.js';
import Picture from './picture.js';
import Font from './text/font.js';
import FontManager from './text/fontmanager.js';
import { TextLayout } from './text/layout.js';
import MarkdownView from './widgets/markdownview.js';
import TexView, { layoutTex, TexBox } from './widgets/tex.js';
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
 *   (e.g. { display: ':1' })
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

          resolve(new App(display));
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
  Window,
  Pixmap,
  Picture,
  Font,
  FontManager,
  TextLayout,
  MarkdownView,
  TexView,
  TexBox,
  layoutTex,
  highlightCode
};
export default { createClient };
