import LineBreaker from 'linebreak';

import { rasterizePolys } from '../rasterize.js';
import { drawGlyphRuns } from './glyphs.js';
import { embeddingLevels, normalizedLevels, reorderRuns } from './shape.js';
import { worthKeeping } from './paragraphs.js';

// The white space a line may end on and hang past its edge: spaces and tabs,
// as CSS hangs them. A no-break space is not one — CSS measures it, and
// `&nbsp;` at the end of a cell or a span is there to take room.
const WS = new Set([0x20, 0x09]);
const HARD_BREAKS = /[\n\r\u2028\u2029]+$/;
const TRAILING_WS = /[ \t]+$/;

/** Scripts written without spaces between words, whose line breaking
 *  needs a dictionary (UAX #14's SA class, and Javanese, Balinese and
 *  Buginese, which are AL there): a token of theirs is a run of words. */
const UNSPACED =
  /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tai_Le}\p{Script=New_Tai_Lue}\p{Script=Tai_Tham}\p{Script=Tai_Viet}\p{Script=Ahom}\p{Script=Javanese}\p{Script=Balinese}\p{Script=Buginese}]/u;

/**
 * How far a line's content may reach past its width and still fit it: a
 * 64th of a pixel. The advances of a line are summed in floating point and
 * come out a hair over a width they were set to fill — a line of Verdana at
 * 12.8px measures 410.0125px in the 410px column it was written for — and
 * a browser takes the line as fitting, comparing in 64ths of a pixel with
 * that much to spare (Blink's line breaker adds a LayoutUnit's epsilon to
 * the width it fits to).
 */
const FIT_SLACK = 1 / 64;

/** How wide a line's tokens are, the white space it ends on left out. */
function tokensWidth(toks) {
  let width = 0;
  for (let i = 0; i < toks.length; i++) width += toks[i].width + (i ? kernBefore(toks[i]) : 0);
  return toks.length ? width - toks[toks.length - 1].wsWidth : 0;
}

/** The kerning between a token and the one before it on its line
 *  (`TextLayout._kernBefore`); none for a token a line starts with. */
function kernBefore(token) {
  return token.kernBefore ?? 0;
}

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
 * `{ text, family?, size?, weight?, style?, features?, language?,
 * letterSpacing?, color?, nowrap?, shapeApart? }`;
 * span fields override the base style. Spans that share a truthy `nowrap` —
 * `true`, or any value a caller tells its groups apart by — have no break
 * opportunity inside them or between them, as the text of an element with
 * CSS's `white-space: nowrap` has none: the break after the last of them is
 * the next span's to allow. Neighbouring spans shaped alike — a colour
 * apart — are shaped as one text, so a word across them keeps its kerning
 * and its joining; a span with a truthy `shapeApart` is shaped on its own,
 * as CSS breaks the shaping at an inline box with a margin, border or
 * padding. Options:
 *
 * - `maxWidth` — target container width (default: unlimited)
 * - `align` — 'left' | 'right' | 'center' | 'start' | 'end'
 * - `lineHeight` — multiplier over natural font line height (default 1)
 * - `direction` — 'ltr' | 'rtl' | 'auto' base paragraph direction
 * - `maxLines` — cap the number of lines (default: unlimited)
 * - `overflow` — 'clip' (default) or 'ellipsis', what a `maxLines` cut looks
 *   like, and a line that does not wrap cut at `maxWidth`. See `_elide`.
 * - `wrap` — false lays the text out a line to each forced break however
 *   wide it is; with `overflow: 'ellipsis'` a line wider than `maxWidth` is
 *   cut there with an ellipsis, inside a word if need be, as CSS's
 *   `text-overflow` cuts text that does not wrap. Default true.
 * - `overflowWrap` — 'break-word' (default) cuts a word wider than the line
 *   at a grapheme boundary; 'normal' keeps it whole on a line of its own,
 *   past the line's end, as CSS's `overflow-wrap: normal` does — but for
 *   text in a script written without spaces (Thai, Khmer, Javanese…), whose
 *   words the breaker cannot find, which is cut as a fallback
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

    // Everything up to the line fill is the same at every width, and a
    // font manager keeps it (text/paragraphs.js): a relayout at a new width
    // starts at the fill.
    // A short text skips it (`PARAGRAPH_MIN_CHARS`): a label is cheap to
    // prepare and seldom laid out at another width.
    const kept = worthKeeping(content) ? fonts._paragraphs : undefined;
    const key = kept ? kept.keyOf(content) : null;
    let paragraph = kept?.find(key, options.direction, content, style);
    if (!paragraph) {
      paragraph = this._prepare(content, style, options.direction);
      kept?.keep(key, options.direction, content, style, paragraph);
    }
    const { spans, text, tokens } = paragraph;
    this._text = text;
    this._cpOffsets = null; // lazy code-point index -> code-unit offset table
    this.baseLevel = paragraph.baseLevel;

    // ---- greedy line fill ----
    const lineTokens = [];
    // a word wider than the line stays whole, past the line's end, where
    // the options say so; cut inside itself where they do not — and in a
    // script written without spaces, where the breaker's "word" is a phrase
    // it had no dictionary to cut, cut anyway (CSS Text 3, 5.1)
    const whole = options.overflowWrap === 'normal';
    // text that does not wrap is a line to each forced break, however wide
    const wraps = options.wrap !== false;
    {
      let cur = [];
      let curWidth = 0;
      const flush = () => {
        lineTokens.push(cur);
        cur = [];
        curWidth = 0;
      };
      for (let token of tokens) {
        while (
          wraps &&
          curWidth + (cur.length ? kernBefore(token) : 0) + token.width - token.wsWidth > maxWidth + FIT_SLACK
        ) {
          if (cur.length > 0) {
            flush();
          } else if (whole && !UNSPACED.test(text.slice(token.start, token.end))) {
            break;
          } else {
            // single token wider than the container: force-break it
            const [head, rest] = this._forceBreak(token, maxWidth);
            if (!head) break; // not even one cluster fits: let it overflow
            cur.push(head);
            flush();
            token = rest;
          }
        }
        curWidth += token.width + (cur.length ? kernBefore(token) : 0);
        cur.push(token);
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
    /** did `maxLines` drop content, or a line that does not wrap its end? */
    this.truncated = lineTokens.length > maxLines;
    if (this.truncated) lineTokens.length = maxLines;
    const ellipses = options.overflow === 'ellipsis';
    const elide = this.truncated && ellipses;
    // and a line that does not wrap is cut where it runs past the width
    const cutWide = ellipses && !wraps && Number.isFinite(maxWidth);

    // ---- assemble lines: strip trailing ws, bidi-reorder, position ----
    const baseSpan = spans[0];
    // a multiplier, as a number or a numeric string; anything else is the
    // font's own line height — `'24px'` made every line NaN pixels tall
    const asked = options.lineHeight == null ? NaN : Number(options.lineHeight);
    const lineHeightMul = asked >= 0 && asked < Infinity ? asked : 1;
    this.lines = [];
    let y = 0;
    let layoutWidth = 0;

    for (let li = 0; li < lineTokens.length; li++) {
      let toks = lineTokens[li];
      const lineStart = toks.length ? toks[0].start : 0;
      let lineEnd = toks.length ? toks[toks.length - 1].end : lineStart;

      // Elision is the last kept line's business, or a line's that does not
      // wrap and runs past the width, and it happens before entries exist,
      // because dropping content means re-shaping the tail.
      const cut = (elide && li === lineTokens.length - 1) || (cutWide && tokensWidth(toks) > maxWidth + FIT_SLACK);
      const ellipsis = cut ? this._elide(toks, baseSpan) : null;
      if (ellipsis) {
        toks = this._fitBefore(toks, maxWidth - ellipsis.width);
        this.truncated = true;
      }

      // entries carry .level so reorderRuns can order them (UAX#9 L2);
      // .start/.end are absolute code-unit ranges into the full text, kept
      // for caret positioning (caretPosition / indexAt)
      let entries = [];
      for (let t = 0; t < toks.length; t++) {
        const token = toks[t];
        // the kerning with the token before it goes before its first run
        let kern = t ? kernBefore(token) : 0;
        for (const frag of token.fragments) {
          for (const run of frag.shaped.runs) {
            const entry = {
              run,
              span: frag.span,
              level: run.level,
              start: frag.start + run.start,
              end: frag.start + run.end
            };
            if (kern) {
              entry.kern = kern;
              kern = 0;
            }
            entries.push(entry);
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
        if (e.kern) x += e.kern;
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
    if (align !== 'left' || this.baseLevel) {
      for (const line of this.lines) {
        const free = container - line.width;
        // a line too long for its container starts at its start edge and
        // runs past its end, whatever the alignment (CSS Text 3, 7.1)
        if (free < 0) line.x = this.baseLevel ? free : 0;
        else if (align !== 'left') line.x = align === 'right' ? free : free / 2;
      }
    }
  }

  /**
   * The part of a layout the width does not decide: the spans normalised
   * and their faces resolved, the embedding levels, and the text cut into
   * tokens at UAX#14 break opportunities, each shaped. Kept per font manager
   * and shared by every layout of the same paragraph (text/paragraphs.js), so
   * nothing after this may change what it returns — a layout's lines are
   * built from new objects over it.
   */
  _prepare(content, style, direction) {
    const fonts = this.fonts;
    // ---- normalize spans, resolve fonts eagerly ----
    // unknown span fields ride along untouched, so a caller can attach its
    // own markers to a span and read them back off the line runs
    // An empty span list is a legitimate thing to lay out — a document view
    // reaches it for a blank paragraph while one is being typed —
    // and every line still needs a style to take its metrics from, so
    // stand one in rather than crashing on the first empty line.
    const given = typeof content === 'string' ? [{ text: content }] : content;
    // What a span is shaped with, one per distinct style rather than one a
    // span (`shapingStyleOf`): the spans of a highlighted source file are its
    // tokens, half a million for twenty thousand lines over a handful of
    // styles, and the font lookup and the shaping memo's key, worked out
    // afresh for each, were most of what laying such a file out cost.
    const styles = [];
    const shapings = [];
    const spans = (given.length ? given : [{ text: '' }]).map((s) => {
      const merged = {
        ...s,
        text: String(s.text ?? ''),
        family: s.family ?? style.family ?? 'sans-serif',
        size: s.size ?? style.size ?? 16,
        weight: s.weight ?? style.weight,
        style: s.style ?? style.style,
        variations: s.variations ?? style.variations,
        opticalSize: s.opticalSize ?? style.opticalSize,
        opticalSizing: s.opticalSizing ?? style.opticalSizing,
        textRendering: s.textRendering ?? style.textRendering,
        features: s.features ?? style.features,
        language: s.language ?? style.language,
        letterSpacing: s.letterSpacing ?? style.letterSpacing,
        color: s.color ?? style.color ?? null
      };
      const shaping = shapingStyleOf(styles, merged, s.font ?? style.font, fonts);
      merged.font = shaping.font;
      shapings.push(shaping);
      return merged;
    });

    const text = spans.map((s) => s.text).join('');
    const emb = embeddingLevels(text, direction);
    const levels = emb.levels;
    const baseLevel = emb.paragraphs.length ? emb.paragraphs[0].level & 1 : 0;

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
        shaping: shapings[lo],
        end: lo + 1 < spanStarts.length ? spanStarts[lo + 1] : text.length
      };
    };

    // ---- tokenize at UAX#14 break opportunities ----
    // none between two characters of spans that share a `nowrap`
    const held = spans.some((s) => s.nowrap);
    const tokens = [];
    {
      const breaker = new LineBreaker(text);
      let prev = 0;
      let bk;
      while ((bk = breaker.nextBreak())) {
        if (held && !bk.required && bk.position < text.length) {
          const before = spanAt(bk.position - 1).span.nowrap;
          if (before && before === spanAt(bk.position).span.nowrap) continue;
        }
        tokens.push(this._makeToken(text, prev, bk.position, levels, spanAt, bk.required));
        prev = bk.position;
      }
      if (prev < text.length || tokens.length === 0) {
        tokens.push(this._makeToken(text, prev, text.length, levels, spanAt, false));
      }
    }
    for (let i = 1; i < tokens.length; i++) {
      const kern = this._kernBefore(text, tokens[i - 1], tokens[i], levels);
      if (kern) tokens[i].kernBefore = kern;
    }

    return { spans, text, baseLevel, tokens };
  }

  /**
   * The kerning between the last letter of one token and the first of the
   * next, where the two are on one line. Each token is shaped apart, so a
   * pair either side of a break opportunity was never kerned — Trebuchet MS
   * sets a space closer to an A, a T or a Y — and a line of it came out
   * wider than a browser's, which shapes a line whole: shaping breaks only
   * at an inline box's margin, border or padding (CSS Text 3, 7.3). Only
   * between letters shaped alike at one left-to-right level; a line that
   * breaks there never meets it.
   */
  _kernBefore(text, prev, next, levels) {
    if (prev.required) return 0;
    const a = prev.fragments[prev.fragments.length - 1];
    const b = next.fragments[0];
    if (!a || !b || a.shaping !== b.shaping || a.span.shapeApart || b.span.shapeApart) return 0;
    const at = a.start + a.text.length;
    if (at !== b.start) return 0;
    // two glyphs the face's tables cannot move against each other are set
    // together as apart, and asked about no further: most faces kern no
    // space, and a paragraph meets one at every word
    const l = a.shaped.runs[a.shaped.runs.length - 1];
    const r = b.shaped.runs[0];
    if (!l || !r || l.font !== r.font) return 0;
    const lg = l.glyphs[l.glyphs.length - 1];
    const rg = r.glyphs[0];
    if (!lg || !rg || (l.font.mayKern && !l.font.mayKern(lg.id, rg.id))) return 0;
    const low = text.charCodeAt(at - 1);
    const before = low >= 0xdc00 && low < 0xe000 && at >= 2 ? 2 : 1;
    const after = text.codePointAt(at) > 0xffff ? 2 : 1;
    const key = normalizedLevels(levels, at - before, at + after);
    if (key.includes(',') || Number(key) & 1) return 0;
    return this.fonts._kernAcross(text.slice(at - before, at + after), before, a.shaping, key);
  }

  /**
   * Whether the letters that meet at an edge between two spans of a group
   * shape otherwise together than apart: their glyphs or their advances
   * change. Compared as a set and a sum, which holds in a right-to-left
   * pair as in a left-to-right one.
   */
  _meets(text, group, levels, shaping) {
    for (let i = 1; i < group.length; i++) {
      const at = group[i].start;
      const low = text.charCodeAt(at - 1);
      const before = low >= 0xdc00 && low < 0xe000 && at >= 2 ? 2 : 1;
      const after = text.codePointAt(at) > 0xffff ? 2 : 1;
      const from = at - before;
      const to = at + after;
      if (this.fonts._meets(text.slice(from, to), before, shaping, normalizedLevels(levels, from, to))) return true;
    }
    return false;
  }

  _makeToken(text, start, end, levels, spanAt, required) {
    const fragments = [];
    let width = 0;
    let pos = start;
    while (pos < end) {
      // The spans of the token shaped alike — a colour apart, say — are
      // shaped as one text and the glyphs shared out among them after, so
      // a word that crosses from one to the next keeps the kerning between
      // its letters there, and a script its joining, as a browser shapes
      // it: an opening quote an `::before` makes kerned with nothing, and
      // an Arabic word in two colours came apart into isolated letters.
      // A span marked `shapeApart` is shaped on its own, as CSS breaks the
      // shaping at an inline box with a margin, border or padding.
      const group = [];
      let shaping = null;
      for (let at = pos; at < end; ) {
        const next = spanAt(at);
        if (shaping && (next.shaping !== shaping || next.span.shapeApart || group[group.length - 1].span.shapeApart))
          break;
        shaping = next.shaping;
        const fragEnd = Math.min(end, next.end);
        group.push({ span: next.span, start: at, end: fragEnd });
        at = fragEnd;
      }
      const groupEnd = group[group.length - 1].end;
      // Only where the letters either side of a span's edge shape otherwise
      // together than apart — a kerning pair, a joining script, a mark on
      // the letter before — is the word shaped whole: two letters are a
      // lookup the memo almost always holds, and a syntax-coloured line of
      // code, a span to a token, shaped each of its words afresh otherwise,
      // at twice the cost of the line.
      let pieces = null;
      if (group.length > 1) {
        const joined = text.slice(pos, groupEnd);
        if (!HARD_BREAKS.test(joined) && this._meets(text, group, levels, shaping)) {
          const whole = this.fonts._shapeCached(joined, shaping, normalizedLevels(levels, pos, groupEnd));
          pieces = splitShapedOnce(
            whole,
            group.slice(1).map((g) => g.start - pos)
          );
        }
      }
      for (let i = 0; i < group.length; i++) {
        const { span, start: fragStart, end: fragEnd } = group[i];
        // hard-break controls only terminate the line; never shape them
        const fragText = text.slice(fragStart, fragEnd).replace(HARD_BREAKS, '');
        if (fragText.length === 0) continue;
        const fragLevels = normalizedLevels(levels, fragStart, fragStart + fragText.length);
        const shaped = pieces ? pieces[i] : this.fonts._shapeCached(fragText, shaping, fragLevels);
        // the levels ride along so a later split can re-shape a piece at the
        // level it actually has, rather than assuming ltr
        fragments.push({ text: fragText, span, shaping, shaped, start: fragStart, levels: fragLevels });
        width += shaped.width;
      }
      pos = groupEnd;
    }
    // trailing whitespace does not count against the container width
    let wsWidth = 0;
    const last = fragments[fragments.length - 1];
    if (last) {
      const m = TRAILING_WS.exec(last.text);
      if (m) {
        const spacing = Number.isFinite(last.span.letterSpacing) ? last.span.letterSpacing : 0;
        wsWidth = m[0].length * (last.span.font.spaceAdvance(last.span.size) + spacing);
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
      const kern = kept.length ? kernBefore(token) : 0;
      if (used + kern + token.width - token.wsWidth <= budget + FIT_SLACK) {
        kept.push(token);
        used += kern + token.width;
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
      if (used + frag.shaped.width <= maxWidth + FIT_SLACK) {
        headFrags.push(frag);
        used += frag.shaped.width;
        continue;
      }
      // shaped at the bidi level this text actually has: assuming level 0
      // here re-shapes an rtl word as ltr, which lays its glyphs out
      // backwards and hands reorderRuns an even level that stops it from
      // being reordered at all
      const shaping = frag.shaping ?? frag.span;
      const shape = (text, from, to) =>
        this.fonts._shapeCached(text, shaping, sliceLevels(frag.levels, from, to));
      let best = null;
      // Graphemes rather than code points: cutting between a base character
      // and its combining mark, or inside an emoji ZWJ sequence, leaves a
      // dotted circle or a pair of half-emoji on the two sides of the break.
      const lead = firstGrapheme(frag.text);
      if (used + shape(lead, 0, lead.length).width <= maxWidth + FIT_SLACK) {
        // binary search the longest grapheme prefix of this fragment that fits
        const cps = graphemes(frag.text);
        let lo = 0;
        let hi = cps.length - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const prefix = cps.slice(0, mid + 1).join('');
          const shaped = shape(prefix, 0, prefix.length);
          if (used + shaped.width <= maxWidth + FIT_SLACK) {
            best = { len: prefix.length, shaped, text: prefix };
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
      } else if (!headFrags.length) {
        // Not even its first cluster fits, so nothing of the token does: the
        // caller lets it overflow whole. That is every word at width 0, where
        // a layout is asked for the narrowest it can be, and the search found
        // it out by segmenting the whole word and shaping a dozen prefixes of
        // it, each a word the memo had never seen.
        return [null, token];
      }
      if (best) {
        headFrags.push({
          text: best.text,
          span: frag.span,
          shaping,
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
          shaping,
          shaped: this.fonts._shapeCached(restText, shaping, restLevels),
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
   * Draw onto a 2d context at (x, y) = top-left of the layout box, in the
   * context's **user space**: the current transform applies to the origin,
   * the same way it applies to `fillText`, `fillRect` and `drawImage`, so a
   * paragraph drawn into a translated context lands where the rest of the
   * drawing does (issue #280). The glyphs themselves are not rotated or
   * scaled by it — set the span size instead.
   *
   * Span `color`s override the context fillStyle; consecutive same-color
   * runs are batched into single CompositeGlyphs requests.
   *
   * `caretPosition`/`indexAt` and the line/run geometry speak the same
   * layout-relative coordinates as the (x, y) here, so hit testing stays
   * `layout.indexAt(px - x, py - y)` — with (px, py) in user space too,
   * which for a pointer event under a transformed context means undoing
   * `ctx.getTransform()` first.
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
      // via the context so the clip and the transform are applied
      // (drawGlyphRuns composites straight onto the picture and can see
      // neither)
      if (typeof ctx.drawGlyphs === 'function') {
        ctx.drawGlyphs(Render.PictOp.Over, src, batch);
      } else {
        drawGlyphRuns(app, Render.PictOp.Over, src.id, ctx.picture.id, batch);
      }
      batch = [];
    };
    // Only the lines the context can show. A layout taller than the view it
    // is drawn in — a code block of twenty thousand lines in a scroll pane —
    // built every line's glyphs, sent them, and had the server clip them
    // away, on every paint. A line is skipped when its box, grown by its
    // height and its font's extent again on either side for ink that
    // overhangs the box, is outside the rows the clip lets through: nothing
    // of it could have landed on a pixel.
    const rows = visibleRows(ctx, y);
    for (const line of this.lines) {
      if (rows) {
        const reach = line.height + line.ascent + line.descent;
        if (line.y + line.height + reach < rows.top) continue;
        if (line.y - reach > rows.bottom) continue;
      }
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

  /**
   * How much of each pixel the glyphs cover, one byte a pixel, without
   * drawing them anywhere — for text that is drawn where a 2d context is
   * not: a GL surface's label atlas, a distance field (react-x11#673).
   *
   * The raster is the layout box in whole pixels with `pad` pixels round it
   * (`width` × `height` bytes, row-major), and the layout's origin — the
   * (x, y) of `draw(ctx, x, y)` — is at (pad, pad). Every glyph's outline is
   * placed where the shaped runs put it, unrounded, and the whole layout is
   * filled once, nonzero, so overlapping glyphs cover a pixel once: the
   * outlines' own coverage, unhinted, which is what a raster that will be
   * scaled wants. Nothing is uploaded and nothing is read back.
   *
   * @param {{ pad?: number }} [options]
   * @returns {{ width: number, height: number, data: Uint8Array } | null}
   */
  coverage({ pad = 0 } = {}) {
    const p = pad > 0 ? Math.ceil(pad) : 0;
    const width = Math.ceil(this.width) + p * 2;
    const height = Math.ceil(this.height) + p * 2;
    if (!(width > 0 && height > 0)) return null;
    const polys = [];
    for (const line of this.lines) {
      for (const r of line.runs) {
        const { font, size, glyphs } = r.run;
        let cursor = p + line.x + r.x;
        const baseline = p + line.baseline;
        for (const g of glyphs) {
          const gx = cursor + g.dx;
          const gy = baseline - g.dy;
          cursor += g.ax;
          for (const poly of font.outline(g.id, size)) {
            const placed = new Float64Array(poly.length);
            for (let i = 0; i < poly.length; i += 2) {
              placed[i] = poly[i] + gx;
              placed[i + 1] = poly[i + 1] + gy;
            }
            polys.push(placed);
          }
        }
      }
    }
    const data = new Uint8Array(width * height);
    if (polys.length > 0) rasterizePolys(polys, width, height, 'nonzero', { out: data });
    return { width, height, data };
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
function graphemeSegmenter() {
  if (segmenter === undefined) {
    segmenter =
      typeof Intl !== 'undefined' && Intl.Segmenter
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;
  }
  return segmenter;
}

// A character that never joins the ones beside it into a cluster (UAX#29):
// whatever extends a cluster or joins into one — marks, joiners, spacing
// marks, prepends — sits at U+0300 or above, and the general punctuation
// block has two of them, the zero-width joiner and non-joiner. Checked pair
// by pair against Intl.Segmenter, all 770,884 pairs of these: every one is
// two clusters but a CR before a LF (GB3). The stateful rules — emoji
// sequences, flags, Indic conjuncts — are about characters outside it.
const standsAlone = (c) =>
  c < 0x300 || (c >= 0x2000 && c <= 0x206f && c !== 0x200c && c !== 0x200d);

// So text of nothing else, which is most of what a document cuts — Latin
// letters, accented or not, and the dashes, quotes and ellipses around them
// — needs no segmenter. One costs a microsecond a call, and the width floors
// ask once a word; and the first one made costs 10 ms, loading ICU's break
// rules, which a first frame of any text with a curly quote in it paid.
function standsApart(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (!standsAlone(c) || (c === 13 && text.charCodeAt(i + 1) === 10)) return false;
  }
  return true;
}

function graphemes(text) {
  if (standsApart(text)) return text.split('');
  const segments = graphemeSegmenter();
  if (!segments) return Array.from(text);
  const out = [];
  for (const { segment } of segments.segment(text)) out.push(segment);
  return out;
}

/** The first grapheme cluster of `text`, without segmenting the rest. */
function firstGrapheme(text) {
  const c0 = text.charCodeAt(0);
  if (c0 !== 13 && standsAlone(c0) && (text.length === 1 || standsAlone(text.charCodeAt(1)))) {
    return text.slice(0, 1);
  }
  const segments = graphemeSegmenter();
  if (!segments) return String.fromCodePoint(text.codePointAt(0));
  for (const { segment } of segments.segment(text)) return segment;
  return '';
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
/**
 * A shaped text (`shapeText`) cut at `cuts` — code-unit offsets inside it,
 * ascending — into as many shaped texts, each of its own piece of the text
 * with its runs and their glyphs, or null where a cut falls inside what a
 * glyph was made from: a ligature, or a cluster the font set as one, which
 * no cut can share out. A glyph keeps the advance shaping gave it, so the
 * kerning between the last letter before a cut and the first after it
 * stays with the first piece. A right-to-left run's glyphs are in visual
 * order, and are walked from their end.
 */
/** `splitShaped`, kept per shaped text and cut, since a shaped text is the
 *  memo's and never changes, and a word a paragraph lays out again is cut
 *  the same way. */
const SPLITS = new WeakMap();
function splitShapedOnce(shaped, cuts) {
  const key = cuts.join(',');
  let byCut = SPLITS.get(shaped);
  if (!byCut) {
    byCut = new Map();
    SPLITS.set(shaped, byCut);
  }
  if (byCut.has(key)) return byCut.get(key);
  const pieces = splitShaped(shaped, cuts);
  byCut.set(key, pieces);
  return pieces;
}

function splitShaped(shaped, cuts) {
  const bounds = [0, ...cuts, shaped.text.length];
  const pieces = cuts.concat(shaped.text.length).map((to, i) => ({
    text: shaped.text.slice(bounds[i], to),
    width: 0,
    baseLevel: shaped.baseLevel,
    runs: []
  }));
  for (const run of shaped.runs) {
    const rtl = (run.level & 1) === 1;
    const logical = rtl ? [...run.glyphs].reverse() : run.glyphs;
    let piece = 0;
    while (bounds[piece + 1] <= run.start) piece++;
    let at = run.start;
    let from = at;
    let glyphs = [];
    const close = () => {
      if (at === from && glyphs.length === 0) return;
      const offset = bounds[piece];
      let width = 0;
      for (const g of glyphs) width += g.ax;
      pieces[piece].runs.push({
        ...run,
        glyphs: rtl ? glyphs.reverse() : glyphs,
        width,
        text: shaped.text.slice(from, at),
        start: from - offset,
        end: at - offset
      });
      pieces[piece].width += width;
    };
    for (const g of logical) {
      let units = 0;
      for (const cp of g.codePoints ?? []) units += cp > 0xffff ? 2 : 1;
      if (units > 0 && at >= bounds[piece + 1]) {
        close();
        while (at >= bounds[piece + 1]) piece++;
        from = at;
        glyphs = [];
      }
      if (at + units > bounds[piece + 1]) return null;
      glyphs.push(g);
      at += units;
    }
    if (at !== run.end) return null;
    close();
  }
  return pieces;
}

function sliceLevels(key, start, end) {
  if (key === undefined) return '0';
  if (!key.includes(',')) return key;
  return key.split(',').slice(start, end).join(',');
}

/**
 * The rows of a layout drawn at `y` that the context can show — its clip's
 * box, or the whole surface with no clip — in the layout's own coordinates.
 * Null where that cannot be said, and the whole layout is drawn: a context
 * that is not ntk's, a transform that is more than a translation, or a
 * shadow, which lands where the text is not.
 */
function visibleRows(ctx, y) {
  if (typeof ctx.drawGlyphs !== 'function') return null;
  if (typeof ctx._clipExtents !== 'function') return null;
  const m = ctx._m;
  if (!m || m[0] !== 1 || m[1] !== 0 || m[2] !== 0 || m[3] !== 1) return null;
  if (typeof ctx._shadowed !== 'function' || ctx._shadowed()) return null;
  const height = ctx.height;
  if (!(height > 0)) return null;
  // the clip's extents skip a region clip, so they are never smaller than
  // what the server lets through
  const box = ctx._clipExtents() ?? { y: 0, h: height };
  const top = box.y - (y + m[5]);
  return { top, bottom: top + box.h };
}

/**
 * How many distinct styles one layout shares shaping styles among. Past it a
 * span is shaped with a style of its own, as every span once was, rather
 * than the search growing with the document.
 */
const MAX_SHAPING_STYLES = 16;

/**
 * The style `span` is shaped with: one already made for a span whose every
 * property shaping reads is the same (`===`), or a new one. Its font is the
 * one the span or the layout named (`given`), else the one its family
 * matches, looked up once for all the spans that share it. What shaping
 * reads is what `shapeText`, `fallbackFor` and the memo key read: the face
 * and what picks it, the size, and features, language and spacing.
 */
function shapingStyleOf(known, span, given, fonts) {
  for (let i = 0; i < known.length; i++) {
    const k = known[i];
    if (
      k.given === given &&
      k.family === span.family &&
      k.size === span.size &&
      k.weight === span.weight &&
      k.style === span.style &&
      k.variations === span.variations &&
      k.opticalSize === span.opticalSize &&
      k.opticalSizing === span.opticalSizing &&
      k.features === span.features &&
      k.language === span.language &&
      k.letterSpacing === span.letterSpacing
    ) {
      return k;
    }
  }
  const k = {
    given,
    font: given ?? fonts.match(span.family, span),
    family: span.family,
    size: span.size,
    weight: span.weight,
    style: span.style,
    variations: span.variations,
    opticalSize: span.opticalSize,
    opticalSizing: span.opticalSizing,
    features: span.features,
    language: span.language,
    letterSpacing: span.letterSpacing
  };
  if (known.length < MAX_SHAPING_STYLES) known.push(k);
  return k;
}
