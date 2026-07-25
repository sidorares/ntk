import LineBreaker from 'linebreak';

import { drawGlyphRuns } from './glyphs.js';
import { embeddingLevels, reorderRuns } from './shape.js';

const WS = new Set([0x20, 0x09, 0xa0]);
const HARD_BREAKS = /[\n\r\u2028\u2029]+$/;
const TRAILING_WS = /[ \t\u00a0]+$/;

function isWsGlyph(g) {
  return g.codePoints.length > 0 && g.codePoints.every((cp) => WS.has(cp));
}

/**
 * Multi-line text layout: breaks (possibly styled) text into lines for a
 * target container width, with full shaping — kerning, ligatures, complex
 * scripts, bidi and font fallback all apply.
 *
 * Line-break opportunities follow UAX#14 (via the `linebreak` package);
 * shaping happens per inter-break segment (so results are cached and reused
 * across relayouts), and bidi reordering is applied per line (UAX#9 L2).
 *
 * Content is a plain string or an array of spans
 * `{ text, family?, size?, weight?, style?, features?, language?, color? }`;
 * span fields override the base style. Options:
 *
 * - `maxWidth` — target container width (default: unlimited)
 * - `align` — 'left' | 'right' | 'center' | 'start' | 'end'
 * - `lineHeight` — multiplier over natural font line height (default 1)
 * - `direction` — 'ltr' | 'rtl' | 'auto' base paragraph direction
 *
 * The result is inspectable before/without drawing: `width`, `height`, and
 * `lines[] = { x, y, baseline, width, ascent, descent, runs }` with
 * `runs[] = { x, width, run, span }` in visual order.
 */
export class TextLayout {
  constructor(fonts, content, style = {}, options = {}) {
    this.fonts = fonts;
    this.options = options;
    const maxWidth = options.maxWidth ?? Infinity;

    // ---- normalize spans, resolve fonts eagerly ----
    const spans = (typeof content === 'string' ? [{ text: content }] : content).map((s) => {
      const merged = {
        text: String(s.text ?? ''),
        family: s.family ?? style.family ?? 'sans-serif',
        size: s.size ?? style.size ?? 16,
        weight: s.weight ?? style.weight,
        style: s.style ?? style.style,
        features: s.features ?? style.features,
        language: s.language ?? style.language,
        color: s.color ?? style.color ?? null
      };
      merged.font = s.font ?? style.font ?? fonts.match(merged.family, merged);
      return merged;
    });

    const text = spans.map((s) => s.text).join('');
    const emb = embeddingLevels(text, options.direction);
    const levels = emb.levels;
    this.baseLevel = emb.paragraphs.length ? emb.paragraphs[0].level & 1 : 0;

    // span boundaries, for binary search by char position
    const spanStarts = [];
    {
      let pos = 0;
      for (const s of spans) {
        spanStarts.push(pos);
        pos += s.text.length;
      }
    }
    const spanAt = (pos) => {
      let lo = 0;
      let hi = spanStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (spanStarts[mid] <= pos) lo = mid;
        else hi = mid - 1;
      }
      return {
        span: spans[lo],
        end: lo + 1 < spanStarts.length ? spanStarts[lo + 1] : text.length
      };
    };

    // ---- tokenize at UAX#14 break opportunities ----
    const tokens = [];
    {
      const breaker = new LineBreaker(text);
      let prev = 0;
      let bk;
      while ((bk = breaker.nextBreak())) {
        tokens.push(this._makeToken(text, prev, bk.position, levels, spanAt, bk.required));
        prev = bk.position;
      }
      if (prev < text.length || tokens.length === 0) {
        tokens.push(this._makeToken(text, prev, text.length, levels, spanAt, false));
      }
    }

    // ---- greedy line fill ----
    const lineTokens = [];
    {
      let cur = [];
      let curWidth = 0;
      const flush = () => {
        lineTokens.push(cur);
        cur = [];
        curWidth = 0;
      };
      for (let token of tokens) {
        while (curWidth + token.width - token.wsWidth > maxWidth) {
          if (cur.length > 0) {
            flush();
          } else {
            // single token wider than the container: force-break it
            const [head, rest] = this._forceBreak(token, maxWidth);
            if (!head) break; // not even one cluster fits: let it overflow
            cur.push(head);
            flush();
            token = rest;
          }
        }
        cur.push(token);
        curWidth += token.width;
        if (token.required) flush();
      }
      if (cur.length) lineTokens.push(cur);
    }

    // ---- assemble lines: strip trailing ws, bidi-reorder, position ----
    const baseSpan = spans[0];
    const lineHeightMul = options.lineHeight ?? 1;
    this.lines = [];
    let y = 0;
    let layoutWidth = 0;

    for (const toks of lineTokens) {
      // entries carry .level so reorderRuns can order them (UAX#9 L2)
      let entries = [];
      for (const token of toks) {
        for (const frag of token.fragments) {
          for (const run of frag.shaped.runs) {
            entries.push({ run, span: frag.span, level: run.level });
          }
        }
      }
      stripTrailingWhitespace(entries);
      entries = reorderRuns(entries);

      let ascent = 0;
      let descent = 0;
      let natural = 0;
      const runs = [];
      let x = 0;
      for (const e of entries) {
        runs.push({ x, width: e.run.width, run: e.run, span: e.span });
        x += e.run.width;
        const m = e.run.font.metrics(e.run.size);
        if (m.ascent > ascent) ascent = m.ascent;
        if (m.descent > descent) descent = m.descent;
        if (m.lineHeight > natural) natural = m.lineHeight;
      }
      if (runs.length === 0) {
        // empty line (blank paragraph): base style metrics
        const m = baseSpan.font.metrics(baseSpan.size);
        ascent = m.ascent;
        descent = m.descent;
        natural = m.lineHeight;
      }
      if (x > layoutWidth) layoutWidth = x;
      this.lines.push({ x: 0, y, baseline: y + ascent, width: x, ascent, descent, runs });
      y += natural * lineHeightMul;
    }

    this.width = layoutWidth;
    this.height = y;

    // ---- horizontal alignment ----
    const container = Number.isFinite(maxWidth) ? maxWidth : this.width;
    let align = options.align ?? 'start';
    if (align === 'start') align = this.baseLevel ? 'right' : 'left';
    if (align === 'end') align = this.baseLevel ? 'left' : 'right';
    if (align !== 'left') {
      for (const line of this.lines) {
        const free = container - line.width;
        line.x = align === 'right' ? free : free / 2;
      }
    }
  }

  _makeToken(text, start, end, levels, spanAt, required) {
    const fragments = [];
    let width = 0;
    let pos = start;
    while (pos < end) {
      const { span, end: spanEnd } = spanAt(pos);
      const fragEnd = Math.min(end, spanEnd);
      // hard-break controls only terminate the line; never shape them
      const fragText = text.slice(pos, fragEnd).replace(HARD_BREAKS, '');
      if (fragText.length > 0) {
        const fragLevels = normalizedLevels(levels, pos, pos + fragText.length);
        const shaped = this.fonts._shapeCached(fragText, span, fragLevels);
        fragments.push({ text: fragText, span, shaped });
        width += shaped.width;
      }
      pos = fragEnd;
    }
    // trailing whitespace does not count against the container width
    let wsWidth = 0;
    const last = fragments[fragments.length - 1];
    if (last) {
      const m = TRAILING_WS.exec(last.text);
      if (m) {
        const spaceGlyph = last.span.font.fk.glyphForCodePoint(0x20);
        wsWidth = m[0].length * spaceGlyph.advanceWidth * last.span.font.scale(last.span.size);
      }
    }
    return { fragments, width, wsWidth, required };
  }

  // split an over-wide token at the widest cluster boundary that fits
  _forceBreak(token, maxWidth) {
    const headFrags = [];
    let used = 0;
    for (let i = 0; i < token.fragments.length; i++) {
      const frag = token.fragments[i];
      if (used + frag.shaped.width <= maxWidth) {
        headFrags.push(frag);
        used += frag.shaped.width;
        continue;
      }
      // binary search the longest codepoint prefix of this fragment that fits
      const cps = Array.from(frag.text);
      let lo = 0;
      let hi = cps.length - 1;
      let best = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const prefix = cps.slice(0, mid + 1).join('');
        const shaped = this.fonts._shapeCached(prefix, frag.span, '0');
        if (used + shaped.width <= maxWidth) {
          best = { len: prefix.length, shaped, text: prefix };
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (best) headFrags.push({ text: best.text, span: frag.span, shaped: best.shaped });

      const restFrags = [];
      const restText = frag.text.slice(best ? best.len : 0);
      if (restText) {
        restFrags.push({
          text: restText,
          span: frag.span,
          shaped: this.fonts._shapeCached(restText, frag.span, '0')
        });
      }
      restFrags.push(...token.fragments.slice(i + 1));
      const sum = (frags) => frags.reduce((w, f) => w + f.shaped.width, 0);
      const head = headFrags.length
        ? { fragments: headFrags, width: sum(headFrags), wsWidth: 0, required: false }
        : null;
      const rest = {
        fragments: restFrags,
        width: sum(restFrags),
        wsWidth: token.wsWidth,
        required: token.required
      };
      return [head, rest];
    }
    // everything fit after all (float rounding): no split needed
    return [
      { ...token, required: false },
      { fragments: [], width: 0, wsWidth: 0, required: token.required }
    ];
  }

  /**
   * Draw onto a 2d context at (x, y) = top-left of the layout box.
   * Span `color`s override the context fillStyle; consecutive same-color
   * runs are batched into single CompositeGlyphs requests.
   */
  draw(ctx, x = 0, y = 0) {
    const app = ctx.window.app;
    const Render = app.display.Render;
    for (const line of this.lines) {
      let batch = [];
      let batchColor;
      const flush = () => {
        if (batch.length === 0) return;
        const src = batchColor ? ctx._stylePicture(batchColor) : ctx._backgroundPicture;
        drawGlyphRuns(app, Render.PictOp.Over, src.id, ctx.picture.id, batch);
        batch = [];
      };
      for (const r of line.runs) {
        const color = r.span.color;
        if (batch.length && color !== batchColor) flush();
        batchColor = color;
        batch.push({ run: r.run, x: x + line.x + r.x, y: y + line.baseline });
      }
      flush();
    }
    ctx._markDirty();
    return this;
  }
}

// Drop trailing whitespace glyphs from the logical end of a line.
// Shaped runs are shared via the shaping cache — clone instead of mutating.
function stripTrailingWhitespace(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const run = entries[i].run;
    // rtl runs store glyphs in visual order: their logical end is index 0
    const fromFront = run.direction === 'rtl';
    let count = 0;
    let wsWidth = 0;
    while (count < run.glyphs.length) {
      const g = run.glyphs[fromFront ? count : run.glyphs.length - 1 - count];
      if (!isWsGlyph(g)) break;
      count++;
      wsWidth += g.ax;
    }
    if (count === 0) return;
    if (count === run.glyphs.length) {
      entries.splice(i, 1);
      continue;
    }
    entries[i] = {
      ...entries[i],
      run: {
        ...run,
        glyphs: fromFront ? run.glyphs.slice(count) : run.glyphs.slice(0, -count),
        width: run.width - wsWidth
      }
    };
    return;
  }
}

// compact levels key for the shaping cache: single char when uniform
function normalizedLevels(levels, start, end) {
  let uniform = true;
  for (let i = start + 1; i < end; i++) {
    if (levels[i] !== levels[start]) {
      uniform = false;
      break;
    }
  }
  if (uniform) return String(levels[start] ?? 0);
  return Array.prototype.slice.call(levels, start, end).join(',');
}
