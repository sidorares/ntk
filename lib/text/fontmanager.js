import { charsetHas, matchSortedSync } from '../fontconfig.js';
import Font from './font.js';
import { shapeText } from './shape.js';
import { TextLayout } from './layout.js';

const WEIGHTS = { normal: 400, bold: 700 };

function numWeight(weight) {
  if (weight === undefined) return 400;
  return WEIGHTS[weight] ?? parseInt(weight, 10) ?? 400;
}

/**
 * Font lookup, loading and caching — the entry point of the text API,
 * available as `app.fonts` (and constructible standalone for headless
 * measurement/layout: `new FontManager()`).
 *
 * - `match(family, {weight, style})` resolves CSS-ish patterns via
 *   fontconfig (fc-match), including comma-separated family lists.
 * - `load(path)` registers a font file (custom/bundled fonts); registered
 *   families take priority over system lookup.
 * - Per-codepoint font fallback uses fontconfig's coverage data, so text a
 *   font can't display automatically borrows glyphs from the best system
 *   font that can.
 * - `shape()` and `layout()` are the shaping/layout front doors; see
 *   docs/text.md.
 */
export default class FontManager {
  constructor() {
    this._fonts = new Map(); // path#postscriptName -> Font
    this._matches = new Map(); // family|weight|style -> Font
    this._fallbacks = new Map(); // family|weight|style -> Map(codepoint -> Font|null)
    this._registered = []; // { font, family (lowercase), weight, italic }
    this._shapeCache = new Map(); // word-level shaping memo (bounded)
  }

  _open(path, postscriptName) {
    const key = `${path}#${postscriptName || ''}`;
    let font = this._fonts.get(key);
    if (!font) {
      font = Font.loadSync(path, postscriptName);
      this._fonts.set(key, font);
    }
    return font;
  }

  /**
   * Load and register a font file. Registered fonts win over system fonts in
   * `match()` and fallback, keyed by their family name (or an alias).
   *
   * @param {string} path .ttf/.otf/.woff/.ttc file
   * @param {object} [opts] { postscriptName (face of a .ttc), family (alias),
   *   weight, style } — weight/style override the values detected from the file
   * @returns {Font}
   */
  load(path, opts = {}) {
    const font = this._open(path, opts.postscriptName);
    const os2 = font.fk['OS/2'];
    this._registered.push({
      font,
      family: (opts.family || font.familyName || '').toLowerCase(),
      weight: opts.weight !== undefined ? numWeight(opts.weight) : (os2 ? os2.usWeightClass : 400),
      italic: opts.style !== undefined ? opts.style.includes('italic') : !!(os2 && os2.fsSelection.italic)
    });
    this._matches.clear();
    this._fallbacks.clear();
    return font;
  }

  _matchRegistered(families, weight, italic) {
    let best = null;
    let bestScore = Infinity;
    for (const family of families) {
      for (const r of this._registered) {
        if (r.family !== family) continue;
        const score = Math.abs(r.weight - weight) + (r.italic !== italic ? 1000 : 0);
        if (score < bestScore) {
          bestScore = score;
          best = r.font;
        }
      }
      if (best) return best; // earlier families in the list win
    }
    return null;
  }

  /**
   * Resolve a family (or CSS-style comma-separated family list) to a Font.
   * Registered fonts are consulted first, then fontconfig.
   *
   * @param {string} family e.g. `'Ubuntu Mono', monospace`
   * @param {object} [opts] { weight: 400|'bold'|…, style: 'normal'|'italic' }
   */
  match(family = 'sans-serif', opts = {}) {
    const weight = numWeight(opts.weight);
    const italic = !!(opts.style && opts.style.includes('italic'));
    const cacheKey = `${family}|${weight}|${italic}`;
    let font = this._matches.get(cacheKey);
    if (font) return font;

    const families = String(family)
      .split(',')
      .map((f) => f.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);

    font = this._matchRegistered(
      families.map((f) => f.toLowerCase()),
      weight,
      italic
    );
    if (!font) {
      // fontconfig understands comma-separated family lists natively
      const { path, postscriptName } = matchSortedSync({
        family: families.join(','),
        weight,
        style: italic ? 'italic' : 'normal'
      })[0];
      font = this._open(path, postscriptName);
    }
    this._matches.set(cacheKey, font);
    return font;
  }

  /**
   * Find a font that has a glyph for `codepoint`, for use when the primary
   * font doesn't. Registered fonts first, then the fontconfig fallback chain
   * (filtered by fontconfig's coverage data — font files are only opened to
   * confirm). Returns null when nothing on the system covers the codepoint.
   */
  fallbackFor(codepoint, family = 'sans-serif', opts = {}) {
    const cacheKey = `${family}|${numWeight(opts.weight)}|${opts.style || ''}`;
    let perCp = this._fallbacks.get(cacheKey);
    if (!perCp) {
      perCp = new Map();
      this._fallbacks.set(cacheKey, perCp);
    }
    if (perCp.has(codepoint)) return perCp.get(codepoint);

    let found = null;
    for (const r of this._registered) {
      if (r.font.hasGlyph(codepoint)) {
        found = r.font;
        break;
      }
    }
    if (!found) {
      const candidates = matchSortedSync({ family, weight: opts.weight, style: opts.style });
      for (const c of candidates) {
        if (!charsetHas(c, codepoint)) continue;
        try {
          const font = this._open(c.path, c.postscriptName);
          if (font.hasGlyph(codepoint)) {
            found = font;
            break;
          }
        } catch {
          // unparseable candidate — try the next one
        }
      }
    }
    perCp.set(codepoint, found);
    return found;
  }

  /**
   * Shape text through the full pipeline (bidi → font fallback → OpenType
   * shaping). See shape.js for the run format.
   *
   * @param {string} text
   * @param {object} style { font | family/weight/style, size, features,
   *   language, direction }
   */
  shape(text, style) {
    return shapeText(this, text, style);
  }

  /**
   * Lay text out into lines for a target container width.
   *
   * @param {string|Array} content plain string or spans
   *   [{ text, ...style overrides, color }]
   * @param {object} style base style ({ family, size, weight, … })
   * @param {object} options { maxWidth, align, lineHeight, direction }
   * @returns {TextLayout}
   */
  layout(content, style, options) {
    return new TextLayout(this, content, style, options);
  }

  /**
   * Memoized shaping used by TextLayout (bounded cache). `levelsKey` is a
   * compact embedding-levels encoding: a single number when uniform for the
   * whole fragment (the common case), else comma-separated per-char levels.
   */
  _shapeCached(text, style, levelsKey = '0') {
    const font = style.font;
    const key = `${font ? font.key : style.family}|${style.size}|${style.weight}|${style.style}|${levelsKey}|${text}`;
    let shaped = this._shapeCache.get(key);
    if (!shaped) {
      let levels;
      if (levelsKey.includes(',')) {
        levels = levelsKey.split(',').map(Number);
      } else {
        levels = new Uint8Array(text.length).fill(Number(levelsKey));
      }
      shaped = shapeText(this, text, style, levels);
      if (this._shapeCache.size > 4000) this._shapeCache.clear();
      this._shapeCache.set(key, shaped);
    }
    return shaped;
  }
}
