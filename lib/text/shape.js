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
  // Text that nothing can make right-to-left is level 0 throughout, which
  // is what the algorithm would work out a character at a time: every
  // layout asks, and most text is Latin, CJK or digits with no bidi at all.
  if (explicit !== 'rtl' && !MAY_REVERSE.test(text)) {
    return {
      levels: new Uint8Array(text.length),
      paragraphs: text.length ? [{ start: 0, end: text.length - 1, level: 0 }] : []
    };
  }
  return bidi.getEmbeddingLevels(text, explicit);
}

/**
 * What can raise a level in a left-to-right paragraph: a strong
 * right-to-left character (Hebrew, Arabic, Syriac, Thaana, N'Ko and their
 * neighbours, their presentation forms, and the right-to-left blocks of the
 * supplementary planes, found by their high surrogates), an Arabic number,
 * RLM and ALM, and every explicit embedding, override and isolate. Anything
 * else resolves to 0.
 */
const MAY_REVERSE =
  /[\u0590-\u08FF\u200F\u202A-\u202E\u2066-\u2069\uFB1D-\uFDFF\uFE70-\uFEFF]|[\uD802\uD803\uD83A\uD83B]/;

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
 * The ligatures a font applies by default and a reader can do without. CSS
 * turns them off wherever letters are spaced apart, since an `fi` drawn as
 * one glyph cannot be spaced in its middle: the gap would open on one side of
 * the pair and not the other. Required ones — Arabic joining forms, `rlig` —
 * stay on.
 */
const OPTIONAL_LIGATURES = ['liga', 'clig', 'dlig', 'hlig'];

/**
 * The features a letter-spaced run shapes with: the optional ligatures off,
 * underneath whatever the caller asked for — a style that names `liga`
 * itself still gets it. `features` is either form fontkit takes, an array of
 * tags to turn on or an object of tag → on/off.
 */
/**
 * A copy of `features` for fontkit, which **adds to the object it is handed**
 * — `rvrn` and the like, as it plans the shaping. Handed a caller's own
 * object that is a style quietly growing keys, which changes the memo key it
 * is filed under next time, and a frozen one throws.
 */
function ownFeatures(features) {
  if (!features) return features;
  return Array.isArray(features) ? [...features] : { ...features };
}

function spacedFeatures(features) {
  const off = Object.fromEntries(OPTIONAL_LIGATURES.map((tag) => [tag, false]));
  if (!features) return off;
  if (Array.isArray(features)) {
    for (const tag of features) off[tag] = true;
    return off;
  }
  return { ...off, ...features };
}

/**
 * Space a shaped run's glyphs apart by `spacing` px: added to the advance of
 * every glyph that has one, so a combining mark keeps sitting on its base.
 * The gap is on each glyph's right in an rtl run as in an ltr one — where
 * CoreText's kerning attribute and browsers put it — so a line that changes
 * direction keeps one gap between every two neighbours: on the reading side
 * of an rtl run's glyphs it came out twice where the direction changed one
 * way and not at all where it changed back.
 */
function spaceGlyphs(shaped, spacing) {
  let width = 0;
  for (const g of shaped.glyphs) {
    if (g.ax > 0) g.ax += spacing;
    width += g.ax;
  }
  shaped.width = width;
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
 *   language, letterSpacing, direction: 'ltr'|'rtl'|'auto' }
 * @param {ArrayLike<number>} [levels] precomputed embedding levels for `text`
 * @returns {{text, width, baseLevel, runs: Array<{font, size, direction,
 *   level, width, glyphs, text, start, end}>}}
 */
export function shapeText(fonts, text, style, levels) {
  const size = style.size ?? 16;
  const family = style.family ?? 'sans-serif';
  // `size` is what drives the `opsz` axis, so a style that leaves it out
  // hands `match()` the size this actually sets at rather than nothing
  const baseFont =
    style.font ?? fonts.match(family, style.size === undefined ? { ...style, size } : style);

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

  // px added after every glyph, CSS's `letter-spacing`; 0 leaves the run
  // exactly as the font shapes it, ligatures and all
  const spacing = Number.isFinite(style.letterSpacing) ? style.letterSpacing : 0;
  const features = spacing ? spacedFeatures(style.features) : ownFeatures(style.features);

  const runs = [];
  let width = 0;
  for (const item of items) {
    const direction = item.level & 1 ? 'rtl' : 'ltr';
    const sub = text.slice(item.start, item.end);
    const shaped = item.font.shape(sub, size, {
      direction,
      features,
      language: style.language
    });
    if (spacing) spaceGlyphs(shaped, spacing);
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
