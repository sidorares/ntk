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
//       { key?, path?, data?, font?, postscriptName?, family?, families? }
//     - `font`: an already-open Font instance (preferred when available)
//     - `data`: font file bytes (Uint8Array/Buffer) for fontkit
//     - `path`: font file path (node only)
//     - `key`: stable cache key (defaults to `${path}#${postscriptName}`)
//     - `family`: the face's family name, for showing a match list without
//       opening every file in it; `families` its aliases, first one first
//       (both optional, but both sources here fill them in)
//
//   matchSortedAsync({ family, weight, style }) -> Promise<candidate[]>
//     The same answer, awaited. Text layout is synchronous and always calls
//     matchSorted; this is for an app asking a source directly — a font
//     picker matching as the user types — where the fontconfig source's
//     ~100ms spawn has no business blocking the event loop. A source with
//     nothing to await implements it by resolving immediately, so a caller
//     can be written once against either.
//
//   covers(candidate, codepoint) -> boolean   [optional]
//     Cheap coverage pre-filter used during per-codepoint fallback, ideally
//     without opening the font. When absent, candidates are opened and
//     checked with `font.hasGlyph()`.
//
// The default source shells out to fc-match (fontconfig) — the behavior ntk
// always had. Swap it per-app (`createClient({ fontSource })`), per-manager
// (`new FontManager({ source })`) or globally (`setDefaultFontSource()`).
//
// All three of those also accept a **font spec** — a path, a directory, font
// bytes, or a list of them — which `createFontSource` turns into a
// StaticFontSource. That is the whole answer for an environment with no
// fontconfig: ntk ships no fonts, so the app has to hand over the ones it
// ships, and the spec is the short way to say so.
//
// node:fs is fetched lazily through builtin() inside the path branch, never a
// direct static import, because this file is the one the browser bundle keeps
// — its whole purpose is running the text stack without a filesystem. See
// builtin.js for how the lazy lookup stays version-tolerant.
import { builtin } from '../builtin.js';
import {
  charsetHas,
  matchSorted,
  matchSortedSync,
  noFontsError,
  prewarm,
  supported
} from '../fontconfig.js';
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

// A font is monospaced if it says so, or if it draws a period as wide as a W.
// The probe is the part that carries its weight — `post.isFixedPitch` is 0 on
// plenty of genuinely fixed-pitch faces.
const PROBE = ['i', 'M', 'W', '.'].map((c) => c.codePointAt(0));

function isMonospaced(font) {
  if (font.fk.post?.isFixedPitch) return true;
  let width = null;
  for (const cp of PROBE) {
    if (!font.hasGlyph(cp)) return false;
    const advance = font.fk.glyphForCodePoint(cp).advanceWidth;
    if (width === null) width = advance;
    else if (advance !== width) return false;
  }
  return width !== null && width > 0;
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
  constructor() {
    // Construction is the moment fontconfig is chosen as the lookup path, so
    // the fc-match spawn for the pattern every widget default resolves to —
    // sans-serif at regular weight, exactly as FontManager.match normalizes
    // it — starts here, asynchronously, instead of stalling the first text
    // layout for ~50ms. Fire-and-forget: prewarm never rejects, and a source
    // constructed where fc-match is missing stays silent until (unless) text
    // is actually rendered.
    prewarm({ family: 'sans-serif', weight: 400, style: 'normal' });
  }

  matchSorted(pattern) {
    return matchSortedSync(pattern);
  }

  /**
   * Non-blocking sibling: the fc-match spawn runs off the event loop and
   * seeds the same cache, so a later synchronous layout for the pattern is
   * a cache hit. Rejects with the same ERR_NTK_NO_FONTS the sync path
   * throws — the failure case must not be the one that blocks.
   */
  matchSortedAsync(pattern) {
    return matchSorted(pattern);
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
    /** files a font spec could not parse: [{ file, error }] */
    this.skipped = [];
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

  /** what the generic families currently resolve to, for inspection */
  get aliases() {
    return Object.fromEntries(this._aliases);
  }

  /**
   * Point `sans-serif`, `serif` and `monospace` at added faces.
   *
   * This is not cosmetic. Every widget default in the toolkit is
   * `sans-serif`, and `code`/`pre` ask for `monospace`; with no alias for
   * them `matchSorted` ranks every face equally and breaks the tie on weight
   * distance and then insertion order, so `monospace` silently renders in a
   * proportional face. Inference happens automatically for a source built
   * from a font spec; a hand-built source calls this when it wants it.
   *
   * A generic is only aliased on positive evidence, and a generic with none
   * is deliberately left out — its absence from `aliases` is the signal to
   * pass an explicit one. Monospace is decided structurally, because fonts
   * lie about it: KaTeX_Typewriter reports `isFixedPitch = 0` while every
   * advance is 525. Sans/serif read the font's own family name, the
   * convention DejaVu, Noto, Liberation, Source and IBM Plex all follow —
   * never the filename, which loses on `Inter_18pt-SemiBold.ttf`.
   *
   * Explicit aliases are never overridden.
   */
  inferGenerics() {
    const mono = [];
    const rest = [];
    for (const face of this._faces) (isMonospaced(face.font) ? mono : rest).push(face);

    // "sans" is checked first and its matches are then excluded, because
    // "SansSerif" and "Sans Serif" contain "serif" — without that, the one
    // family named for both wins the generic it is least suited to
    const sans = rest.filter((f) => /sans/i.test(f.font.familyName || ''));
    const serif = rest.filter((f) => !sans.includes(f) && /serif/i.test(f.font.familyName || ''));
    const evidence = {
      monospace: mono[0]?.family,
      'sans-serif': sans[0]?.family,
      serif: serif[0]?.family
    };
    for (const [generic, family] of Object.entries(evidence)) {
      if (family && !this._aliases.has(generic)) this._aliases.set(generic, family);
    }
    return this;
  }

  matchSorted(pattern = {}) {
    if (this._faces.length === 0) {
      throw noFontsError('this font source has no fonts added');
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
        // the font's own family name, not the (lowercased, possibly aliased)
        // one it is matched by — this field is the one to show a reader
        const name = face.font.familyName || '';
        face.candidate = {
          key: face.font.key,
          font: face.font,
          family: name,
          families: name ? [name] : []
        };
      }
      return face.candidate;
    });
  }

  /**
   * Nothing here is off-process, so matching is already instant — this
   * exists so an app can await either source without asking which it has.
   */
  async matchSortedAsync(pattern = {}) {
    return this.matchSorted(pattern);
  }

  covers(candidate, codepoint) {
    return candidate.font.hasGlyph(codepoint);
  }
}

// A directory of an app's own faces is a handful of files; a system font
// tree is hundreds, and every one of them is parsed and then retained for
// the life of the FontManager (one macOS emoji collection alone is 188 MB).
// Rather than document that and hope, the walk stops and names the option —
// an app that really means it says so.
const MAX_FILES = 64;
const MAX_DEPTH = 8;

// Said whenever ntk is handed something it cannot read as fonts. It names
// every accepted shape rather than the one that was wrong, and states the
// premise — ntk has no fonts of its own — because the spec that brings people
// here is `'bundled'`, from an issue proposing a font package that does not
// exist. Naming that value in the matcher would enshrine an API that never
// shipped; this answers the question without making it real.
const ACCEPTED =
  ". Pass 'system', a path to a font file or directory, font bytes, an array of " +
  'those, { fonts, alias }, or a FontSource. ntk ships no fonts of its own — see ' +
  'docs/fonts.md';

function fs() {
  const mod = builtin('node:fs');
  if (!mod) {
    throw new Error(
      'ntk: a font path can only be read in node. In a browser, fetch the font ' +
        'bytes yourself and pass them: fontSource: [bytes] — see docs/fonts.md'
    );
  }
  return mod;
}

/** stat a spec'd path, reporting a missing one as the spec mistake it is
 * rather than as a bare ENOENT from somewhere inside ntk */
function statOf(path) {
  try {
    return fs().statSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // A bare word is far more likely a spec someone invented — 'bundled' is
      // the one the issue asks for — than a path they mistyped. Answer the
      // question they were actually asking.
      const guess = /[/\\.]/.test(path) ? '' : ACCEPTED;
      throw new Error(`ntk: no such font file or directory: "${path}"${guess}`, { cause: err });
    }
    throw err;
  }
}

/** every font file in a directory, sorted — never readdir order, which would
 * let the filesystem pick which face `sans-serif` lands on */
function fontFilesIn(dir, recursive, budget, depth = 0) {
  const { readdirSync } = fs();
  const found = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    // isDirectory() is false for a symlink, so this skips linked directories
    // and with them any chance of a cycle
    if (entry.isDirectory()) {
      if (recursive && depth < MAX_DEPTH) found.push(...fontFilesIn(path, true, budget, depth + 1));
    } else if (supported.test(entry.name)) {
      found.push(path);
      if (++budget.count > budget.max) {
        throw new Error(
          `ntk: more than ${budget.max} font files under "${budget.root}". That is a font ` +
            "tree rather than an app's own faces, and every one of them would be parsed and " +
            'kept in memory for the life of the process. List the faces you want, or raise ' +
            `the limit deliberately: { fonts: '${budget.root}', maxFiles: N } — see docs/fonts.md`
        );
      }
    }
  }
  return found;
}

/** does this look like a face rather than a typo? */
function isFace(face) {
  return (
    typeof face === 'string' ||
    ArrayBuffer.isView(face) ||
    face instanceof ArrayBuffer ||
    (!!face && typeof face === 'object' && (typeof face.path === 'string' || face.data != null))
  );
}

function addFace(source, face, skipped) {
  try {
    if (typeof face === 'string') return source.add(Font.loadSync(face));
    if (ArrayBuffer.isView(face) || face instanceof ArrayBuffer) return source.add(face);
    const { path, data, ...opts } = face;
    return source.add(path ? Font.loadSync(path, opts.postscriptName) : data, opts);
  } catch (err) {
    // one unparseable file should not take a whole directory down; a spec
    // that yields no usable face at all still throws, below
    skipped.push({ file: typeof face === 'string' ? face : face?.path, error: err });
    return null;
  }
}

function describe(value) {
  if (typeof value === 'string') return `"${value}"`;
  if (Array.isArray(value)) return 'that array';
  return value === null ? 'null' : typeof value;
}

/**
 * Resolve a **font spec** to a FontSource.
 *
 * ```
 * spec  := FontSource | 'system' | null | undefined
 *        | faces | { fonts: faces, alias?, recursive?, maxFiles? }
 * faces := face | face[]
 * face  := string (path to a font FILE or DIRECTORY)
 *        | Uint8Array | Buffer | ArrayBuffer
 *        | { path | data, family?, weight?, style?, postscriptName? }
 * ```
 *
 * Idempotent — a FontSource passes straight through, which is what lets
 * `createClient`, `FontManager` and `setDefaultFontSource` all coerce
 * without caring whether someone already did.
 *
 * Anything built from faces is a `StaticFontSource`, so there is one
 * matching implementation to reason about rather than two. Generic families
 * are inferred (see `inferGenerics`) with an explicit `alias` map winning.
 *
 * @param {*} spec
 * @returns {object|null|undefined} a FontSource
 */
export function createFontSource(spec) {
  if (spec == null) return spec; // preserves setDefaultFontSource(null)'s reset
  if (typeof spec.matchSorted === 'function') return spec;
  if (spec === 'system') return new FontconfigFontSource();

  const configured = !Array.isArray(spec) && typeof spec === 'object' && 'fonts' in spec;
  const { fonts, alias, recursive = false, maxFiles = MAX_FILES } = configured ? spec : { fonts: spec };
  const list = Array.isArray(fonts) ? fonts : [fonts];

  if (list.length === 0 || !list.every(isFace)) {
    throw new Error(`ntk: ${describe(spec)} is not a font source${ACCEPTED}`);
  }

  const source = new StaticFontSource();
  const skipped = [];
  const budget = { count: 0, max: maxFiles, root: null };
  let added = 0;
  for (const face of list) {
    if (typeof face === 'string' && statOf(face).isDirectory()) {
      budget.root = face;
      const files = fontFilesIn(face, recursive, budget);
      if (files.length === 0) {
        throw new Error(
          `ntk: no font files in "${face}" — looked for .ttf/.otf/.woff/.woff2/.ttc/.dfont` +
            (recursive ? '' : '. Pass { fonts, recursive: true } to walk subdirectories')
        );
      }
      for (const file of files) if (addFace(source, file, skipped)) added++;
    } else if (addFace(source, face, skipped)) {
      added++;
    }
  }

  source.skipped = skipped;
  if (added === 0) {
    throw new Error(
      `ntk: none of the ${skipped.length} font file(s) given could be parsed — ` +
        `${skipped[0]?.file ?? 'the first'}: ${skipped[0]?.error?.message ?? 'unknown error'}`
    );
  }

  for (const [generic, family] of Object.entries(alias ?? {})) source.alias(generic, family);
  return source.inferGenerics();
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
 *
 * Takes a font spec as well as a source, so pointing the whole process at a
 * directory is one line. `null` restores the fontconfig default.
 */
export function setDefaultFontSource(source) {
  _default = createFontSource(source);
}
