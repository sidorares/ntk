import bidiFactory from 'bidi-js';

const bidi = bidiFactory();

// characters that never force a font switch: whitespace and default-ignorable
// format controls stay with the surrounding font
function neverSwitches(cp) {
  return (
    cp === 0x20 ||
    cp === 0x09 ||
    cp === 0x0a ||
    cp === 0x0d ||
    cp === 0xa0 ||
    (cp >= 0x200b && cp <= 0x200f) || // zw space/nonjoiner/joiner, lrm/rlm
    (cp >= 0x202a && cp <= 0x202e) || // bidi embedding controls
    (cp >= 0x2066 && cp <= 0x2069) || // bidi isolate controls
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    cp === 0xfeff
  );
}

/**
 * UAX#9 embedding levels for a string. `direction` is 'ltr', 'rtl' or 'auto'
 * (first-strong detection). Returns bidi-js's result object.
 */
export function embeddingLevels(text, direction = 'auto') {
  const explicit = direction === 'ltr' || direction === 'rtl' ? direction : null;
  return bidi.getEmbeddingLevels(text, explicit);
}

/**
 * Compact embedding-levels encoding for the shaping memo key: a single
 * number when uniform over [start, end) — the common case — else
 * comma-separated per-char levels.
 */
export function normalizedLevels(levels, start, end) {
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

/**
 * Shape a string through the full pipeline:
 *
 *   1. bidi resolution (UAX#9, bidi-js) — unless precomputed `levels` are
 *      passed in (TextLayout resolves whole paragraphs at once)
 *   2. itemization: split into maximal runs of same bidi level and same font,
 *      switching to a fallback font for codepoints the primary font lacks
 *   3. OpenType shaping per run (fontkit): kerning, ligatures, contextual
 *      forms; RTL runs come back in visual glyph order
 *
 * Runs are returned in **logical order**, each tagged with its bidi `level`;
 * use `reorderRuns()` to get visual order for drawing.
 *
 * @param {FontManager} fonts
 * @param {string} text
 * @param {object} style { font | family/weight/style, size, features,
 *   language, direction: 'ltr'|'rtl'|'auto' }
 * @param {ArrayLike<number>} [levels] precomputed embedding levels for `text`
 * @returns {{text, width, baseLevel, runs: Array<{font, size, direction,
 *   level, width, glyphs, text, start, end}>}}
 */
export function shapeText(fonts, text, style, levels) {
  const size = style.size ?? 16;
  const family = style.family ?? 'sans-serif';
  const baseFont = style.font ?? fonts.match(family, style);

  let baseLevel = 0;
  if (!levels) {
    const emb = embeddingLevels(text, style.direction);
    levels = emb.levels;
    baseLevel = emb.paragraphs.length ? emb.paragraphs[0].level : 0;
  } else {
    baseLevel = levels.length ? levels[0] & ~1 : 0;
  }

  // itemize: walk codepoints, splitting where bidi level or font changes
  const items = []; // { font, level, start, end }
  let cur = null;
  let curFont = baseFont;
  let i = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const level = levels[i] ?? baseLevel;
    let font = curFont;
    if (!neverSwitches(cp)) {
      // the primary font always wins when it covers the char, so fallback
      // runs stay as short as possible
      if (baseFont.hasGlyph(cp)) font = baseFont;
      else if (!font.hasGlyph(cp)) font = fonts.fallbackFor(cp, family, style) ?? baseFont;
    }
    if (cur && cur.font === font && cur.level === level) {
      cur.end = i + ch.length;
    } else {
      cur = { font, level, start: i, end: i + ch.length };
      items.push(cur);
    }
    curFont = font;
    i += ch.length;
  }

  const runs = [];
  let width = 0;
  for (const item of items) {
    const direction = item.level & 1 ? 'rtl' : 'ltr';
    const sub = text.slice(item.start, item.end);
    const shaped = item.font.shape(sub, size, {
      direction,
      features: style.features,
      language: style.language
    });
    shaped.level = item.level;
    shaped.text = sub;
    shaped.start = item.start;
    shaped.end = item.end;
    width += shaped.width;
    runs.push(shaped);
  }

  return { text, width, baseLevel, runs };
}

/**
 * Reorder logical runs into visual (left-to-right drawing) order —
 * UAX#9 rule L2 applied at run granularity.
 */
export function reorderRuns(runs) {
  if (runs.length < 2) return runs.slice();
  let max = 0;
  let minOdd = Infinity;
  for (const r of runs) {
    if (r.level > max) max = r.level;
    if (r.level & 1 && r.level < minOdd) minOdd = r.level;
  }
  const out = runs.slice();
  for (let level = max; level >= minOdd; level--) {
    let start = -1;
    for (let j = 0; j <= out.length; j++) {
      if (j < out.length && out[j].level >= level) {
        if (start === -1) start = j;
      } else if (start !== -1) {
        for (let a = start, b = j - 1; a < b; a++, b--) {
          const tmp = out[a];
          out[a] = out[b];
          out[b] = tmp;
        }
        start = -1;
      }
    }
  }
  return out;
}
