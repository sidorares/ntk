// Static HTML browser demo: the HtmlView widget renders HTML + CSS (block
// flow and flexbox via yoga-layout, shaped/wrapped text, PNG/JPEG images)
// with no scripting and no network access.
//
// Navigation contract: the widget never loads documents itself. Clicking a
// link only fires `onLink` — this app decides what that means (here: swap
// between in-memory pages with setHtml, open http(s) externally). The wheel
// scrolls (built into window mode); resize the window to re-wrap.
import { spawn } from 'node:child_process';

import { PNG } from 'pngjs';

import { createClient, HtmlView } from '../lib/index.js';

// a little generated image, embedded as a data URI (no files, no network)
function gradientPng(w, h) {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      png.data[i] = Math.round((255 * x) / w);
      png.data[i + 1] = 80;
      png.data[i + 2] = Math.round((255 * y) / h);
      png.data[i + 3] = 255;
    }
  }
  return 'data:image/png;base64,' + PNG.sync.write(png).toString('base64');
}

const pages = {
  home: `
    <body>
      <h1 style="border-bottom: 2px solid #ddd; padding-bottom: 8px">HtmlView</h1>
      <p>A <b>static HTML widget</b> for ntk: <i>no scripts</i>, no network —
        just markup, CSS and the ntk rendering pipeline (server-side composition,
        shaped text, PNG/JPEG images).</p>

      <div style="display: flex; gap: 12px; margin: 16px 0">
        <div style="flex: 1; background: #eef3fb; padding: 12px; border: 1px solid #ccd9ee">
          <h3 style="margin: 0 0 6px 0">Layout</h3>
          Block flow and <code>display: flex</code> are computed by
          <a href="https://www.npmjs.com/package/yoga-layout">yoga-layout</a>.
        </div>
        <div style="flex: 1; background: #fbf3ee; padding: 12px; border: 1px solid #eeddcc">
          <h3 style="margin: 0 0 6px 0">Text</h3>
          Kerning, ligatures, bidi and font fallback:
          世界 · العالم · κόσμος · мир
        </div>
      </div>

      <img src="${gradientPng(120, 60)}" alt="generated gradient">

      <h2>Pages</h2>
      <ul>
        <li><a href="page:styles">Styling showcase</a> — cascade, selectors, colors</li>
        <li><a href="page:pre">Preformatted text</a> — white-space handling</li>
        <li><a href="https://github.com/sidorares/ntk">ntk on GitHub</a> (opens in your browser)</li>
      </ul>

      <blockquote style="border-left: 3px solid #d8d8d8; padding-left: 12px; color: #555">
        Clicking a link never navigates by itself — the app's
        <code>onLink</code> callback decides what happens.
      </blockquote>
    </body>`,

  styles: `
    <body>
      <style>
        .card { border: 1px solid #ddd; padding: 10px; margin: 10px 0 }
        .card h3 { margin: 0; color: #205090 }
        .tag { background: #ffe9a8; padding: 1px 4px }
        #special { background: #e8ffe8 }
      </style>
      <p><a href="page:home">← back</a></p>
      <h1>Styling</h1>
      <div class="card">
        <h3>Class selector</h3>
        <p style="margin: 6px 0 0 0">Styled by <code>.card</code> and <code>.card h3</code>,
          with an inline <span class="tag">highlighted tag</span>.</p>
      </div>
      <div class="card" id="special">
        <h3>Id beats class</h3>
        <p style="margin: 6px 0 0 0">This card adds <code>#special</code> background.</p>
      </div>
      <p style="text-align: center">centered ·
        <s>struck</s> · <u>underlined</u> ·
        <span style="color: #c02050">colored</span> ·
        <b style="font-size: 20px">bigger</b></p>
      <ol style="list-style-type: lower-alpha">
        <li>alpha markers</li>
        <li>are supported too</li>
      </ol>
    </body>`,

  pre: `
    <body>
      <p><a href="page:home">← back</a></p>
      <h1>Preformatted</h1>
      <pre style="background: #f4f4f4; padding: 10px; border: 1px solid #e0e0e0">const app = await createClient();
const wnd  = app.createWindow({ width: 640, height: 480 });
const view = new HtmlView(wnd, {
  onLink: (href) => console.log(href)
});
view.setHtml('&lt;h1&gt;Hello&lt;/h1&gt;');
wnd.map();</pre>
      <p style="white-space: nowrap">And this long nowrap line just keeps going and going without ever wrapping, overflowing quietly.</p>
    </body>`
};

const app = await createClient();
const wnd = app.createWindow({ width: 660, height: 700, title: 'ntk html' });

const view = new HtmlView(wnd, {
  onLink: (href) => {
    if (href.startsWith('page:')) {
      const page = pages[href.slice(5)];
      if (page) {
        view.setHtml(page);
        wnd.setTitle(`ntk html — ${href.slice(5)}`);
      }
      return;
    }
    if (/^https?:/.test(href)) {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(opener, [href], { detached: true, stdio: 'ignore' }).unref();
    }
  }
});

view.setHtml(pages.home);
wnd.map();
console.log('click around — wheel scrolls, links navigate via the onLink callback');
