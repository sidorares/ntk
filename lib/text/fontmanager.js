import Font from './font.js';
import {
  createFontSource,
  defaultFontSource,
  detectStyle,
  numericWeight as numWeight
} from './fontsource.js';
import { embeddingLevels, normalizedLevels, shapeText } from './shape.js';
import { TextLayout } from './layout.js';

// Bound on the resolved-match map. See the sweep in `match()`.
const MAX_MATCHES = 512;

/** Cache-key fragment for a style's `variations`, before any font is known. */
function variationsKeyOf(variations) {
  if (!variations) return '';
  return Object.keys(variations)
    .sort()
    .map((tag) => `${tag}=${variations[tag]}`)
    .join(',');
}

/**
 * The optical size a style is set at, or `undefined` for "leave `opsz`
 * alone" — see `instantiate()`.
 *
 * `opsz` is the one axis whose coordinate is not a design choice but a
 * consequence of the size, so it defaults from `size` and needs an escape
 * hatch for each way that default can be wrong:
 *
 * - `opticalSizing: 'none'` is CSS's `font-optical-sizing: none` — the face
 *   stays at its own default optical size;
 * - `opticalSize` is the typographic size to use when it is not `size`.
 *   `size` on this path is CSS px, and a caller that has already multiplied
 *   by a device scale is holding device pixels: a 13px label on a 2×
 *   display arrives here as 26 and would pick a display cut. Such a caller
 *   passes the unscaled size as `opticalSize` and keeps the scaled one for
 *   the glyphs.
 */
function opticalSizeFor(style) {
  if (!style || style.opticalSizing === 'none') return undefined;
  const size = style.opticalSize ?? style.size;
  return typeof size === 'number' && Number.isFinite(size) ? size : undefined;
}

/** Cache-key fragment for the optical size, `''` when the axis is left alone. */
function opticalKeyOf(style) {
  return opticalSizeFor(style) ?? '';
}

/**
 * Put a resolved face at the point in its design space the style asked for.
 *
 * Two axes get a coordinate from a style that never names them, because CSS
 * says both are consequences of properties the style does name:
 *
 * - `weight`. `font-weight: 460` on a variable font means the `wght` axis at
 *   460, not "the nearest face", so an app that hands ntk a variable file
 *   gets the weight it asked for without knowing an axis exists.
 * - `size`. `font-optical-sizing: auto` has been the initial value since
 *   optical sizing was specified: `opsz` tracks `font-size` unless the
 *   author says otherwise. Without this a face is drawn at whatever optical
 *   size its file happens to default to — on macOS the only San Francisco
 *   fontconfig can see is a variable file defaulting to `opsz` 28, a
 *   *display* cut, so every 13px menu label was set in display-sized
 *   letterforms. Clamping does the rest: 13 against SF's `17..96` lands on
 *   17, which is exactly Apple's Text end.
 *
 * An explicit `variations.wght` / `variations.opsz` wins in both cases,
 * because a caller naming the axis directly is being more specific than one
 * naming a weight or a size — the same order CSS gives
 * `font-variation-settings` over the properties it overlaps.
 *
 * Everything here is a no-op for a static face: `variation()` returns the
 * font unchanged when the settings do not apply, so this costs one property
 * read on the path every non-variable app is already on.
 */
function instantiate(font, weight, variations, opticalSize) {
  const axes = font.variationAxes;
  if (!axes || (!axes.wght && !axes.opsz && !variations)) return font;
  const settings = { ...variations };
  if (axes.wght && settings.wght === undefined) settings.wght = weight;
  if (axes.opsz && settings.opsz === undefined && opticalSize !== undefined) {
    settings.opsz = opticalSize;
  }
  return font.variation(settings);
}

/**
 * Font lookup, loading and caching — the entry point of the text API,
 * available as `app.fonts` (and constructible standalone for headless
 * measurement/layout: `new FontManager()`).
 *
 * - `match(family, {weight, style})` resolves CSS-ish patterns via the
 *   manager's FontSource (fontconfig/fc-match by default), including
 *   comma-separated family lists.
 * - `load(path)` registers a font file (custom/bundled fonts); registered
 *   families take priority over system lookup.
 * - Per-codepoint font fallback uses the source's coverage data, so text a
 *   font can't display automatically borrows glyphs from the best system
 *   font that can.
 * - `shape()` and `layout()` are the shaping/layout front doors; see
 *   docs/text.md.
 *
 * All system lookup goes through a pluggable FontSource (see
 * text/fontsource.js) — pass `{ source }` to use something other than
 * fontconfig, e.g. a StaticFontSource in a browser bundle. `source` also
 * takes a font spec: a path, a directory of faces, or font bytes.
 */
export default class FontManager {
  constructor({ source } = {}) {
    // coerced here rather than in the getter, which is on the match path;
    // null stays null so the process-wide default can still be set late
    this._source = createFontSource(source) ?? null;
    this._fonts = new Map(); // candidate key -> Font
    this._matches = new Map(); // family|weight|style -> Font
    this._fallbacks = new Map(); // family|weight|style -> Map(codepoint -> Font|null)
    this._registered = []; // { font, family (lowercase), weight, italic }
    this._shapeCache = new Map(); // word-level shaping memo (bounded, LRU)
  }

  /** the FontSource in effect (explicit, else the process-wide default) */
  get source() {
    return this._source ?? defaultFontSource();
  }

  /** open (and cache) a match candidate — see fontsource.js for the shape */
  _open(candidate) {
    const key = candidate.key ?? `${candidate.path}#${candidate.postscriptName || ''}`;
    let font = this._fonts.get(key);
    if (!font) {
      if (candidate.font) {
        font = candidate.font;
      } else if (candidate.data) {
        font = Font.fromData(candidate.data, { key, postscriptName: candidate.postscriptName });
      } else {
        font = Font.loadSync(candidate.path, candidate.postscriptName);
      }
      this._fonts.set(key, font);
    }
    return font;
  }

  /**
   * Load and register a font. Registered fonts win over system fonts in
   * `match()` and fallback, keyed by their family name (or an alias).
   *
   * @param {string|Uint8Array|Buffer} source path to a .ttf/.otf/.woff/.ttc
   *   file, or the font file's bytes (environments without a filesystem)
   * @param {object} [opts] { postscriptName (face of a .ttc), family (alias),
   *   weight, style } — weight/style override the values detected from the file
   * @returns {Font}
   */
  load(source, opts = {}) {
    const candidate =
      typeof source === 'string'
        ? { path: source, postscriptName: opts.postscriptName }
        : {
            data: source,
            postscriptName: opts.postscriptName,
            key: `loaded:${this._fonts.size}:${opts.family || opts.postscriptName || ''}`
          };
    const font = this._open(candidate);
    const detected = detectStyle(font);
    this._registered.push({
      font,
      family: (opts.family || font.familyName || '').toLowerCase(),
      weight: opts.weight !== undefined ? numWeight(opts.weight) : detected.weight,
      italic: opts.style !== undefined ? opts.style.includes('italic') : detected.italic
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
   * What is cached here is the *face* the pattern resolved to — the
   * expensive half, since it is an fc-match and a file parse — and not the
   * instance `instantiate()` cuts out of it. Two things follow. The map
   * stays one entry per family/weight/style however many points of an axis
   * an app asks for, so a slider animating `wght`, or a tree of labels at a
   * dozen sizes, walks a face's own bounded instance cache rather than
   * evicting other families out of this one. And `size` can drive `opsz`
   * without joining the key: the coordinate is applied per call, so the
   * first size asked for does not become every later one's.
   *
   * @param {string} family e.g. `'Ubuntu Mono', monospace`
   * @param {object} [opts] { weight: 400|'bold'|…, style: 'normal'|'italic',
   *   size, variations, opticalSize, opticalSizing: 'auto'|'none' }
   */
  match(family = 'sans-serif', opts = {}) {
    const weight = numWeight(opts.weight);
    const italic = !!(opts.style && opts.style.includes('italic'));
    const cacheKey = `${family}|${weight}|${italic}`;
    let face = this._matches.get(cacheKey);
    if (face) {
      // insertion order is LRU order; re-inserting a hit moves it to the tail
      this._matches.delete(cacheKey);
      this._matches.set(cacheKey, face);
      return instantiate(face, weight, opts.variations, opticalSizeFor(opts));
    }

    const families = String(family)
      .split(',')
      .map((f) => f.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);

    face = this._matchRegistered(
      families.map((f) => f.toLowerCase()),
      weight,
      italic
    );
    if (!face) {
      // sources understand comma-separated family lists natively
      const candidates = this.source.matchSorted({
        family: families.join(','),
        weight,
        style: italic ? 'italic' : 'normal'
      });
      face = this._open(candidates[0]);
    }
    this._matches.set(cacheKey, face);
    // A long-lived app can name a lot of families. Same sweep as the shaping
    // memo: drop the stale half in one pass rather than one entry per insert.
    if (this._matches.size > MAX_MATCHES) {
      let drop = this._matches.size >> 1;
      for (const key of this._matches.keys()) {
        if (drop-- <= 0) break;
        this._matches.delete(key);
      }
    }
    return instantiate(face, weight, opts.variations, opticalSizeFor(opts));
  }

  /**
   * Find a font that has a glyph for `codepoint`, for use when the primary
   * font doesn't. Registered fonts first, then the source's fallback chain
   * (filtered by the source's coverage data — font files are only opened to
   * confirm). Returns null when nothing on the system covers the codepoint.
   *
   * "Nothing covers it" includes "this environment has no system fonts at
   * all". An app that loaded its own faces still reaches here for the first
   * character they lack — a bullet, a curly quote — and before this returned
   * null there, a fontconfig-less box crashed mid-shape on that character,
   * arbitrarily far from anything about fonts. `shapeText` renders .notdef
   * for a null, which is the right answer to "no font has this glyph".
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
      const source = this.source;
      let candidates;
      try {
        candidates = source.matchSorted({ family, weight: opts.weight, style: opts.style });
      } catch (err) {
        // no system fonts to fall back to is an answer, not a crash; a source
        // that failed for any other reason is a real bug and still propagates
        if (err.code !== 'ERR_NTK_NO_FONTS') throw err;
        candidates = [];
      }
      for (const c of candidates) {
        if (source.covers && !source.covers(c, codepoint)) continue;
        try {
          const font = this._open(c);
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
   * Memoized shaping used by TextLayout and the canvas text path (bounded
   * LRU). `levelsKey` is a compact embedding-levels encoding: a single
   * number when uniform for the whole fragment (the common case), else
   * comma-separated per-char levels.
   */
  _shapeCached(text, style, levelsKey = '0') {
    const font = style.font;
    // A resolved `font` already carries its coordinates in its key, so the
    // variations and optical-size fragments only earn their keep on the
    // family path — where two points of one axis would otherwise share a
    // shaped run, and the second would be drawn with the first's advances.
    const key = font
      ? `${font.key}|${style.size}|${style.weight}|${style.style}|${levelsKey}|${text}`
      : `${style.family}|${style.size}|${style.weight}|${style.style}|${variationsKeyOf(
          style.variations
        )}|${opticalKeyOf(style)}|${levelsKey}|${text}`;
    let shaped = this._shapeCache.get(key);
    if (shaped) {
      // Map iterates in insertion order: re-inserting a hit moves it to the
      // tail, so the eviction sweep below walks least-recently-used first
      this._shapeCache.delete(key);
      this._shapeCache.set(key, shaped);
      return shaped;
    }
    let levels;
    if (levelsKey.includes(',')) {
      levels = levelsKey.split(',').map(Number);
    } else {
      levels = new Uint8Array(text.length).fill(Number(levelsKey));
    }
    shaped = shapeText(this, text, style, levels);
    if (this._shapeCache.size > 4000) {
      // drop the stale half in one sweep rather than one entry per insert —
      // a live UI's working set sits at the recent end and survives, where
      // the old wholesale clear() re-shaped everything on screen
      let drop = this._shapeCache.size >> 1;
      for (const k of this._shapeCache.keys()) {
        if (drop-- <= 0) break;
        this._shapeCache.delete(k);
      }
    }
    this._shapeCache.set(key, shaped);
    return shaped;
  }

  /**
   * Memoized whole-string shaping — what `ctx.fillText` draws through, so
   * repainting the same label hits the same entries TextLayout populates
   * instead of re-running bidi + OpenType shaping every frame.
   *
   * Bidi is resolved here because the memo key needs the embedding levels;
   * the paragraph level rides back on the result separately, since per-char
   * levels cannot recover it (RTL text in an RTL paragraph carries level 1,
   * which reads as an even base) and start/end alignment depends on it.
   *
   * `features` and `language` change shaped output but are not part of the
   * memo key (styles reaching it via TextLayout never carry them into the
   * key either), so a style with either shapes uncached rather than
   * poisoning entries other callers share.
   */
  _shapeCachedWhole(text, style) {
    if (style.features || style.language) return shapeText(this, text, style);
    const emb = embeddingLevels(text, style.direction);
    const baseLevel = emb.paragraphs.length ? emb.paragraphs[0].level : 0;
    const shaped = this._shapeCached(text, style, normalizedLevels(emb.levels, 0, text.length));
    return shaped.baseLevel === baseLevel ? shaped : { ...shaped, baseLevel };
  }
}
