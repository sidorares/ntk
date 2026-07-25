import { TextLayout } from '../text/layout.js';
import { tokenize } from './highlight.js';
import { parseMarkdown } from './markdown.js';
import { layoutTex } from './tex.js';

const MATH_LANGS = new Set(['math', 'tex', 'latex', 'katex']);

const DEFAULT_THEME = {
  family: 'sans-serif',
  monoFamily: 'monospace',
  size: 16,
  color: '#222222',
  background: 'white',
  lineHeight: 1.35,
  headingScales: [2, 1.5, 1.25, 1.1, 1, 0.9],
  linkColor: '#0b61c9',
  codeColor: '#8f2b4f',
  codeBg: '#f2f2f2',
  quoteColor: '#555555',
  quoteBar: '#d8d8d8',
  hrColor: '#dddddd',
  tableBorder: '#d8d8d8',
  tableHeaderBg: '#f7f7f7',
  blockSpacing: 0.7, // em (of base size) between blocks
  padding: 16,
  // fence syntax highlighting (lib/widgets/highlight.js token kinds);
  // unlisted kinds (incl. 'plain') fall back to the base text color
  codeTheme: {
    keyword: '#a626a4',
    literal: '#0184bc',
    string: '#50a14f',
    number: '#986801',
    comment: '#a0a1a7',
    tag: '#e45649',
    attr: '#986801',
    function: '#4078f2'
  }
};

/**
 * A widget that renders markdown into a window (or any 2d context target).
 *
 * All layout runs client-side through the text API (`FontManager` /
 * `TextLayout`): heading/paragraph/list/quote/code blocks become styled
 * spans, get shaped (kerning, fallback, bidi) and wrapped to the container
 * width; drawing batches glyphs into minimal CompositeGlyphs requests.
 *
 *   const view = new MarkdownView(wnd, { theme: { size: 15 } });
 *   view.setMarkdown('# Hello\n\nSome *markdown* here.');
 *   wnd.map();
 *
 * Standalone use (no window attach): `view.layout(width)` then
 * `view.draw(ctx, x, y)`; `view.contentHeight` after layout.
 */
export default class MarkdownView {
  constructor(window, opts = {}) {
    this.window = window ?? null;
    this._standaloneFonts = opts.fonts ?? null; // for headless layout without a window
    this.theme = { ...DEFAULT_THEME, ...(opts.theme || {}) };
    if (opts.theme?.codeTheme) {
      this.theme.codeTheme = { ...DEFAULT_THEME.codeTheme, ...opts.theme.codeTheme };
    }
    if (opts.padding !== undefined) this.theme.padding = opts.padding;
    this._blocks = [];
    this._items = []; // placed draw items from the last layout()
    this._links = []; // clickable link rects from the last draw()
    this._layoutWidth = -1;
    this.contentHeight = 0;
    /** called with (href, event) when a rendered link is clicked (window
     *  mode wires mousedown automatically; standalone callers use linkAt) */
    this.onLink = opts.onLink ?? null;

    if (this.window) {
      this._ctx = this.window.getContext('2d');
      this.window.on('expose', () => this.render());
      this.window.on('resize', () => {
        this._layoutWidth = -1; // invalidate
      });
      this.window.on('mousedown', (ev) => {
        if (ev.keycode !== 1 || !this.onLink) return; // left button only
        const href = this.linkAt(ev.x, ev.y);
        if (href) this.onLink(href, ev);
      });
    }
  }

  /**
   * The link href under a point, or null. Coordinates are in the same
   * device space as the last `draw()` (window mode: window coordinates).
   */
  linkAt(x, y) {
    for (const l of this._links) {
      if (x >= l.x && x < l.x + l.w && y >= l.y && y < l.y + l.h) return l.href;
    }
    return null;
  }

  setMarkdown(src) {
    this._blocks = parseMarkdown(src);
    this._layoutWidth = -1;
    if (this.window && this.window._mapped) this.render();
    return this;
  }

  /** lay content out for a container width; returns total content height */
  layout(width) {
    const fonts = this._fonts();
    this._items = [];
    const t = this.theme;
    const inner = Math.max(20, width - t.padding * 2);
    const y = this._layoutBlocks(fonts, this._blocks, this._blockStyles(), t.padding, 0, inner);
    this.contentHeight = y + t.padding * 2;
    this._layoutWidth = width;
    return this.contentHeight;
  }

  _fonts() {
    if (this.window) return this.window.app.fonts;
    if (!this._standaloneFonts) {
      throw new Error('MarkdownView without a window needs { fonts: new FontManager() }');
    }
    return this._standaloneFonts;
  }

  _blockStyles() {
    const t = this.theme;
    return {
      base: { family: t.family, size: t.size, color: t.color },
      mono: { family: t.monoFamily, size: t.size * 0.9, color: t.codeColor }
    };
  }

  /** recursive block layout; returns the y after the last block */
  _layoutBlocks(fonts, blocks, styles, x, y, width) {
    const t = this.theme;
    const spacing = t.blockSpacing * t.size;
    let first = true;

    for (const block of blocks) {
      if (!first) y += spacing;
      first = false;

      switch (block.type) {
        case 'heading': {
          const scale = t.headingScales[block.level - 1] ?? 1;
          const style = {
            ...styles.base,
            size: Math.round(t.size * scale),
            weight: 700
          };
          y += block.level <= 2 ? spacing * 0.5 : 0;
          const layout = new TextLayout(fonts, this._spans(block.children, style), style, {
            maxWidth: width,
            lineHeight: t.lineHeight
          });
          this._items.push({ kind: 'text', x, y, layout });
          y += layout.height;
          break;
        }

        case 'paragraph': {
          const style = styles.base;
          const layout = new TextLayout(fonts, this._spans(block.children, style), style, {
            maxWidth: width,
            lineHeight: t.lineHeight
          });
          this._items.push({ kind: 'text', x, y, layout });
          y += layout.height;
          break;
        }

        case 'code': {
          // ```math / ```latex fences render as display-mode formulas
          if (MATH_LANGS.has((block.lang || '').toLowerCase())) {
            let box = null;
            try {
              // 1.21 mirrors katex.css's font-size on .katex in body text
              box = layoutTex(block.text, {
                size: t.size * 1.21,
                displayMode: true,
                color: t.color
              });
            } catch {
              // KaTeX parse error: fall through to the plain code block
            }
            if (box) {
              const bx = x + Math.max(0, (width - box.width) / 2);
              this._items.push({ kind: 'tex', x: bx, y, box });
              y += box.height;
              break;
            }
          }
          const pad = t.size * 0.5;
          const style = { ...styles.mono, color: t.color };
          const spans = tokenize(block.text, block.lang).map((tok) => ({
            text: tok.text,
            color: t.codeTheme?.[tok.kind] ?? style.color
          }));
          const layout = new TextLayout(fonts, spans.length ? spans : '', style, {
            maxWidth: width - pad * 2,
            lineHeight: 1.25
          });
          this._items.push({
            kind: 'rect',
            x,
            y,
            width,
            height: layout.height + pad * 2,
            color: t.codeBg
          });
          this._items.push({ kind: 'text', x: x + pad, y: y + pad, layout });
          y += layout.height + pad * 2;
          break;
        }

        case 'blockquote': {
          const indent = t.size;
          const startY = y;
          const bar = { kind: 'rect', x, y, width: 3, height: 0, color: t.quoteBar };
          this._items.push(bar);
          const quoted = {
            base: { ...styles.base, color: t.quoteColor },
            mono: styles.mono
          };
          y = this._layoutBlocks(fonts, block.blocks, quoted, x + indent, y, width - indent);
          bar.height = y - startY;
          break;
        }

        case 'list': {
          const indent = t.size * 1.6;
          let n = block.start;
          for (let it = 0; it < block.items.length; it++) {
            if (it > 0) y += spacing * 0.4;
            const marker = block.ordered ? `${n++}.` : '•';
            const markerLayout = new TextLayout(fonts, marker, styles.base, {});
            this._items.push({ kind: 'text', x, y, layout: markerLayout });
            y = this._layoutBlocks(fonts, block.items[it], styles, x + indent, y, width - indent);
          }
          break;
        }

        case 'table': {
          y = this._layoutTable(fonts, block, styles, x, y, width);
          break;
        }

        case 'hr': {
          this._items.push({
            kind: 'rect',
            x,
            y: y + spacing * 0.5,
            width,
            height: 1,
            color: t.hrColor
          });
          y += spacing;
          break;
        }
      }
    }
    return y;
  }

  /**
   * Table layout: columns take their natural (unwrapped) width when the
   * table fits, otherwise shrink proportionally (with a floor) and cells
   * wrap. The grid and header background are emitted as rect items, so the
   * two-pass draw() paints them under the cell text.
   */
  _layoutTable(fonts, block, styles, x, y, width) {
    const t = this.theme;
    const hpad = t.size * 0.55;
    const vpad = t.size * 0.3;
    const ncols = block.header.length;
    const allRows = [block.header, ...block.rows];

    // natural width per column: widest unwrapped cell
    const cellStyle = (isHeader) => (isHeader ? { ...styles.base, weight: 700 } : styles.base);
    const cellSpans = allRows.map((row, r) =>
      Array.from({ length: ncols }, (_, c) => this._spans(row[c] ?? [], cellStyle(r === 0)))
    );
    const natural = new Array(ncols).fill(0);
    for (const row of cellSpans) {
      for (let c = 0; c < ncols; c++) {
        if (!row[c].length) continue;
        const measure = new TextLayout(fonts, row[c], styles.base, { lineHeight: t.lineHeight });
        natural[c] = Math.max(natural[c], measure.width);
      }
    }

    const cols = natural.map((w) => w + hpad * 2);
    const total = cols.reduce((a, b) => a + b, 0);
    if (total > width) {
      // proportional shrink; the floor keeps narrow columns readable even
      // if wide neighbors then push the table slightly past the container
      const minCol = Math.min(t.size * 2.5 + hpad * 2, width / ncols);
      for (let c = 0; c < ncols; c++) {
        cols[c] = Math.max(minCol, (cols[c] / total) * width);
      }
    }
    const tableW = cols.reduce((a, b) => a + b, 0);

    const topY = y;
    const rowLines = [y];
    for (let r = 0; r < cellSpans.length; r++) {
      const layouts = cellSpans[r].map((spans, c) =>
        new TextLayout(fonts, spans.length ? spans : '', styles.base, {
          maxWidth: cols[c] - hpad * 2,
          align: block.align[c] ?? 'left',
          lineHeight: t.lineHeight
        })
      );
      const rowH = Math.max(...layouts.map((l) => l.height), t.size * t.lineHeight) + vpad * 2;
      if (r === 0) {
        this._items.push({ kind: 'rect', x, y, width: tableW, height: rowH, color: t.tableHeaderBg });
      }
      let cx = x;
      for (let c = 0; c < ncols; c++) {
        this._items.push({ kind: 'text', x: cx + hpad, y: y + vpad, layout: layouts[c] });
        cx += cols[c];
      }
      y += rowH;
      rowLines.push(y);
    }

    // grid: horizontal rule per row boundary, vertical per column boundary
    for (const ly of rowLines) {
      this._items.push({ kind: 'rect', x, y: ly, width: tableW, height: 1, color: t.tableBorder });
    }
    let cx = x;
    for (let c = 0; c <= ncols; c++) {
      this._items.push({ kind: 'rect', x: cx, y: topY, width: 1, height: y - topY + 1, color: t.tableBorder });
      if (c < ncols) cx += cols[c];
    }
    return y + 1;
  }

  /** inline AST -> styled spans for TextLayout */
  _spans(children, base, state = {}, out = []) {
    const t = this.theme;
    for (const node of children) {
      switch (node.type) {
        case 'text':
          out.push({
            text: node.text,
            family: state.code ? t.monoFamily : base.family,
            size: state.code ? Math.round(base.size * 0.9) : base.size,
            weight: state.bold ? 700 : base.weight,
            style: state.italic ? 'italic' : base.style,
            color: state.code ? t.codeColor : state.link ? t.linkColor : base.color,
            _deco: state.code ? { bg: t.codeBg } : state.link ? { underline: t.linkColor } : null,
            _href: state.link ? state.href : null
          });
          break;
        case 'code':
          this._spans([{ type: 'text', text: node.text }], base, { ...state, code: true }, out);
          break;
        case 'strong':
          this._spans(node.children, base, { ...state, bold: true }, out);
          break;
        case 'em':
          this._spans(node.children, base, { ...state, italic: true }, out);
          break;
        case 'link':
          this._spans(node.children, base, { ...state, link: true, href: node.href }, out);
          break;
      }
    }
    return out;
  }

  /** draw the last layout()'s items onto a 2d context */
  draw(ctx, ox = 0, oy = 0) {
    this._links = [];
    for (const item of this._items) {
      if (item.kind === 'rect') {
        ctx.fillStyle = item.color;
        ctx.fillRect(Math.round(ox + item.x), Math.round(oy + item.y), Math.ceil(item.width), Math.ceil(item.height));
      }
    }
    for (const item of this._items) {
      if (item.kind === 'tex') {
        item.box.draw(ctx, ox + item.x, oy + item.y);
        continue;
      }
      if (item.kind !== 'text') continue;
      const x = ox + item.x;
      const y = oy + item.y;
      // span decorations (inline-code background, link underline) first
      for (const line of item.layout.lines) {
        for (const r of line.runs) {
          if (r.span._href) {
            // clickable region in the device coordinates of this draw
            const m = r.run.font.metrics(r.run.size);
            this._links.push({
              x: x + line.x + r.x,
              y: y + line.baseline - m.ascent,
              w: r.width,
              h: m.ascent + m.descent,
              href: r.span._href
            });
          }
          const deco = r.span._deco;
          if (!deco) continue;
          if (deco.bg) {
            const m = r.run.font.metrics(r.run.size);
            ctx.fillStyle = deco.bg;
            ctx.fillRect(
              Math.round(x + line.x + r.x - 2),
              Math.round(y + line.baseline - m.ascent),
              Math.ceil(r.width + 4),
              Math.ceil(m.ascent + m.descent)
            );
          }
          if (deco.underline) {
            ctx.fillStyle = deco.underline;
            ctx.fillRect(Math.round(x + line.x + r.x), Math.round(y + line.baseline + 2), Math.ceil(r.width), 1);
          }
        }
      }
      item.layout.draw(ctx, x, y);
    }
    return this;
  }

  /** full window render: clear background, (re)layout on size change, draw */
  render() {
    if (!this.window) throw new Error('MarkdownView.render() needs a window');
    const ctx = this._ctx;
    if (this._layoutWidth !== this.window.width) this.layout(this.window.width);
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(0, 0, this.window.width, this.window.height);
    this.draw(ctx, 0, this.theme.padding);
    return this;
  }
}
