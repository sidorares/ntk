// Pluggable system-font lookup — the seam that lets the text stack run in
// environments without fontconfig or a filesystem (browser bundles, hermetic
// tests). A font source answers "which fonts match this pattern, in fallback
// order?" and hands the FontManager something it can open.
//
// FontSource interface (duck-typed):
//
//   matchSorted({ family, weight, style }) -> candidate[]
//     Full match list for a pattern, best first — the fallback chain.
//     `family` may be a CSS-style comma-separated list. Must return at
//     least one candidate or throw. A candidate is openable:
//       { key?, path?, data?, font?, postscriptName? }
//     - `font`: an already-open Font instance (preferred when available)
//     - `data`: font file bytes (Uint8Array/Buffer) for fontkit
//     - `path`: font file path (node only)
//     - `key`: stable cache key (defaults to `${path}#${postscriptName}`)
//
//   covers(candidate, codepoint) -> boolean   [optional]
//     Cheap coverage pre-filter used during per-codepoint fallback, ideally
//     without opening the font. When absent, candidates are opened and
//     checked with `font.hasGlyph()`.
//
// The default source shells out to fc-match (fontconfig) — the behavior ntk
// always had. Swap it per-app (`createClient({ fontSource })`), per-manager
// (`new FontManager({ source })`) or globally (`setDefaultFontSource()`).
import { charsetHas, matchSortedSync } from '../fontconfig.js';
import Font from './font.js';

const WEIGHTS = { normal: 400, bold: 700 };

/** css-ish weight ('bold' | 400 | '600') -> number, default 400 */
export function numericWeight(weight) {
  if (weight === undefined) return 400;
  if (WEIGHTS[weight] !== undefined) return WEIGHTS[weight];
  const n = parseInt(weight, 10);
  return Number.isNaN(n) ? 400 : n;
}

/**
 * Detect a Font's weight/italic from its tables. Fonts are sloppy about
 * italics — check the fsSelection bit, then italicAngle, then the
 * subfamily name (KaTeX's italic faces set nothing but the name).
 */
export function detectStyle(font) {
  const os2 = font.fk['OS/2'];
  return {
    weight: os2 ? os2.usWeightClass : 400,
    italic: !!(
      (os2 && os2.fsSelection.italic) ||
      font.fk.italicAngle ||
      /italic|oblique/i.test(font.fk.subfamilyName || '')
    )
  };
}

/** split a CSS font-family list into normalized lowercase names */
export function parseFamilies(family) {
  return String(family ?? '')
    .split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, '').toLowerCase())
    .filter(Boolean);
}

/**
 * The default source: fontconfig via the fc-match CLI, font files opened
 * from disk. Node-only (needs shell access); see StaticFontSource for a
 * self-contained alternative.
 */
export class FontconfigFontSource {
  matchSorted(pattern) {
    return matchSortedSync(pattern);
  }

  covers(candidate, codepoint) {
    return charsetHas(candidate, codepoint);
  }
}

/**
 * A font source backed entirely by fonts you hand it — no fontconfig, no
 * filesystem. Works anywhere fontkit runs, including browser bundles:
 *
 *   const source = new StaticFontSource();
 *   source.add(bytes, { family: 'DejaVu Sans' });
 *   source.alias('sans-serif', 'DejaVu Sans');
 *   const app = await createClient({ fontSource: source });
 *
 * Matching mirrors fontconfig semantics: every added face is a fallback
 * candidate; faces matching a requested family (in list order) rank first,
 * then closest weight, then style. Coverage checks use the real font
 * tables, so per-codepoint fallback works exactly like the system path.
 */
export class StaticFontSource {
  constructor() {
    this._faces = []; // { font, family, weight, italic, candidate }
    this._aliases = new Map(); // 'sans-serif' -> 'dejavu sans'
    this._n = 0;
  }

  /**
   * Register a font.
   * @param {Uint8Array|Buffer|Font} data font file bytes (or an open Font)
   * @param {object} [opts] { family (alias for matching; defaults to the
   *   font's family name), weight, style, postscriptName (face of a .ttc) }
   * @returns {Font}
   */
  add(data, opts = {}) {
    const font =
      data instanceof Font
        ? data
        : Font.fromData(data, {
            key: `static:${this._n++}:${opts.family || opts.postscriptName || ''}`,
            postscriptName: opts.postscriptName
          });
    const detected = detectStyle(font);
    this._faces.push({
      font,
      family: (opts.family || font.familyName || '').toLowerCase(),
      weight: opts.weight !== undefined ? numericWeight(opts.weight) : detected.weight,
      italic:
        opts.style !== undefined ? String(opts.style).includes('italic') : detected.italic,
      candidate: null
    });
    return font;
  }

  /** map a generic family ('sans-serif', 'monospace', …) to an added family */
  alias(name, family) {
    this._aliases.set(name.toLowerCase(), family.toLowerCase());
  }

  matchSorted(pattern = {}) {
    if (this._faces.length === 0) {
      throw new Error('StaticFontSource: no fonts added');
    }
    const families = parseFamilies(pattern.family).map((f) => this._aliases.get(f) ?? f);
    const weight = numericWeight(pattern.weight);
    const italic = !!(pattern.style && String(pattern.style).includes('italic'));

    const scored = this._faces.map((face) => {
      let rank = families.indexOf(face.family);
      if (rank === -1) rank = families.length; // non-matching faces trail
      return {
        face,
        score:
          rank * 1e6 + (face.italic !== italic ? 1e4 : 0) + Math.abs(face.weight - weight)
      };
    });
    scored.sort((a, b) => a.score - b.score);
    return scored.map(({ face }) => {
      if (!face.candidate) {
        face.candidate = { key: face.font.key, font: face.font };
      }
      return face.candidate;
    });
  }

  covers(candidate, codepoint) {
    return candidate.font.hasGlyph(codepoint);
  }
}

let _default = null;

/** the process-wide default FontSource (fontconfig unless overridden) */
export function defaultFontSource() {
  if (!_default) _default = new FontconfigFontSource();
  return _default;
}

/**
 * Replace the process-wide default FontSource. Affects every FontManager
 * created afterwards without an explicit source — including the ones
 * widgets create internally. The primary hook for browser playgrounds:
 * call it once with a StaticFontSource before creating any app/window.
 */
export function setDefaultFontSource(source) {
  _default = source;
}
