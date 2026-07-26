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

      <div style="display: flex; gap: 16px; align-items: center; margin: 8px 0">
        <img src="${gradientPng(120, 60)}" alt="generated gradient">
        <!-- inline svg renders through SvgView, sized like an image -->
        <svg width="60" height="60" viewBox="0 0 24 24">
          <defs>
            <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#ffba08"/>
              <stop offset="1" stop-color="#d00000"/>
            </linearGradient>
          </defs>
          <circle cx="12" cy="12" r="10" fill="none" stroke="url(#ring)" stroke-width="3"/>
          <path d="M8 12 l3 3 l5 -6" fill="none" stroke="#2d6a4f" stroke-width="2.5"/>
        </svg>
        <!-- and so do <img> elements with an svg data: URI source -->
        <img width="60" height="60" alt="svg heart" src="data:image/svg+xml,${encodeURIComponent(
          '<svg viewBox="0 0 32 32"><path d="M16 28 C4 19 2 12 6 8 C10 4 15 7 16 11 C17 7 22 4 26 8 C30 12 28 19 16 28 Z" fill="#e5383b"/></svg>'
        )}">
      </div>

      <h2>Pages</h2>
      <ul>
        <li><a href="page:styles">Styling showcase</a> — cascade, selectors, colors</li>
        <li><a href="page:svg">SVG</a> — inline markup and img sources</li>
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

  svg: `
    <body>
      <p><a href="page:home">← back</a></p>
      <h1>SVG in HtmlView</h1>
      <p>Inline <code>&lt;svg&gt;</code> elements are replaced elements —
        laid out like images (intrinsic size from
        <code>width</code>/<code>height</code>/<code>viewBox</code>,
        ratio-preserving shrink) and rendered by <code>SvgView</code>
        through the same server-side 2d pipeline.</p>

      <div style="display: flex; gap: 12px; align-items: flex-end">
        <svg width="90" height="90" viewBox="0 0 24 24">
          <rect x="2" y="2" width="20" height="20" rx="4" fill="#eef3fb" stroke="#ccd9ee"/>
          <path d="M6 16 L10 9 L13 13 L16 7 L18 16 Z" fill="#0077b6"/>
        </svg>
        <svg width="70" height="70" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" fill="#ffe9a8" stroke="#c8a028"/>
          <circle cx="9" cy="10" r="1.4" fill="#333"/>
          <circle cx="15" cy="10" r="1.4" fill="#333"/>
          <path d="M8 14 Q12 18 16 14" fill="none" stroke="#333" stroke-width="1.5"/>
        </svg>
        <svg width="50" height="90" viewBox="0 0 10 18">
          <rect x="4" y="6" width="2" height="12" fill="#7f4f24"/>
          <path d="M5 0 L9 8 H1 Z" fill="#2d6a4f"/>
        </svg>
      </div>

      <p>An <code>&lt;img&gt;</code> whose source is SVG (file path,
        <code>data:image/svg+xml</code>, or a <code>loadResource</code>
        buffer) is sniffed and routed the same way — vector, so it stays
        sharp at any size:</p>
      <img width="260" alt="scene" src="data:image/svg+xml,${encodeURIComponent(
        '<svg viewBox="0 0 60 30"><rect width="60" height="30" fill="#8ecae6"/><circle cx="50" cy="7" r="4" fill="#ffdd00"/><path d="M0 22 Q15 15 30 21 T60 20 V30 H0 Z" fill="#74c69d"/><path d="M12 24 L17 14 L22 24 Z" fill="#2d6a4f"/></svg>'
      )}">
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
