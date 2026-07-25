// Markdown rendering: full client-side layout (shaping, wrapping, styles)
// drawn with batched server-side glyph composition. Resize the window to
// watch it re-wrap.
import { createClient, MarkdownView } from '../lib/index.js';

const app = await createClient();
const wnd = app.createWindow({ width: 640, height: 720, title: 'ntk markdown' });

const view = new MarkdownView(wnd);
view.setMarkdown(`# ntk text rendering

The text pipeline is **pure JavaScript**: fonts are parsed with *fontkit*,
shaped with OpenType \`GSUB\`/\`GPOS\` (kerning, ligatures, contextual forms),
wrapped with UAX#14 line breaking and reordered with UAX#9 bidi.

## Wire efficiency

Glyphs upload to the X server *once* per face and size; after that a line of
text costs about **1 byte per glyph** on the wire:

\`\`\`js
const layout = ctx.layoutText(text, { maxWidth: wnd.width - 32 });
layout.draw(ctx, 16, 16);
\`\`\`

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

*That's all, folks.*`);

wnd.map();
