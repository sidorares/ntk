import { TextLayout } from '../text/layout.js';
import { parseMarkdown } from './markdown.js';

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
  blockSpacing: 0.7, // em (of base size) between blocks
  padding: 16
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
    if (opts.padding !== undefined) this.theme.padding = opts.padding;
    this._blocks = [];
    this._items = []; // placed draw items from the last layout()
    this._layoutWidth = -1;
    this.contentHeight = 0;

    if (this.window) {
      this._ctx = this.window.getContext('2d');
      this.window.on('expose', () => this.render());
      this.window.on('resize', () => {
        this._layoutWidth = -1; // invalidate
      });
    }
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
          const pad = t.size * 0.5;
          const style = { ...styles.mono, color: t.color };
          const layout = new TextLayout(fonts, block.text, style, {
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
            _deco: state.code ? { bg: t.codeBg } : state.link ? { underline: t.linkColor } : null
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
          this._spans(node.children, base, { ...state, link: true }, out);
          break;
      }
    }
    return out;
  }

  /** draw the last layout()'s items onto a 2d context */
  draw(ctx, ox = 0, oy = 0) {
    for (const item of this._items) {
      if (item.kind === 'rect') {
        ctx.fillStyle = item.color;
        ctx.fillRect(Math.round(ox + item.x), Math.round(oy + item.y), Math.ceil(item.width), Math.ceil(item.height));
      }
    }
    for (const item of this._items) {
      if (item.kind !== 'text') continue;
      const x = ox + item.x;
      const y = oy + item.y;
      // span decorations (inline-code background, link underline) first
      for (const line of item.layout.lines) {
        for (const r of line.runs) {
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
