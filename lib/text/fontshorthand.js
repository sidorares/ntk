// The CSS `font` shorthand, as `ctx.font` takes it:
//
//   [ <style> || <variant> || <weight> || <stretch> ]? <size> [ / <line-height> ]? <family>#
//
// canvas-fontstyle read this before, with a regular expression from an old
// node-canvas that allowed no space at all after a weight — so `2000px` was
// weight 200 at size 0, and every size from 1000 up that begins with a weight
// set no text — required the weight before the style, took no line height,
// and cached every string it was handed as a property on an LRU object it
// never evicted from, which grew without bound under an animated size.

// What 1em is. Canvas resolves a relative size against the canvas element's
// font; a context here has no element, so it is the size of the font a
// context starts with (DEFAULT_FONT in renderingcontext_2d.js).
const EM = 20;

const ABSOLUTE_SIZES = {
  'xx-small': 9,
  'x-small': 10,
  small: 13,
  medium: 16,
  large: 18,
  'x-large': 24,
  'xx-large': 32,
  'xxx-large': 48
};

const UNITS = {
  px: 1,
  pt: 4 / 3,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  em: EM,
  rem: EM,
  '%': EM / 100
};

const STYLES = new Set(['italic', 'oblique']);
const WEIGHTS = new Set(['bold', 'bolder', 'lighter']);
const STRETCHES = new Set([
  'ultra-condensed',
  'extra-condensed',
  'condensed',
  'semi-condensed',
  'semi-expanded',
  'expanded',
  'extra-expanded',
  'ultra-expanded'
]);

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const LENGTH = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]+|%)$/i;
const ANGLE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:deg|grad|rad|turn)$/i;

/** A font size in pixels, or null when `token` is not one. */
function sizeOf(token) {
  const word = token.toLowerCase();
  if (Object.hasOwn(ABSOLUTE_SIZES, word)) return ABSOLUTE_SIZES[word];
  if (word === 'larger') return EM * 1.2;
  if (word === 'smaller') return EM / 1.2;
  const m = LENGTH.exec(word);
  if (!m || !Object.hasOwn(UNITS, m[2])) return null;
  const px = Number(m[1]) * UNITS[m[2]];
  return px >= 0 && px < Infinity ? px : null;
}

/** A line height; only its shape matters, since a canvas ignores it. */
const isLineHeight = (text) =>
  text.toLowerCase() === 'normal' || NUMBER.test(text) || (LENGTH.test(text) && sizeOf(text) !== null);

/**
 * The family list, first family first: quoted names as written, unquoted ones
 * as the identifiers they are with the white space between them collapsed.
 * Null when it is not a list of families.
 */
function familiesOf(text) {
  const families = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    let name;
    if (text[i] === '"' || text[i] === "'") {
      const quote = text[i];
      const end = text.indexOf(quote, i + 1);
      if (end === -1) return null;
      name = text.slice(i + 1, end);
      i = end + 1;
      while (i < text.length && /\s/.test(text[i])) i++;
    } else {
      const end = text.indexOf(',', i);
      const raw = (end === -1 ? text.slice(i) : text.slice(i, end)).trim();
      // a run of identifiers: `Times New Roman`, not `12px` or `"x`
      if (!/^-?[a-z_\u00a0-\uffff][\w\u00a0-\uffff-]*(?:\s+-?[a-z_\u00a0-\uffff][\w\u00a0-\uffff-]*)*$/i.test(raw)) {
        return null;
      }
      name = raw.replace(/\s+/g, ' ');
      i = end === -1 ? text.length : end;
    }
    if (!name) return null;
    families.push(name);
    if (i < text.length) {
      if (text[i] !== ',') return null;
      i++;
    }
  }
  return families.length ? families : null;
}

/**
 * Parse a CSS `font` shorthand into `{ weight, style, size, unit, family,
 * families }`, the size in pixels, or undefined when it is not one — which
 * `ctx.font` ignores, keeping the font it had, as canvas says.
 *
 * `weight` and `style` are the words written (`'normal'`, `'bold'`, `'600'`,
 * `'oblique 10deg'`), `family` the first family and `families` all of them.
 */
export function parseFont(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;

  let weight;
  let style;
  let variant;
  let stretch;
  let normals = 0;
  let i = 0;
  let size = null;
  // the keywords before the size, each at most once, in any order; `normal`
  // is whichever of them is left unset, so it only counts against the four
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    let end = i;
    while (end < text.length && !/[\s/,"']/.test(text[end])) end++;
    const token = text.slice(i, end);
    if (!token) return undefined;
    const word = token.toLowerCase();
    if (STYLES.has(word) && style === undefined) {
      style = word;
      // `oblique` may carry its angle
      if (word === 'oblique') {
        let j = end;
        while (j < text.length && /\s/.test(text[j])) j++;
        let k = j;
        while (k < text.length && !/[\s/,]/.test(text[k])) k++;
        if (ANGLE.test(text.slice(j, k))) {
          style = `oblique ${text.slice(j, k).toLowerCase()}`;
          end = k;
        }
      }
    } else if (WEIGHTS.has(word) && weight === undefined) {
      weight = word;
    } else if (NUMBER.test(word) && weight === undefined && Number(word) >= 1 && Number(word) <= 1000) {
      weight = word;
    } else if (word === 'small-caps' && variant === undefined) {
      variant = word;
    } else if (STRETCHES.has(word) && stretch === undefined) {
      stretch = word;
    } else if (word === 'normal') {
      normals++;
    } else {
      size = sizeOf(token);
      if (size === null) return undefined;
      i = end;
      break;
    }
    const named = [style, weight, variant, stretch].filter((v) => v !== undefined).length;
    if (named + normals > 4) return undefined;
    i = end;
  }

  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] === '/') {
    i++;
    while (i < text.length && /\s/.test(text[i])) i++;
    let end = i;
    while (end < text.length && !/[\s,"']/.test(text[end])) end++;
    if (!isLineHeight(text.slice(i, end))) return undefined;
    i = end;
  }

  const families = familiesOf(text.slice(i));
  if (!families) return undefined;
  return {
    weight: weight ?? 'normal',
    style: style ?? 'normal',
    size,
    unit: 'px',
    family: families[0],
    families
  };
}

// Each spelling is parsed once: a context sets its font on every draw, and
// the same few strings come round again. Bounded, and dropped whole rather
// than evicted — the old cache held every string it was ever handed.
const parsed = new Map();
const PARSED_MAX = 256;

/** `parseFont`, remembered per spelling. */
export function parseFontCached(value) {
  if (typeof value !== 'string') return undefined;
  let font = parsed.get(value);
  if (font === undefined && !parsed.has(value)) {
    font = parseFont(value);
    if (parsed.size >= PARSED_MAX) parsed.clear();
    parsed.set(value, font);
  }
  return font;
}
