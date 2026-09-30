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
// <use>, linear/radial gradients (objectBoundingBox and userSpaceOnUse),
// transform lists, opacity/fill-opacity/stroke-opacity, fill-rule, basic
// <text>. See docs/svg.md for the full surface and limitations.

import { textContent } from 'domutils';
import { parseDocument } from 'htmlparser2';

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
  textAnchor: 'start'
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
  'text-anchor': 'textAnchor'
};

const NUMERIC = new Set(['strokeWidth', 'miterLimit', 'fillOpacity', 'strokeOpacity', 'fontSize']);

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
 * Whether an element is `display: none`, by its attribute or in its
 * `style`, which wins. Such an element is not rendered, and nor is anything
 * in it, whatever that says of itself: `display` is not inherited, and a
 * child's `display="inline"` brings nothing back (SVG 1.1, 11.5). That is
 * how an editor writes a hidden layer — Illustrator's `<g display="none">`
 * around shapes it marks `display="inline"`.
 */
function displayNone(node) {
  let v = attr(node, 'display');
  const style = node.attribs?.style;
  if (style && style.includes('display')) {
    for (const decl of style.split(';')) {
      const idx = decl.indexOf(':');
      if (idx > 0 && decl.slice(0, idx).trim() === 'display') v = decl.slice(idx + 1);
    }
  }
  return v !== undefined && String(v).trim().toLowerCase() === 'none';
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
 * The walk mirrors `_style` and `_renderNode` — fill and stroke inherit,
 * inline `style` beats the presentation attribute, the initial fill is black
 * and the initial stroke is none, `<line>` never fills, `<use>` paints its
 * target with the *use* element's style, and non-rendered subtrees
 * contribute nothing. It starts at the root element itself, because `draw`
 * does: the root `<svg>` is an ordinary element for inheritance, and every
 * mainstream icon set puts `fill`/`stroke` there (issue #306). The two walks
 * have to agree — a scan that skipped the root would disagree with what is
 * painted.
 *
 * @returns {{ kind: 'mono'|'multi', solo: string|null }} `solo` is the one
 *   paint a `mono` document uses — a colour, or the literal `'currentColor'`
 *   when the document defers to its caller — and null when nothing paints.
 */
function scanPaints(root, ids) {
  const paints = new Set();
  let multi = false;

  const paintOf = (node, name, inherited) => {
    let v = attr(node, name);
    for (const decl of (node.attribs?.style || '').split(';')) {
      const idx = decl.indexOf(':');
      if (idx > 0 && decl.slice(0, idx).trim() === name) v = decl.slice(idx + 1);
    }
    if (v === undefined || v === '' || v === 'inherit') return inherited;
    return String(v).trim();
  };

  const note = (paint) => {
    if (paint === 'none') return;
    if (/^url\(/i.test(paint)) multi = true;
    else paints.add(paint);
  };

  const kids = (node, fill, stroke, depth) => {
    for (const child of node.children || []) {
      if (child.type === 'tag') visit(child, fill, stroke, depth + 1);
    }
  };

  const visit = (node, fill, stroke, depth) => {
    if (multi || depth > 32) return;
    const name = tag(node);
    if (NON_RENDERED.has(name) || displayNone(node)) return;
    const f = paintOf(node, 'fill', fill);
    const s = paintOf(node, 'stroke', stroke);
    switch (name) {
      case 'svg':
      case 'g':
      case 'a':
        kids(node, f, s, depth);
        return;
      case 'use': {
        const href = node.attribs?.href || node.attribs?.['xlink:href'] || '';
        const target = href.startsWith('#') ? ids.get(href.slice(1)) : null;
        if (!target) return;
        // <symbol> is non-rendered on its own but renders through <use>
        if (tag(target) === 'symbol') kids(target, f, s, depth);
        else visit(target, f, s, depth + 1);
        return;
      }
      case 'text':
        note(f);
        return;
      default:
        if (name !== 'line') note(f);
        note(s);
    }
  };

  visit(root, INHERITED.fill, INHERITED.stroke, 0);
  return {
    kind: multi || paints.size > 1 ? 'multi' : 'mono',
    solo: paints.size === 1 ? [...paints][0] : null
  };
}

/**
 * Widget rendering a static SVG document into a window (or any 2d context
 * via `draw()`). Scripting, CSS stylesheets, filters, masks and external
 * references are not supported — see docs/svg.md.
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

    this._root = null;
    this._ids = new Map();
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

    const scanned = scanPaints(this._root, this._ids);
    this.paintKind = scanned.kind;
    this.soloPaint = scanned.solo;

    const a = this._root.attribs || {};
    const vb = (attr(this._root, 'viewBox') || '')
      .split(/[\s,]+/)
      .filter((s) => s !== '')
      .map(parseFloat);
    this.viewBox = vb.length === 4 && vb.every(Number.isFinite) ? vb : null;
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
   */
  draw(ctx, x = 0, y = 0, w = this.naturalWidth, h = this.naturalHeight, opts = {}) {
    if (!this._root) return;
    ctx.save();
    ctx.translate(x, y);
    if (this.viewBox) {
      const [minX, minY, vbW, vbH] = this.viewBox;
      if (vbW > 0 && vbH > 0) {
        ctx.scale(w / vbW, h / vbH);
        ctx.translate(-minX, -minY);
      }
    } else if (this.naturalWidth > 0 && this.naturalHeight > 0) {
      ctx.scale(w / this.naturalWidth, h / this.naturalHeight);
    }
    this._renderChildren(
      this._root,
      ctx,
      this._style(this._root, { ...INHERITED, color: opts.color ?? this.color }),
      1,
      0
    );
    ctx.restore();
  }

  // ------------------------------------------------------------------

  _style(node, parent) {
    let style = parent;
    const own = () => (style === parent ? (style = { ...parent }) : style);
    const apply = (name, raw) => {
      const key = STYLE_ATTRS[name];
      if (!key || raw === undefined || raw === '' || raw === 'inherit') return;
      let v = String(raw).trim();
      if (NUMERIC.has(key)) {
        const n = parseFloat(v);
        if (!Number.isFinite(n)) return;
        own()[key] = n;
      } else {
        own()[key] = v;
      }
    };
    for (const [name, value] of Object.entries(node.attribs || {})) apply(name, value);
    // inline style="" wins over presentation attributes
    for (const decl of (node.attribs?.style || '').split(';')) {
      const idx = decl.indexOf(':');
      if (idx > 0) apply(decl.slice(0, idx).trim(), decl.slice(idx + 1).trim());
    }
    return style;
  }

  _paint(ctx, value, style, path) {
    if (value === 'currentColor') return style.color;
    const url = /^url\(['"]?#([^'")]+)['"]?\)/.exec(value);
    if (!url) return value;
    const node = this._ids.get(url[1]);
    if (!node || (tag(node) !== 'lineargradient' && tag(node) !== 'radialgradient')) return null;
    return this._gradient(ctx, node, path);
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

  _gradient(ctx, node, path) {
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
      if (Number.isFinite(so) && so < 1) {
        gradient.addColorStop(offset, rgbaWithAlpha(color, so));
      } else {
        gradient.addColorStop(offset, color);
      }
    }
    return gradient;
  }

  _renderChildren(node, ctx, style, alpha, depth) {
    for (const child of node.children || []) {
      if (child.type !== 'tag') continue;
      this._renderNode(child, ctx, style, alpha, depth);
    }
  }

  _renderNode(node, ctx, parentStyle, alpha, depth) {
    if (depth > 32) return;
    const name = tag(node);
    if (NON_RENDERED.has(name) || displayNone(node)) return;

    const style = this._style(node, parentStyle);
    const opacity = parseFloat(node.attribs?.opacity ?? '1');
    const nodeAlpha = alpha * (Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1);
    if (nodeAlpha <= 0) return;

    const transforms = parseSvgTransform(node.attribs?.transform);
    const needsCtxState = transforms.length > 0;
    if (needsCtxState) {
      ctx.save();
      for (const t of transforms) ctx.transform(t[0], t[1], t[2], t[3], t[4], t[5]);
    }

    switch (name) {
      case 'svg':
      case 'g':
      case 'a':
        this._renderChildren(node, ctx, style, nodeAlpha, depth + 1);
        break;
      case 'use': {
        const href = node.attribs?.href || node.attribs?.['xlink:href'] || '';
        const target = href.startsWith('#') ? this._ids.get(href.slice(1)) : null;
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
        this._renderText(node, ctx, style, nodeAlpha);
        break;
      default: {
        const path = shapePath(node);
        if (!path) break;
        if (name !== 'line' && style.fill !== 'none') {
          const paint = this._paint(ctx, style.fill, style, path);
          if (paint) {
            ctx.fillStyle = paint;
            ctx.globalAlpha = nodeAlpha * style.fillOpacity;
            ctx.fill(path, style.fillRule === 'evenodd' ? 'evenodd' : 'nonzero');
          }
        }
        if (style.stroke !== 'none' && style.strokeWidth > 0) {
          const paint = this._paint(ctx, style.stroke, style, path);
          if (paint) {
            ctx.strokeStyle = paint;
            ctx.globalAlpha = nodeAlpha * style.strokeOpacity;
            ctx.lineWidth = style.strokeWidth;
            ctx.lineCap = style.lineCap;
            ctx.lineJoin = style.lineJoin;
            ctx.miterLimit = style.miterLimit;
            ctx.stroke(path);
          }
        }
        ctx.globalAlpha = 1;
        break;
      }
    }

    if (needsCtxState) ctx.restore();
  }

  _renderText(node, ctx, style, alpha) {
    const text = textContent(node).trim();
    if (!text || style.fill === 'none') return;
    const x = attrNum(node, 'x');
    const y = attrNum(node, 'y');
    // glyphs are not scaled by the canvas transform — bake the average
    // scale factor into the font size instead
    const m = ctx.getTransform();
    const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
    ctx.save();
    ctx.font = `${Math.max(1, style.fontSize * scale)}px ${style.fontFamily}`;
    ctx.fillStyle = style.fill === 'currentColor' ? style.color : style.fill;
    ctx.globalAlpha = alpha * style.fillOpacity;
    ctx.textAlign = style.textAnchor === 'middle' ? 'center' : style.textAnchor === 'end' ? 'right' : 'left';
    ctx.fillText(text, x, y);
    ctx.restore();
  }
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
