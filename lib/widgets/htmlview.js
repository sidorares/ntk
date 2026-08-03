import { selectAll } from 'css-select';
import { textContent } from 'domutils';
import { parseDocument } from 'htmlparser2';
import Yoga from '../yoga.js';

import { decodeImage, Image } from '../image.js';
import { TextLayout } from '../text/layout.js';
import { computeStyles, cssColor } from './css.js';
import SvgView from './svgview.js';

const DEFAULT_THEME = {
  family: 'sans-serif',
  size: 16,
  color: '#222222',
  background: 'white'
};

const FLEX_DIRECTION = {
  column: Yoga.FLEX_DIRECTION_COLUMN,
  'column-reverse': Yoga.FLEX_DIRECTION_COLUMN_REVERSE,
  row: Yoga.FLEX_DIRECTION_ROW,
  'row-reverse': Yoga.FLEX_DIRECTION_ROW_REVERSE
};
const JUSTIFY = {
  'flex-start': Yoga.JUSTIFY_FLEX_START,
  center: Yoga.JUSTIFY_CENTER,
  'flex-end': Yoga.JUSTIFY_FLEX_END,
  'space-between': Yoga.JUSTIFY_SPACE_BETWEEN,
  'space-around': Yoga.JUSTIFY_SPACE_AROUND,
  'space-evenly': Yoga.JUSTIFY_SPACE_EVENLY
};
const ALIGN = {
  auto: Yoga.ALIGN_AUTO,
  'flex-start': Yoga.ALIGN_FLEX_START,
  center: Yoga.ALIGN_CENTER,
  'flex-end': Yoga.ALIGN_FLEX_END,
  stretch: Yoga.ALIGN_STRETCH,
  baseline: Yoga.ALIGN_BASELINE
};
const WRAP = {
  nowrap: Yoga.WRAP_NO_WRAP,
  wrap: Yoga.WRAP_WRAP,
  'wrap-reverse': Yoga.WRAP_WRAP_REVERSE
};
const EDGES = [Yoga.EDGE_TOP, Yoga.EDGE_RIGHT, Yoga.EDGE_BOTTOM, Yoga.EDGE_LEFT];

const VOID_SKIP = new Set(['script', 'style', 'head', 'title', 'meta', 'link', 'template', 'noscript', 'iframe', 'object', 'embed', 'audio', 'video', 'canvas', 'input', 'select', 'textarea', 'button']);

/**
 * A widget that renders a static subset of HTML + CSS into a window (or any
 * 2d context target). No scripting, no network: documents are provided as
 * strings, resources resolve only through an explicit allow-path (see
 * "Resources" in docs/html.md).
 *
 *   const view = new HtmlView(wnd, {
 *     onLink: (href) => console.log('clicked', href)
 *   });
 *   view.setHtml('<h1>Hello</h1><p>Some <b>html</b>.</p>');
 *   wnd.map();
 *
 * Layout: block flow and flexbox are computed by yoga-layout; inline runs
 * are shaped and wrapped by the ntk text pipeline (TextLayout). Supported
 * markup and CSS are documented in docs/html.md.
 *
 * Standalone (windowless) use mirrors MarkdownView:
 *   const view = new HtmlView(null, { fonts });
 *   view.setHtml(html); view.layout(width); view.draw(ctx, x, y);
 * Content that arrives asynchronously (images) invalidates the layout —
 * pass `onInvalidate` to re-layout/redraw when that happens (window mode
 * repaints automatically).
 */
export default class HtmlView {
  constructor(window, opts = {}) {
    this.window = window ?? null;
    this._standaloneFonts = opts.fonts ?? null;
    this.theme = { ...DEFAULT_THEME, ...(opts.theme || {}) };

    /** called with (href, event, element) when a link is activated */
    this.onLink = opts.onLink ?? null;
    /** called when async content (an image) invalidates the layout;
     *  standalone hosts re-layout/redraw here — window mode also repaints
     *  on its own */
    this.onInvalidate = opts.onInvalidate ?? null;
    /** extra author stylesheet(s) applied after document <style>s */
    this._userSheets = [].concat(opts.stylesheet ?? []);
    /**
     * resource loading policy:
     *  - a function `(url, { element }) => Promise<Buffer|Image|null>`
     *  - undefined: default loader — data: URIs always; file reads only
     *    when `baseUrl` is set, resolved relative to it
     *  - null/false: data: URIs only
     */
    this._loadResource = opts.loadResource;
    this.baseUrl = opts.baseUrl ?? null;

    this._dom = null;
    this._styles = null;
    this._root = null; // box tree root
    this._images = new Map(); // <img> element -> { image, promise, failed }
    this._links = [];
    this._layoutWidth = -1;
    this.contentHeight = 0;
    this.scrollY = 0;

    if (this.window) {
      this._ctx = this.window.getContext('2d');
      this.window.on('expose', () => this.render());
      // a move is a ConfigureNotify too; re-laying out a document per step
      // of a window drag is exactly what ev.resized is for
      this.window.on('resize', (ev) => {
        if (ev.resized) this._layoutWidth = -1;
      });
      this.window.on('mousedown', (ev) => {
        if (ev.keycode === 4 || ev.keycode === 5) {
          // X11 wheel: buttons 4 (up) / 5 (down)
          this.scrollBy(ev.keycode === 4 ? -48 : 48);
          return;
        }
        if (ev.keycode !== 1) return;
        const hit = this.linkAt(ev.x, ev.y);
        if (hit && this.onLink) this.onLink(hit.href, ev, hit.element);
      });
    }
  }

  // -------------------------------------------------------------------------
  // document lifecycle

  /**
   * Parse and adopt a new document. The widget never loads or replaces
   * documents on its own — link clicks only fire `onLink`; navigation (e.g.
   * fetching new content and calling `setHtml` again) belongs to the app.
   *
   * @param {string} html document or fragment markup
   * @param {object} [opts] { baseUrl } — overrides the constructor baseUrl
   *   for this document (used to resolve relative image `src`)
   */
  setHtml(html, opts = {}) {
    if (opts.baseUrl !== undefined) this.baseUrl = opts.baseUrl;
    this._dom = parseDocument(String(html ?? ''));
    const sheets = selectAll('style', this._dom).map((el) => textContent(el));
    this._styles = computeStyles(this._dom, [...sheets, ...this._userSheets], {
      rootFontSize: this.theme.size,
      baseStyle: {
        fontFamily: this.theme.family,
        fontSize: this.theme.size,
        color: cssColor(this.theme.color) ?? undefined
      }
    });
    this._disposeTree();
    for (const entry of this._images.values()) entry.image?.destroy();
    this._images.clear();
    const rootStyle = this._blockStyle();
    this._root = this._buildBox(null, rootStyle, this._partition(this._dom.children, rootStyle));
    this._collectImages(this._root);
    this._layoutWidth = -1;
    this.scrollY = 0;
    if (this.window && this.window._mapped) this.render();
    return this;
  }

  _blockStyle() {
    return {
      display: 'block',
      color: cssColor(this.theme.color),
      background: null,
      fontFamily: this.theme.family,
      fontSize: this.theme.size,
      fontWeight: 400,
      fontStyle: 'normal',
      lineHeight: { mult: 1.25 },
      textAlign: 'left',
      textDecoration: 'none',
      whiteSpace: 'normal',
      listStyleType: 'disc',
      margin: [{ px: 0 }, { px: 0 }, { px: 0 }, { px: 0 }],
      padding: [{ px: 0 }, { px: 0 }, { px: 0 }, { px: 0 }],
      borderWidth: [0, 0, 0, 0],
      borderColor: [null, null, null, null],
      borderStyle: ['none', 'none', 'none', 'none'],
      width: 'auto',
      height: 'auto',
      minWidth: null,
      maxWidth: null,
      minHeight: null,
      maxHeight: null,
      flexDirection: 'column',
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
  }

  _fonts() {
    if (this.window) return this.window.app.fonts;
    if (!this._standaloneFonts) {
      throw new Error('HtmlView without a window needs { fonts: new FontManager() }');
    }
    return this._standaloneFonts;
  }

  // -------------------------------------------------------------------------
  // box tree construction

  /**
   * Partition an element's children into block-level boxes and anonymous
   * inline runs (which become text boxes). Returns child box descriptors.
   */
  _partition(children, containerStyle, inheritedHref = null) {
    const out = [];
    let run = []; // pending inline content: { el|text, style, href }

    const flushRun = () => {
      if (!run.length) return;
      const spans = run;
      run = [];
      // drop runs that collapse to pure whitespace
      const hasContent = spans.some((s) => s.text !== undefined ? /\S/.test(s.text) || s.pre : true);
      if (!hasContent) return;
      out.push({ kind: 'text', parts: spans });
    };

    const visitInline = (el, href) => {
      const st = this._styles.get(el);
      for (const child of el.children ?? []) {
        if (child.type === 'text') {
          run.push({ text: child.data, style: st, href, pre: st.whiteSpace.startsWith('pre') });
        } else if (child.type === 'tag' || child.type === 'style' || child.type === 'script') {
          dispatch(child, href);
        }
      }
    };

    const dispatch = (el, href) => {
      if (VOID_SKIP.has(el.name)) return;
      const st = this._styles.get(el);
      if (!st || st.display === 'none') return;
      const elHref = el.name === 'a' && el.attribs?.href ? el.attribs.href : href;
      if (el.name === 'br') {
        run.push({ text: '\n', style: st, href: elHref, pre: true });
        return;
      }
      if (el.name === 'img' || el.name === 'svg') {
        // replaced elements: inline <svg> renders through SvgView, like an
        // image with an intrinsic size (its children never join text flow)
        flushRun();
        out.push({ kind: 'image', element: el, style: st, href: elHref });
        return;
      }
      if (st.display === 'inline') {
        visitInline(el, elHref);
        return;
      }
      // block, flex, list-item, inline-block: a box of its own
      flushRun();
      out.push({ kind: 'box', element: el, style: st, href: elHref });
    };

    const containerPre = !!containerStyle?.whiteSpace?.startsWith('pre');
    for (const node of children) {
      if (node.type === 'text') {
        run.push({ text: node.data, style: null, href: inheritedHref, pre: containerPre });
      } else if (node.type === 'tag' || node.type === 'style' || node.type === 'script') {
        dispatch(node, inheritedHref);
      }
    }
    flushRun();
    return out;
  }

  /** build a container box (and recursively its subtree) */
  _buildBox(element, style, childDescs) {
    const box = {
      element,
      style,
      kind: 'container',
      children: [],
      href: null,
      x: 0,
      y: 0,
      w: 0,
      h: 0
    };
    let liIndex = 0;
    for (const desc of childDescs) {
      if (desc.kind === 'text') {
        box.children.push(this._makeTextBox(desc.parts, style));
      } else if (desc.kind === 'image') {
        const child = {
          element: desc.element,
          style: desc.style,
          kind: 'image',
          children: [],
          href: desc.href,
          x: 0, y: 0, w: 0, h: 0
        };
        box.children.push(child);
      } else {
        const el = desc.element;
        const st = desc.style;
        if (st.display === 'list-item') st._liIndex = ++liIndex;
        const child = this._buildBox(el, st, this._partition(el.children ?? [], st, desc.href));
        child.href = desc.href;
        box.children.push(child);
      }
    }
    return box;
  }

  /** anonymous inline run -> text box with TextLayout spans */
  _makeTextBox(parts, containerStyle) {
    const fonts = this._fonts();
    const spans = [];
    let endedWithSpace = true; // strip leading whitespace at run start
    for (const part of parts) {
      const own = part.style != null; // inline element vs bare text node
      const st = part.style ?? containerStyle;
      let text = part.text;
      if (!part.pre) {
        text = text.replace(/[\t\n\r ]+/g, ' ');
        if (endedWithSpace && text.startsWith(' ')) text = text.replace(/^ +/, '');
        if (!text) continue;
        endedWithSpace = text.endsWith(' ');
      } else {
        endedWithSpace = /[\s]$/.test(text);
      }
      // container background/decoration is drawn at box level; only inline
      // elements' own decorations become span decorations
      const deco =
        own && (st.textDecoration !== 'none' || st.background)
          ? {
              underline: st.textDecoration === 'underline' ? st.color : null,
              strike: st.textDecoration === 'line-through' ? st.color : null,
              bg: st.background
            }
          : null;
      spans.push({
        text,
        family: st.fontFamily,
        size: st.fontSize,
        weight: st.fontWeight,
        style: st.fontStyle,
        color: st.color,
        _href: part.href,
        _deco: deco
      });
    }
    // strip trailing collapsible whitespace of the run
    for (let i = spans.length - 1; i >= 0; i--) {
      spans[i].text = spans[i].text.replace(/ +$/, '');
      if (spans[i].text) break;
      spans.splice(i, 1);
    }

    const style = containerStyle;
    const m = fonts.match(style.fontFamily, { weight: style.fontWeight, style: style.fontStyle });
    const natural = m.metrics(style.fontSize).lineHeight || style.fontSize * 1.2;
    const desired = style.lineHeight.px !== undefined ? style.lineHeight.px : style.lineHeight.mult * style.fontSize;

    return {
      element: null,
      style,
      kind: 'text',
      children: [],
      spans,
      align: style.textAlign,
      nowrap: style.whiteSpace === 'nowrap' || style.whiteSpace === 'pre',
      lineHeightMult: natural > 0 ? desired / natural : 1,
      _layouts: new Map(),
      x: 0, y: 0, w: 0, h: 0
    };
  }

  _textLayout(box, width) {
    const key = box.nowrap ? -1 : Math.max(0, Math.round(width));
    let layout = box._layouts.get(key);
    if (!layout) {
      layout = new TextLayout(this._fonts(), box.spans.length ? box.spans : '', box.style, {
        maxWidth: box.nowrap ? Infinity : key,
        align: box.align,
        lineHeight: box.lineHeightMult
      });
      box._layouts.set(key, layout);
    }
    return layout;
  }

  _collectImages(box) {
    if (box.kind === 'image') {
      const el = box.element;
      if (el.name === 'svg') {
        // inline svg: adopt the already-parsed element synchronously, so
        // its intrinsic size is known on the first layout pass
        if (!this._images.has(el)) {
          const entry = { image: null, svg: null, failed: false };
          this._images.set(el, entry);
          try {
            entry.svg = new SvgView(null).setSvgDom(el);
          } catch {
            entry.failed = true;
          }
        }
      } else {
        const src = el.attribs?.src;
        if (src && !this._images.has(el)) {
          const entry = { image: null, svg: null, failed: false };
          this._images.set(el, entry);
          this._fetchImage(src, el).then(
            (res) => {
              if (res instanceof SvgView) entry.svg = res;
              else entry.image = res;
              if (!res) entry.failed = true;
              this._invalidate();
            },
            () => {
              entry.failed = true;
              this._invalidate();
            }
          );
        }
      }
    }
    for (const child of box.children) this._collectImages(child);
  }

  /** async content arrived: drop the cached layout, repaint and/or notify */
  _invalidate() {
    this._layoutWidth = -1;
    if (this.window && this.window._mapped) this.render();
    if (this.onInvalidate) this.onInvalidate();
  }

  // decoded bytes -> Image (PNG/JPEG) or SvgView (sniffed SVG markup)
  _decodeResource(buf) {
    const head = buf.subarray(0, 1024).toString('utf8');
    if (head.trimStart().startsWith('<') && /<svg[\s>]/i.test(head)) {
      return new SvgView(null).setSvg(buf.toString('utf8'));
    }
    return decodeImage(buf);
  }

  /** resolve + decode an image source according to the resource policy */
  async _fetchImage(src, element) {
    if (src.startsWith('data:')) {
      const svg = /^data:image\/svg\+xml(?:;charset=[\w-]+)?(;base64)?,(.*)$/s.exec(src);
      if (svg) {
        const text = svg[1] ? Buffer.from(svg[2], 'base64').toString('utf8') : decodeURIComponent(svg[2]);
        return new SvgView(null).setSvg(text);
      }
      const m = /^data:image\/[\w+.-]+;base64,(.*)$/s.exec(src);
      if (!m) return null;
      return decodeImage(Buffer.from(m[1], 'base64'));
    }
    if (typeof this._loadResource === 'function') {
      const res = await this._loadResource(src, { element });
      if (res instanceof Image || res instanceof SvgView) return res;
      if (res) return this._decodeResource(res);
      return null;
    }
    if (this._loadResource === null || this._loadResource === false) return null;
    // default policy: local files, only relative to an explicit baseUrl.
    // node builtins are fetched lazily — in environments without them
    // (browser bundles) pass a `loadResource` callback instead.
    const getBuiltin = globalThis.process?.getBuiltinModule;
    const fs = getBuiltin?.call(process, 'node:fs');
    if (!fs || !this.baseUrl) return null;
    let base = this.baseUrl;
    if (typeof base === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(base)) {
      // filesystem path; point at the directory itself when given one
      let p = base;
      if (!/[/\\]$/.test(p) && fs.existsSync(p) && fs.statSync(p).isDirectory()) p += '/';
      base = getBuiltin.call(process, 'node:url').pathToFileURL(p);
    }
    const url = new URL(src, base);
    if (url.protocol !== 'file:') return null;
    return this._decodeResource(await fs.promises.readFile(url));
  }

  // -------------------------------------------------------------------------
  // layout

  /** lay the document out for a container width; returns content height */
  layout(width) {
    if (!this._root) return 0;
    this._disposeYoga(this._root);
    const yroot = this._yogaFor(this._root, true);
    yroot.setWidth(width);
    yroot.calculateLayout(width, undefined, Yoga.DIRECTION_LTR);
    this._absolutize(this._root, 0, 0);
    this.contentHeight = Math.ceil(this._root.h);
    this._layoutWidth = width;
    return this.contentHeight;
  }

  _yogaFor(box, isRoot = false) {
    const node = Yoga.Node.create();
    box.yoga = node;
    const st = box.style;

    if (box.kind === 'text') {
      node.setMeasureFunc((w, wMode) => {
        const maxW = wMode === Yoga.MEASURE_MODE_UNDEFINED ? Infinity : w;
        const layout = this._textLayout(box, maxW === Infinity ? Infinity : maxW);
        return { width: Math.ceil(layout.width), height: Math.ceil(layout.height) };
      });
      return node;
    }

    if (box.kind === 'image') {
      this._applyBoxStyle(node, st);
      const entry = this._images.get(box.element);
      const img = entry?.image;
      const cssW = st.width;
      const cssH = st.height;
      const natW = img?.width ?? entry?.svg?.naturalWidth ?? (entry?.failed ? 80 : 0);
      const natH = img?.height ?? entry?.svg?.naturalHeight ?? (entry?.failed ? 40 : 0);
      if (cssW === 'auto' && cssH === 'auto') {
        // natural size, shrunk (ratio-preserving) to the available width; a
        // measure function is used because yoga's min/max clamping does not
        // recompute the aspect-ratio-derived dimension
        if (st.alignSelf === 'auto') node.setAlignSelf(Yoga.ALIGN_FLEX_START);
        node.setMeasureFunc((w, wMode) => {
          let iw = natW;
          if (wMode !== Yoga.MEASURE_MODE_UNDEFINED && w < iw) iw = w;
          return { width: iw, height: natW > 0 ? (iw * natH) / natW : natH };
        });
      } else if (natW > 0 && natH > 0 && (cssW === 'auto' || cssH === 'auto')) {
        // one dimension styled: the other follows the natural ratio
        node.setAspectRatio(natW / natH);
      }
      return node;
    }

    // container
    this._applyBoxStyle(node, st);
    if (st.display === 'flex') {
      node.setFlexDirection(FLEX_DIRECTION[st.flexDirection]);
      node.setFlexWrap(WRAP[st.flexWrap]);
      node.setJustifyContent(JUSTIFY[st.justifyContent]);
      node.setAlignItems(ALIGN[st.alignItems] ?? Yoga.ALIGN_STRETCH);
      node.setGap(Yoga.GUTTER_ROW, st.rowGap);
      node.setGap(Yoga.GUTTER_COLUMN, st.columnGap);
    } else {
      node.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN);
      node.setAlignItems(Yoga.ALIGN_STRETCH);
    }

    // children; approximate CSS adjacent-margin collapsing in block flow
    const collapse = st.display !== 'flex';
    let prevBottom = 0;
    box.children.forEach((child, i) => {
      const cnode = this._yogaFor(child);
      if (collapse && child.style) {
        const mt = child.style.margin?.[0];
        const mb = child.style.margin?.[2];
        const topPx = mt && mt.px !== undefined ? mt.px : 0;
        if (i > 0 && mt && mt.px !== undefined) {
          cnode.setMargin(Yoga.EDGE_TOP, Math.max(topPx, prevBottom) - prevBottom);
        }
        prevBottom = mb && mb.px !== undefined ? mb.px : 0;
      }
      node.insertChild(cnode, i);
    });
    return node;
  }

  _applyBoxStyle(node, st) {
    const setLen = (val, pxFn, pctFn, autoFn) => {
      if (val === 'auto') {
        if (autoFn) autoFn();
      } else if (val && val.px !== undefined) {
        pxFn(val.px);
      } else if (val && val.pct !== undefined && pctFn) {
        pctFn(val.pct);
      }
    };

    for (let i = 0; i < 4; i++) {
      const edge = EDGES[i];
      setLen(
        st.margin[i],
        (v) => node.setMargin(edge, v),
        (v) => node.setMarginPercent(edge, v),
        () => node.setMarginAuto(edge)
      );
      setLen(
        st.padding[i],
        (v) => node.setPadding(edge, v),
        (v) => node.setPaddingPercent(edge, v)
      );
      if (st.borderWidth[i] > 0) node.setBorder(edge, st.borderWidth[i]);
    }

    setLen(st.width, (v) => node.setWidth(v), (v) => node.setWidthPercent(v), () => node.setWidthAuto());
    setLen(st.height, (v) => node.setHeight(v), (v) => node.setHeightPercent(v), () => node.setHeightAuto());
    setLen(st.minWidth, (v) => node.setMinWidth(v), (v) => node.setMinWidthPercent(v));
    setLen(st.maxWidth, (v) => node.setMaxWidth(v), (v) => node.setMaxWidthPercent(v));
    setLen(st.minHeight, (v) => node.setMinHeight(v), (v) => node.setMinHeightPercent(v));
    setLen(st.maxHeight, (v) => node.setMaxHeight(v), (v) => node.setMaxHeightPercent(v));

    node.setFlexGrow(st.flexGrow);
    node.setFlexShrink(st.flexShrink);
    setLen(st.flexBasis, (v) => node.setFlexBasis(v), (v) => node.setFlexBasisPercent(v), () => node.setFlexBasisAuto());
    if (st.alignSelf !== 'auto') node.setAlignSelf(ALIGN[st.alignSelf] ?? Yoga.ALIGN_AUTO);
  }

  /** copy computed yoga geometry into absolute box coordinates */
  _absolutize(box, ox, oy) {
    const node = box.yoga;
    box.x = ox + node.getComputedLeft();
    box.y = oy + node.getComputedTop();
    box.w = node.getComputedWidth();
    box.h = node.getComputedHeight();
    box.contentX = box.x + node.getComputedBorder(Yoga.EDGE_LEFT) + node.getComputedPadding(Yoga.EDGE_LEFT);
    box.contentY = box.y + node.getComputedBorder(Yoga.EDGE_TOP) + node.getComputedPadding(Yoga.EDGE_TOP);
    box.contentW =
      box.w -
      node.getComputedBorder(Yoga.EDGE_LEFT) - node.getComputedBorder(Yoga.EDGE_RIGHT) -
      node.getComputedPadding(Yoga.EDGE_LEFT) - node.getComputedPadding(Yoga.EDGE_RIGHT);
    box.contentH =
      box.h -
      node.getComputedBorder(Yoga.EDGE_TOP) - node.getComputedBorder(Yoga.EDGE_BOTTOM) -
      node.getComputedPadding(Yoga.EDGE_TOP) - node.getComputedPadding(Yoga.EDGE_BOTTOM);
    for (const child of box.children) this._absolutize(child, box.x, box.y);
  }

  _disposeYoga(box) {
    if (box.yoga) {
      if (!box.yoga.getParent()) box.yoga.freeRecursive();
      box.yoga = null;
      for (const child of box.children) child.yoga = null, this._disposeYoga(child);
    }
    if (box._layouts) box._layouts.clear();
  }

  _disposeTree() {
    if (this._root) {
      this._disposeYoga(this._root);
      this._root = null;
    }
  }

  // -------------------------------------------------------------------------
  // drawing and hit testing

  /** draw the last layout() onto a 2d context at (ox, oy) */
  draw(ctx, ox = 0, oy = 0) {
    this._links = [];
    if (this._root) this._drawBox(ctx, this._root, ox, oy);
    return this;
  }

  _drawBox(ctx, box, ox, oy) {
    const st = box.style;
    const x = ox + box.x;
    const y = oy + box.y;

    if (box.kind === 'text') {
      // anonymous text boxes share the container's style object — the
      // container already painted its background and borders
      this._drawText(ctx, box, ox, oy);
      return;
    }

    if (st?.background) {
      ctx.fillStyle = st.background;
      ctx.fillRect(Math.round(x), Math.round(y), Math.ceil(box.w), Math.ceil(box.h));
    }
    if (st) this._drawBorders(ctx, box, x, y);

    if (box.kind === 'image') {
      this._drawImage(ctx, box, x, y);
      if (box.href) {
        this._links.push({ x, y, w: box.w, h: box.h, href: box.href, element: box.element });
      }
      return;
    }

    if (st?.display === 'list-item') this._drawListMarker(ctx, box, ox, oy);
    for (const child of box.children) this._drawBox(ctx, child, ox, oy);
  }

  _drawBorders(ctx, box, x, y) {
    const st = box.style;
    const bw = st.borderWidth;
    if (!bw.some((w, i) => w > 0 && st.borderStyle[i] !== 'none')) return;
    const color = (i) => st.borderColor[i] ?? st.color;
    const w = Math.ceil(box.w);
    const h = Math.ceil(box.h);
    x = Math.round(x);
    y = Math.round(y);
    if (bw[0] > 0 && st.borderStyle[0] !== 'none') {
      ctx.fillStyle = color(0);
      ctx.fillRect(x, y, w, Math.round(bw[0]));
    }
    if (bw[2] > 0 && st.borderStyle[2] !== 'none') {
      ctx.fillStyle = color(2);
      ctx.fillRect(x, y + h - Math.round(bw[2]), w, Math.round(bw[2]));
    }
    if (bw[3] > 0 && st.borderStyle[3] !== 'none') {
      ctx.fillStyle = color(3);
      ctx.fillRect(x, y, Math.round(bw[3]), h);
    }
    if (bw[1] > 0 && st.borderStyle[1] !== 'none') {
      ctx.fillStyle = color(1);
      ctx.fillRect(x + w - Math.round(bw[1]), y, Math.round(bw[1]), h);
    }
  }

  _drawText(ctx, box, ox, oy) {
    const layout = this._textLayout(box, box.w);
    const x = ox + box.x;
    const y = oy + box.y;
    for (const line of layout.lines) {
      for (const r of line.runs) {
        const m = r.run.font.metrics(r.run.size);
        if (r.span._href) {
          this._links.push({
            x: x + line.x + r.x,
            y: y + line.baseline - m.ascent,
            w: r.width,
            h: m.ascent + m.descent,
            href: r.span._href,
            element: null
          });
        }
        const deco = r.span._deco;
        if (!deco) continue;
        if (deco.bg) {
          ctx.fillStyle = deco.bg;
          ctx.fillRect(
            Math.round(x + line.x + r.x),
            Math.round(y + line.baseline - m.ascent),
            Math.ceil(r.width),
            Math.ceil(m.ascent + m.descent)
          );
        }
        if (deco.underline) {
          ctx.fillStyle = deco.underline;
          ctx.fillRect(Math.round(x + line.x + r.x), Math.round(y + line.baseline + 2), Math.ceil(r.width), 1);
        }
        if (deco.strike) {
          ctx.fillStyle = deco.strike;
          ctx.fillRect(
            Math.round(x + line.x + r.x),
            Math.round(y + line.baseline - m.ascent * 0.3),
            Math.ceil(r.width),
            1
          );
        }
      }
    }
    layout.draw(ctx, x, y);
  }

  _drawImage(ctx, box, x, y) {
    const entry = this._images.get(box.element);
    const img = entry?.image;
    const w = box.contentW ?? box.w;
    const h = box.contentH ?? box.h;
    if (img) {
      if (w > 0 && h > 0) ctx.drawImage(img, Math.round(box.contentX ?? x), Math.round(box.contentY ?? y), Math.round(w), Math.round(h));
      return;
    }
    if (entry?.svg) {
      if (w > 0 && h > 0) entry.svg.draw(ctx, Math.round(box.contentX ?? x), Math.round(box.contentY ?? y), Math.round(w), Math.round(h));
      return;
    }
    // placeholder: light box with alt text
    if (box.w > 2 && box.h > 2) {
      ctx.fillStyle = '#eeeeee';
      ctx.fillRect(Math.round(x), Math.round(y), Math.ceil(box.w), Math.ceil(box.h));
      const alt = box.element.attribs?.alt;
      if (alt) {
        const layout = new TextLayout(this._fonts(), alt, { ...box.style, fontSize: 12 }, {
          maxWidth: Math.max(10, box.w - 8)
        });
        ctx.fillStyle = '#666666';
        layout.draw(ctx, x + 4, y + 4);
      }
    }
  }

  _drawListMarker(ctx, box, ox, oy) {
    const st = box.style;
    const n = st._liIndex ?? 1;
    let marker;
    switch (st.listStyleType) {
      case 'none':
        return;
      case 'decimal':
        marker = `${n}.`;
        break;
      case 'lower-alpha':
      case 'lower-roman':
        marker = `${String.fromCharCode(96 + ((n - 1) % 26) + 1)}.`;
        break;
      case 'upper-alpha':
      case 'upper-roman':
        marker = `${String.fromCharCode(64 + ((n - 1) % 26) + 1)}.`;
        break;
      case 'circle':
        marker = '◦';
        break;
      case 'square':
        marker = '▪';
        break;
      default:
        marker = '•';
    }
    const layout = new TextLayout(this._fonts(), marker, st, {});
    layout.draw(ctx, ox + box.x - layout.width - st.fontSize * 0.4, oy + box.y);
  }

  /**
   * The link under a point (device coordinates of the last draw), or null.
   * Returns `{ href, element }`.
   */
  linkAt(x, y) {
    for (let i = this._links.length - 1; i >= 0; i--) {
      const l = this._links[i];
      if (x >= l.x && x < l.x + l.w && y >= l.y && y < l.y + l.h) return l;
    }
    return null;
  }

  /**
   * The deepest DOM element whose box contains the point (coordinates as in
   * the last draw), or null. Text runs report their nearest element ancestor.
   */
  elementAt(x, y) {
    const scroll = this.window ? this.scrollY : 0;
    const hit = (box, px, py, best) => {
      if (px >= box.x && px < box.x + box.w && py >= box.y && py < box.y + box.h) {
        if (box.element) best = box.element;
        for (const child of box.children) best = hit(child, px, py, best);
      }
      return best;
    };
    return this._root ? hit(this._root, x, y + scroll, null) : null;
  }

  // -------------------------------------------------------------------------
  // window mode

  /** scroll the document vertically (window mode); clamps to content */
  scrollBy(dy) {
    return this.scrollTo(this.scrollY + dy);
  }

  scrollTo(yPos) {
    if (!this.window) return this;
    const max = Math.max(0, this.contentHeight - this.window.height);
    const next = Math.max(0, Math.min(max, yPos));
    if (next !== this.scrollY) {
      this.scrollY = next;
      this.render();
    }
    return this;
  }

  /** full window render: (re)layout on size change, clear, draw */
  render() {
    if (!this.window) throw new Error('HtmlView.render() needs a window');
    const ctx = this._ctx;
    if (this._layoutWidth !== this.window.width) {
      this.layout(this.window.width);
      const max = Math.max(0, this.contentHeight - this.window.height);
      if (this.scrollY > max) this.scrollY = max;
    }
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(0, 0, this.window.width, this.window.height);
    this.draw(ctx, 0, -this.scrollY);
    return this;
  }

  /** free yoga nodes and server-side image uploads */
  destroy() {
    this._disposeTree();
    for (const entry of this._images.values()) entry.image?.destroy();
    this._images.clear();
  }

  [Symbol.dispose]() {
    this.destroy();
  }
}
