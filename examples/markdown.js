// Markdown documentation browser: full client-side layout (shaping,
// wrapping, styles, highlighted + math fences) with clickable local links.
//
// The start page links to the ntk documentation in docs/; clicking a local
// .md link navigates (Backspace or the "back" link returns), http(s) links
// open in the system browser, the wheel / arrow keys scroll. Resize the
// window to watch everything re-wrap.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient, MarkdownView } from '../lib/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const HOME = `# ntk text rendering

**[View ntk documentation](docs/README.md)**

The text pipeline is **pure JavaScript**: fonts are parsed with *fontkit*,
shaped with OpenType \`GSUB\`/\`GPOS\` (kerning, ligatures, contextual forms),
wrapped with UAX#14 line breaking and reordered with UAX#9 bidi.

## Wire efficiency

Glyphs upload to the X server *once* per face and size; after that a line of
text costs about **1 byte per glyph** on the wire:

\`\`\`js
// fences are syntax highlighted (dependency-free tokenizer)
const layout = ctx.layoutText(text, { maxWidth: wnd.width - 32 });
layout.draw(ctx, 16, 16);
\`\`\`

## Math

Fences tagged \`math\`/\`latex\` render with KaTeX:

\`\`\`math
\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}
\`\`\`

## Tables

| Stage | What happens | Cost |
|:------|:------------:|-----:|
| shape | \`GSUB\`/\`GPOS\`, kerning | *cached* |
| wrap | UAX#14 breaks | per width |
| draw | CompositeGlyphs | **~1 byte/glyph** |

## Things that just work

- Kerning pairs like AV and _To_ — compare with your browser
- Automatic font fallback: 世界 · العالم · κόσμος · мир
- Ordered lists:
  1. shape
  2. wrap
  3. composite
- [Links](https://github.com/sidorares/ntk) and \`inline code\`

> Blockquotes wrap like everything else — try making the window narrow.

---

*That's all, folks.*`;

const app = await createClient();
const wnd = app.createWindow({ width: 640, height: 720, title: 'ntk markdown' });
const ctx = wnd.getContext('2d');
const view = new MarkdownView(null, { fonts: app.fonts });

let currentPath = null; // null = home page, else absolute path of the .md
const history = [];
let scroll = 0;
let layoutWidth = -1;

function show(path) {
  currentPath = path;
  scroll = 0;
  layoutWidth = -1;
  let md;
  if (!path) {
    md = HOME;
    wnd.setTitle('ntk markdown');
  } else {
    try {
      md = `[← back](ntk:back)\n\n${readFileSync(path, 'utf8')}`;
    } catch (err) {
      md = `[← back](ntk:back)\n\n# Cannot open\n\n\`${path}\`\n\n${err.message}`;
    }
    wnd.setTitle(`ntk docs — ${relative(repoRoot, path)}`);
  }
  view.setMarkdown(md);
  render();
}

function render() {
  if (layoutWidth !== wnd.width) {
    view.layout(wnd.width);
    layoutWidth = wnd.width;
  }
  scroll = Math.max(0, Math.min(scroll, view.contentHeight - wnd.height));
  ctx.fillStyle = view.theme.background;
  ctx.fillRect(0, 0, wnd.width, wnd.height);
  view.draw(ctx, 0, view.theme.padding - scroll);
}

function navigate(href) {
  if (href === 'ntk:back') {
    show(history.pop() ?? null);
    return;
  }
  if (/^https?:/.test(href)) {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [href], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const clean = href.replace(/#.*$/, '');
  if (!clean.endsWith('.md')) return; // images etc.
  const base = currentPath ? dirname(currentPath) : repoRoot;
  const target = resolve(base, clean);
  if (!target.startsWith(repoRoot)) return; // stay inside the repo
  history.push(currentPath);
  show(target);
}

wnd.on('expose', render);
wnd.on('resize', render);

wnd.on('mousedown', (ev) => {
  if (ev.keycode === 4 || ev.keycode === 5) {
    scroll += ev.keycode === 4 ? -60 : 60; // wheel
    render();
    return;
  }
  if (ev.keycode !== 1) return; // left click
  const href = view.linkAt(ev.x, ev.y);
  if (href) navigate(href);
});

const KEY = { up: 0xff52, down: 0xff54, pageUp: 0xff55, pageDown: 0xff56, home: 0xff50, end: 0xff57, backspace: 0xff08 };
wnd.on('keydown', (ev) => {
  const sym = wnd.X.keycode2keysyms[ev.keycode]?.[0];
  const page = wnd.height - 40;
  if (sym === KEY.up) scroll -= 40;
  else if (sym === KEY.down) scroll += 40;
  else if (sym === KEY.pageUp) scroll -= page;
  else if (sym === KEY.pageDown) scroll += page;
  else if (sym === KEY.home) scroll = 0;
  else if (sym === KEY.end) scroll = Infinity;
  else if (sym === KEY.backspace) return navigate('ntk:back');
  else return;
  render();
});

show(null);
wnd.map();
console.log('click "View ntk documentation" — wheel/arrows scroll, Backspace goes back');
