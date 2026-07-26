// TeX math rendering on top of KaTeX (pure JS) and the ntk text stack.
//
// KaTeX parses TeX and produces a DOM-like tree (spans, vertical lists,
// symbol nodes, rules, SVG surds) that browsers lay out with CSS. This
// module reimplements the small CSS subset that tree actually uses —
// inline flow with em margins, vlist absolute positioning, border-bottom
// rules, font-size/font-family classes — directly in pixel space, using
// the bundled KaTeX .ttf fonts for glyphs and metrics.
//
// Wire efficiency: adjacent symbols that resolve to the same font/size/color
// are concatenated and shaped as single runs, and drawing routes every run
// of a formula into ONE batched CompositeGlyphs request per color (via
// drawGlyphRuns) — not one placement per character. Radical/stretchy SVG
// paths are filled server-side as trapezoids through the same scratch mask
// as the vector text path.
//
//   const box = layoutTex('\\frac{a+b}{2}', { size: 24 });
//   box.draw(ctx, x, y);        // x, y = top-left; box.width/height/baseline
//
// or as a widget: new TexView(wnd, { tex: '...', size: 32 }).
import { parseSvgPath } from '../path.js';
import { flatten } from '../rasterize.js';
import { trapezoidize } from '../trapezoid.js';
import Font from '../text/font.js';
import { compositeTraps, drawGlyphRuns } from '../text/glyphs.js';

// node builtins are fetched lazily so browser bundles never resolve them;
// there, inject the assets with configureTex() instead.
function nodeRequire() {
  const mod = globalThis.process?.getBuiltinModule?.('node:module');
  return mod ? mod.createRequire(import.meta.url) : null;
}

// katex is sizable — load it on first formula, not on package import
let katex = null;
function loadKatex() {
  if (!katex) {
    const require = nodeRequire();
    if (!require) {
      throw new Error(
        'TeX rendering: the katex package cannot be required here — inject it with configureTex({ katex })'
      );
    }
    katex = require('katex');
  }
  return katex;
}

// ---------------------------------------------------------------------------
// KaTeX font files

let fontDir = null; // node path to katex/dist/fonts (null when injected)
let fontFiles = null; // Set of available .ttf file names
let injectedFonts = null; // Map file name -> bytes | Font

/**
 * Provide the KaTeX assets explicitly instead of resolving them from
 * node_modules — required in environments without node builtins (browser
 * bundles), harmless elsewhere.
 *
 * @param {object} opts { katex: the katex module, fonts: map/object of
 *   'KaTeX_Main-Regular.ttf' -> font bytes (or Font) for the .ttf files
 *   shipped in katex/dist/fonts (a subset is fine) }
 */
export function configureTex({ katex: katexModule, fonts } = {}) {
  if (katexModule) katex = katexModule;
  if (fonts) {
    injectedFonts = fonts instanceof Map ? fonts : new Map(Object.entries(fonts));
    fontDir = null;
    fontFiles = null;
    fontCache.clear();
  }
}

function katexFontFiles() {
  if (!fontFiles) {
    if (injectedFonts) {
      fontFiles = new Set(injectedFonts.keys());
    } else {
      const require = nodeRequire();
      if (!require) {
        throw new Error(
          'TeX rendering: KaTeX fonts cannot be read here — inject them with configureTex({ fonts })'
        );
      }
      const { readdirSync } = process.getBuiltinModule('node:fs');
      const { dirname, join } = process.getBuiltinModule('node:path');
      fontDir = join(dirname(require.resolve('katex/package.json')), 'dist', 'fonts');
      fontFiles = new Set(readdirSync(fontDir).filter((f) => f.endsWith('.ttf')));
    }
  }
  return fontFiles;
}

const fontCache = new Map(); // file name -> Font

/** resolve a KaTeX family/weight/style to a bundled Font, with graceful
 *  degradation when the exact variant does not exist (e.g. Math-Regular) */
function katexFont(family, bold, italic) {
  const files = katexFontFiles();
  const variants = [
    bold && italic ? 'BoldItalic' : null,
    bold ? 'Bold' : null,
    italic ? 'Italic' : null,
    'Regular',
    'Italic' // KaTeX_Math ships italic faces only
  ];
  for (const variant of variants) {
    if (!variant) continue;
    const file = `KaTeX_${family}-${variant}.ttf`;
    if (!files.has(file)) continue;
    let font = fontCache.get(file);
    if (!font) {
      if (injectedFonts) {
        const value = injectedFonts.get(file);
        font = value instanceof Font ? value : Font.fromData(value, { key: `katex:${file}` });
      } else {
        font = Font.loadSync(`${fontDir}/${file}`);
      }
      fontCache.set(file, font);
    }
    return font;
  }
  throw new Error(`no KaTeX font for family ${family}`);
}

// ---------------------------------------------------------------------------
// class / style interpretation (mirrors katex.css)

// KaTeX size multipliers, sizes 1..11 (src/Options.js)
const SIZE_MULT = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.44, 1.728, 2.074, 2.488];

const FONT_CLASSES = {
  mathnormal: { family: 'Math', italic: true },
  mathit: { family: 'Main', italic: true },
  mathrm: { italic: false },
  mathbf: { family: 'Main', bold: true },
  boldsymbol: { family: 'Math', bold: true, italic: true },
  amsrm: { family: 'AMS' },
  mathbb: { family: 'AMS' },
  textbb: { family: 'AMS' },
  mathcal: { family: 'Caligraphic' },
  mathfrak: { family: 'Fraktur' },
  textfrak: { family: 'Fraktur' },
  mathboldfrak: { family: 'Fraktur', bold: true },
  textboldfrak: { family: 'Fraktur', bold: true },
  mathtt: { family: 'Typewriter' },
  texttt: { family: 'Typewriter' },
  mathscr: { family: 'Script' },
  textscr: { family: 'Script' },
  mathsf: { family: 'SansSerif' },
  textsf: { family: 'SansSerif' },
  mathboldsf: { family: 'SansSerif', bold: true },
  textboldsf: { family: 'SansSerif', bold: true },
  mathsfit: { family: 'SansSerif', italic: true },
  mathitsf: { family: 'SansSerif', italic: true },
  textitsf: { family: 'SansSerif', italic: true },
  mainrm: { family: 'Main', italic: false },
  textrm: { family: 'Main' },
  textbf: { bold: true },
  textit: { italic: true }
};

// css lengths on domTree nodes are 'Xem' (occasionally 'Xpx'); px stays px
function parseLen(value, em) {
  if (!value) return 0;
  const n = parseFloat(value);
  if (Number.isNaN(n)) return 0;
  return String(value).endsWith('px') ? n : n * em;
}

/** apply a node's classes and inline style to the inherited state */
function applyState(node, st) {
  const classes = node.classes || [];
  let out = st;
  const own = () => (out === st ? (out = { ...st }) : out);

  const sizing =
    classes.includes('katex-sizing') ||
    classes.includes('sizing') ||
    classes.includes('fontsize-ensurer');
  const delimsizing = classes.includes('delimsizing');

  let resetSize = null;
  let toSize = null;
  for (const c of classes) {
    const font = FONT_CLASSES[c];
    if (font) Object.assign(own(), font);
    let m;
    if ((m = /^reset-size(\d+)$/.exec(c))) {
      resetSize = +m[1];
    } else if (sizing && (m = /^size(\d+)$/.exec(c))) {
      toSize = +m[1];
    } else if (delimsizing && (m = /^size(\d+)$/.exec(c))) {
      own().family = `Size${m[1]}`;
      own().italic = false;
      own().bold = false;
    } else if ((m = /^delim-size(\d+)$/.exec(c))) {
      own().family = `Size${m[1]}`;
      own().italic = false;
      own().bold = false;
    } else if (c === 'small-op') {
      own().family = 'Size1';
    } else if (c === 'large-op') {
      own().family = 'Size2';
    }
  }
  if (resetSize !== null && toSize !== null) {
    own().em = st.em * (SIZE_MULT[toSize - 1] / SIZE_MULT[resetSize - 1]);
  }
  if (node.style && node.style.color) {
    own().color = node.style.color;
  }
  return out;
}


// ---------------------------------------------------------------------------
// layout walker

const STRETCH = -1; // width placeholder resolved by the containing vlist

function isSymbol(node) {
  return node.constructor && node.constructor.name === 'SymbolNode';
}

function isSvg(node) {
  return node.constructor && node.constructor.name === 'SvgNode';
}

function classSet(node) {
  return node.classes || [];
}

function has(node, cls) {
  return classSet(node).includes(cls);
}

class Walker {
  constructor() {
    this.warnings = [];
  }

  /** dispatch any child node -> box { width, items, stretch? } */
  layoutAny(node, st, align) {
    if (isSymbol(node)) {
      // bare symbol outside an hbox (e.g. directly inside a vlist wrap)
      return this.hbox([node], st, 0);
    }
    if (isSvg(node)) return this.svg(node, st, null);
    if (node.children) return this.span(node, st, align);
    return { width: 0, items: [] };
  }

  span(node, st0, align = 'left') {
    const st = applyState(node, st0);
    const em = st.em;
    const cls = classSet(node);
    const style = node.style || {};

    if (cls.includes('katex-strut') || cls.includes('pstrut') || cls.includes('vlist-s')) {
      return { width: 0, items: [] };
    }

    // rules drawn with borders: frac-line, overline/underline-line, hlines
    if (style.borderBottomWidth !== undefined) {
      const h = Math.max(parseLen(style.borderBottomWidth, em), 1);
      return {
        width: 0,
        stretch: true,
        items: [{ type: 'rect', x: 0, y: -h, w: STRETCH, h, color: st.color }]
      };
    }
    // \rule: content-less span sized by borders, lifted by style.bottom
    if (cls.includes('katex-rule') || cls.includes('rule')) {
      const w = parseLen(style.borderRightWidth ?? style.width, em);
      const h = Math.max(parseLen(style.borderTopWidth ?? style.height, em), 1);
      const shift = parseLen(style.bottom, em);
      return {
        width: w,
        items: w > 0 ? [{ type: 'rect', x: 0, y: -shift - h, w, h, color: st.color }] : []
      };
    }

    if (cls.includes('vlist-t')) {
      return this.vlist(node, st, align);
    }

    // spans hosting an absolutely-positioned svg (sqrt surds, stretchy fills)
    const svgChild = (node.children || []).find(isSvg);
    if (svgChild) {
      const cssH = parseLen(style.height, em) || parseLen(svgChild.attributes?.height, em);
      const box = this.svg(svgChild, st, cssH);
      const minW = parseLen(style.minWidth, em);
      return {
        width: Math.max(parseLen(style.width, em), minW),
        stretch: true, // hide-tail spans are width:100% of their column
        stretchMin: minW,
        items: box.items
      };
    }

    // generic inline flow
    const box = this.hbox(node.children || [], st, parseLen(style.paddingLeft, em), align);

    // explicit width overrides (mspace \hspace etc.) and width:0 hacks
    if (style.width !== undefined) box.width = parseLen(style.width, em);
    if (cls.includes('nulldelimiter')) box.width = 0.12 * em;
    if (cls.includes('llap') || cls.includes('clap')) {
      const shift = cls.includes('llap') ? -box.width : -box.width / 2;
      for (const item of box.items) item.x += shift;
      box.width = 0;
    } else if (cls.includes('rlap')) {
      box.width = 0;
    } else if (cls.includes('accent-body') && !cls.includes('accent-full')) {
      box.width = 0;
    }
    return box;
  }

  /** children in inline flow; merges adjacent same-style symbols into runs */
  hbox(children, st, x0 = 0, align = 'left') {
    const items = [];
    let x = x0;
    let group = null;

    const flush = () => {
      if (!group) return;
      const run = group.font.shape(group.text, group.size);
      items.push({ type: 'run', run, x: group.x0, y: 0, color: group.color });
      x = group.x0 + run.width + group.italic;
      group = null;
    };

    for (const child of children) {
      if (isSymbol(child)) {
        const cst = applyState(child, st);
        // strip zero-width space / BOM (vlist alignment hacks)
        const text = child.text.replace(/[\u200b\ufeff]/g, '');
        if (!text) continue;
        const style = child.style || {};
        const ml = parseLen(style.marginLeft, cst.em);
        const mr = parseLen(style.marginRight, cst.em);
        if (ml) {
          flush();
          x += ml;
        }
        const font = katexFont(cst.family, cst.bold, cst.italic);
        if (
          group &&
          (group.font !== font || group.size !== cst.em || group.color !== cst.color)
        ) {
          flush();
        }
        if (!group) group = { font, size: cst.em, color: cst.color, text: '', x0: x, italic: 0 };
        group.text += text;
        group.italic = (child.italic || 0) * cst.em;
        // italic correction / explicit margin ends the mergeable sequence
        if (child.italic || mr) {
          flush();
          x += mr;
        }
        continue;
      }
      if (isSvg(child)) {
        // absolutely positioned inside its span: draws but does not advance
        flush();
        const box = this.svg(child, st, null);
        for (const item of box.items) {
          item.x += x;
          items.push(item);
        }
        continue;
      }
      if (!child.children && !child.style) continue; // text/doc nodes
      flush();
      const style = child.style || {};
      const cem = applyState(child, st).em;
      x += parseLen(style.marginLeft, cem);
      const box = this.span(child, st, this.childAlign(child, align));
      const dy = parseLen(style.top, cem) - parseLen(style.verticalAlign, cem);
      for (const item of box.items) {
        item.x += x;
        item.y += dy;
        items.push(item);
      }
      x += box.width + parseLen(style.marginRight, cem);
    }
    flush();
    return { width: x, items };
  }

  /** text-align context for a span's children (inherits; a few classes set it) */
  childAlign(node, inherited) {
    const cls = classSet(node);
    if (cls.includes('mfrac') || cls.includes('op-limits') || cls.includes('katex-accent')) {
      return 'center';
    }
    if (cls.includes('col-align-c')) return 'center';
    if (cls.includes('col-align-r')) return 'right';
    if (cls.includes('col-align-l') || cls.includes('msupsub') || cls.includes('svg-align')) {
      return 'left';
    }
    return inherited;
  }

  /** KaTeX vertical list: rows absolutely positioned via pstrut + top */
  vlist(vtable, st, align) {
    const em = st.em;
    const rows = (vtable.children || []).filter((c) => has(c, 'vlist-r'));
    const column = rows.length ? (rows[0].children || []).find((c) => has(c, 'vlist')) : null;
    if (!column) return { width: 0, items: [] };

    const entries = [];
    for (const wrap of column.children || []) {
      const kids = wrap.children || [];
      const pstrut = kids.find((k) => has(k, 'pstrut'));
      const elem = kids.find((k) => k !== pstrut);
      if (!elem) continue;
      const style = wrap.style || {};
      const P = parseLen(pstrut?.style?.height, em);
      const T = parseLen(style.top, em);
      const wrapAlign = this.childAlign(wrap, align);
      // wrapper classes carry state for stacked delimiters (delim-sizeN)
      const box = this.layoutAny(elem, applyState(wrap, st), wrapAlign);
      entries.push({
        box,
        dy: P + T,
        ml: parseLen(style.marginLeft, em),
        mr: parseLen(style.marginRight, em),
        align: has(wrap, 'svg-align') ? 'left' : wrapAlign
      });
    }

    let colWidth = 0;
    for (const e of entries) {
      if (e.box.stretch) {
        if (e.box.stretchMin) colWidth = Math.max(colWidth, e.box.stretchMin);
        continue;
      }
      colWidth = Math.max(colWidth, e.ml + e.box.width + e.mr);
    }

    const items = [];
    for (const e of entries) {
      const w = e.box.stretch ? colWidth : e.box.width;
      let ox = e.ml;
      if (!e.box.stretch) {
        if (e.align === 'center') ox += (colWidth - e.ml - e.box.width - e.mr) / 2;
        else if (e.align === 'right') ox += colWidth - e.ml - e.box.width - e.mr;
      }
      for (const item of e.box.items) {
        if (item.w === STRETCH) item.w = w;
        if (item.clipW === STRETCH) item.clipW = w;
        item.x += ox;
        item.y += e.dy;
        items.push(item);
      }
    }
    return { width: colWidth, items };
  }

  /** SvgNode -> filled path item; box is bottom-aligned to the baseline */
  svg(node, st, cssH) {
    const attrs = node.attributes || {};
    const viewBox = String(attrs.viewBox || '0 0 1 1')
      .split(/[\s,]+/)
      .map(Number);
    const vbH = viewBox[3] || 1;
    const heightPx = cssH ?? parseLen(attrs.height, st.em);
    const scale = vbH ? heightPx / vbH : 0;

    const polys = [];
    for (const child of node.children || []) {
      let d = child.alternate;
      if (!d && typeof child.toMarkup === 'function') {
        const m = / d="([^"]*)"/.exec(child.toMarkup());
        if (m) d = m[1];
      }
      if (!d) continue;
      for (const poly of flatten(parseSvgPath(d))) {
        const scaled = new Array(poly.length);
        for (let i = 0; i < poly.length; i += 2) {
          scaled[i] = poly[i] * scale;
          scaled[i + 1] = poly[i + 1] * scale - heightPx; // bottom on the baseline
        }
        polys.push(scaled);
      }
    }
    return {
      width: 0,
      items: polys.length
        ? [{ type: 'path', polys, x: 0, y: 0, clipW: STRETCH, color: st.color }]
        : []
    };
  }
}

// ---------------------------------------------------------------------------
// public API

/**
 * Parse and lay out a TeX formula with KaTeX. Fully headless (no X
 * connection needed) — the result can be measured, then drawn any number of
 * times onto 2d contexts.
 *
 * @param {string} tex
 * @param {object} [options]
 *   - size: base font size in px (the em of the formula), default 16
 *   - displayMode: KaTeX display mode (block, \displaystyle), default false
 *   - color: default ink color (spans with explicit \color override it)
 *   - katex: extra options passed through to KaTeX (macros, strict, ...)
 * @returns {TexBox}
 */
export function layoutTex(tex, options = {}) {
  const em = options.size ?? 16;
  const tree = loadKatex().__renderToDomTree(String(tex ?? ''), {
    output: 'html',
    displayMode: !!options.displayMode,
    ...options.katex
  });

  // find the .katex span ( __renderToDomTree may wrap it in .katex-display )
  let root = tree;
  if (has(root, 'katex-display')) root = root.children.find((c) => has(c, 'katex'));
  const html = (root.children || []).find((c) => has(c, 'katex-html')) ?? root;

  const st = {
    em,
    family: 'Main',
    bold: false,
    italic: false,
    color: options.color ?? null
  };
  const walker = new Walker();
  const box = walker.hbox(html.children || [], st);

  const height = (root.height || 0) * em;
  const depth = (root.depth || 0) * em;
  return new TexBox(box.items, box.width, height, depth, em);
}

/**
 * A laid-out formula. Coordinates are relative to the top-left corner;
 * `baseline` px below the top is the alphabetic baseline.
 */
export class TexBox {
  constructor(items, width, height, depth, em) {
    this.items = items;
    this.width = width;
    this.baseline = height;
    this.height = height + depth;
    this.depth = depth;
    this.em = em;
  }

  /**
   * Draw at (x, y) = top-left. Text is batched into one CompositeGlyphs
   * request per color; rules become FillRectangles; radical strokes become
   * trapezoids. The context fillStyle is used for items without an explicit
   * color and is left untouched.
   */
  draw(ctx, x = 0, y = 0) {
    const app = ctx.window.app;
    const Render = app.display.Render;
    const base = y + this.baseline;

    for (const item of this.items) {
      if (item.type !== 'rect') continue;
      const src = item.color ? ctx._stylePicture(item.color) : ctx._backgroundPicture;
      Render.Composite(
        Render.PictOp.Over,
        src.id,
        ctx.clipMask ? ctx.clipMask.id : 0,
        ctx.picture.id,
        Math.round(x + item.x),
        Math.round(base + item.y),
        Math.round(x + item.x),
        Math.round(base + item.y),
        Math.round(x + item.x),
        Math.round(base + item.y),
        Math.max(1, Math.round(item.w)),
        Math.max(1, Math.round(item.h))
      );
    }

    for (const item of this.items) {
      if (item.type !== 'path') continue;
      const src = item.color ? ctx._stylePicture(item.color) : ctx._backgroundPicture;
      const traps = [];
      for (const poly of item.polys) {
        let clipped = poly;
        if (item.clipW !== STRETCH && item.clipW !== undefined) {
          clipped = poly.slice();
          for (let i = 0; i < clipped.length; i += 2) {
            if (clipped[i] > item.clipW) clipped[i] = item.clipW;
          }
        }
        trapezoidize([clipped], x + item.x, base + item.y, traps);
      }
      compositeTraps(app, Render.PictOp.Over, src.id, ctx.picture.id, traps);
    }

    // batch every run of the same color into a single CompositeGlyphs
    const byColor = new Map();
    for (const item of this.items) {
      if (item.type !== 'run') continue;
      const key = item.color ?? '';
      let list = byColor.get(key);
      if (!list) byColor.set(key, (list = { color: item.color, runs: [] }));
      list.runs.push({ run: item.run, x: x + item.x, y: base + item.y });
    }
    for (const { color, runs } of byColor.values()) {
      const src = color ? ctx._stylePicture(color) : ctx._backgroundPicture;
      drawGlyphRuns(app, Render.PictOp.Over, src.id, ctx.picture.id, runs);
    }

    ctx._markDirty();
    return this;
  }
}

/**
 * A widget that renders one TeX formula into a window, KaTeX-style.
 *
 *   const view = new TexView(wnd, { tex: 'e^{i\\pi} + 1 = 0', size: 40 });
 *   wnd.map();
 *
 * Options: tex, size, color, background, displayMode, padding, katex
 * (pass-through options). `setTex(tex)` updates and re-renders.
 */
export default class TexView {
  constructor(window, opts = {}) {
    this.window = window ?? null;
    this.size = opts.size ?? 24;
    this.color = opts.color ?? '#222222';
    this.background = opts.background ?? 'white';
    this.displayMode = opts.displayMode ?? true;
    this.padding = opts.padding ?? 16;
    this.katexOptions = opts.katex;
    this._box = null;
    this._tex = '';
    if (opts.tex) this.setTex(opts.tex);

    if (this.window) {
      this._ctx = this.window.getContext('2d');
      this.window.on('expose', () => this.render());
    }
  }

  setTex(tex) {
    this._tex = String(tex ?? '');
    this._box = layoutTex(this._tex, {
      size: this.size,
      color: this.color,
      displayMode: this.displayMode,
      katex: this.katexOptions
    });
    if (this.window && this.window._mapped) this.render();
    return this;
  }

  /** the laid-out TexBox (width/height/baseline) for the current tex */
  get box() {
    return this._box;
  }

  render() {
    if (!this.window) throw new Error('TexView.render() needs a window');
    const ctx = this._ctx;
    ctx.fillStyle = this.background;
    ctx.fillRect(0, 0, this.window.width, this.window.height);
    if (!this._box) return this;
    // centered, like KaTeX display mode
    const x = Math.max(this.padding, (this.window.width - this._box.width) / 2);
    const y = Math.max(this.padding, (this.window.height - this._box.height) / 2);
    ctx.fillStyle = this.color;
    this._box.draw(ctx, x, y);
    return this;
  }
}
