// Static SVG rendering on top of the ntk 2d context.
//
// Documents are parsed with htmlparser2 (XML mode) and rendered through the
// canvas API — Path2D for geometry, ctx transforms for <g transform="…">,
// canvas gradients for paint servers — so everything ends up as server-side
// XRender composites like any other 2d drawing.
//
//   const view = new SvgView(wnd);
//   view.setSvg('<svg viewBox="0 0 24 24">…</svg>');
//   wnd.map();
//
// Standalone (windowless) use, which is how a document renderer drives it:
//   const view = new SvgView(null);
//   view.setSvg(svgText);
//   view.draw(ctx, x, y, width, height);
//
// Supported: path/rect/circle/ellipse/line/polyline/polygon, <g>, <defs>,
// <use>, <switch>, linear/radial gradients (objectBoundingBox and
// userSpaceOnUse), transform lists, opacity/fill-opacity/stroke-opacity,
// display, visibility, nested <svg> viewports, fill-rule, <text> with its
// <tspan>s, and <mask>. See docs/svg.md for the full surface and
// limitations.

import { parseDocument } from 'htmlparser2';

import { cssColorStraight } from '../color.js';
import { Path2D, flattenPath } from '../path.js';

const INHERITED = {
  fill: '#000',
  stroke: 'none',
  strokeWidth: 1,
  lineCap: 'butt',
  lineJoin: 'miter',
  miterLimit: 4,
  fillRule: 'nonzero',
  fillOpacity: 1,
  strokeOpacity: 1,
  color: '#000',
  fontFamily: 'sans-serif',
  fontSize: 16,
  fontWeight: 400,
  fontStyle: 'normal',
  letterSpacing: 0,
  wordSpacing: 0,
  textTransform: 'none',
  whiteSpace: 'normal',
  dominantBaseline: 'auto',
  textAnchor: 'start',
  visibility: 'visible',
  markerStart: 'none',
  markerMid: 'none',
  markerEnd: 'none'
};

const STYLE_ATTRS = {
  fill: 'fill',
  stroke: 'stroke',
  'stroke-width': 'strokeWidth',
  'stroke-linecap': 'lineCap',
  'stroke-linejoin': 'lineJoin',
  'stroke-miterlimit': 'miterLimit',
  'fill-rule': 'fillRule',
  'fill-opacity': 'fillOpacity',
  'stroke-opacity': 'strokeOpacity',
  color: 'color',
  'font-family': 'fontFamily',
  'font-size': 'fontSize',
  'font-weight': 'fontWeight',
  'font-style': 'fontStyle',
  'letter-spacing': 'letterSpacing',
  'word-spacing': 'wordSpacing',
  'text-transform': 'textTransform',
  'white-space': 'whiteSpace',
  'xml:space': 'whiteSpace',
  'dominant-baseline': 'dominantBaseline',
  'text-anchor': 'textAnchor',
  visibility: 'visibility',
  'marker-start': 'markerStart',
  'marker-mid': 'markerMid',
  'marker-end': 'markerEnd'
};

/** The three a `marker` declaration in a `style` sets, which is a CSS
 * shorthand and no presentation attribute (SVG 2, 11.6.3). */
const MARKER_PROPERTIES = ['marker-start', 'marker-mid', 'marker-end'];

const NUMERIC = new Set(['strokeWidth', 'miterLimit']);
const ALPHA = new Set(['fillOpacity', 'strokeOpacity']);
const VISIBILITY = new Set(['visible', 'hidden', 'collapse']);

// documents may come from an XML parse (setSvg: exact case) or from an HTML
// parse (inline <svg>: tag/attribute names lowercased) — compare
// names lowercased and look attributes up by their lowercase form too
const tag = (node) => (node.name || '').toLowerCase();

function attr(node, name) {
  const a = node.attribs;
  if (!a) return undefined;
  return a[name] ?? a[name.toLowerCase()];
}

function attrNum(node, name, fallback = 0) {
  const v = attr(node, name);
  if (v === undefined || v === '') return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * A property that is not inherited, as an element sets it itself: in its
 * `style`, the last declaration of it there that `read` makes something
 * of, or else by its presentation attribute — the order `resolveStyle`
 * applies the inherited ones in. `undefined` where it sets it neither way.
 */
function ownProperty(node, name, read) {
  const raw = attr(node, name);
  let v = raw === undefined ? undefined : read(raw);
  const style = node.attribs?.style;
  if (style && style.includes(name)) {
    for (const decl of style.split(';')) {
      const idx = decl.indexOf(':');
      if (idx > 0 && decl.slice(0, idx).trim() === name) v = read(decl.slice(idx + 1)) ?? v;
    }
  }
  return v;
}

const keyword = (raw) => String(raw).trim().toLowerCase() || undefined;

/**
 * Whether an element is `display: none`, by its attribute or in its
 * `style`, which wins. Such an element is not rendered, and nor is anything
 * in it, whatever that says of itself: `display` is not inherited, and a
 * child's `display="inline"` brings nothing back (SVG 1.1, 11.5). That is
 * how an editor writes a hidden layer — Illustrator's `<g display="none">`
 * around shapes it marks `display="inline"`.
 */
function displayNone(node) {
  return ownProperty(node, 'display', keyword) === 'none';
}

// SVG 1.1 features whose elements SvgView draws nothing of: a branch of a
// <switch> that needs one would come out empty or wrong here, so the
// author's fallback is what to draw instead
const UNDRAWN_FEATURES = new Set(
  [
    'Extensibility', 'Image', 'Clip', 'BasicClip', 'Filter', 'BasicFilter',
    'Pattern', 'Marker', 'Font', 'BasicFont', 'Script', 'Animation', 'ColorProfile',
    'Cursor', 'View'
  ].map((name) => `http://www.w3.org/TR/SVG11/feature#${name}`)
);

let defaultLanguages = null;

/**
 * The languages a document's `systemLanguage` is matched against where the
 * caller names none: the browser's, or the locale the runtime runs in, each
 * followed by its language alone — `en-AU`, then `en` — as a browser's
 * language settings suggest (SVG 1.1, 5.8.5). Worked out once.
 */
function userLanguages() {
  if (defaultLanguages) return defaultLanguages;
  const nav = globalThis.navigator?.languages;
  const tags = nav?.length ? [...nav] : [new Intl.DateTimeFormat().resolvedOptions().locale];
  const out = [];
  for (const t of tags) {
    for (const v of [t, t.split('-')[0]]) {
      const lower = v.toLowerCase();
      if (lower && !out.includes(lower)) out.push(lower);
    }
  }
  return (defaultLanguages = out);
}

/**
 * Whether an element's conditional processing attributes hold (SVG 1.1,
 * 5.8): where one does not, the element and all of it are not rendered, and
 * a `<switch>` passes over it to the next. One it does not carry holds.
 *
 * - `requiredExtensions` never holds, as SvgView supports no extension; an
 *   empty one does not either.
 * - `requiredFeatures` holds unless it names a feature SvgView draws nothing
 *   of. SVG 2 dropped the attribute and browsers hold every one, but the
 *   one they would pick, a `foreignObject`, draws nothing here, and the
 *   `<text>` an exporter writes after it for renderers like this one does.
 * - `systemLanguage` holds where one of its comma-separated tags is one of
 *   `languages`, or that narrowed by a subtag, or the other way round.
 */
function conditionsHold(node, languages) {
  if (!node.attribs) return true;
  if (attr(node, 'requiredExtensions') !== undefined) return false;
  const features = attr(node, 'requiredFeatures');
  if (features !== undefined && features.split(/\s+/).some((f) => UNDRAWN_FEATURES.has(f))) return false;
  const system = attr(node, 'systemLanguage');
  if (system !== undefined) {
    const tags = system.split(',').map((t) => t.trim().toLowerCase());
    const matches = (t, u) => t === u || t.startsWith(`${u}-`) || u.startsWith(`${t}-`);
    if (!tags.some((t) => t && languages.some((u) => matches(t, u)))) return false;
  }
  return true;
}

/**
 * What a `<switch>` renders: its first child element whose conditions hold
 * (SVG 1.1, 5.8.2), whatever that is — a `display: none` one is chosen, and
 * draws nothing — or null where none does.
 */
function switchChoice(node, languages) {
  for (const child of node.children || []) {
    if (child.type === 'tag' && conditionsHold(child, languages)) return child;
  }
  return null;
}

/**
 * An `<alpha-value>` — `opacity`, `fill-opacity`, `stroke-opacity`: a number
 * or a percentage, clamped to 0..1 (CSS Color 4, 5.2). `undefined` for
 * anything else, so the caller keeps what it had.
 */
function alphaValue(raw) {
  const v = String(raw ?? '').trim();
  let n = parseFloat(v);
  if (!Number.isFinite(n)) return undefined;
  if (v.endsWith('%')) n /= 100;
  return Math.min(1, Math.max(0, n));
}

/** A `viewBox` as `[minX, minY, width, height]`, or null where it has none. */
function parseViewBox(node) {
  const vb = (attr(node, 'viewBox') || '')
    .split(/[\s,]+/)
    .filter((s) => s !== '')
    .map(parseFloat);
  return vb.length === 4 && vb.every(Number.isFinite) ? vb : null;
}

/**
 * A length on a viewport-establishing element — `x`, `y`, `width`, `height`
 * — in the user units of the viewport it sits in, `size` along its axis;
 * a percentage is of that. `auto` and a missing or unreadable value are the
 * `fallback`.
 */
function viewportLength(node, name, size, fallback) {
  const v = String(attr(node, name) ?? '').trim();
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return v.endsWith('%') ? (n / 100) * size : n;
}

const ALIGN = /^x(Min|Mid|Max)Y(Min|Mid|Max)$/;
const ALONG = { Min: 0, Mid: 0.5, Max: 1 };

/**
 * The transform that fits a `viewBox` into a viewport `w` by `h` at `x`,`y`,
 * as `preserveAspectRatio` asks (SVG 2, 8.8): scaled evenly to fit inside
 * (`meet`, the default) or to cover it (`slice`), and set where its
 * alignment says, `xMidYMid` by default; or stretched to it for `none`.
 *
 * @returns {[number, number, number, number]} `[sx, sy, tx, ty]`
 */
function viewBoxFit([minX, minY, vbW, vbH], x, y, w, h, par) {
  const words = String(par || '').trim().split(/\s+/);
  if (words[0] === 'defer') words.shift();
  const [align, meetOrSlice] = words;
  let sx = w / vbW;
  let sy = h / vbH;
  if (align === 'none') return [sx, sy, x - minX * sx, y - minY * sy];
  // a value it cannot read is the default as a whole, xMidYMid meet
  const m = ALIGN.exec(align || '');
  const [fx, fy] = m ? [ALONG[m[1]], ALONG[m[2]]] : [0.5, 0.5];
  sx = sy = m && meetOrSlice === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
  return [sx, sy, x - minX * sx + (w - vbW * sx) * fx, y - minY * sy + (h - vbH * sy) * fy];
}

const NON_RENDERED = new Set([
  'defs', 'title', 'desc', 'metadata', 'symbol', 'style',
  'lineargradient', 'radialgradient', 'clippath', 'mask', 'filter', 'pattern', 'marker'
]);

/** parse an SVG transform list into ctx.transform() calls */
export function parseSvgTransform(str) {
  const out = [];
  if (!str) return out;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(str))) {
    const args = m[2]
      .split(/[\s,]+/)
      .filter((s) => s !== '')
      .map(parseFloat);
    if (args.some((a) => !Number.isFinite(a))) continue;
    switch (m[1]) {
      case 'matrix':
        if (args.length === 6) out.push(args);
        break;
      case 'translate':
        out.push([1, 0, 0, 1, args[0] || 0, args[1] || 0]);
        break;
      case 'scale': {
        const sx = args[0] ?? 1;
        const sy = args.length > 1 ? args[1] : sx;
        out.push([sx, 0, 0, sy, 0, 0]);
        break;
      }
      case 'rotate': {
        const a = ((args[0] || 0) * Math.PI) / 180;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        if (args.length > 2) {
          const [, cx, cy] = args;
          out.push([1, 0, 0, 1, cx, cy], [cos, sin, -sin, cos, 0, 0], [1, 0, 0, 1, -cx, -cy]);
        } else {
          out.push([cos, sin, -sin, cos, 0, 0]);
        }
        break;
      }
      case 'skewX':
        out.push([1, 0, Math.tan(((args[0] || 0) * Math.PI) / 180), 1, 0, 0]);
        break;
      case 'skewY':
        out.push([1, Math.tan(((args[0] || 0) * Math.PI) / 180), 0, 1, 0, 0]);
        break;
    }
  }
  return out;
}

function shapePath(node) {
  const a = node.attribs || {};
  const path = new Path2D();
  switch (tag(node)) {
    case 'path':
      return a.d ? new Path2D(a.d) : null;
    case 'rect': {
      const x = attrNum(node, 'x');
      const y = attrNum(node, 'y');
      const w = attrNum(node, 'width');
      const h = attrNum(node, 'height');
      if (!(w > 0) || !(h > 0)) return null;
      let rx = a.rx !== undefined ? attrNum(node, 'rx') : undefined;
      let ry = a.ry !== undefined ? attrNum(node, 'ry') : undefined;
      if (rx === undefined) rx = ry;
      if (ry === undefined) ry = rx;
      if (rx || ry) path.roundRect(x, y, w, h, [{ x: rx || 0, y: ry || 0 }]);
      else path.rect(x, y, w, h);
      return path;
    }
    case 'circle': {
      const r = attrNum(node, 'r');
      if (!(r > 0)) return null;
      path.arc(attrNum(node, 'cx'), attrNum(node, 'cy'), r, 0, Math.PI * 2);
      path.closePath();
      return path;
    }
    case 'ellipse': {
      const rx = attrNum(node, 'rx');
      const ry = attrNum(node, 'ry');
      if (!(rx > 0) || !(ry > 0)) return null;
      path.ellipse(attrNum(node, 'cx'), attrNum(node, 'cy'), rx, ry, 0, 0, Math.PI * 2);
      path.closePath();
      return path;
    }
    case 'line':
      path.moveTo(attrNum(node, 'x1'), attrNum(node, 'y1'));
      path.lineTo(attrNum(node, 'x2'), attrNum(node, 'y2'));
      return path;
    case 'polyline':
    case 'polygon': {
      const nums = (a.points || '')
        .split(/[\s,]+/)
        .filter((s) => s !== '')
        .map(parseFloat);
      if (nums.length < 4) return null;
      path.moveTo(nums[0], nums[1]);
      for (let i = 2; i + 1 < nums.length; i += 2) path.lineTo(nums[i], nums[i + 1]);
      if (node.name === 'polygon') path.closePath();
      return path;
    }
    default:
      return null;
  }
}

function pathBBox(path) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of flattenPath(path._cmds, null, 1)) {
    for (let i = 0; i < poly.pts.length; i += 2) {
      if (poly.pts[i] < minX) minX = poly.pts[i];
      if (poly.pts[i] > maxX) maxX = poly.pts[i];
      if (poly.pts[i + 1] < minY) minY = poly.pts[i + 1];
      if (poly.pts[i + 1] > maxY) maxY = poly.pts[i + 1];
    }
  }
  if (minX > maxX) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

const ABSOLUTE_UNITS = { '': 1, px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 };
const LENGTH = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$/i;

/**
 * A length in user units, which are CSS pixels: a number, a length in an
 * absolute unit, `em` and `ex` of `fontSize`, `rem` of the initial 16px,
 * and a percentage of `percent` — undefined where a percentage means
 * nothing, and for anything it cannot read.
 */
function userLength(raw, fontSize, percent) {
  const m = LENGTH.exec(String(raw ?? '').trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit in ABSOLUTE_UNITS) return n * ABSOLUTE_UNITS[unit];
  if (unit === 'em') return n * fontSize;
  if (unit === 'ex') return (n * fontSize) / 2;
  if (unit === 'rem') return n * 16;
  if (unit === '%' && percent !== undefined) return (n / 100) * percent;
  return undefined;
}

/** A list of lengths — `x="10 20 30"`, `dy="1em"` — or null for none. */
function userLengths(raw, fontSize, percent) {
  if (raw === undefined) return null;
  const out = [];
  for (const part of String(raw).trim().split(/[\s,]+/)) {
    if (part === '') continue;
    const n = userLength(part, fontSize, percent);
    if (n === undefined) return null;
    out.push(n);
  }
  return out.length ? out : null;
}

const FONT_SIZES = {
  'xx-small': 9,
  'x-small': 10,
  small: 13,
  medium: 16,
  large: 18,
  'x-large': 24,
  'xx-large': 32,
  'xxx-large': 48
};

/** `font-size`, against the size it inherits (CSS Fonts 4, 2.5). */
function fontSizeValue(v, inherited) {
  const k = v.toLowerCase();
  if (k in FONT_SIZES) return FONT_SIZES[k];
  if (k === 'larger') return inherited * 1.2;
  if (k === 'smaller') return inherited / 1.2;
  const n = userLength(v, inherited, inherited);
  return n !== undefined && n >= 0 ? n : undefined;
}

/** `font-weight` as a number, `bolder` and `lighter` against the weight it
 * inherits (CSS Fonts 4, 2.2). */
function fontWeightValue(v, inherited) {
  const k = v.toLowerCase();
  if (k === 'normal') return 400;
  if (k === 'bold') return 700;
  if (k === 'bolder') return inherited < 350 ? 400 : inherited < 550 ? 700 : Math.max(900, inherited);
  if (k === 'lighter') return inherited < 100 ? inherited : inherited < 550 ? 100 : inherited < 750 ? 400 : 700;
  const n = Number(k);
  return Number.isFinite(n) && n >= 1 && n <= 1000 ? n : undefined;
}

/** `letter-spacing` and `word-spacing`: `normal` is none, and a length in
 * `em` is of the element's own font size. */
function spacingValue(v, fontSize) {
  if (v.toLowerCase() === 'normal') return 0;
  return userLength(v, fontSize, undefined);
}

const TEXT_TRANSFORMS = new Set(['none', 'uppercase', 'lowercase', 'capitalize']);

/**
 * Whether white space is kept as written: `xml:space="preserve"`, or a CSS
 * `white-space` that does not collapse it (SVG 2, 11.7). Either way a line
 * break and a tab are a space, since an SVG text chunk never wraps.
 */
function whiteSpaceValue(name, v) {
  const k = v.toLowerCase();
  if (name === 'xml:space') return k === 'preserve' ? 'pre' : k === 'default' ? 'normal' : undefined;
  if (k === 'pre' || k === 'pre-wrap' || k === 'break-spaces') return 'pre';
  if (k === 'normal' || k === 'nowrap' || k === 'pre-line') return 'normal';
  return undefined;
}

/**
 * The inherited properties an element ends up with: its parent's, where
 * the element sets them neither by presentation attribute nor in its inline
 * `style`, which wins over the attribute. A value it cannot read is dropped,
 * as CSS drops an invalid declaration — and so is one that leans on a
 * custom property, which there are none of here: `font-family="var(--sans)"`
 * is the family the element inherits. Returns `parent` itself where nothing
 * changes.
 *
 * `font-size` is read first, whichever way round the element writes them:
 * a `letter-spacing` in `em` is of the element's own size.
 */
function resolveStyle(node, parent) {
  let style = parent;
  const own = () => (style === parent ? (style = { ...parent }) : style);
  const decls = [];
  for (const [name, value] of Object.entries(node.attribs || {})) {
    if (STYLE_ATTRS[name]) decls.push([name, value]);
  }
  // inline style="" wins over presentation attributes
  const inline = node.attribs?.style;
  if (inline) {
    for (const decl of inline.split(';')) {
      const idx = decl.indexOf(':');
      if (idx <= 0) continue;
      const name = decl.slice(0, idx).trim().toLowerCase();
      if (STYLE_ATTRS[name]) decls.push([name, decl.slice(idx + 1)]);
      else if (name === 'marker') {
        for (const each of MARKER_PROPERTIES) decls.push([each, decl.slice(idx + 1)]);
      }
    }
  }
  if (!decls.length) return parent;
  const apply = (name, raw) => {
    const key = STYLE_ATTRS[name];
    if (raw === undefined) return;
    const v = String(raw).trim().replace(/\s*!important$/i, '');
    if (v === '' || v === 'inherit') return;
    let value;
    if (NUMERIC.has(key)) {
      const n = parseFloat(v);
      if (Number.isFinite(n)) value = n;
    } else if (ALPHA.has(key)) {
      value = alphaValue(v);
    } else {
      switch (key) {
        case 'visibility': {
          const k = v.toLowerCase();
          if (VISIBILITY.has(k)) value = k;
          break;
        }
        case 'fontSize':
          value = fontSizeValue(v, parent.fontSize);
          break;
        case 'fontWeight':
          value = fontWeightValue(v, parent.fontWeight);
          break;
        case 'fontStyle': {
          const k = v.toLowerCase();
          if (k === 'normal' || k === 'italic') value = k;
          else if (k.startsWith('oblique')) value = 'oblique';
          break;
        }
        case 'fontFamily':
          if (!/\b(?:var|env)\(/i.test(v)) value = v;
          break;
        case 'letterSpacing':
        case 'wordSpacing':
          value = spacingValue(v, (style ?? parent).fontSize);
          break;
        case 'textTransform': {
          const k = v.toLowerCase();
          if (TEXT_TRANSFORMS.has(k)) value = k;
          break;
        }
        case 'whiteSpace':
          value = whiteSpaceValue(name, v);
          break;
        case 'dominantBaseline':
        case 'textAnchor':
          value = v.toLowerCase();
          break;
        case 'markerStart':
        case 'markerMid':
        case 'markerEnd':
          // `none`, or the id a `url(#id)` names; anything else leaves it
          value = urlReference(v);
          if (value === '') value = 'none';
          break;
        default:
          value = v;
      }
    }
    if (value !== undefined) own()[key] = value;
  };
  for (const [name, raw] of decls) if (name === 'font-size') apply(name, raw);
  for (const [name, raw] of decls) if (name !== 'font-size') apply(name, raw);
  return style;
}

/**
 * How many distinct colours a document actually commits to, decided once at
 * parse time.
 *
 * `mono` means every fill and stroke that reaches a shape is `none` or the
 * *same* paint — one literal colour, or `currentColor` throughout. Such a
 * drawing is really a coverage mask plus a colour, so a caller can render it
 * once and recolour it on every draw. `multi` is everything else: a second
 * distinct paint, or a gradient/pattern reference, whose colours belong to
 * the drawing rather than to the UI around it.
 *
 * Opacity does not enter into it: `opacity`, `fill-opacity` and
 * `stroke-opacity` scale coverage, which a mask carries perfectly well.
 *
 * The walk mirrors `_renderNode`, and reads style with the same
 * `resolveStyle` — fill and stroke inherit, inline `style` beats the
 * presentation attribute, the initial fill is black and the initial stroke
 * is none, `<line>` never fills, `<use>` paints its target with the *use*
 * element's style, a shape whose inherited `visibility` is not `visible`
 * paints nothing, and non-rendered and `display: none` subtrees contribute
 * nothing. It starts at the root element itself, because `draw`
 * does: the root `<svg>` is an ordinary element for inheritance, and every
 * mainstream icon set puts `fill`/`stroke` there (issue #306). The two walks
 * have to agree — a scan that skipped the root would disagree with what is
 * painted.
 *
 * @returns {{ kind: 'mono'|'multi', solo: string|null }} `solo` is the one
 *   paint a `mono` document uses — a colour, or the literal `'currentColor'`
 *   when the document defers to its caller — and null when nothing paints.
 */
function scanPaints(root, ids, languages) {
  const paints = new Set();
  let multi = false;

  const note = (paint) => {
    if (paint === 'none') return;
    if (/^url\(/i.test(paint)) multi = true;
    else paints.add(paint);
  };

  const kids = (node, style, depth) => {
    for (const child of node.children || []) {
      if (child.type === 'tag') visit(child, style, depth + 1);
    }
  };

  const visit = (node, parent, depth) => {
    if (multi || depth > 32) return;
    const name = tag(node);
    if (NON_RENDERED.has(name) || displayNone(node) || !conditionsHold(node, languages)) return;
    const style = resolveStyle(node, parent);
    switch (name) {
      case 'svg':
      case 'g':
      case 'a':
        kids(node, style, depth);
        return;
      case 'switch': {
        const chosen = switchChoice(node, languages);
        if (chosen) visit(chosen, style, depth + 1);
        return;
      }
      case 'use': {
        const href = node.attribs?.href || node.attribs?.['xlink:href'] || '';
        const target = href.startsWith('#') ? ids.get(href.slice(1)) : null;
        if (!target) return;
        // <symbol> is non-rendered on its own but renders through <use>
        if (tag(target) === 'symbol') kids(target, style, depth);
        else visit(target, style, depth + 1);
        return;
      }
      case 'text': {
        // each span of it fills in its own paint, and a span of a hidden
        // text may be shown again
        const spans = (el, st, d) => {
          if (st.visibility === 'visible') note(st.fill);
          for (const child of el.children || []) {
            if (child.type !== 'tag' || !TEXT_SPANS.has(tag(child)) || displayNone(child) || d > 32) continue;
            spans(child, resolveStyle(child, st), d + 1);
          }
        };
        spans(node, style, 0);
        return;
      }
      default:
        // a hidden shape paints nothing, though what is in a hidden
        // group may show itself again
        if (style.visibility !== 'visible') return;
        if (name !== 'line') note(style.fill);
        note(style.stroke);
        // what its markers paint is its drawing's too, in the style each
        // marker has where it stands
        if (MARKABLE.has(name)) {
          for (const id of markerIds(style)) {
            const marker = ids.get(id);
            if (marker && tag(marker) === 'marker' && !inMarker.has(marker)) {
              inMarker.add(marker);
              kids(marker, styleWhereItStands(marker, root), depth);
              inMarker.delete(marker);
            }
          }
        }
    }
  };
  const inMarker = new Set();

  visit(root, INHERITED, 0);
  return {
    kind: multi || paints.size > 1 ? 'multi' : 'mono',
    solo: paints.size === 1 ? [...paints][0] : null
  };
}

/**
 * Widget rendering a static SVG document into a window (or any 2d context
 * via `draw()`). Scripting, CSS stylesheets, filters, clip paths and
 * external references are not supported — see docs/svg.md.
 */
export default class SvgView {
  constructor(window, opts = {}) {
    this.window = window ?? null;
    this.theme = { background: 'white', ...(opts.theme || {}) };
    /** fit mode in window mode: 'contain' (default) | 'fill' */
    this.fit = opts.fit || 'contain';
    /**
     * What `currentColor` resolves to, for documents that defer their colour
     * to the surrounding UI the way an icon set does. Per-draw `opts.color`
     * overrides it; both fall back to the CSS initial value, black.
     */
    this.color = opts.color ?? INHERITED.color;
    /**
     * The languages `systemLanguage` is matched against, most preferred
     * first, like `navigator.languages`. Read when a document is adopted, for
     * `paintKind`, and on every draw.
     */
    this.languages = (opts.languages ?? userLanguages()).map((t) => String(t).toLowerCase());

    this._root = null;
    this._ids = new Map();
    this._viewport = [0, 0];
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.viewBox = null;
    /** see `scanPaints`: 'mono' | 'multi', and the single paint of a mono
     * document — `'currentColor'` when it defers its colour to the caller */
    this.paintKind = 'mono';
    this.soloPaint = null;

    if (this.window) {
      this._ctx = this.window.getContext('2d');
      this.window.on('expose', () => this.render());
    }
  }

  /** parse and adopt a new document (a string containing an <svg> element) */
  setSvg(svg) {
    const doc = parseDocument(String(svg), { xmlMode: true });
    const findSvg = (nodes) => {
      for (const n of nodes || []) {
        if (n.type === 'tag' && tag(n) === 'svg') return n;
        const inner = findSvg(n.children);
        if (inner) return inner;
      }
      return null;
    };
    const root = findSvg(doc.children);
    if (!root) throw new Error('SvgView: no <svg> element found');
    return this.setSvgDom(root);
  }

  /**
   * Adopt an already-parsed `<svg>` element (htmlparser2 DOM node) — how a
   * host document hands over its inline SVG, and how react-x11's `<svg>`
   * element passes JSX children. HTML-mode parses (lowercased tag/attribute
   * names) are handled.
   */
  setSvgDom(element) {
    if (!element || element.type !== 'tag' || tag(element) !== 'svg') {
      throw new Error('SvgView: expected an <svg> element');
    }
    this._root = element;

    this._ids = new Map();
    const collect = (node) => {
      for (const child of node.children || []) {
        if (child.type !== 'tag') continue;
        if (child.attribs?.id) this._ids.set(child.attribs.id, child);
        collect(child);
      }
    };
    collect(this._root);

    const scanned = scanPaints(this._root, this._ids, this.languages);
    this.paintKind = scanned.kind;
    this.soloPaint = scanned.solo;

    const a = this._root.attribs || {};
    this.viewBox = parseViewBox(this._root);
    const w = parseFloat(a.width);
    const h = parseFloat(a.height);
    this.naturalWidth = Number.isFinite(w) && !String(a.width || '').endsWith('%') ? w : this.viewBox ? this.viewBox[2] : 300;
    this.naturalHeight = Number.isFinite(h) && !String(a.height || '').endsWith('%') ? h : this.viewBox ? this.viewBox[3] : 150;

    if (this.window) this.render();
    return this;
  }

  /** window mode: clear the background and draw fitted + centered */
  render() {
    if (!this.window) throw new Error('SvgView.render() needs a window');
    const ctx = this._ctx;
    const ww = this.window.width;
    const wh = this.window.height;
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(0, 0, ww, wh);
    if (!this._root) return this;
    let w = ww;
    let h = wh;
    let x = 0;
    let y = 0;
    if (this.fit === 'contain' && this.naturalWidth > 0 && this.naturalHeight > 0) {
      const s = Math.min(ww / this.naturalWidth, wh / this.naturalHeight);
      w = this.naturalWidth * s;
      h = this.naturalHeight * s;
      x = (ww - w) / 2;
      y = (wh - h) / 2;
    }
    this.draw(ctx, x, y, w, h);
    return this;
  }

  /**
   * Draw the document into any 2d context. `w`/`h` default to the
   * document's natural size; the viewBox (when present) is scaled to fit.
   *
   * `opts.color` is what `fill="currentColor"` and `stroke="currentColor"`
   * resolve to for this draw, overriding the view's own `color`. That is how
   * an icon takes its colour from the UI around it — the document itself
   * names no colour, so the same parsed document paints in whatever the
   * caller is using, and a caller caching the result can recolour a cached
   * `paintKind === 'mono'` drawing without re-rendering it.
   *
   * `opts.surface(width, height)` makes an offscreen surface to draw a
   * masked element on: something with a `getContext('2d')`, a `destroy()`,
   * that `ctx.drawImage` takes — or null where there is none. Where it is
   * not given, a context of ntk's own makes an ntk `Surface` on its app, and
   * a window-mode view one on its window's; a context that is neither's —
   * the macOS one react-x11 draws with — needs it given. With no surface, a
   * masked element is drawn unmasked, cut to the mask's region.
   *
   * `opts.font` is what the document's text inherits where it names no font
   * of its own — `{ family, size, weight, style }`, any of them, the size in
   * user units: an inline `<svg>` takes its font from the page around it,
   * as it does in a browser, where on its own it starts from 16px
   * sans-serif.
   */
  draw(ctx, x = 0, y = 0, w = this.naturalWidth, h = this.naturalHeight, opts = {}) {
    if (!this._root) return;
    // what a masked element's surface is made with, and where it can show
    this._surface = opts.surface ?? surfaceMaker(ctx) ?? surfaceMaker(this._ctx);
    this._bounds = deviceBox(ctx, x, y, w, h);
    this._masking = new Set();
    ctx.save();
    ctx.translate(x, y);
    // the user-space size of the viewport, what a nested <svg>'s
    // percentages are of
    this._viewport = [w, h];
    if (this.viewBox) {
      const [minX, minY, vbW, vbH] = this.viewBox;
      if (vbW > 0 && vbH > 0) {
        ctx.scale(w / vbW, h / vbH);
        ctx.translate(-minX, -minY);
        this._viewport = [vbW, vbH];
      }
    } else if (this.naturalWidth > 0 && this.naturalHeight > 0) {
      ctx.scale(w / this.naturalWidth, h / this.naturalHeight);
      this._viewport = [this.naturalWidth, this.naturalHeight];
    }
    this._initial = { ...INHERITED, color: opts.color ?? this.color, ...inheritedFont(opts.font) };
    try {
      this._renderChildren(this._root, ctx, this._style(this._root, this._initial), 1, 0);
    } finally {
      this._surface = null;
      ctx.restore();
    }
  }

  // ------------------------------------------------------------------

  _style(node, parent) {
    return resolveStyle(node, parent);
  }

  /**
   * What a fill or a stroke paints with: a colour, `currentColor`'s, or a
   * gradient for `path`. `tint` maps each colour it is made of — a luminance
   * mask's content is drawn as the coverage it makes (`_ink`).
   */
  _paint(ctx, value, style, path, tint = null) {
    if (value === 'currentColor') value = style.color;
    const url = /^url\(['"]?#([^'")]+)['"]?\)/.exec(value);
    if (!url) return tint ? tint(value) : value;
    const node = this._ids.get(url[1]);
    if (!node || (tag(node) !== 'lineargradient' && tag(node) !== 'radialgradient')) return null;
    return this._gradient(ctx, node, path, tint);
  }

  /**
   * Fill or stroke with a paint: `draw` makes the marks, in `fillStyle` or
   * `strokeStyle` as `kind` says, at `alpha`.
   *
   * Inside a luminance mask (`_renderMasked`), what is drawn is the mask's
   * value, into the alpha of the surface: CSS Masking 1 takes a pixel's
   * luminance times its alpha, as composited. A mark of luminance `L` at
   * alpha `a` leaves `L·a + m·(1 − a)` where it falls on a mask of `m` —
   * `destination-out` at `a`, then `lighter` at `L·a` — so a black shape
   * over a white one hides what is under it, as the colours composited would
   * have. Where the context has neither op, the mark is drawn at `L·a`.
   */
  _ink(ctx, kind, value, style, path, alpha, draw) {
    const key = kind === 'fill' ? 'fillStyle' : 'strokeStyle';
    if (!this._luminance) {
      const paint = this._paint(ctx, value, style, path);
      if (!paint) return;
      ctx[key] = paint;
      ctx.globalAlpha = alpha;
      draw();
      return;
    }
    const erase = this._paint(ctx, value, style, path, coverageOf);
    const add = this._paint(ctx, value, style, path, luminanceOf);
    if (!erase || !add) return;
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = 'destination-out';
    if (ctx.globalCompositeOperation === 'destination-out') {
      ctx[key] = erase;
      draw();
      ctx.globalCompositeOperation = 'lighter';
    }
    ctx[key] = add;
    draw();
    ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * A gradient and the gradients it takes after: the one its `href` names,
   * the one that names, and so on (SVG 1.1, 13.2.2). What a gradient does
   * not set itself it takes from the first of these that sets it, and its
   * stops, where it has none, from the first that has some. An editor
   * writes a drawing's colours once, in a gradient of stops alone, and
   * every gradient that uses them as one line with an `xlink:href` to it:
   * read without it, each had no stops, and what it filled was not drawn.
   */
  _gradientChain(node) {
    const chain = [node];
    for (let at = node; chain.length < 32;) {
      const href = attr(at, 'href') || attr(at, 'xlink:href') || '';
      const next = href.startsWith('#') ? this._ids.get(href.slice(1)) : null;
      if (!next || chain.includes(next)) break;
      if (tag(next) !== 'lineargradient' && tag(next) !== 'radialgradient') break;
      chain.push(next);
      at = next;
    }
    return chain;
  }

  _gradient(ctx, node, path, tint = null) {
    const chain = this._gradientChain(node);
    const own = (name) => {
      for (const from of chain) {
        const value = attr(from, name);
        if (value !== undefined) return value;
      }
      return undefined;
    };
    const units = own('gradientUnits') || 'objectBoundingBox';
    const bbox = units === 'objectBoundingBox' ? pathBBox(path) : null;
    const coord = (raw, fallback, axis) => {
      let v = raw === undefined ? fallback : parseFloat(raw);
      if (String(raw ?? '').endsWith('%')) v /= 100;
      if (!Number.isFinite(v)) v = fallback;
      if (!bbox) return v;
      return axis === 'x' ? bbox.x + v * bbox.w : bbox.y + v * bbox.h;
    };
    // `gradientTransform` is set in the gradient's own space, the bounding
    // box's where that is its units: here, as the matrix it comes to in
    // the path's user space
    const matrix = gradientMatrix(own('gradientTransform'), bbox);
    // gradient coordinates are user space, like the path's own — the
    // context resolves them against the transform in force when it paints,
    // which is this one (issue #271)
    let gradient;
    if (tag(node) === 'lineargradient') {
      let x1 = coord(own('x1'), 0, 'x');
      let y1 = coord(own('y1'), 0, 'y');
      let x2 = coord(own('x2'), 1, 'x');
      let y2 = coord(own('y2'), 0, 'y');
      if (matrix) [x1, y1, x2, y2] = transformedLine(matrix, x1, y1, x2, y2);
      gradient = ctx.createLinearGradient(x1, y1, x2, y2);
    } else {
      let cx = coord(own('cx'), 0.5, 'x');
      let cy = coord(own('cy'), 0.5, 'y');
      const raw = own('r');
      let r = raw === undefined ? 0.5 : parseFloat(raw);
      if (String(raw ?? '').endsWith('%')) r /= 100;
      if (bbox) r *= (bbox.w + bbox.h) / 2;
      if (matrix) {
        // a circle's centre goes where the matrix takes it, and its radius
        // grows by what the matrix scales an area by: exact for a matrix
        // that turns, moves and scales evenly, and a circle of the same
        // area where one stretches it into an ellipse, which a context's
        // radial gradient is not
        const [a, b, c, d, e, f] = matrix;
        [cx, cy] = [a * cx + c * cy + e, b * cx + d * cy + f];
        r *= Math.sqrt(Math.abs(a * d - b * c));
      }
      gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    }

    const stops = chain.find((from) =>
      (from.children || []).some((child) => child.type === 'tag' && tag(child) === 'stop')
    );
    for (const stop of stops?.children || []) {
      if (stop.type !== 'tag' || tag(stop) !== 'stop') continue;
      const sa = stop.attribs || {};
      const decls = {};
      for (const decl of (sa.style || '').split(';')) {
        const idx = decl.indexOf(':');
        if (idx > 0) decls[decl.slice(0, idx).trim()] = decl.slice(idx + 1).trim();
      }
      let offset = parseFloat(sa.offset ?? '0');
      if (String(sa.offset ?? '').endsWith('%')) offset /= 100;
      if (!Number.isFinite(offset)) offset = 0;
      const color = decls['stop-color'] || sa['stop-color'] || '#000';
      const so = parseFloat(decls['stop-opacity'] ?? sa['stop-opacity'] ?? '1');
      const stopColor = Number.isFinite(so) && so < 1 ? rgbaWithAlpha(color, so) : color;
      const painted = tint ? tint(stopColor) : stopColor;
      if (painted) gradient.addColorStop(offset, painted);
    }
    return gradient;
  }

  _renderChildren(node, ctx, style, alpha, depth) {
    for (const child of node.children || []) {
      if (child.type !== 'tag') continue;
      this._renderNode(child, ctx, style, alpha, depth);
    }
  }

  /**
   * A nested `<svg>`, which is a new viewport and not a group (SVG 2, 8.2):
   * `width` by `height` at `x`,`y` of the user space it sits in, all of the
   * viewport around it where they are unset, and percentages of that. Its
   * `viewBox` is fitted in as `preserveAspectRatio` says, and what it draws
   * is clipped to it unless its `overflow` is `visible` or `auto`. A zero
   * or negative size, or a zero-sized `viewBox`, draws nothing.
   */
  _renderViewport(node, ctx, style, alpha, depth) {
    const outer = this._viewport;
    const [pw, ph] = outer;
    const x = viewportLength(node, 'x', pw, 0);
    const y = viewportLength(node, 'y', ph, 0);
    const w = viewportLength(node, 'width', pw, pw);
    const h = viewportLength(node, 'height', ph, ph);
    if (!(w > 0) || !(h > 0)) return;
    // a negative size makes the viewBox an error, and it is ignored
    let vb = parseViewBox(node);
    if (vb && (vb[2] === 0 || vb[3] === 0)) return;
    if (vb && (vb[2] < 0 || vb[3] < 0)) vb = null;

    ctx.save();
    const overflow = ownProperty(node, 'overflow', keyword);
    if (overflow !== 'visible' && overflow !== 'auto') {
      const clip = new Path2D();
      clip.rect(x, y, w, h);
      ctx.clip(clip);
    }
    if (vb) {
      const [sx, sy, tx, ty] = viewBoxFit(vb, x, y, w, h, attr(node, 'preserveAspectRatio'));
      ctx.transform(sx, 0, 0, sy, tx, ty);
      this._viewport = [vb[2], vb[3]];
    } else {
      if (x || y) ctx.translate(x, y);
      this._viewport = [w, h];
    }
    this._renderChildren(node, ctx, style, alpha, depth + 1);
    this._viewport = outer;
    ctx.restore();
  }

  _renderNode(node, ctx, parentStyle, alpha, depth) {
    if (depth > 32) return;
    const name = tag(node);
    if (NON_RENDERED.has(name) || displayNone(node) || !conditionsHold(node, this.languages)) return;

    const style = this._style(node, parentStyle);
    // not inherited: a group's multiplies down through what is in it
    const nodeAlpha = alpha * (ownProperty(node, 'opacity', alphaValue) ?? 1);
    if (nodeAlpha <= 0) return;

    const transforms = parseSvgTransform(node.attribs?.transform);
    const needsCtxState = transforms.length > 0;
    if (needsCtxState) {
      ctx.save();
      for (const t of transforms) ctx.transform(t[0], t[1], t[2], t[3], t[4], t[5]);
    }

    const mask = this._maskOf(node);
    if (mask) this._renderMasked(node, mask, ctx, style, nodeAlpha, depth);
    else this._renderElement(node, ctx, style, nodeAlpha, depth);

    if (needsCtxState) ctx.restore();
  }

  /** What an element draws, in the user space its `transform` makes. */
  _renderElement(node, ctx, style, nodeAlpha, depth) {
    const name = tag(node);
    switch (name) {
      case 'svg':
        this._renderViewport(node, ctx, style, nodeAlpha, depth);
        break;
      case 'g':
      case 'a':
        this._renderChildren(node, ctx, style, nodeAlpha, depth + 1);
        break;
      case 'switch': {
        // a group of one: its transform and opacity are a group's, and it
        // draws the first child whose conditions hold and none of the rest
        const chosen = switchChoice(node, this.languages);
        if (chosen) this._renderNode(chosen, ctx, style, nodeAlpha, depth + 1);
        break;
      }
      case 'use': {
        const target = this._useTarget(node);
        if (target) {
          const ux = attrNum(node, 'x');
          const uy = attrNum(node, 'y');
          ctx.save();
          if (ux || uy) ctx.translate(ux, uy);
          if (tag(target) === 'symbol') this._renderChildren(target, ctx, style, nodeAlpha, depth + 1);
          else this._renderNode(target, ctx, style, nodeAlpha, depth + 1);
          ctx.restore();
        }
        break;
      }
      case 'text':
        // `visibility` is asked of each run, since a span of a hidden
        // `<text>` may be shown again
        this._renderText(node, ctx, style, nodeAlpha);
        break;
      default: {
        // `visibility` hides what an element paints itself, and is
        // inherited: a group walks on, since what is in it may say
        // `visible` again
        if (style.visibility !== 'visible') break;
        const path = shapePath(node);
        if (!path) break;
        if (name !== 'line' && style.fill !== 'none') {
          const rule = style.fillRule === 'evenodd' ? 'evenodd' : 'nonzero';
          this._ink(ctx, 'fill', style.fill, style, path, nodeAlpha * style.fillOpacity, () => ctx.fill(path, rule));
        }
        if (style.stroke !== 'none' && style.strokeWidth > 0) {
          ctx.lineWidth = style.strokeWidth;
          ctx.lineCap = style.lineCap;
          ctx.lineJoin = style.lineJoin;
          ctx.miterLimit = style.miterLimit;
          this._ink(ctx, 'stroke', style.stroke, style, path, nodeAlpha * style.strokeOpacity, () => ctx.stroke(path));
        }
        ctx.globalAlpha = 1;
        // over its fill and its stroke, which is the default paint order
        if (MARKABLE.has(name)) this._renderMarkers(path, ctx, style, nodeAlpha, depth);
        break;
      }
    }
  }

  /**
   * The markers a shape's `marker-start`, `marker-mid` and `marker-end`
   * name, drawn at its vertices (SVG 2, 11.6): the first vertex of the
   * path, every one between, and the last. Each is a `<marker>`'s content
   * in a viewport of its own — `markerWidth` by `markerHeight`, scaled by
   * the stroke width unless `markerUnits` is `userSpaceOnUse` — with its
   * `viewBox` fitted in, the point `refX`,`refY` of it on the vertex,
   * turned to the direction the path runs there where `orient` is `auto`
   * (and the other way at the start for `auto-start-reverse`) or by its
   * angle, and clipped to the viewport unless its `overflow` is `visible`
   * or `auto`. What is in a marker inherits from the marker's ancestors,
   * not from the shape, and a marker that is being drawn already draws
   * nothing.
   */
  _renderMarkers(path, ctx, style, alpha, depth) {
    if (style.markerStart === 'none' && style.markerMid === 'none' && style.markerEnd === 'none') return;
    const vertices = pathVertices(path);
    if (!vertices.length) return;
    const last = vertices.length - 1;
    vertices.forEach((v, i) => {
      const id = i === 0 ? style.markerStart : i === last ? style.markerEnd : style.markerMid;
      if (id !== 'none') this._renderMarker(id, v, i === 0, ctx, style, alpha, depth);
    });
  }

  _renderMarker(id, vertex, first, ctx, style, alpha, depth) {
    const marker = this._ids.get(id);
    if (!marker || tag(marker) !== 'marker' || displayNone(marker)) return;
    if ((this._marking ??= new Set()).has(marker)) return;
    const mw = viewportLength(marker, 'markerWidth', 0, 3);
    const mh = viewportLength(marker, 'markerHeight', 0, 3);
    if (!(mw > 0) || !(mh > 0)) return;
    let vb = parseViewBox(marker);
    if (vb && !(vb[2] > 0 && vb[3] > 0)) return;
    const angle = markerAngle(attr(marker, 'orient'), vertex, first);
    const units = (attr(marker, 'markerUnits') || '').trim() === 'userSpaceOnUse' ? 1 : style.strokeWidth;
    if (!(units > 0)) return;
    const [sx, sy, tx, ty] = vb ? viewBoxFit(vb, 0, 0, mw, mh, attr(marker, 'preserveAspectRatio')) : [1, 1, 0, 0];
    const box = vb ?? [0, 0, mw, mh];
    const refX = refPoint(attr(marker, 'refX'), box[0], box[2]);
    const refY = refPoint(attr(marker, 'refY'), box[1], box[3]);

    const outer = this._viewport;
    ctx.save();
    this._marking.add(marker);
    try {
      ctx.transform(1, 0, 0, 1, vertex.x, vertex.y);
      if (angle) {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        ctx.transform(cos, sin, -sin, cos, 0, 0);
      }
      if (units !== 1) ctx.transform(units, 0, 0, units, 0, 0);
      // the viewport's corner, so that the reference point is on the vertex
      ctx.transform(1, 0, 0, 1, -(sx * refX + tx), -(sy * refY + ty));
      const overflow = ownProperty(marker, 'overflow', keyword);
      if (overflow !== 'visible' && overflow !== 'auto') {
        const clip = new Path2D();
        clip.rect(0, 0, mw, mh);
        ctx.clip(clip);
      }
      if (vb) ctx.transform(sx, 0, 0, sy, tx, ty);
      this._viewport = [box[2], box[3]];
      this._renderChildren(marker, ctx, this._inheritedStyle(marker), alpha, depth + 1);
    } finally {
      this._viewport = outer;
      this._marking.delete(marker);
      ctx.restore();
    }
  }

  _useTarget(node) {
    const href = node.attribs?.href || node.attribs?.['xlink:href'] || '';
    return href.startsWith('#') ? (this._ids.get(href.slice(1)) ?? null) : null;
  }

  /** The `<mask>` an element's `mask` names, or null for none — and for one
   * that is being drawn already, which a mask that reaches itself is. */
  _maskOf(node) {
    const id = ownProperty(node, 'mask', urlReference);
    if (!id) return null;
    const mask = this._ids.get(id);
    if (!mask || tag(mask) !== 'mask' || this._masking?.has(mask)) return null;
    return mask;
  }

  /**
   * A masked element (CSS Masking 1, 7): drawn on a surface of its own, and
   * the mask's content on a second, through the same transform — device
   * pixels, the part of the mask's region the drawing can show. The second
   * cuts the first with `destination-in`, and the first is composited in
   * the element's place at its opacity, which applies to what the mask
   * leaves of it as a group. A `mask-type` of `alpha` takes the mask's
   * alpha as it is; the default, `luminance`, has its content drawn as the
   * luminance it makes (`_ink`).
   *
   * With no surface to draw on, or no `destination-in` to cut with, the
   * element is drawn as it is, cut to the mask's region.
   */
  _renderMasked(node, mask, ctx, style, alpha, depth) {
    const byBox = (attr(mask, 'maskUnits') || '').trim() !== 'userSpaceOnUse';
    const contentByBox = (attr(mask, 'maskContentUnits') || '').trim() === 'objectBoundingBox';
    let bbox = null;
    if (byBox || contentByBox) {
      bbox = this._bbox(node, ctx, style, depth);
      // with no area there is nothing to measure the mask against, and the
      // element is not drawn
      if (!bbox || !(bbox.w > 0 && bbox.h > 0)) return;
    }
    const region = maskRegion(mask, byBox ? bbox : null, this._viewport);
    if (!region) return;
    const m = ctx.getTransform?.();
    const make = this._surface;
    const box = m && make && ctx.drawImage && ctx.setTransform ? surfaceBox(m, region, this._bounds) : null;
    if (box === EMPTY) return;
    let content = null;
    let cover = null;
    let cctx = null;
    let mctx = null;
    let done = false;
    const bounds = this._bounds;
    const luminance = this._luminance;
    try {
      if (box) {
        content = make(box.w, box.h);
        cover = content && make(box.w, box.h);
      }
      if (cover) {
        cctx = content.getContext('2d');
        cctx.globalCompositeOperation = 'destination-in';
        if (cctx.globalCompositeOperation === 'destination-in') {
          cctx.globalCompositeOperation = 'source-over';
          const place = [m.a, m.b, m.c, m.d, m.e - box.x, m.f - box.y];
          // what the surfaces show is all of them
          this._bounds = { x: 0, y: 0, w: box.w, h: box.h };
          this._luminance = false;
          cctx.transform(...place);
          this._renderElement(node, cctx, style, 1, depth);

          mctx = cover.getContext('2d');
          mctx.transform(...place);
          const clip = new Path2D();
          clip.rect(region.x, region.y, region.w, region.h);
          mctx.clip(clip);
          if (contentByBox) mctx.transform(bbox.w, 0, 0, bbox.h, bbox.x, bbox.y);
          this._luminance = ownProperty(mask, 'mask-type', keyword) !== 'alpha';
          this._masking.add(mask);
          try {
            this._renderChildren(mask, mctx, this._inheritedStyle(mask), 1, depth + 1);
          } finally {
            this._masking.delete(mask);
          }

          cctx.setTransform(1, 0, 0, 1, 0, 0);
          cctx.globalAlpha = 1;
          cctx.globalCompositeOperation = 'destination-in';
          cctx.drawImage(cover, 0, 0);
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.globalAlpha = alpha;
          ctx.drawImage(content, box.x, box.y);
          ctx.restore();
          done = true;
        }
      }
    } finally {
      this._bounds = bounds;
      this._luminance = luminance;
      mctx?.destroy?.();
      cctx?.destroy?.();
      cover?.destroy?.();
      content?.destroy?.();
    }
    if (done) return;
    ctx.save();
    const clip = new Path2D();
    clip.rect(region.x, region.y, region.w, region.h);
    ctx.clip(clip);
    this._renderElement(node, ctx, style, alpha, depth);
    ctx.restore();
  }

  /** The style an element has where it stands in the document: what is in a
   * `<mask>` inherits from the mask's ancestors, not from what it masks. */
  _inheritedStyle(node) {
    const chain = [];
    for (let at = node; at && at.type === 'tag' && at !== this._root; at = at.parent) chain.push(at);
    let style = this._style(this._root, this._initial ?? INHERITED);
    for (let i = chain.length - 1; i >= 0; i--) style = this._style(chain[i], style);
    return style;
  }

  /**
   * An element's bounding box in its own user space (SVG 2, 8.10): the
   * geometry of its shapes and text, without strokes, through the
   * transforms of what is in it but not its own. Null for one that has
   * none.
   */
  _bbox(node, ctx, style, depth) {
    if (depth > 32) return null;
    const name = tag(node);
    switch (name) {
      case 'svg':
      case 'g':
      case 'a':
      case 'switch': {
        const kids = name === 'switch' ? [switchChoice(node, this.languages)] : node.children || [];
        let box = null;
        for (const child of kids) {
          if (!child || child.type !== 'tag') continue;
          if (NON_RENDERED.has(tag(child)) || displayNone(child) || !conditionsHold(child, this.languages)) continue;
          const inner = this._bbox(child, ctx, this._style(child, style), depth + 1);
          if (inner) box = unionBox(box, transformedBox(inner, parseSvgTransform(child.attribs?.transform)));
        }
        return box;
      }
      case 'use': {
        const target = this._useTarget(node);
        if (!target || displayNone(target)) return null;
        let box = null;
        if (tag(target) === 'symbol') {
          for (const child of target.children || []) {
            if (child.type !== 'tag' || NON_RENDERED.has(tag(child)) || displayNone(child)) continue;
            const inner = this._bbox(child, ctx, this._style(child, style), depth + 1);
            if (inner) box = unionBox(box, transformedBox(inner, parseSvgTransform(child.attribs?.transform)));
          }
        } else {
          const inner = this._bbox(target, ctx, this._style(target, style), depth + 1);
          if (inner) box = transformedBox(inner, parseSvgTransform(target.attribs?.transform));
        }
        return box && { ...box, x: box.x + attrNum(node, 'x'), y: box.y + attrNum(node, 'y') };
      }
      case 'text': {
        ctx.save();
        try {
          return this._layoutText(node, ctx, style, 1).box;
        } finally {
          ctx.restore();
        }
      }
      default: {
        const path = shapePath(node);
        return path ? pathBBox(path) : null;
      }
    }
  }

  /**
   * A `<text>` laid out (SVG 2, 11.8): its characters, after white space is
   * collapsed, in runs of one style that nothing places apart, each where
   * the positions before it put it, with each text chunk — what starts at
   * an absolute `x` or `y` — moved as its `text-anchor` says. A run is
   * `{ text, x, y, font, span }`, `y` its baseline, and `box` is what the
   * runs cover.
   *
   * The anchor is measured, not left to `textAlign`: a chunk is more than
   * one run as soon as a `tspan` changes its size, and a context that
   * draws through CoreText or DirectWrite has no `textAlign` at all.
   *
   * Lengths are user units, and the glyphs are set at the size they are
   * drawn: where the context does not scale text with its transform — ntk's
   * own, whose glyphs are rasterized at the size they were shaped at — the
   * transform's scale goes into the font size, and what is measured comes
   * back out of it.
   */
  _layoutText(node, ctx, style, alpha) {
    const chars = [];
    const owner = [];
    const spans = [];
    // whether a space here would follow another, or nothing: one that
    // would is collapsed away
    let space = true;
    const collect = (el, st, a, depth) => {
      const index = spans.length;
      const span = { node: el, style: st, alpha: a, start: chars.length, end: chars.length };
      spans.push(span);
      const keep = st.whiteSpace === 'pre';
      const walk = (list) => {
        for (const child of list || []) {
          if (child.type === 'text') {
            for (const ch of child.data) {
              if (ch === '\r') continue;
              const c = ch === '\n' || ch === '\t' ? ' ' : ch;
              if (c === ' ' && space && !keep) continue;
              chars.push(c);
              owner.push(index);
              space = c === ' ';
            }
          } else if (child.type === 'cdata') {
            walk(child.children);
          } else if (child.type === 'tag' && depth < 32) {
            if (!TEXT_SPANS.has(tag(child)) || displayNone(child) || !conditionsHold(child, this.languages)) continue;
            const ca = a * (ownProperty(child, 'opacity', alphaValue) ?? 1);
            collect(child, this._style(child, st), ca, depth + 1);
          }
        }
      };
      walk(el.children);
      span.end = chars.length;
    };
    collect(node, style, alpha, 0);
    // and a space at the end goes, as one at the start did
    while (chars.length && chars[chars.length - 1] === ' ' && spans[owner[owner.length - 1]].style.whiteSpace !== 'pre') {
      chars.pop();
      owner.pop();
    }
    const n = chars.length;
    if (!n) return { pieces: [], box: null };
    for (const span of spans) {
      span.start = Math.min(span.start, n);
      span.end = Math.min(span.end, n);
    }

    // Each character's position, from the innermost element that gives
    // one for it: an element's lists are of its own characters, in order,
    // and an element comes after the ones it is in.
    const [vw, vh] = this._viewport;
    const X = [];
    const Y = [];
    const DX = [];
    const DY = [];
    const place = (into, span, list) => {
      if (!list) return;
      for (let k = 0; k < list.length && span.start + k < span.end; k++) into[span.start + k] = list[k];
    };
    for (const span of spans) {
      if (span.start === span.end) continue;
      const size = span.style.fontSize;
      place(X, span, userLengths(attr(span.node, 'x'), size, vw));
      place(Y, span, userLengths(attr(span.node, 'y'), size, vh));
      place(DX, span, userLengths(attr(span.node, 'dx'), size, vw));
      place(DY, span, userLengths(attr(span.node, 'dy'), size, vh));
    }

    const m = ctx.getTransform?.();
    const scale = ctx.scalesText || !m ? 1 : Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
    const pieces = [];
    const chunks = [];
    let chunk = null;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < n; ) {
      const span = spans[owner[i]];
      const st = span.style;
      if (chunk === null || X[i] !== undefined || Y[i] !== undefined) {
        if (X[i] !== undefined) cx = X[i];
        if (Y[i] !== undefined) cy = Y[i];
        chunk = { anchor: st.textAnchor, start: Infinity, end: -Infinity, pieces: [] };
        chunks.push(chunk);
      }
      cx += DX[i] ?? 0;
      cy += DY[i] ?? 0;
      // spacing goes after each character, so each is a run of its own
      const spaced = st.letterSpacing !== 0 || st.wordSpacing !== 0;
      let j = i + 1;
      if (!spaced) {
        while (
          j < n &&
          owner[j] === owner[i] &&
          X[j] === undefined &&
          Y[j] === undefined &&
          DX[j] === undefined &&
          DY[j] === undefined
        ) {
          j++;
        }
      }
      const raw = chars.slice(i, j).join('');
      const text = transformText(raw, st.textTransform, i === 0 || /\s/.test(chars[i - 1]));
      const font = fontOf(st, scale);
      ctx.font = font;
      const metrics = ctx.measureText?.(text);
      const width = (metrics?.width ?? 0) / scale;
      // the font's own extent where the context says, and an em's
      // proportions where it does not
      const fa = metrics?.fontBoundingBoxAscent;
      const fd = metrics?.fontBoundingBoxDescent;
      const ascent = Number.isFinite(fa) ? fa / scale : 0.8 * st.fontSize;
      const descent = Number.isFinite(fd) ? fd / scale : 0.2 * st.fontSize;
      const align = ownProperty(span.node, 'alignment-baseline', keyword);
      const baseline = align && align !== 'auto' && align !== 'baseline' ? align : st.dominantBaseline;
      const shift = baselineShift(baseline, ascent, descent, st.fontSize);
      const piece = { text, x: cx, y: cy + shift, width, ascent, descent, font, span };
      pieces.push(piece);
      chunk.pieces.push(piece);
      chunk.start = Math.min(chunk.start, cx);
      cx += width;
      if (spaced) cx += st.letterSpacing + (raw === ' ' ? st.wordSpacing : 0);
      chunk.end = Math.max(chunk.end, cx);
      i = j;
    }
    let box = null;
    for (const c of chunks) {
      const extent = c.end - c.start;
      const by = c.anchor === 'middle' ? -extent / 2 : c.anchor === 'end' ? -extent : 0;
      for (const p of c.pieces) {
        p.x += by;
        box = unionBox(box, { x: p.x, y: p.y - p.ascent, w: p.width, h: p.ascent + p.descent });
      }
    }
    return { pieces, box };
  }

  _renderText(node, ctx, style, alpha) {
    ctx.save();
    try {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      const { pieces, box } = this._layoutText(node, ctx, style, alpha);
      // what a gradient's bounding box is: the whole text's
      let bounds = null;
      for (const p of pieces) {
        const st = p.span.style;
        if (st.visibility !== 'visible' || st.fill === 'none' || !p.text.trim()) continue;
        if (!bounds) {
          bounds = new Path2D();
          bounds.rect(box.x, box.y, box.w, box.h);
        }
        ctx.font = p.font;
        this._ink(ctx, 'fill', st.fill, st, bounds, p.span.alpha * st.fillOpacity, () => ctx.fillText(p.text, p.x, p.y));
      }
    } finally {
      ctx.restore();
    }
  }
}

/** The font properties a caller's `opts.font` gives the root to inherit,
 * as far as they are ones it can use. */
function inheritedFont(font) {
  const out = {};
  if (!font) return out;
  if (typeof font.family === 'string' && font.family.trim() && !/\b(?:var|env)\(/i.test(font.family)) {
    out.fontFamily = font.family.trim();
  }
  if (Number.isFinite(font.size) && font.size >= 0) out.fontSize = font.size;
  if (Number.isFinite(font.weight) && font.weight >= 1 && font.weight <= 1000) out.fontWeight = font.weight;
  if (font.style === 'normal' || font.style === 'italic' || font.style === 'oblique') out.fontStyle = font.style;
  return out;
}

/** What a `<text>` holds that is text of its own: a span of it. */
const TEXT_SPANS = new Set(['tspan', 'a', 'textpath']);

/**
 * The font a run is set in, as a CSS `font` shorthand — `italic` and the
 * weight before the size, which is the order both ntk's parser and
 * react-x11's native contexts read. The weight is a number between 100
 * and 999 to keep to three digits, which the native contexts ask of one.
 */
function fontOf(style, scale) {
  const size = Math.round(Math.max(0, style.fontSize * scale) * 1000) / 1000;
  const w = Math.min(999, Math.max(100, Math.round(style.fontWeight)));
  const weight = w === 400 ? '' : w === 700 ? 'bold ' : `${w} `;
  const slant = style.fontStyle === 'normal' ? '' : `${style.fontStyle} `;
  return `${slant}${weight}${size}px ${style.fontFamily}`;
}

/** `text-transform` on a run; `atWordStart` says whether it starts a word,
 * for `capitalize`. */
function transformText(text, how, atWordStart) {
  switch (how) {
    case 'uppercase':
      return text.toUpperCase();
    case 'lowercase':
      return text.toLowerCase();
    case 'capitalize': {
      let out = '';
      let start = atWordStart;
      for (const ch of text) {
        out += start ? ch.toUpperCase() : ch;
        start = /\s/.test(ch);
      }
      return out;
    }
    default:
      return text;
  }
}

/**
 * How far below the `y` it is given a run's alphabetic baseline goes, for
 * the baseline `dominant-baseline` or `alignment-baseline` names (CSS
 * Inline 3, 4): `central` is half way down the font's extent, `middle`
 * half an x-height above the baseline — the em's half of one where the
 * font's is not known — and the edges are the font's ascent and descent.
 */
function baselineShift(baseline, ascent, descent, fontSize) {
  switch (baseline) {
    case 'central':
      return (ascent - descent) / 2;
    case 'middle':
      return 0.25 * fontSize;
    case 'hanging':
      return 0.8 * ascent;
    case 'mathematical':
      return ascent / 2;
    case 'text-before-edge':
    case 'before-edge':
    case 'text-top':
      return ascent;
    case 'text-after-edge':
    case 'after-edge':
    case 'text-bottom':
    case 'ideographic':
      return -descent;
    default:
      return 0;
  }
}

/** The id a `mask` names — `url(#id)` — `''` for `none`, and undefined for
 * anything else, which leaves what the attribute said. */
function urlReference(raw) {
  const v = String(raw ?? '').trim();
  if (v.toLowerCase() === 'none') return '';
  const m = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/i.exec(v);
  return m ? m[1] : undefined;
}

/** The shapes that take markers (SVG 2, 11.6): the ones with vertices. */
const MARKABLE = new Set(['path', 'line', 'polyline', 'polygon']);

/** The ids of the markers a style names, each once. */
function markerIds(style) {
  const ids = new Set([style.markerStart, style.markerMid, style.markerEnd]);
  ids.delete('none');
  return ids;
}

/** The style an element has where it stands, from the root down — what a
 * marker's content inherits, the walk `_inheritedStyle` makes for a
 * drawing. */
function styleWhereItStands(node, root) {
  const chain = [];
  for (let at = node; at && at.type === 'tag' && at !== root; at = at.parent) chain.push(at);
  let style = resolveStyle(root, INHERITED);
  for (let i = chain.length - 1; i >= 0; i--) style = resolveStyle(chain[i], style);
  return style;
}

/**
 * A path's vertices, for its markers (SVG 2, 11.6.2): where each subpath
 * starts and where each of its segments ends, a closing segment's at the
 * subpath's start, with the direction the path comes in by and goes out
 * by, in radians — null where it does neither. A segment's direction at an
 * end is its tangent there, a curve's toward the nearest control point
 * that is not on that end. An arc, which the parser turns into curves, is
 * one segment: the curves it was cut into make no vertices between them.
 */
function pathVertices(path) {
  const out = [];
  const cmds = path?._cmds;
  if (!Array.isArray(cmds)) return out;
  let x = 0;
  let y = 0;
  let start = -1;
  const toward = (fx, fy, points) => {
    for (const [px, py] of points) {
      if (px !== fx || py !== fy) return Math.atan2(py - fy, px - fx);
    }
    return null;
  };
  const segment = (startDir, endDir, nx, ny, inner) => {
    const from = out[out.length - 1];
    if (from && from.out === null) from.out = startDir;
    x = nx;
    y = ny;
    if (!inner) out.push({ x, y, in: endDir, out: null });
  };
  for (const c of cmds) {
    switch (c.type) {
      case 'M':
        x = c.x;
        y = c.y;
        start = out.length;
        out.push({ x, y, in: null, out: null });
        break;
      case 'L': {
        const dir = toward(x, y, [[c.x, c.y]]);
        segment(dir, dir, c.x, c.y, false);
        break;
      }
      case 'C': {
        const back = toward(c.x, c.y, [[c.x2, c.y2], [c.x1, c.y1], [x, y]]);
        const ahead = toward(x, y, [[c.x1, c.y1], [c.x2, c.y2], [c.x, c.y]]);
        segment(ahead, back === null ? null : back + Math.PI, c.x, c.y, c.arcPart === true);
        break;
      }
      case 'Q': {
        const back = toward(c.x, c.y, [[c.x1, c.y1], [x, y]]);
        segment(toward(x, y, [[c.x1, c.y1], [c.x, c.y]]), back === null ? null : back + Math.PI, c.x, c.y, false);
        break;
      }
      case 'Z': {
        if (start < 0) break;
        const head = out[start];
        const dir = toward(x, y, [[head.x, head.y]]);
        segment(dir, dir, head.x, head.y, false);
        const closing = out[out.length - 1];
        // a closed subpath comes back into its start by its closing segment,
        // and its closing vertex goes on out the way the start did
        head.in = closing.in;
        closing.out = head.out;
        break;
      }
    }
  }
  return out;
}

/**
 * The angle a marker is turned by at a vertex: `orient`'s angle, in
 * degrees unless it names another unit; or the direction of the path
 * there for `auto` — the one it comes in by and the one it goes out by
 * halved, at a vertex with both — and at the start the other way round
 * for `auto-start-reverse`. 0 where it says neither.
 */
function markerAngle(raw, vertex, first) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'auto' || v === 'auto-start-reverse') {
    const { in: a, out: b } = vertex;
    let angle = 0;
    if (a !== null && b !== null) {
      const dx = Math.cos(a) + Math.cos(b);
      const dy = Math.sin(a) + Math.sin(b);
      angle = Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9 ? a : Math.atan2(dy, dx);
    } else angle = a ?? b ?? 0;
    return v === 'auto-start-reverse' && first ? angle + Math.PI : angle;
  }
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|rad|grad|turn)?$/.exec(v);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2] ?? 'deg';
  return unit === 'rad' ? n : unit === 'grad' ? (n * Math.PI) / 200 : unit === 'turn' ? n * 2 * Math.PI : (n * Math.PI) / 180;
}

/** `refX` or `refY`: a number in the marker's own units, or `left`,
 * `center` or `right` (`top`, `center`, `bottom`) of the box it is in. */
function refPoint(raw, min, size) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'left' || v === 'top') return min;
  if (v === 'center') return min + size / 2;
  if (v === 'right' || v === 'bottom') return min + size;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A mask's region (CSS Masking 1, 10.1): `x`, `y`, `width` and `height` as
 * fractions of the element's bounding box where `bbox` is given —
 * `maskUnits="objectBoundingBox"`, the default — and lengths in user space
 * otherwise, percentages of the viewport. -10%, -10%, 120% and 120% where
 * they are not set. Null for a region of no area, which shows nothing.
 */
function maskRegion(mask, bbox, [vw, vh]) {
  const read = (name, fallback, size) => {
    const raw = attr(mask, name);
    if (raw === undefined) return fallback;
    const v = String(raw).trim();
    if (bbox) {
      const n = parseFloat(v);
      if (!Number.isFinite(n)) return fallback;
      return v.endsWith('%') ? n / 100 : n;
    }
    return userLength(v, 16, size) ?? fallback;
  };
  let region;
  if (bbox) {
    const fx = read('x', -0.1);
    const fy = read('y', -0.1);
    const fw = read('width', 1.2);
    const fh = read('height', 1.2);
    region = { x: bbox.x + fx * bbox.w, y: bbox.y + fy * bbox.h, w: fw * bbox.w, h: fh * bbox.h };
  } else {
    region = {
      x: read('x', -0.1 * vw, vw),
      y: read('y', -0.1 * vh, vh),
      w: read('width', 1.2 * vw, vw),
      h: read('height', 1.2 * vh, vh)
    };
  }
  return region.w > 0 && region.h > 0 ? region : null;
}

/** A rectangle under a transform list, as the rectangle it lands in. */
function transformedBox(box, transforms) {
  if (!transforms.length) return box;
  let [a, b, c, d, e, f] = transforms[0];
  for (let i = 1; i < transforms.length; i++) {
    const [a2, b2, c2, d2, e2, f2] = transforms[i];
    [a, b, c, d, e, f] = [
      a * a2 + c * b2,
      b * a2 + d * b2,
      a * c2 + c * d2,
      b * c2 + d * d2,
      a * e2 + c * f2 + e,
      b * e2 + d * f2 + f
    ];
  }
  return matrixBox({ a, b, c, d, e, f }, box);
}

function matrixBox(m, { x, y, w, h }) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h]
  ]) {
    const tx = m.a * px + m.c * py + m.e;
    const ty = m.b * px + m.d * py + m.f;
    if (tx < minX) minX = tx;
    if (tx > maxX) maxX = tx;
    if (ty < minY) minY = ty;
    if (ty > maxY) maxY = ty;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function unionBox(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Where a drawing `w` by `h` at `x`,`y` lands on a context, in device
 * pixels, or null where the context cannot say. */
function deviceBox(ctx, x, y, w, h) {
  const m = ctx.getTransform?.();
  return m ? matrixBox(m, { x, y, w, h }) : null;
}

const EMPTY = Symbol('empty');

/** The largest surface a mask is drawn on: 4096 by 4096. */
const MAX_SURFACE = 4096 * 4096;

/**
 * The device-pixel rectangle a mask's region lands in, under `m` and
 * inside what the drawing can show, whole pixels out: `EMPTY` where none of
 * it shows, and null where it is too large to draw on a surface.
 */
function surfaceBox(m, region, bounds) {
  let box = matrixBox(m, region);
  if (![box.x, box.y, box.w, box.h].every(Number.isFinite)) return null;
  if (bounds) {
    const x = Math.max(box.x, bounds.x);
    const y = Math.max(box.y, bounds.y);
    box = { x, y, w: Math.min(box.x + box.w, bounds.x + bounds.w) - x, h: Math.min(box.y + box.h, bounds.y + bounds.h) - y };
  }
  const x0 = Math.floor(box.x);
  const y0 = Math.floor(box.y);
  const x1 = Math.ceil(box.x + box.w);
  const y1 = Math.ceil(box.y + box.h);
  if (!(x1 > x0 && y1 > y0)) return EMPTY;
  if ((x1 - x0) * (y1 - y0) > MAX_SURFACE) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** What makes an ntk `Surface` for a context of ntk's own: on its app.
 * Through the app, so that `ntk/svg` loads no X11 client of its own. */
function surfaceMaker(ctx) {
  const app = ctx?.window?.app;
  if (typeof app?.createSurface !== 'function' || !app.display?.Render) return null;
  return (width, height) => {
    try {
      return app.createSurface({ width, height });
    } catch {
      return null;
    }
  };
}

/** A colour as the coverage it makes: its alpha, in black. */
function coverageOf(color) {
  const c = cssColorStraight(color);
  return c ? `rgba(0, 0, 0, ${c[3]})` : null;
}

/** A colour as the luminance mask value it makes: its luminance times its
 * alpha (CSS Masking 1, 8.2), as an alpha, in black. */
function luminanceOf(color) {
  const c = cssColorStraight(color);
  return c ? `rgba(0, 0, 0, ${(0.2125 * c[0] + 0.7154 * c[1] + 0.0721 * c[2]) * c[3]})` : null;
}

// fold an opacity into a CSS color by going through rgba()
/**
 * A `gradientTransform` as one matrix in the path's user space, or null
 * where there is none. With `objectBoundingBox` units the transform is set
 * in the box's own 0-to-1 space, so it is carried out of it and back:
 * `B · M · B⁻¹`, for the matrix `B` that takes that space to the box.
 */
function gradientMatrix(value, bbox) {
  const list = parseSvgTransform(value);
  if (!list.length) return null;
  const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5]
  ];
  let matrix = list.reduce(mul);
  if (bbox) {
    if (!(bbox.w > 0 && bbox.h > 0)) return null;
    const box = [bbox.w, 0, 0, bbox.h, bbox.x, bbox.y];
    const back = [1 / bbox.w, 0, 0, 1 / bbox.h, -bbox.x / bbox.w, -bbox.y / bbox.h];
    matrix = mul(mul(box, matrix), back);
  }
  return matrix;
}

/**
 * A linear gradient's line under a matrix. Its start goes where the matrix
 * takes it. Its end does only where the matrix keeps right angles: the
 * lines of one colour cross the gradient's line squarely, and go where the
 * matrix takes *them*, so the new line is the one square to those, as long
 * as takes it from the start's line of colour to the end's.
 */
function transformedLine([a, b, c, d, e, f], x1, y1, x2, y2) {
  const px = a * x1 + c * y1 + e;
  const py = b * x1 + d * y1 + f;
  const qx = a * x2 + c * y2 + e;
  const qy = b * x2 + d * y2 + f;
  // a line of one colour runs square to the gradient's, (-dy, dx)
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lx = a * -dy + c * dx;
  const ly = b * -dy + d * dx;
  // the new line is square to that, (ly, -lx), and as long as (q - p) is
  // along it
  const n2 = lx * lx + ly * ly;
  if (!(n2 > 0)) return [px, py, qx, qy];
  const along = ((qx - px) * ly + (qy - py) * -lx) / n2;
  return [px, py, px + ly * along, py - lx * along];
}

function rgbaWithAlpha(color, alpha) {
  // cheap path for #rrggbb / #rgb; anything else goes through rgba() string
  if (/^#([0-9a-f]{6})$/i.test(color)) {
    const v = parseInt(color.slice(1), 16);
    return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`;
  }
  if (/^#([0-9a-f]{3})$/i.test(color)) {
    const v = parseInt(color.slice(1), 16);
    const r = ((v >> 8) & 15) * 17;
    const g = ((v >> 4) & 15) * 17;
    const b = (v & 15) * 17;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}
