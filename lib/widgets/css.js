// CSS support for HtmlView: stylesheet parsing (postcss), selector matching
// (css-select), cascade (specificity + order + !important), inheritance and
// computed-value resolution for the property subset the widget renders.
import { selectAll } from 'css-select';
import postcss from 'postcss';

import parseColorRaw from 'parse-color';

/** parse a CSS color to premultipliable [r, g, b, a] floats, or null */
export function cssColor(value) {
  if (!value) return null;
  if (value === 'transparent') return [0, 0, 0, 0];
  const c = parseColorRaw(String(value).trim());
  if (!c || !c.rgba) return null;
  return [c.rgba[0] / 255, c.rgba[1] / 255, c.rgba[2] / 255, c.rgba[3]];
}

const FONT_SIZE_KEYWORDS = {
  'xx-small': 9,
  'x-small': 10,
  small: 13,
  medium: 16,
  large: 18,
  'x-large': 24,
  'xx-large': 32
};

/**
 * Parse a CSS length into `{ px }`, `{ pct }` or `'auto'`; null if
 * unsupported. `em` resolves against `emBase` (the element's font size).
 */
export function cssLength(value, emBase = 16, rootSize = 16) {
  if (value == null) return null;
  value = String(value).trim();
  if (value === 'auto') return 'auto';
  if (value === '0') return { px: 0 };
  const m = /^(-?\d*\.?\d+)(px|pt|em|rem|%)$/.exec(value);
  if (!m) return null;
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case 'px':
      return { px: n };
    case 'pt':
      return { px: (n * 4) / 3 };
    case 'em':
      return { px: n * emBase };
    case 'rem':
      return { px: n * rootSize };
    case '%':
      return { pct: n };
  }
  return null;
}

// ---------------------------------------------------------------------------
// specificity

// (ids, classes/attributes/pseudo-classes, types/pseudo-elements) packed into
// one comparable number. Computed textually from the selector — robust enough
// for the supported subset.
export function specificity(selector) {
  let s = selector
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, 'v') // string literals
    .replace(/\\./g, 'c'); // escaped chars
  let b = 0;
  // attribute selectors (may contain anything except ])
  s = s.replace(/\[[^\]]*\]/g, () => ((b += 1), ' '));
  let a = 0;
  s = s.replace(/#[\w-]+/g, () => ((a += 1), ' '));
  s = s.replace(/\.[\w-]+/g, () => ((b += 1), ' '));
  let c = 0;
  s = s.replace(/::[\w-]+/g, () => ((c += 1), ' '));
  // :not() adds the specificity of its argument but not itself
  s = s.replace(/:not\(/g, '(');
  s = s.replace(/:[\w-]+(\([^)]*\))?/g, () => ((b += 1), ' '));
  s.replace(/(^|[\s>+~(,])[a-zA-Z][\w-]*/g, () => ((c += 1), ' '));
  return a * 1_000_000 + b * 1_000 + c;
}

// ---------------------------------------------------------------------------
// stylesheet parsing

// media queries are not evaluated: rules under a plain `screen`/`all` @media
// apply, anything conditional is skipped
const APPLIED_MEDIA = /^\s*(all|screen)?\s*$/;

/**
 * Parse a stylesheet into flat rule entries
 * `{ selector, specificity, decls: [{ prop, value, important }] }`.
 * Invalid CSS is dropped (postcss safe-ish: parse errors throw — callers
 * treat a throwing sheet as empty).
 */
export function parseStylesheet(cssText) {
  let root;
  try {
    root = postcss.parse(cssText);
  } catch {
    return [];
  }
  const rules = [];
  root.walkRules((rule) => {
    if (rule.parent?.type === 'atrule') {
      const at = rule.parent;
      if (at.name !== 'media' || !APPLIED_MEDIA.test(at.params)) return;
    }
    const decls = [];
    for (const node of rule.nodes ?? []) {
      if (node.type !== 'decl') continue;
      decls.push({ prop: node.prop.toLowerCase(), value: node.value.trim(), important: !!node.important });
    }
    if (!decls.length) return;
    for (const selector of rule.selectors ?? [rule.selector]) {
      rules.push({ selector: selector.trim(), specificity: specificity(selector), decls });
    }
  });
  return rules;
}

/** parse an inline `style="..."` attribute into decl entries */
export function parseInlineStyle(text) {
  const rules = parseStylesheet(`x{${text}}`);
  return rules.length ? rules[0].decls : [];
}

// ---------------------------------------------------------------------------
// the UA stylesheet

export const UA_STYLESHEET = `
html, body, div, p, h1, h2, h3, h4, h5, h6, ul, ol, li, dl, dt, dd,
blockquote, pre, hr, address, figure, figcaption, fieldset, form,
table, caption, section, article, header, footer, nav, aside, main,
details, summary { display: block }
head, style, script, title, meta, link, template, noscript { display: none }
body { margin: 8px }
p, blockquote, ul, ol, dl, pre, table, figure { margin-top: 1em; margin-bottom: 1em }
h1 { font-size: 2em; margin-top: 0.67em; margin-bottom: 0.67em; font-weight: bold }
h2 { font-size: 1.5em; margin-top: 0.83em; margin-bottom: 0.83em; font-weight: bold }
h3 { font-size: 1.17em; margin-top: 1em; margin-bottom: 1em; font-weight: bold }
h4 { margin-top: 1.33em; margin-bottom: 1.33em; font-weight: bold }
h5 { font-size: 0.83em; margin-top: 1.67em; margin-bottom: 1.67em; font-weight: bold }
h6 { font-size: 0.75em; margin-top: 2.33em; margin-bottom: 2.33em; font-weight: bold }
ul, ol { padding-left: 40px }
ul { list-style-type: disc }
ol { list-style-type: decimal }
ul ul, ol ul { list-style-type: circle }
li { display: list-item }
b, strong { font-weight: bold }
i, em, cite, var { font-style: italic }
u, ins { text-decoration: underline }
s, strike, del { text-decoration: line-through }
code, pre, kbd, samp, tt { font-family: monospace; font-size: 0.9em }
pre { white-space: pre }
a { color: #0b61c9; text-decoration: underline }
blockquote { margin-left: 40px; margin-right: 40px }
figure { margin-left: 40px; margin-right: 40px }
hr { border-bottom: 1px solid #999999; margin-top: 0.5em; margin-bottom: 0.5em }
img { display: inline-block }
table { display: flex; flex-direction: column }
thead, tbody, tfoot { display: flex; flex-direction: column }
tr { display: flex; flex-direction: row }
td, th { display: flex; flex-direction: column; flex: 1; padding: 3px }
th { font-weight: bold }
center { display: block; text-align: center }
big { font-size: 1.2em }
small, sub, sup { font-size: 0.83em }
dd { margin-left: 40px }
dt { font-weight: bold }
summary { font-weight: bold }
`;

// ---------------------------------------------------------------------------
// computed styles

const INHERITED = new Set([
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'text-align',
  'white-space',
  'list-style-type'
]);

export const DEFAULT_STYLE = {
  display: 'inline',
  color: [0.133, 0.133, 0.133, 1],
  background: null,
  fontFamily: 'sans-serif',
  fontSize: 16,
  fontWeight: 400,
  fontStyle: 'normal',
  lineHeight: { mult: 1.25 },
  textAlign: 'left',
  textDecoration: 'none',
  whiteSpace: 'normal',
  listStyleType: 'disc',
  margin: ['auto0', 'auto0', 'auto0', 'auto0'], // see note below
  padding: [{ px: 0 }, { px: 0 }, { px: 0 }, { px: 0 }],
  borderWidth: [0, 0, 0, 0],
  borderColor: [null, null, null, null], // null -> currentColor
  borderStyle: ['none', 'none', 'none', 'none'],
  width: 'auto',
  height: 'auto',
  minWidth: null,
  maxWidth: null,
  minHeight: null,
  maxHeight: null,
  flexDirection: 'row',
  flexWrap: 'nowrap',
  justifyContent: 'flex-start',
  alignItems: 'stretch',
  alignSelf: 'auto',
  flexGrow: 0,
  flexShrink: 1,
  flexBasis: 'auto',
  rowGap: 0,
  columnGap: 0
};

const SIDES = ['top', 'right', 'bottom', 'left'];

// expand 1-4 value shorthand into [top, right, bottom, left] value strings
function expandBox(value) {
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const [a, b = a, c = a, d = b] = parts;
  return [a, b, c, d];
}

function splitOutsideParens(value) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// border shorthand: any of width / style / color in any order
function parseBorderShorthand(value) {
  const out = { width: null, style: null, color: null };
  for (const part of splitOutsideParens(value)) {
    if (/^(none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)$/.test(part)) {
      out.style = part === 'hidden' ? 'none' : part;
    } else if (/^(thin|medium|thick)$/.test(part)) {
      out.width = { thin: 1, medium: 3, thick: 5 }[part];
    } else if (cssLength(part) && cssLength(part) !== 'auto') {
      out.width = cssLength(part).px ?? null;
    } else if (cssColor(part)) {
      out.color = cssColor(part);
    }
  }
  return out;
}

const DISPLAY_VALUES = new Set([
  'block',
  'inline',
  'inline-block',
  'flex',
  'inline-flex',
  'list-item',
  'none'
]);

/**
 * Apply one declaration to a computed style object (mutates `st`).
 * `emBase` is the element's own font size (already resolved), used for
 * `em` lengths on non-font-size properties.
 */
function applyDecl(st, prop, value, emBase, rootSize, parent) {
  const len = (v) => cssLength(v, emBase, rootSize);
  const px = (v) => {
    const l = len(v);
    return l && l !== 'auto' && l.px !== undefined ? l.px : null;
  };
  const sizeVal = (v) => {
    const l = len(v);
    if (l === 'auto') return 'auto';
    if (!l) return null;
    return l; // {px} or {pct}
  };

  switch (prop) {
    case 'display': {
      const v = value.toLowerCase();
      if (DISPLAY_VALUES.has(v)) st.display = v === 'inline-flex' ? 'flex' : v;
      break;
    }
    case 'color': {
      const c = cssColor(value);
      if (c) st.color = c;
      break;
    }
    case 'background':
    case 'background-color': {
      if (value === 'none') {
        st.background = null;
        break;
      }
      // background shorthand: take the first color-looking token
      for (const part of splitOutsideParens(value)) {
        const c = cssColor(part);
        if (c) {
          st.background = c;
          break;
        }
      }
      break;
    }
    case 'font-family':
      st.fontFamily = value.split(',')[0].trim().replace(/^["']|["']$/g, '') || st.fontFamily;
      break;
    case 'font-size': {
      const v = value.toLowerCase();
      if (FONT_SIZE_KEYWORDS[v] !== undefined) {
        st.fontSize = FONT_SIZE_KEYWORDS[v];
      } else {
        // em/% for font-size resolve against the parent font size
        const l = cssLength(v, parent.fontSize, rootSize);
        if (l && l !== 'auto') {
          st.fontSize = l.px !== undefined ? l.px : (l.pct / 100) * parent.fontSize;
        }
      }
      break;
    }
    case 'font-weight': {
      const v = value.toLowerCase();
      if (v === 'bold' || v === 'bolder') st.fontWeight = 700;
      else if (v === 'normal' || v === 'lighter') st.fontWeight = 400;
      else if (/^\d+$/.test(v)) st.fontWeight = parseInt(v, 10);
      break;
    }
    case 'font-style': {
      const v = value.toLowerCase();
      if (v === 'italic' || v === 'oblique') st.fontStyle = 'italic';
      else if (v === 'normal') st.fontStyle = 'normal';
      break;
    }
    case 'line-height': {
      const v = value.toLowerCase();
      if (v === 'normal') st.lineHeight = { mult: 1.25 };
      else if (/^\d*\.?\d+$/.test(v)) st.lineHeight = { mult: parseFloat(v) };
      else {
        const l = len(v);
        if (l && l.px !== undefined) st.lineHeight = { px: l.px };
        else if (l && l.pct !== undefined) st.lineHeight = { mult: l.pct / 100 };
      }
      break;
    }
    case 'text-align': {
      const v = value.toLowerCase();
      if (['left', 'right', 'center', 'justify', 'start', 'end'].includes(v)) {
        st.textAlign = v === 'justify' ? 'left' : v === 'start' ? 'left' : v === 'end' ? 'right' : v;
      }
      break;
    }
    case 'text-decoration':
    case 'text-decoration-line': {
      const v = value.toLowerCase();
      if (v.includes('underline')) st.textDecoration = 'underline';
      else if (v.includes('line-through')) st.textDecoration = 'line-through';
      else if (v.includes('none')) st.textDecoration = 'none';
      break;
    }
    case 'white-space': {
      const v = value.toLowerCase();
      if (['normal', 'pre', 'nowrap', 'pre-wrap', 'pre-line'].includes(v)) st.whiteSpace = v;
      break;
    }
    case 'list-style':
    case 'list-style-type': {
      const v = value.toLowerCase();
      for (const part of v.split(/\s+/)) {
        if (['disc', 'circle', 'square', 'decimal', 'none', 'lower-alpha', 'upper-alpha', 'lower-roman', 'upper-roman'].includes(part)) {
          st.listStyleType = part;
        }
      }
      break;
    }

    case 'margin': {
      const box = expandBox(value);
      if (box) box.forEach((v, i) => {
        const l = sizeVal(v);
        if (l) st.margin[i] = l;
      });
      break;
    }
    case 'margin-top':
    case 'margin-right':
    case 'margin-bottom':
    case 'margin-left': {
      const l = sizeVal(value);
      if (l) st.margin[SIDES.indexOf(prop.slice(7))] = l;
      break;
    }
    case 'padding': {
      const box = expandBox(value);
      if (box) box.forEach((v, i) => {
        const l = sizeVal(v);
        if (l && l !== 'auto') st.padding[i] = l;
      });
      break;
    }
    case 'padding-top':
    case 'padding-right':
    case 'padding-bottom':
    case 'padding-left': {
      const l = sizeVal(value);
      if (l && l !== 'auto') st.padding[SIDES.indexOf(prop.slice(8))] = l;
      break;
    }

    case 'border': {
      const b = parseBorderShorthand(value);
      for (let i = 0; i < 4; i++) {
        if (b.style) st.borderStyle[i] = b.style;
        st.borderWidth[i] = b.style === 'none' ? 0 : (b.width ?? (b.style ? 3 : st.borderWidth[i]));
        if (b.color) st.borderColor[i] = b.color;
      }
      break;
    }
    case 'border-top':
    case 'border-right':
    case 'border-bottom':
    case 'border-left': {
      const i = SIDES.indexOf(prop.slice(7));
      const b = parseBorderShorthand(value);
      if (b.style) st.borderStyle[i] = b.style;
      st.borderWidth[i] = b.style === 'none' ? 0 : (b.width ?? (b.style ? 3 : st.borderWidth[i]));
      if (b.color) st.borderColor[i] = b.color;
      break;
    }
    case 'border-width': {
      const box = expandBox(value);
      if (box) box.forEach((v, i) => {
        const w = /^(thin|medium|thick)$/.test(v) ? { thin: 1, medium: 3, thick: 5 }[v] : px(v);
        if (w !== null) st.borderWidth[i] = w;
      });
      break;
    }
    case 'border-style': {
      const box = expandBox(value.toLowerCase());
      if (box) box.forEach((v, i) => {
        st.borderStyle[i] = v === 'none' || v === 'hidden' ? 'none' : 'solid';
        if (st.borderStyle[i] === 'none') st.borderWidth[i] = 0;
      });
      break;
    }
    case 'border-color': {
      const box = expandBox(value);
      if (box) box.forEach((v, i) => {
        const c = cssColor(v);
        if (c) st.borderColor[i] = c;
      });
      break;
    }

    case 'width':
    case 'height': {
      const l = sizeVal(value);
      if (l) st[prop] = l;
      break;
    }
    case 'min-width':
    case 'max-width':
    case 'min-height':
    case 'max-height': {
      const l = sizeVal(value);
      if (l && l !== 'auto') {
        st[prop.replace(/-(\w)/, (_, ch) => ch.toUpperCase())] = l;
      }
      break;
    }

    case 'flex-direction': {
      const v = value.toLowerCase();
      if (['row', 'column', 'row-reverse', 'column-reverse'].includes(v)) st.flexDirection = v;
      break;
    }
    case 'flex-wrap': {
      const v = value.toLowerCase();
      if (['nowrap', 'wrap', 'wrap-reverse'].includes(v)) st.flexWrap = v;
      break;
    }
    case 'justify-content': {
      const v = value.toLowerCase();
      if (['flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly', 'start', 'end'].includes(v)) {
        st.justifyContent = v === 'start' ? 'flex-start' : v === 'end' ? 'flex-end' : v;
      }
      break;
    }
    case 'align-items':
    case 'align-self': {
      const v = value.toLowerCase();
      const key = prop === 'align-items' ? 'alignItems' : 'alignSelf';
      if (['flex-start', 'flex-end', 'center', 'stretch', 'baseline', 'auto', 'start', 'end'].includes(v)) {
        st[key] = v === 'start' ? 'flex-start' : v === 'end' ? 'flex-end' : v;
      }
      break;
    }
    case 'flex-grow':
      if (/^\d*\.?\d+$/.test(value)) st.flexGrow = parseFloat(value);
      break;
    case 'flex-shrink':
      if (/^\d*\.?\d+$/.test(value)) st.flexShrink = parseFloat(value);
      break;
    case 'flex-basis': {
      const l = sizeVal(value);
      if (l) st.flexBasis = l;
      break;
    }
    case 'flex': {
      const v = value.toLowerCase().trim();
      if (v === 'none') {
        st.flexGrow = 0;
        st.flexShrink = 0;
        st.flexBasis = 'auto';
        break;
      }
      const parts = v.split(/\s+/);
      if (/^\d*\.?\d+$/.test(parts[0])) {
        st.flexGrow = parseFloat(parts[0]);
        st.flexShrink = parts[1] && /^\d*\.?\d+$/.test(parts[1]) ? parseFloat(parts[1]) : 1;
        const basis = parts[2] ?? (parts[1] && !/^\d*\.?\d+$/.test(parts[1]) ? parts[1] : '0px');
        st.flexBasis = sizeVal(basis) ?? { px: 0 };
      }
      break;
    }
    case 'gap': {
      const parts = value.split(/\s+/).filter(Boolean);
      const row = px(parts[0]);
      if (row !== null) st.rowGap = row;
      const col = parts[1] ? px(parts[1]) : row;
      if (col !== null) st.columnGap = col;
      break;
    }
    case 'row-gap': {
      const v = px(value);
      if (v !== null) st.rowGap = v;
      break;
    }
    case 'column-gap': {
      const v = px(value);
      if (v !== null) st.columnGap = v;
      break;
    }
  }
}

/**
 * Compute styles for every element of a parsed document.
 *
 * @param {object} dom htmlparser2 document node
 * @param {string[]} authorSheets stylesheet texts, in cascade order (the UA
 *   sheet is always applied first)
 * @param {object} [opts] { rootFontSize = 16, baseStyle } — `baseStyle`
 *   overrides DEFAULT_STYLE fields for the root (theming: font, color...)
 * @returns {Map<element, computedStyle>}
 */
export function computeStyles(dom, authorSheets = [], opts = {}) {
  const rootSize = opts.rootFontSize ?? 16;

  // parse all sheets into one ordered rule list (UA first: lowest priority
  // at equal specificity because of source order)
  const rules = [];
  for (const text of [UA_STYLESHEET, ...authorSheets]) {
    for (const rule of parseStylesheet(text)) rules.push(rule);
  }

  // match each rule once over the whole document
  const matches = new Map(); // element -> [{specificity, order, decls}]
  rules.forEach((rule, order) => {
    let matched;
    try {
      matched = selectAll(rule.selector, dom);
    } catch {
      return; // unsupported selector: skip the rule
    }
    for (const el of matched) {
      let list = matches.get(el);
      if (!list) matches.set(el, (list = []));
      list.push({ specificity: rule.specificity, order, decls: rule.decls });
    }
  });

  const computed = new Map();
  const defaultStyle = { ...DEFAULT_STYLE, ...(opts.baseStyle || {}) };

  const walk = (el, parentStyle) => {
    // htmlparser2 marks <style>/<script> with their own node types
    if (el.type !== 'tag' && el.type !== 'style' && el.type !== 'script') {
      // only elements get computed styles; recurse for containers
      for (const child of el.children ?? []) walk(child, parentStyle);
      return;
    }

    // start from inherited/default values
    const st = {
      ...defaultStyle,
      margin: ['auto0', 'auto0', 'auto0', 'auto0'],
      padding: [{ px: 0 }, { px: 0 }, { px: 0 }, { px: 0 }],
      borderWidth: [0, 0, 0, 0],
      borderColor: [null, null, null, null],
      borderStyle: ['none', 'none', 'none', 'none']
    };
    for (const prop of ['color', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'textAlign', 'whiteSpace', 'listStyleType']) {
      st[prop] = parentStyle[prop];
    }
    // text-decoration propagates to inline descendants (approximation of
    // CSS decoration propagation)
    st.textDecoration = 'none';
    st.display = 'inline';
    st.background = null;
    st.width = 'auto';
    st.height = 'auto';
    st.minWidth = st.maxWidth = st.minHeight = st.maxHeight = null;
    st.flexDirection = 'row';
    st.flexWrap = 'nowrap';
    st.justifyContent = 'flex-start';
    st.alignItems = 'stretch';
    st.alignSelf = 'auto';
    st.flexGrow = 0;
    st.flexShrink = 1;
    st.flexBasis = 'auto';
    st.rowGap = 0;
    st.columnGap = 0;

    // presentational attributes (lowest priority)
    const attribs = el.attribs || {};
    if (el.name === 'img') {
      if (attribs.width && /^\d+$/.test(attribs.width)) st.width = { px: parseInt(attribs.width, 10) };
      if (attribs.height && /^\d+$/.test(attribs.height)) st.height = { px: parseInt(attribs.height, 10) };
    }

    // cascade: sort matched decl blocks; then apply — font-size first so em
    // lengths in the same element resolve against the final font size
    const declBlocks = (matches.get(el) ?? [])
      .slice()
      .sort((x, y) => x.specificity - y.specificity || x.order - y.order);
    const decls = [];
    for (const block of declBlocks) for (const d of block.decls) decls.push(d);
    if (attribs.style) for (const d of parseInlineStyle(attribs.style)) decls.push(d);
    // stable partition: non-important then important
    const ordered = [...decls.filter((d) => !d.important), ...decls.filter((d) => d.important)];

    for (const d of ordered) {
      if (d.prop === 'font-size') applyDecl(st, d.prop, d.value, st.fontSize, rootSize, parentStyle);
    }
    for (const d of ordered) {
      if (d.prop !== 'font-size') applyDecl(st, d.prop, d.value, st.fontSize, rootSize, parentStyle);
    }

    // unset margins default to 0 (the 'auto0' marker distinguishes "not
    // set" from an explicit `margin: auto`)
    st.margin = st.margin.map((m) => (m === 'auto0' ? { px: 0 } : m));

    computed.set(el, st);
    for (const child of el.children ?? []) walk(child, st);
  };

  for (const child of dom.children ?? []) walk(child, defaultStyle);
  return computed;
}
