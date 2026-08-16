import LineBreaker from 'linebreak';

import { drawGlyphRuns } from './glyphs.js';
import { embeddingLevels, normalizedLevels, reorderRuns } from './shape.js';

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
 * - `maxLines` — cap the number of lines (default: unlimited)
 * - `overflow` — 'clip' (default) or 'ellipsis', what a `maxLines` cut looks
 *   like. See `_elide`.
 *
 * The result is inspectable before/without drawing: `width`, `height`,
 * `truncated`, and `lines[] = { x, y, height, baseline, width, ascent,
 * descent, runs, start, end }` with
 * `runs[] = { x, width, run, span, start, end }` in visual order
 * (`start`/`end` are logical UTF-16 ranges into the full text). A line's
 * box is `y` to `y + height`; its glyphs sit centred in it, from
 * `baseline - ascent` to `baseline + descent`.
 *
 * `caretPosition(index)` / `indexAt(x, y)` map logical code-point indices
 * to visual caret geometry and back (bidi/ligature/trailing-whitespace
 * aware) — see docs/text.md.
 */
export class TextLayout {
  constructor(fonts, content, style = {}, options = {}) {
    this.fonts = fonts;
    this.options = options;
    const maxWidth = options.maxWidth ?? Infinity;

    // ---- normalize spans, resolve fonts eagerly ----
    // unknown span fields ride along untouched, so a caller can attach its
    // own markers to a span and read them back off the line runs
    // An empty span list is a legitimate thing to lay out — a document view
    // reaches it for a blank paragraph while one is being typed —
    // and every line still needs a style to take its metrics from, so
    // stand one in rather than crashing on the first empty line.
    const given = typeof content === 'string' ? [{ text: content }] : content;
    const spans = (given.length ? given : [{ text: '' }]).map((s) => {
      const merged = {
        ...s,
        text: String(s.text ?? ''),
        family: s.family ?? style.family ?? 'sans-serif',
        size: s.size ?? style.size ?? 16,
        weight: s.weight ?? style.weight,
        style: s.style ?? style.style,
        variations: s.variations ?? style.variations,
        textRendering: s.textRendering ?? style.textRendering,
        features: s.features ?? style.features,
        language: s.language ?? style.language,
        color: s.color ?? style.color ?? null
      };
      merged.font = s.font ?? style.font ?? fonts.match(merged.family, merged);
      return merged;
    });

    const text = spans.map((s) => s.text).join('');
    this._text = text;
    this._cpOffsets = null; // lazy code-point index -> code-unit offset table
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

    // ---- cap the line count ----
    // The cut happens here, between filling and assembly, so the dropped
    // lines cost nothing to position and `height` counts only what is kept.
    const maxLines = Number.isFinite(options.maxLines)
      ? Math.max(0, Math.floor(options.maxLines))
      : Infinity;
    /** did `maxLines` drop content? */
    this.truncated = lineTokens.length > maxLines;
    if (this.truncated) lineTokens.length = maxLines;
    const elide = this.truncated && options.overflow === 'ellipsis';

    // ---- assemble lines: strip trailing ws, bidi-reorder, position ----
    const baseSpan = spans[0];
    const lineHeightMul = options.lineHeight ?? 1;
    this.lines = [];
    let y = 0;
    let layoutWidth = 0;

    for (let li = 0; li < lineTokens.length; li++) {
      let toks = lineTokens[li];
      const lineStart = toks.length ? toks[0].start : 0;
      let lineEnd = toks.length ? toks[toks.length - 1].end : lineStart;

      // Elision is the last kept line's business only, and it happens before
      // entries exist, because dropping content means re-shaping the tail.
      const ellipsis = elide && li === lineTokens.length - 1 ? this._elide(toks, baseSpan) : null;
      if (ellipsis) toks = this._fitBefore(toks, maxWidth - ellipsis.width);

      // entries carry .level so reorderRuns can order them (UAX#9 L2);
      // .start/.end are absolute code-unit ranges into the full text, kept
      // for caret positioning (caretPosition / indexAt)
      let entries = [];
      for (const token of toks) {
        for (const frag of token.fragments) {
          for (const run of frag.shaped.runs) {
            entries.push({
              run,
              span: frag.span,
              level: run.level,
              start: frag.start + run.start,
              end: frag.start + run.end
            });
          }
        }
      }
      let trailing = stripTrailingWhitespace(entries);
      const contentEnd = trailing
        ? trailing.start
        : entries.length
          ? entries[entries.length - 1].end
          : lineStart;
      if (ellipsis) {
        // The ellipsis takes the *paragraph* level, which is what a neutral
        // at the end of a paragraph resolves to under UAX#9 — so reorderRuns
        // puts it at the right edge of an LTR line and the left edge of an
        // RTL one, without a special case here. Its logical range is empty
        // and pinned at the cut, so caret mapping treats it as the end of
        // the visible text rather than as characters of its own.
        for (const run of ellipsis.shaped.runs) {
          entries.push({
            run,
            span: ellipsis.span,
            level: this.baseLevel,
            start: contentEnd,
            end: contentEnd,
            ellipsis: true
          });
        }
        // whatever whitespace was stripped is gone for good, not merely
        // pushed past the line edge: there is no wrap for it to precede
        trailing = null;
        lineEnd = contentEnd;
      }
      entries = reorderRuns(entries);

      let ascent = 0;
      let descent = 0;
      let natural = 0;
      const runs = [];
      let x = 0;
      for (const e of entries) {
        const positioned = { x, width: e.run.width, run: e.run, span: e.span, start: e.start, end: e.end };
        if (e.ellipsis) positioned.ellipsis = true;
        runs.push(positioned);
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
      // Half-leading (CSS Inline Layout 3): the slack between the glyphs and
      // the line box is split evenly above and below, rather than all of it
      // landing under the text. This is what makes a single line sit
      // centred in a box measured from `layout.height`, and it applies at
      // `lineHeight: 1` too — a font's natural line height includes its line
      // gap, which is 8px at 16px for some UI faces.
      //
      // A multiplier small enough to make the box shorter than the glyphs
      // gives negative leading and the text overflows evenly on both sides,
      // which is also what CSS does.
      const box = natural * lineHeightMul;
      const leading = (box - (ascent + descent)) / 2;
      this.lines.push({
        x: 0,
        y,
        height: box,
        baseline: y + leading + ascent,
        width: x,
        ascent,
        descent,
        runs,
        start: lineStart,
        end: lineEnd,
        _contentEnd: contentEnd,
        _trailing: trailing
      });
      y += box;
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
        // the levels ride along so a later split can re-shape a piece at the
        // level it actually has, rather than assuming ltr
        fragments.push({ text: fragText, span, shaped, start: pos, levels: fragLevels });
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
    return { fragments, width, wsWidth, required, start, end };
  }

  /**
   * The ellipsis to append to a line that was cut short: `{ text, span,
   * shaped, width }`.
   *
   * Shaped in the style of the line's **logically trailing** span, so an
   * elided line ending in a large or bold word gets a matching ellipsis
   * rather than one in the paragraph's base style. That span is chosen
   * before the cut, not after: choosing it after would make the ellipsis
   * width depend on a cut that depends on the ellipsis width.
   *
   * U+2026 is not universal — a subsetted icon or maths face may well lack
   * it — so when neither the span's font nor any fallback covers it, three
   * periods stand in. Shaping the real character through a font that has no
   * glyph for it would draw a .notdef box, which is a worse way to say
   * "there is more text".
   */
  _elide(toks, baseSpan) {
    let span = baseSpan;
    for (let i = toks.length - 1; i >= 0; i--) {
      const frags = toks[i].fragments;
      if (frags.length) {
        span = frags[frags.length - 1].span;
        break;
      }
    }
    const covered =
      span.font.hasGlyph(0x2026) || this.fonts.fallbackFor(0x2026, span.family, span) !== null;
    const text = covered ? '…' : '...';
    const shaped = this.fonts._shapeCached(text, span, String(this.baseLevel));
    return { text, span, shaped, width: shaped.width };
  }

  /**
   * The longest prefix of a line's tokens whose width fits `budget` — whole
   * tokens while they fit, then a grapheme-boundary cut into the first one
   * that does not.
   *
   * Cutting has to happen here rather than by slicing the text, because the
   * tail is re-shaped: kerning and ligatures across the cut change widths,
   * and in a mixed-direction line the visually-last run is not the logically
   * last one. Working in tokens keeps both facts inside the machinery that
   * already knows them.
   */
  _fitBefore(toks, budget) {
    const kept = [];
    let used = 0;
    for (const token of toks) {
      // trailing whitespace does not count against the budget, exactly as it
      // does not count during the greedy fill
      if (used + token.width - token.wsWidth <= budget) {
        kept.push(token);
        used += token.width;
        continue;
      }
      const [head] = this._forceBreak(token, budget - used);
      if (head && head.fragments.length) kept.push(head);
      break;
    }
    return kept;
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
      // binary search the longest grapheme prefix of this fragment that fits.
      // Graphemes rather than code points: cutting between a base character
      // and its combining mark, or inside an emoji ZWJ sequence, leaves a
      // dotted circle or a pair of half-emoji on the two sides of the break.
      const cps = graphemes(frag.text);
      let lo = 0;
      let hi = cps.length - 1;
      let best = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const prefix = cps.slice(0, mid + 1).join('');
        // shaped at the bidi level this text actually has: assuming level 0
        // here re-shapes an rtl word as ltr, which lays its glyphs out
        // backwards and hands reorderRuns an even level that stops it from
        // being reordered at all
        const shaped = this.fonts._shapeCached(prefix, frag.span, sliceLevels(frag.levels, 0, prefix.length));
        if (used + shaped.width <= maxWidth) {
          best = { len: prefix.length, shaped, text: prefix };
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (best) {
        headFrags.push({
          text: best.text,
          span: frag.span,
          shaped: best.shaped,
          start: frag.start,
          levels: sliceLevels(frag.levels, 0, best.len)
        });
      }

      const restFrags = [];
      const cut = best ? best.len : 0;
      const restText = frag.text.slice(cut);
      if (restText) {
        const restLevels = sliceLevels(frag.levels, cut, frag.text.length);
        restFrags.push({
          text: restText,
          span: frag.span,
          shaped: this.fonts._shapeCached(restText, frag.span, restLevels),
          start: frag.start + cut,
          levels: restLevels
        });
      }
      restFrags.push(...token.fragments.slice(i + 1));
      const sum = (frags) => frags.reduce((w, f) => w + f.shaped.width, 0);
      const splitAt = restFrags.length ? restFrags[0].start : token.end;
      const head = headFrags.length
        ? { fragments: headFrags, width: sum(headFrags), wsWidth: 0, required: false, start: token.start, end: splitAt }
        : null;
      const rest = {
        fragments: restFrags,
        width: sum(restFrags),
        wsWidth: token.wsWidth,
        required: token.required,
        start: splitAt,
        end: token.end
      };
      return [head, rest];
    }
    // everything fit after all (float rounding): no split needed
    return [
      { ...token, required: false },
      { fragments: [], width: 0, wsWidth: 0, required: token.required, start: token.end, end: token.end }
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
    // One batch for the whole layout, not one per line: every positioned
    // run carries its own absolute baseline, so a uniformly coloured
    // paragraph becomes a single glyph composite instead of one per line.
    // Only a colour change forces a flush.
    let batch = [];
    let batchColor;
    const flush = () => {
      if (batch.length === 0) return;
      const src = batchColor ? ctx._stylePicture(batchColor) : ctx._backgroundPicture;
      // via the context so the clip is applied (drawGlyphRuns composites
      // straight onto the picture and cannot see it)
      if (typeof ctx.drawGlyphs === 'function') {
        ctx.drawGlyphs(Render.PictOp.Over, src, batch);
      } else {
        drawGlyphRuns(app, Render.PictOp.Over, src.id, ctx.picture.id, batch);
      }
      batch = [];
    };
    for (const line of this.lines) {
      for (const r of line.runs) {
        const color = r.span.color;
        if (batch.length && color !== batchColor) flush();
        batchColor = color;
        batch.push({
          run: r.run,
          x: x + line.x + r.x,
          y: y + line.baseline,
          // per run, because it is a span property: one paragraph may hold
          // a display word that wants exact positions and body text that
          // wants its glyph cache. `drawGlyphRuns` already partitions.
          textRendering: r.span.textRendering
        });
      }
    }
    flush();
    ctx._markDirty();
    return this;
  }

  // ---- caret positioning / hit testing ----------------------------------
  //
  // Both methods speak logical **code-point** indices (what you get from
  // `Array.from(text)` / caret arithmetic on code points), converted
  // internally to the code-unit ranges the shaped runs carry.
  //
  // Conventions (v1):
  // - Direction boundaries: a single caret, placed at the trailing edge of
  //   the character logically before the index (the run containing the
  //   previous character wins). At a line start the leading edge of the
  //   run containing the index is used. Indices on both sides of a
  //   direction boundary may therefore map to the same visual x.
  // - Ligature/cluster interior indices interpolate proportionally (by
  //   code-point count) across the cluster's advance.
  // - An index just after a hard break belongs to the next line; the index
  //   of the break character itself sits at the end of its line. An index
  //   at a soft wrap boundary belongs to the start of the wrapped line.
  // - Trailing whitespace stripped from a line end still advances the
  //   caret, extending past the line edge on the paragraph-direction side.

  /** lazy code-point index -> code-unit offset table (n + 1 entries) */
  _offsets() {
    if (!this._cpOffsets) {
      const offs = [];
      let cu = 0;
      for (const ch of this._text) {
        offs.push(cu);
        cu += ch.length;
      }
      offs.push(cu);
      this._cpOffsets = offs;
    }
    return this._cpOffsets;
  }

  /** code-unit offset -> code-point index (binary search) */
  _cpOf(cu) {
    const offs = this._offsets();
    let lo = 0;
    let hi = offs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offs[mid] <= cu) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Visual caret geometry for a logical code-point index in
   * `[0, codePointCount]` (out-of-range indices clamp).
   *
   * @returns {{ x, y, height, line }} `x` is the caret's visual x within
   *   the layout box (alignment included), `y` the top of the **glyphs**,
   *   `height` = ascent + descent, `line` the line index.
   *
   * `y` tracks the text rather than the line box, so a caret drawn from it
   * stays locked to the glyphs whatever the leading. For a full-height
   * selection band instead, the line box is `line.y` to `line.y +
   * line.height`.
   */
  caretPosition(index) {
    const offs = this._offsets();
    const n = offs.length - 1;
    const i = Math.max(0, Math.min(Math.floor(index), n));
    const cu = offs[i];
    let li = 0;
    for (let l = this.lines.length - 1; l >= 0; l--) {
      if (cu >= this.lines[l].start) {
        li = l;
        break;
      }
    }
    const line = this.lines[li];
    return {
      x: this._caretXInLine(line, cu),
      y: line.baseline - line.ascent,
      height: line.ascent + line.descent,
      line: li
    };
  }

  /**
   * Hit test: the logical code-point index of the caret boundary closest
   * to layout-box coordinates (x, y). Picks the line by y (clamping above
   * the first / below the last line), then the nearest boundary by x in
   * visual order — a click past the midpoint of a cluster snaps to its far
   * edge. Inverse of `caretPosition` up to bidi boundary ambiguity.
   */
  indexAt(x, y) {
    const lines = this.lines;
    if (lines.length === 0) return 0;
    let li = lines.length - 1;
    for (let l = 0; l < lines.length; l++) {
      const bottom = l + 1 < lines.length ? lines[l + 1].y : Infinity;
      if (y < bottom) {
        li = l;
        break;
      }
    }
    const line = lines[li];
    const lx = x - line.x;
    const t = line._trailing;
    const rightSide = !(this.baseLevel & 1);
    if (t && (rightSide ? lx > line.width : lx < 0)) {
      // in the stripped trailing-whitespace zone past the line edge
      const dist = rightSide ? lx - line.width : -lx;
      let pos = t.start;
      let edge = 0;
      for (const g of t.glyphs) {
        if (dist < edge + g.ax / 2) return this._cpOf(pos);
        edge += g.ax;
        pos += g.len;
      }
      return this._cpOf(pos);
    }
    if (line.runs.length === 0) return this._cpOf(line.start);
    const cx = Math.max(0, Math.min(lx, line.width));
    let target = line.runs[line.runs.length - 1];
    for (const r of line.runs) {
      if (cx <= r.x + r.width) {
        target = r;
        break;
      }
    }
    // the ellipsis stands for text that is not displayed, so anywhere on it
    // is the end of what is: it has no indices of its own to land in
    if (target.ellipsis) return this._cpOf(line._contentEnd);
    return this._cpOf(this._runIndexAt(target, cx));
  }

  /** caret x (layout-box coords) for an absolute code-unit offset on `line` */
  _caretXInLine(line, cu) {
    const t = line._trailing;
    if (t && cu > t.start) {
      // inside (or past) the stripped trailing whitespace: extend beyond
      // the visual line edge on the paragraph-direction side
      let adv = 0;
      let pos = t.start;
      for (const g of t.glyphs) {
        if (cu >= pos + g.len) {
          adv += g.ax;
          pos += g.len;
        } else {
          if (cu > pos) adv += (g.ax * (cu - pos)) / g.len;
          break;
        }
      }
      return this.baseLevel & 1 ? line.x - adv : line.x + line.width + adv;
    }
    if (line.runs.length === 0) return line.x;
    const cc = Math.min(cu, line._contentEnd);
    // previous-character rule: the run containing the char before the index
    let target = null;
    if (cc > line.start) {
      for (const r of line.runs) {
        if (r.start < cc && cc <= r.end) {
          target = r;
          break;
        }
      }
    }
    if (!target) {
      for (const r of line.runs) {
        if (r.start <= cc && cc < r.end) {
          target = r;
          break;
        }
      }
    }
    if (!target) target = line.runs[this.baseLevel & 1 ? line.runs.length - 1 : 0];
    return line.x + this._boundaryX(target, cc);
  }

  /** x of logical boundary `cu` within a positioned line run (run-local + run.x) */
  _boundaryX(lineRun, cu) {
    const { run, start, end } = lineRun;
    let x = lineRun.x;
    if (run.direction === 'rtl') {
      // glyphs stored in visual order; leftmost glyph is logically last
      let pos = end;
      for (const g of run.glyphs) {
        const len = cuLength(g.codePoints);
        if (len === 0) {
          x += g.ax;
          continue;
        }
        if (cu >= pos) return x;
        if (cu > pos - len) {
          // fraction of the cluster left of the caret = code points after cu
          const cps = g.codePoints;
          let k = 0;
          let c = pos;
          for (let j = cps.length - 1; j >= 0; j--) {
            const l = cps[j] > 0xffff ? 2 : 1;
            if (c - l < cu) break;
            c -= l;
            k++;
          }
          return x + (g.ax * k) / cps.length;
        }
        pos -= len;
        x += g.ax;
      }
      return x;
    }
    let pos = start;
    for (const g of run.glyphs) {
      const len = cuLength(g.codePoints);
      if (len === 0) {
        x += g.ax;
        continue;
      }
      if (cu <= pos) return x;
      if (cu < pos + len) {
        const cps = g.codePoints;
        let k = 0;
        let c = pos;
        for (const cp of cps) {
          const l = cp > 0xffff ? 2 : 1;
          if (c + l > cu) break;
          c += l;
          k++;
        }
        return x + (g.ax * k) / cps.length;
      }
      pos += len;
      x += g.ax;
    }
    return x;
  }

  /** nearest caret boundary (code units) to line-local x within a line run */
  _runIndexAt(lineRun, lx) {
    const { run, start, end } = lineRun;
    const rtl = run.direction === 'rtl';
    let pos = rtl ? end : start;
    let gx = lineRun.x;
    for (const g of run.glyphs) {
      const len = cuLength(g.codePoints);
      if (len === 0 || g.ax <= 0) {
        gx += g.ax;
        if (g.ax <= 0) pos += rtl ? -len : len;
        continue;
      }
      if (lx <= gx + g.ax) {
        const cps = g.codePoints;
        let k = Math.round(((lx - gx) / g.ax) * cps.length);
        k = Math.max(0, Math.min(k, cps.length));
        // move k code points into the cluster from its left edge
        let c = pos;
        if (rtl) {
          for (let j = cps.length - 1; j >= cps.length - k; j--) {
            c -= cps[j] > 0xffff ? 2 : 1;
          }
        } else {
          for (let j = 0; j < k; j++) c += cps[j] > 0xffff ? 2 : 1;
        }
        return c;
      }
      pos += rtl ? -len : len;
      gx += g.ax;
    }
    return pos;
  }
}

// Grapheme clusters (UAX#29), for cut points that never land inside one.
// Intl.Segmenter is in node >= 16 and every current browser; where it is
// somehow absent, code points are the old behaviour and still safe for the
// scripts that reach a force-break most often.
let segmenter;
function graphemes(text) {
  if (segmenter === undefined) {
    segmenter =
      typeof Intl !== 'undefined' && Intl.Segmenter
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;
  }
  if (!segmenter) return Array.from(text);
  const out = [];
  for (const { segment } of segmenter.segment(text)) out.push(segment);
  return out;
}

// UTF-16 length of a glyph cluster's codePoints array
function cuLength(codePoints) {
  let len = 0;
  for (const cp of codePoints) len += cp > 0xffff ? 2 : 1;
  return len;
}

// Drop trailing whitespace glyphs from the logical end of a line.
// Shaped runs are shared via the shaping cache — clone instead of mutating.
// Returns what was stripped — `{ start, glyphs: [{ ax, len }] }` in logical
// order (absolute code-unit start, per-glyph advance and code-unit length) —
// so caret positioning can still walk through trailing spaces, or null when
// nothing was stripped. Adjusts the surviving entries' logical `end`.
function stripTrailingWhitespace(entries) {
  const stripped = [];
  let strippedStart = null;
  const result = () => (stripped.length ? { start: strippedStart, glyphs: stripped } : null);
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
    if (count === 0) return result();
    // stripped glyphs in logical order (rtl glyph storage is reversed)
    const tail = fromFront
      ? run.glyphs.slice(0, count).reverse()
      : run.glyphs.slice(run.glyphs.length - count);
    let cuStripped = 0;
    const info = tail.map((g) => {
      const len = cuLength(g.codePoints);
      cuStripped += len;
      return { ax: g.ax, len };
    });
    stripped.unshift(...info);
    strippedStart = entries[i].end - cuStripped;
    if (count === run.glyphs.length) {
      entries.splice(i, 1);
      continue;
    }
    entries[i] = {
      ...entries[i],
      end: entries[i].end - cuStripped,
      run: {
        ...run,
        glyphs: fromFront ? run.glyphs.slice(count) : run.glyphs.slice(0, -count),
        width: run.width - wsWidth
      }
    };
    return result();
  }
  return result();
}

// The levels key for a code-unit slice of a fragment. A uniform key covers
// any slice of itself; a per-character one has to be cut to match.
function sliceLevels(key, start, end) {
  if (key === undefined) return '0';
  if (!key.includes(',')) return key;
  return key.split(',').slice(start, end).join(',');
}
