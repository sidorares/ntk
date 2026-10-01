// node:child_process is fetched lazily (via builtin(), not a static import) so
// that browser bundles of the package never try to resolve it; in non-node
// environments use a custom FontSource instead (see text/fontsource.js).
import { builtin } from './builtin.js';

function childProcess() {
  return builtin('node:child_process');
}

const NOT_NODE =
  'fontconfig matching needs node (the fc-match CLI) and this is not a node environment';

function execFileSync(...args) {
  const cp = childProcess();
  if (!cp) throw noFontsError(NOT_NODE);
  return cp.execFileSync(...args);
}

let fcMatchFound = null;

/**
 * fc-match's path, looked up once per PATH. Spawned by its bare name, the
 * system searches PATH for it, and on macOS that is `posix_spawnp`, which
 * attempts a spawn in every directory ahead of the one that has it: with
 * fc-match seventh on a developer's PATH, each spawn took 45 ms where the
 * path itself takes 15 — and the synchronous ones stall the first text
 * layout. A directory search here is a few stats. Not found, the bare name
 * is spawned as before, so a missing fontconfig reports exactly as it did.
 */
export function fcMatchFile() {
  const p = globalThis.process;
  const path = p?.env?.PATH ?? '';
  if (fcMatchFound !== null && fcMatchFound.path === path) return fcMatchFound.file;
  let file = 'fc-match';
  const fs = p?.platform === 'win32' ? undefined : builtin('node:fs');
  if (fs) {
    for (const dir of path.split(':')) {
      const candidate = `${dir || '.'}/fc-match`;
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
        file = candidate;
        break;
      } catch {
        // not here, or not ours to run: the next directory
      }
    }
  }
  fcMatchFound = { path, file };
  return file;
}

const DOCS = 'https://github.com/sidorares/ntk/blob/master/docs/fonts.md#environments-without-fontconfig';

/**
 * The one error for "this environment has nothing to render text with" —
 * fc-match missing, fc-match unhappy, fc-match matching nothing parseable, or
 * a StaticFontSource with no faces.
 *
 * It exists because of where it lands. Font lookup is lazy, so the failure
 * surfaces inside the first text layout with no hint that fonts are involved:
 * a fontconfig-less container used to report exactly `spawnSync fc-match
 * ENOENT` from deep inside shapeText, which reads as "ntk is broken in
 * Docker". The message is long on purpose — it is thrown once, at a reader
 * who does not yet know the subject.
 *
 * `code` is the load-bearing part rather than decoration: FontManager's
 * fallbackFor distinguishes "this environment has no fonts" (degrade to
 * .notdef) from "your custom source threw" (propagate), and it gives a host
 * renderer something to branch on without matching message text.
 *
 * @param {string} reason first line — what specifically was missing
 * @param {Error} [cause] the underlying failure, preserved for debugging
 */
export function noFontsError(reason, cause) {
  const err = new Error(
    `ntk: no fonts available — ${reason}.\n` +
      '\n' +
      'ntk ships no font files, so a slim/distroless container, a single-executable\n' +
      'build, a kiosk image or a CI box without font packages has to supply them:\n' +
      '\n' +
      "    createClient({ fontSource: '/app/fonts' })   // a directory of .ttf/.otf files\n" +
      '    createClient({ fontSource: [bytes] })        // font bytes — no filesystem needed\n' +
      '\n' +
      'Where a package manager is available, installing fontconfig plus a font package\n' +
      'is simpler: Debian/Ubuntu `apt-get install -y --no-install-recommends fontconfig\n' +
      'fonts-dejavu-core`; Alpine `apk add fontconfig font-dejavu`.\n' +
      '\n' +
      DOCS,
    cause ? { cause } : undefined
  );
  err.code = 'ERR_NTK_NO_FONTS';
  return err;
}

// css weight -> fontconfig weight: fontconfig's own table
// (FcWeightFromOpenTypeDouble), the one it reads every face's OS/2 weight
// through, so a pattern's weight sits where a face of that CSS weight does
const cssToFcWeight = [
  [0, 0],
  [100, 0], // thin
  [200, 40], // extralight
  [300, 50], // light
  [350, 55], // demilight
  [380, 75], // book
  [400, 80], // regular
  [500, 100], // medium
  [600, 180], // demibold
  [700, 200], // bold
  [800, 205], // extrabold
  [900, 210], // black
  [1000, 215] // extrablack
];

// CSS's 400 and 500, and the heaviest weight there is, on fontconfig's scale
const REGULAR = 80;
const MEDIUM = 100;
const HEAVIEST = 215;

// formats fontkit can parse. Exported so the font-spec resolver filters a
// directory listing by exactly the same rule fc-match output is filtered by —
// bitmap .pcf/.bdf fonts are the common near-miss.
export const supported = /\.(ttf|otf|woff|woff2|ttc|dfont)$/i;

const sortedCache = new Map();

// Why fc-match could not be used, remembered so a render loop that catches
// the error does not respawn a missing binary every frame. The reason string
// is cached rather than the Error, so each throw still carries its own stack.
// A process that somehow gains fontconfig mid-run will not notice; nobody
// installs fontconfig into a running process.
let unavailable = null;

/**
 * The exit code fc-match left, or null if the child never ran at all.
 *
 * The two exec flavours report it differently: execFileSync puts it in
 * `status` and leaves `code` for the spawn failure, while execFile puts both
 * in `code`. Normalized here so one diagnosis serves the sync and async
 * paths rather than two that can drift apart.
 */
function exitStatus(err) {
  if (err.status != null) return err.status;
  return typeof err.code === 'number' ? err.code : null;
}

/**
 * Did the spawn itself fail, as opposed to fc-match running and being
 * unhappy? No exit code means the child never ran, and these are the codes
 * that mean "no usable binary at this name" rather than a transient failure
 * worth reporting verbatim.
 */
function isSpawnFailure(err) {
  return exitStatus(err) == null && ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(err.code);
}

/**
 * An fc-match failure -> the error to report for it.
 *
 * Only a path that actually reports belongs here: a missing binary is
 * memoized in `unavailable` on the way through, which is exactly what
 * `prewarm` must not do (see there). It swallows the raw failure instead.
 */
function fcMatchError(err) {
  if (err.code === 'ERR_NTK_NO_FONTS') return err; // no child_process at all
  if (isSpawnFailure(err)) {
    unavailable = 'the fc-match CLI (fontconfig) is not installed here';
    return noFontsError(unavailable, err);
  }
  const status = exitStatus(err);
  if (status != null) {
    // fontconfig is installed and said no — an image with fontconfig but no
    // font package answers "No fonts installed on the system" and exits 1.
    // Not memoized: unlike a missing binary this can depend on the pattern.
    const stderr = String(err.stderr || '').trim().split('\n')[0];
    return noFontsError(`fc-match exited ${status}${stderr ? `: ${stderr}` : ''}`, err);
  }
  return err;
}

/**
 * macOS's own face for a CSS generic family that fontconfig answers there
 * with the wrong script's face, keyed by the generic.
 *
 * Only `sans-serif` is here, because it is the only generic fontconfig
 * resolves to a CJK face on a Mac (see `platformFamilies`). `serif` and
 * `monospace` land on PT Serif and Andale Mono, both of which set Latin,
 * Cyrillic and Greek at their own widths.
 */
const DARWIN_GENERICS = new Map([['sans-serif', 'Helvetica']]);

/**
 * A family list with macOS's own face for a generic named ahead of it — on
 * macOS only, and only for the generics in `DARWIN_GENERICS`. Everywhere
 * else the list goes to fc-match exactly as it came.
 *
 * Homebrew's fontconfig (2.18) ships 48-guessfamily.conf, which tags a query
 * naming a generic with that generic, and under it a `sans-serif` query
 * ranks every face with "Sans" in its name ahead of all of 60-latin.conf's
 * preferences — Verdana, Arial and Helvetica come in past the hundredth
 * candidate. So `fc-match sans-serif` answers with whichever "…Sans…" face
 * ranks first, and on a Mac that is Hiragino Sans: a Japanese face whose
 * Cyrillic, Greek, `…` and `—` are full-width. "Мост" set in it is four
 * em-wide cells, and CoreText sets it the same way — the advances are the
 * font's own, so what is wrong is the face, not the shaping. Without that
 * one file (XQuartz's fontconfig ships without it) the same query answers
 * Verdana.
 *
 * Browsers never ask fontconfig on macOS, and all of them give `sans-serif`
 * Helvetica. Naming it first does the same here, and the generic stays
 * after it, so a codepoint Helvetica lacks still falls back through
 * fontconfig's sans-serif list — CJK to Hiragino, as before.
 *
 * @param {string} family CSS-style family list, as FontManager hands it over
 * @param {string} [platform] `process.platform`; a parameter so that a test
 *   can ask for either answer on any machine
 * @returns {string} the family list to hand fc-match
 */
export function platformFamilies(family, platform = globalThis.process?.platform) {
  if (platform !== 'darwin') return family;
  const names = String(family)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const lower = names.map((name) => name.replace(/^["']|["']$/g, '').toLowerCase());
  const out = [];
  let changed = false;
  for (let i = 0; i < names.length; i++) {
    const face = DARWIN_GENERICS.get(lower[i]);
    // a list that already names the face ahead of the generic needs nothing
    if (face && !lower.slice(0, i).includes(face.toLowerCase())) {
      out.push(face);
      changed = true;
    }
    out.push(names[i]);
  }
  return changed ? out.join(',') : family;
}

/**
 * A family name as fontconfig's pattern syntax reads it (FcNameParse): a
 * `-` starts the point size, a `:` the properties, a `,` the next family,
 * and a `\` escapes each of them. Unescaped, the CSS list
 * `tablet-gothic-condensed, "arial narrow", arial` was the family `tablet`
 * and a size fc-match could not read, the families after it were gone, and
 * the face was fontconfig's default for nothing: Verdana, where a browser
 * sets Arial Narrow.
 */
function fcName(name) {
  return name.replace(/[\\\-:,]/g, '\\$&');
}

/**
 * A pattern as fc-match is handed it (`fc`, which is also its cache key),
 * with what CSS's matching needs of it besides: the family names it asks
 * for, the weight on fontconfig's scale (its default, regular, where none
 * is asked for) and whether it asks for italic.
 */
function specFor({ family, weight, style }) {
  const names = String(platformFamilies(family || 'sans-serif'))
    .split(',')
    .map((name) => name.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  let fc = names.map(fcName).join(',');
  const fcWeight = normalizeWeight(weight);
  if (fcWeight !== undefined) fc += `:weight=${fcWeight}`;
  const italic = Boolean(style && style.includes('italic'));
  if (italic) fc += ':slant=italic';
  return { fc, names, weight: fcWeight ?? REGULAR, italic };
}

function patternFor(pattern) {
  return specFor(pattern).fc;
}

// One command shared by the sync and async paths, so a prewarmed cache entry
// is byte-for-byte what the sync call would have computed.
//
// `%{family}` is a *list*: fontconfig keeps every name a face answers to,
// localized aliases included (`Hiragino Sans`, `ヒラギノ角ゴシック`, and the
// style-suffixed forms of both are one face), and `--format` joins them with
// commas. The fields are tab-separated so a comma inside one costs nothing,
// and `charset` stays last because it is by far the longest. Weight, slant
// and width are what CSS's matching reads (`cssFace`).
const fcMatchArgs = [
  '-s',
  '--format',
  '%{file}\t%{postscriptname}\t%{family}\t%{weight}\t%{slant}\t%{width}\t%{charset}\n'
];
const fcMatchOpts = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };

/**
 * A weight, slant or width as fontconfig prints it, as `[lo, hi]`: a number
 * is both ends, and a variable font's range, `[80 200]`, its own. Null where
 * there is none.
 */
function valueRange(text) {
  const n = text ? Number(text) : NaN;
  if (!Number.isNaN(n)) return [n, n];
  const values = String(text ?? '')
    .replace(/[[\]]/g, ' ')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  if (values.length === 0 || values.some(Number.isNaN)) return null;
  return [Math.min(...values), Math.max(...values)];
}

/**
 * One face fontconfig named, as a candidate. `charset` is null where it was
 * not asked for (the census's faces) — the face's coverage is not known, and
 * `charsetHas` answers yes, so a fallback opens it and asks the font.
 */
function candidate(path, postscriptName, family, weight, slant, width, charset) {
  // `families` keeps fontconfig's whole list, in its order; `family` is
  // the first of them, which is the name fontconfig leads with for the
  // current locale and the one to show in a UI.
  const families = family ? family.split(',').filter(Boolean) : [];
  return {
    path,
    postscriptName,
    family: families[0] || '',
    families,
    charset,
    _ranges: null,
    _style: [weight, slant, width]
  };
}

/**
 * A candidate's weight, slant and width as ranges (`valueRange`), read the
 * first time they are asked for — a chain's head is, the 150 faces behind
 * it never are. Null where fontconfig did not say.
 */
function styleOf(face) {
  if (Array.isArray(face._style)) {
    const [weight, slant, width] = face._style.map(valueRange);
    face._style = weight && slant && width ? { weight, slant, width } : null;
  }
  return face._style;
}

/** fc-match -s output -> candidates, filtered to formats fontkit can parse */
function parseMatches(out) {
  const list = [];
  for (const line of out.split('\n')) {
    const [path, postscriptName, family, weight, slant, width, charset] = line.split('\t');
    if (path && supported.test(path)) {
      list.push(candidate(path, postscriptName, family, weight, slant, width, charset || ''));
    }
  }
  return list;
}

/**
 * fc-match output -> the cached candidate list for a pattern, its head the
 * face CSS picks (`cssChain`). Throws for output that parses to nothing
 * usable, which is a fontconfig answer rather than a fontconfig failure and
 * so is diagnosed separately.
 */
function cacheMatches(spec, out) {
  const list = parseMatches(out);
  if (list.length === 0) {
    throw noFontsError(
      `fontconfig matched no font ntk can parse for "${spec.fc}" (needs ` +
        '.ttf/.otf/.woff/.woff2/.ttc/.dfont — bitmap .pcf/.bdf fonts are not usable)'
    );
  }
  const chain = cssChain(spec, list);
  sortedCache.set(spec.fc, chain);
  return chain;
}

// The census: every face fontconfig knows, a line each — file, PostScript
// name, families, weight, slant and width — from one fc-list a process,
// started beside the first prewarm's fc-matches (`spawnToFiles`) and read
// the first time a weight needs it (`cssFace`). 357 KB for 1,900 faces on a
// Mac, 45 ms to list. It is kept as the bytes it was read as and a family's
// lines found in it by a byte search: decoded whole, it was a millisecond of
// the layout that first needed it, and a family is a dozen of its lines.
const CENSUS_FORMAT = '%{file}\t%{postscriptname}\t%{family}\t%{weight}\t%{slant}\t%{width}\n';

// undefined until a prewarm starts it; then its prewarm entry, with `bytes`
// (undefined until read, null where there is none to read) and `faces`, the
// family -> faces lookups already made in it
let census;

/**
 * The census's bytes — waited for synchronously while its child runs. Null
 * where it failed, took too long, or never ran (no shell to run it in), and
 * then for good: a face answered without it must not be answered otherwise
 * a moment later.
 */
function censusBytes() {
  if (!census) return null;
  if (census.bytes !== undefined) return census.bytes;
  const deadline = performance.now() + PREWARM_WAIT_MS;
  let status = prewarmStatus(census.base);
  while (status === null && !census.exited && performance.now() < deadline) {
    Atomics.wait(nap, 0, 0, 1);
    status = prewarmStatus(census.base);
  }
  census.bytes = null;
  if (status === 0) {
    try {
      census.bytes = builtin('node:fs').readFileSync(`${census.base}.out`);
    } catch {
      // gone from under us: no census, as if it had failed
    }
  }
  removePrewarm(census.base);
  return census.bytes;
}

/** once the census can be read without waiting: for a caller that awaits */
function censusSettled() {
  return census && census.bytes === undefined && !census.exited ? census.promise : undefined;
}

// a family name as fontconfig compares one: case and blanks aside
const folded = (name) => name.replace(/\s+/g, '').toLowerCase();

/**
 * The faces of the family fontconfig matched a pattern to, as the census has
 * them — those ntk can open. Null where there is no census.
 *
 * The family is the name `head` was matched by: the first of the pattern's
 * that the face answers to, or — for a generic, or a family fontconfig put
 * another in place of — the name it leads with. Which name matters: `Avenir
 * Next Ultra Light` is a family of two faces, and `Avenir Next` one of
 * twelve that holds both.
 */
function familyFaces(names, head) {
  const bytes = censusBytes();
  if (bytes === null) return null;
  let name;
  for (const asked of names.map(folded)) {
    name = head.families.find((f) => folded(f) === asked);
    if (name) break;
  }
  name ??= head.families[0];
  if (!name) return null;
  const key = folded(name);
  let faces = census.faces.get(key);
  if (faces) return faces;
  faces = [];
  // fontconfig spells a name alike in both answers, so a search for it finds
  // every line it is on, and the line's own family list says whether it is
  // one of the face's names or only part of a longer one
  for (let at = bytes.indexOf(name); at !== -1; ) {
    const start = bytes.lastIndexOf(10, at) + 1;
    let end = bytes.indexOf(10, at);
    if (end === -1) end = bytes.length;
    const line = bytes.toString('utf8', start, end);
    const [path, postscriptName, family, weight, slant, width] = line.split('\t');
    const face = candidate(path, postscriptName, family, weight, slant, width, null);
    if (path && supported.test(path) && face.families.some((f) => folded(f) === key)) faces.push(face);
    at = bytes.indexOf(name, end);
  }
  census.faces.set(key, faces);
  return faces;
}

// CSS Fonts 4 §5.2's order, as ranks on fontconfig's scale, lowest first.
// Width (font-stretch, normal being 100): the normal width, then narrower
// ones nearest first, then wider ones.
function widthRank([lo, hi]) {
  if (lo <= 100 && hi >= 100) return 0;
  return hi < 100 ? 100 - hi : 1000 + lo - 100;
}

// Slant: the one asked for, then oblique (fontconfig's 110), then the other.
function slantRank(italic, [lo, hi]) {
  const asked = italic ? 100 : 0;
  if (lo <= asked && hi >= asked) return 0;
  return lo >= 105 ? 1 : 2;
}

// Weight, for `weight` asked: between 400 and 500, up to 500 ascending, then
// lighter descending, then past 500 ascending; below 400 lighter first, above
// 500 heavier first. A variable face's range holds every weight in it.
// `regular` and `medium` are 400 and 500 on the scale the weights are on —
// fontconfig's here, CSS's in StaticFontSource, where an OS/2 weight class can
// be anything up to 65535 and so each direction is a million past the last.
export function weightRank(weight, [lo, hi], regular = REGULAR, medium = MEDIUM) {
  if (lo <= weight && hi >= weight) return 0;
  const x = hi < weight ? hi : lo;
  if (weight >= regular && weight <= medium) {
    if (x > weight && x <= medium) return x - weight;
    return x < weight ? 1e6 + weight - x : 2e6 + x - weight;
  }
  if (weight < regular) return x < weight ? weight - x : 1e6 + x - weight;
  return x > weight ? x - weight : 1e6 + weight - x;
}

/**
 * Is `head`, the face fontconfig picked, the one CSS picks — whatever else
 * the family holds?
 *
 * Fontconfig picks the face nearest in weight, after the slant: so no face
 * of the head's slant is nearer the weight asked for than the head, and that
 * is all one answer says about the family. The head is CSS's pick when every
 * weight CSS would try before the head's lies nearer — 500 in Helvetica,
 * whose regular is 80 against 100 asked, where CSS tries 500 alone first.
 * 450 in Arial is not: 500 is as near as its regular, so a medium could be
 * there, and CSS would take it. Then the census decides.
 *
 * Fontconfig ranks width after weight and CSS before it, so a head of
 * another width than normal is never shown to be CSS's: 900 in Helvetica
 * Neue is its condensed black. Nor is an italic head for an upright ask,
 * where CSS tries oblique first.
 */
function provenPick(weight, italic, head) {
  const style = styleOf(head);
  if (!style) return false;
  if (widthRank(style.width) !== 0) return false;
  if (!italic && slantRank(false, style.slant) === 2) return false;
  const [lo, hi] = style.weight;
  if (lo <= weight && hi >= weight) return true;
  const x = hi < weight ? hi : lo;
  const near = Math.abs(x - weight);
  // the weights CSS tries before x: from, whether it is open, to, whether it is
  let from, fromOpen, to, toOpen;
  if (weight >= REGULAR && weight <= MEDIUM) {
    if (x > weight && x <= MEDIUM) [from, fromOpen, to, toOpen] = [weight, false, x, true];
    else if (x < weight) [from, fromOpen, to, toOpen] = [x, true, MEDIUM, false];
    else [from, fromOpen, to, toOpen] = [0, false, x, true];
  } else if (weight < REGULAR) {
    if (x < weight) [from, fromOpen, to, toOpen] = [x, true, weight, false];
    else [from, fromOpen, to, toOpen] = [0, false, x, true];
  } else if (x > weight) [from, fromOpen, to, toOpen] = [weight, false, x, true];
  else [from, fromOpen, to, toOpen] = [x, true, HEAVIEST, false];
  return (
    (from > weight - near || (fromOpen && from >= weight - near)) &&
    (to < weight + near || (toOpen && to <= weight + near))
  );
}

/** a < b, comparing [width, slant, weight] ranks in turn */
function ranksBefore(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/**
 * The face CSS's matching (CSS Fonts 4 §5.2) picks for a pattern, given
 * `head`, the face fontconfig picked: the head itself where it can be shown
 * to be CSS's (`provenPick`), or where there is no census to say otherwise,
 * and the family's best face by width, slant and weight in that order where
 * there is one. Fontconfig picks the face nearest in weight, after the
 * slant and before the width, so 520 in Arial was the regular, which a
 * browser sets in the bold.
 *
 * The head wins ties: a face like it is fontconfig's to choose between. So
 * does a head that is a variable font's instance where CSS picks the font —
 * a weight its axis holds is set on the axis (`instantiate`) whichever face
 * of the file it is opened through.
 *
 * The head is ranked as the census lists it, because an answer describes
 * the face as fontconfig will render it: an upright face matched for an
 * italic ask comes back oblique (90-synthetic.conf slants it), and ranked
 * by that it beat its own family's upright faces — W1 of Hiragino Sans,
 * which has no italics, at 160, where CSS takes W0.
 */
function cssFace(spec, head) {
  if (!head || provenPick(spec.weight, spec.italic, head)) return head;
  const faces = familyFaces(spec.names, head);
  if (!faces || faces.length === 0) return head;
  const ranks = (face) => {
    const style = styleOf(face);
    return style && [widthRank(style.width), slantRank(spec.italic, style.slant), weightRank(spec.weight, style.weight)];
  };
  const listed = faces.find((f) => f.path === head.path && f.postscriptName === head.postscriptName);
  let best = null;
  let bestRanks = ranks(listed ?? head);
  for (const face of faces) {
    const r = ranks(face);
    if (r && (bestRanks === null || ranksBefore(r, bestRanks))) [best, bestRanks] = [face, r];
  }
  if (best === null) return head;
  const [lo, hi] = styleOf(best).weight;
  if (lo < hi && best.path === head.path) return head;
  return best;
}

/**
 * A fallback chain with the face CSS picks at its head (`cssFace`). Where
 * that is not fontconfig's head it is moved up from where the chain has it,
 * or, as `-s` trims a face whose coverage the faces before it already give —
 * a family's bold, behind its regular — put there from the census.
 */
function cssChain(spec, list) {
  const face = cssFace(spec, list[0]);
  if (face === list[0]) return list;
  const same = (c) => c.path === face.path && c.postscriptName === face.postscriptName;
  return [list.find(same) ?? face, ...list.filter((c) => !same(c))];
}

// fc -> { promise, base }: one child per pattern however many callers ask.
// `base` is where a prewarm writes its answer (`spawnToFiles`), null for a
// child whose answer only reaches the event loop.
const inflight = new Map();

// fc -> the prewarm entry of a `best` job: the one face fontconfig picks for a
// pattern, asked for beside its chain so a layout can take it first
// (`bestOfPrewarm`)
const bestInflight = new Map();

/**
 * fc-match for a pattern, off the event loop — one child per pattern however
 * many callers ask at once, so a prewarm and an awaiting `matchSorted` share
 * a single spawn instead of racing two.
 *
 * Rejects with the *raw* failure, undiagnosed: `fcMatchError` memoizes a
 * missing binary, and whether that should happen is the caller's decision,
 * not this one's.
 *
 * @returns {Promise<string>} raw fc-match stdout
 */
function runFcMatch(fc) {
  const pending = inflight.get(fc);
  if (pending) return pending.promise;
  const cp = childProcess();
  if (!cp) return Promise.reject(noFontsError(NOT_NODE));

  const entry = { promise: null, base: null };
  entry.promise = new Promise((resolve, reject) => {
    cp.execFile(fcMatchFile(), [...fcMatchArgs, fc], fcMatchOpts, (err, out, stderr) => {
      if (inflight.get(fc) === entry) inflight.delete(fc);
      if (!err) return resolve(out);
      // execFile hands stderr to the callback; execFileSync hangs it on the
      // error, which is where the shared diagnosis reads it from
      if (err.stderr === undefined) err.stderr = stderr;
      reject(err);
    });
  });
  inflight.set(fc, entry);
  return entry.promise;
}

// What a prewarm's child runs: an fc-match for each job, side by side, each
// with its answer in a file and then — once that file is complete — its exit
// status in another, which is what a synchronous caller waits for
// (`answerSync`). The arguments are fc-match's own (`fcMatchArgs`, the sort
// flag first), then a file base, a kind and a pattern for each job: `sorted`
// asks for the whole fallback chain, `best` for the one face fontconfig
// would pick, which it answers in half the time, since it sorts nothing and
// writes one line (`bestOfPrewarm`). `census` lists every face, with the
// format in the pattern's place (`CENSUS_FORMAT`). The shell exits once
// every job has. Nothing but shell builtins runs besides fc-match and
// fc-list, so a PATH that holds those is enough; without fc-list there is no
// census, and fontconfig's own picks stand.
const PREWARM_SCRIPT = [
  ...fcMatchArgs.map((_, i) => `a${i}=\${${i + 1}}`),
  `shift ${fcMatchArgs.length}`,
  'while [ $# -gt 2 ]; do ' +
    'if [ "$2" = census ]; then ' +
    '(fc-list --format "$3" > "$1.out" 2> "$1.err"; echo $? > "$1.done") & ' +
    'elif [ "$2" = best ]; then ' +
    `(fc-match ${fcMatchArgs
      .slice(1)
      .map((_, i) => `"$a${i + 1}"`)
      .join(' ')} "$3" > "$1.out" 2> "$1.err"; echo $? > "$1.done") & ` +
    'else ' +
    `(fc-match ${fcMatchArgs.map((_, i) => `"$a${i}"`).join(' ')} "$3" > "$1.out" 2> "$1.err"; ` +
    'echo $? > "$1.done") & ' +
    'fi; shift 3; done',
  'wait'
].join('; ');

// The directory prewarms write into, made on first use: undefined until
// then, null where it cannot be (no shell, no writable tmpdir), which leaves
// prewarms on the event loop the way they always were.
let prewarmDir;
let prewarmCount = 0;

function prewarmBase() {
  const fs = builtin('node:fs');
  const path = builtin('node:path');
  if (prewarmDir === undefined) {
    prewarmDir = null;
    const p = globalThis.process;
    const os = builtin('node:os');
    if (p && p.platform !== 'win32' && fs && os && path && fs.existsSync('/bin/sh')) {
      try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntk-fc-'));
        p.once('exit', () => {
          try {
            fs.rmSync(dir, { recursive: true, force: true });
          } catch {
            // a tmpdir cleaned up under us is already clean
          }
        });
        prewarmDir = dir;
      } catch {
        // a read-only or missing tmpdir: prewarm the old way
      }
    }
  }
  return prewarmDir === null ? null : path.join(prewarmDir, String(prewarmCount++));
}

/** The exit status a prewarm left, once it has left it; null while it is
 *  still running. */
function prewarmStatus(base) {
  const fs = builtin('node:fs');
  let done;
  try {
    done = fs.readFileSync(`${base}.done`, 'utf8');
  } catch {
    return null;
  }
  // `echo` writes the status and the newline in one go, but a read can land
  // between the file appearing and its bytes arriving
  if (!done.endsWith('\n')) return null;
  return Number(done);
}

/** The status and answer a prewarm left, once it has left them; null while
 *  it is still running. */
function readPrewarm(base) {
  const fs = builtin('node:fs');
  const status = prewarmStatus(base);
  if (status === null) return null;
  let out = '';
  if (status === 0) {
    try {
      out = fs.readFileSync(`${base}.out`, 'utf8');
    } catch {
      return { status: -1, out: '' };
    }
  }
  return { status, out };
}

function removePrewarm(base) {
  const fs = builtin('node:fs');
  for (const ext of ['.out', '.err', '.done']) {
    try {
      fs.unlinkSync(base + ext);
    } catch {
      // never written, or already gone
    }
  }
}

/**
 * A prewarm's child, answering through files so that the synchronous path
 * can take its answer without the event loop (`answerSync`) — which the
 * first text layout is holding, from inside a render, for as long as the
 * first frame takes. A prewarm answered through `execFile` alone lands after
 * that, so the layout it was started for spawned fc-match a second time and
 * waited for that one instead.
 *
 * One child for all the patterns handed over, because what a spawn costs is
 * node's: libuv forks the whole process to start one, and a fork copies page
 * tables that grow with the heap. Four spawns took 4.7 ms of the main thread
 * at 130 MB and 33 ms at 260 MB on a Linux desktop; one shell starting the
 * same four took 1.4 and 8, since the shell's own forks cost next to nothing.
 *
 * The answers stay in their files until something asks for one
 * (`answerSync`), so a face no text is set in — a family's italics, as often
 * as not — is never read. Read and parsed as each child exited, a family's
 * answers were 9 ms of the main thread while the connection was still being
 * set up: 634 KB apiece, most of it the coverage of every face fontconfig
 * sorts behind the first.
 *
 * The first child also lists every face, once a process (the census, see
 * `CENSUS_FORMAT`): a job of its own beside the matches, so a weight CSS
 * matches differently from fontconfig costs no spawn of the app's.
 *
 * An entry a pattern, in order; null where files cannot be used, and the
 * caller prewarms the old way.
 */
function spawnToFiles(fcs, bests = []) {
  const cp = childProcess();
  const all = [...fcs, ...bests];
  const listing = census === undefined;
  const bases = cp ? Array.from({ length: all.length + (listing ? 1 : 0) }, () => prewarmBase()) : [];
  if (bases.length === 0 || bases[0] === null) return null;
  const jobs = [];
  all.forEach((fc, i) => jobs.push(bases[i], i < fcs.length ? 'sorted' : 'best', fc));
  if (listing) jobs.push(bases[all.length], 'census', CENSUS_FORMAT);
  let child;
  try {
    child = cp.spawn('/bin/sh', ['-c', PREWARM_SCRIPT, 'ntk-fc-match', ...fcMatchArgs, ...jobs], {
      stdio: 'ignore'
    });
  } catch {
    return null;
  }
  // `promise` resolves once the child is gone, with what it left in the
  // files; `exited` tells a synchronous caller there is nothing to wait for
  const entry = (base) => {
    const e = { promise: null, base, answer: undefined, exited: false, gone: null };
    e.promise = new Promise((resolve) => {
      e.gone = resolve;
    });
    return e;
  };
  const entries = all.map((fc, i) => {
    const e = entry(bases[i]);
    (i < fcs.length ? inflight : bestInflight).set(fc, e);
    return e;
  });
  if (listing) {
    census = Object.assign(entry(bases[all.length]), { bytes: undefined, faces: new Map() });
    entries.push(census);
  }
  const gone = () => {
    for (const entry of entries) {
      entry.exited = true;
      entry.gone();
    }
  };
  child.once('error', gone);
  child.once('exit', gone);
  return entries;
}

// the synchronous path's nap while a prewarm finishes
const nap = new Int32Array(new SharedArrayBuffer(4));

// How long the synchronous path waits on a prewarm before asking fc-match
// itself. fc-match answers in tens of milliseconds, and a prewarm that is
// running has a head start on any spawn that could replace it.
const PREWARM_WAIT_MS = 3000;

/**
 * A prewarm's answer, read from its files — waited for synchronously while
 * the child still runs: its stdout, or null if it failed or took too long.
 * The caller then spawns fc-match itself, which is also what reports why.
 */
function answerSync(fc, entry) {
  const deadline = performance.now() + PREWARM_WAIT_MS;
  let left = readPrewarm(entry.base);
  // a child that is gone has left all it ever will
  while (left === null && !entry.exited && performance.now() < deadline) {
    Atomics.wait(nap, 0, 0, 1);
    left = readPrewarm(entry.base);
  }
  if (inflight.get(fc) === entry) inflight.delete(fc);
  if (entry.answer === undefined) {
    entry.answer = left && left.status === 0 ? left.out : null;
    if (left !== null) removePrewarm(entry.base);
  }
  return entry.answer;
}

/**
 * The first candidate of a prewarm's answer that ntk can open, read from the
 * head of its file — waited for synchronously while the child still runs.
 * Null where the answer failed, took too long, or holds no such candidate;
 * the caller then reads it whole (`matchSortedSync`), which also reports why.
 *
 * An answer is the whole fallback chain, each face with its coverage: 634 KB
 * for `sans-serif` on a Linux desktop, 2-3 ms to read and parse, where a
 * layout setting text in the face needs its first line. The rest waits in
 * the file for the first character that falls back, which Latin text in a
 * face that covers it never has.
 *
 * The face is the one CSS picks (`cssFace`), as the chain's head will be.
 */
function firstOfPrewarm(spec, entry) {
  if (entry.first !== undefined) return entry.first;
  const deadline = performance.now() + PREWARM_WAIT_MS;
  let status = prewarmStatus(entry.base);
  while (status === null && !entry.exited && performance.now() < deadline) {
    Atomics.wait(nap, 0, 0, 1);
    status = prewarmStatus(entry.base);
  }
  // not answered, or not yet: the whole read is what decides, and reports
  if (status !== 0) return null;
  entry.first = cssFace(spec, firstCandidate(`${entry.base}.out`));
  return entry.first;
}

/**
 * The face a prewarm's `best` job found for a pattern, if ntk can open it —
 * waited for synchronously while the job still runs. Null where it failed,
 * took too long or named a face ntk cannot open; the caller then takes the
 * chain's head (`firstOfPrewarm`).
 *
 * A `best` job asks fontconfig for the face it would pick, which it answers
 * in about half the time the whole chain takes (15 ms against 30 on a Linux
 * desktop): no sort, one line. A layout that asks for a family warmed while
 * its component rendered waits on the prewarm, and the chain was most of
 * that wait. Fontconfig's face, that is: the one CSS picks may be another
 * (`cssFace`).
 */
function bestOfPrewarm(spec, entry) {
  if (entry.first !== undefined) return entry.first;
  const deadline = performance.now() + PREWARM_WAIT_MS;
  let left = readPrewarm(entry.base);
  while (left === null && !entry.exited && performance.now() < deadline) {
    Atomics.wait(nap, 0, 0, 1);
    left = readPrewarm(entry.base);
  }
  if (left === null) return null;
  removePrewarm(entry.base);
  const [best] = left.status === 0 ? parseMatches(left.out) : [];
  entry.first = best ? cssFace(spec, best) : null;
  return entry.first;
}

// how much of an answer's head a read takes at a time: a line is a face's
// path, names and coverage, a few KB at most
const HEAD_CHUNK = 16384;

/** The first line of an fc-match answer naming a face ntk can open, parsed;
 *  null if the file has none, or cannot be read. */
function firstCandidate(file) {
  const fs = builtin('node:fs');
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  const decoder = new TextDecoder();
  try {
    let pending = new Uint8Array(0);
    const chunk = new Uint8Array(HEAD_CHUNK);
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, HEAD_CHUNK, null);
      let bytes = pending;
      if (read > 0) {
        bytes = new Uint8Array(pending.length + read);
        bytes.set(pending);
        bytes.set(chunk.subarray(0, read), pending.length);
      }
      let start = 0;
      // a newline never falls inside a UTF-8 sequence, so whole lines decode
      for (let nl = bytes.indexOf(10, start); nl !== -1; nl = bytes.indexOf(10, start)) {
        const [candidate] = parseMatches(decoder.decode(bytes.subarray(start, nl)));
        if (candidate) return candidate;
        start = nl + 1;
      }
      if (read <= 0) {
        const [candidate] = parseMatches(decoder.decode(bytes.subarray(start)));
        return candidate ?? null;
      }
      pending = bytes.slice(start);
    }
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Seed the match cache for a pattern ahead of time, off the event loop.
 *
 * matchSortedSync is deliberately synchronous — it answers from inside text
 * layout — so the first layout for a pattern pays the fc-match spawn (~50ms)
 * as a first-paint stall. Starting the same command here with a non-blocking
 * spawn, while the X connection is still being set up, moves that cost off
 * the critical path (issue #182). The child answers through files as well as
 * through the event loop, so a layout that asks for the pattern before the
 * loop has run takes the prewarm's answer rather than spawning its own.
 *
 * Never rejects and never reports: a prewarm is an optimization, and an app
 * that never renders text must not crash — or even warn — over a missing
 * fc-match. An app that does render text reaches the sync path, which
 * diagnoses the failure properly. For the same reason nothing here touches
 * `unavailable`: the first sync throw keeps its original spawn error as
 * `cause`.
 *
 * `matchSorted` is the reporting variant: same spawn, same cache, but it
 * awaits an answer and so has somewhere to put a failure.
 *
 * @returns {Promise<void>} resolves once the answer is ready for the first
 *   layout that asks — in the cache, or in the prewarm's files — or the
 *   attempt abandoned
 */
export function prewarm(pattern = {}) {
  return warm([specFor(pattern)])[0];
}

/**
 * `prewarm` for several patterns at once, started together in one child: the
 * faces a caller knows text will be set in besides a family's four — a menu's
 * medium. Patterns already cached or running are not asked again.
 *
 * @returns {Promise<void>} once every pattern's answer is ready or given
 *   up on; never rejects
 */
export function prewarmPatterns(patterns) {
  return Promise.all(warm(patterns.map(specFor))).then(() => {});
}

/**
 * `prewarm` for a list of patterns (`specFor`): the ones neither cached nor
 * already running start together, in one child (`spawnToFiles`). A promise a
 * pattern, resolving once its answer is ready or given up on; none rejects.
 */
function warm(specs, best = null) {
  if (unavailable) return specs.map(() => Promise.resolve());
  const fcs = specs.map((spec) => spec.fc);
  const fresh = [...new Set(fcs)].filter((fc) => !sortedCache.has(fc) && !inflight.has(fc));
  // the best face only beside its own chain: once that is running or read,
  // the chain's head answers as soon as a best job would
  const bests = best !== null && fresh.includes(best) && !bestInflight.has(best) ? [best] : [];
  if (fresh.length > 0) spawnToFiles(fresh, bests);
  return specs.map((spec) => {
    const { fc } = spec;
    if (sortedCache.has(fc)) return Promise.resolve();
    // a prewarm's answer waits in its files for the first ask
    const running = inflight.get(fc);
    if (running?.base) return running.promise;
    const pending = running?.promise ?? runFcMatch(fc);
    return pending
      .then(async (out) => {
        // the census decides the head: read once it is in, never waited on
        await censusSettled();
        if (!sortedCache.has(fc)) {
          const list = parseMatches(out);
          if (list.length > 0) sortedCache.set(fc, cssChain(spec, list));
        }
      })
      .catch(() => {});
  });
}

// the faces a family is asked for in: regular, bold, and both in italic
const FACES = [
  [400, 'normal'],
  [700, 'normal'],
  [400, 'italic'],
  [700, 'italic']
];
const facesWarmed = new Set();

/**
 * Prewarm a family in the four faces text is set in — once per family.
 *
 * A document asks for its family's faces one at a time, as layout reaches
 * the first bold word, the first emphasis, and each ask that misses is a
 * synchronous fc-match on the way to the first frame: a Markdown document
 * waited on five of them, 600 ms on XQuartz. Started together, from one
 * child, they run side by side, and each later ask finds its answer there.
 */
export function prewarmFaces(pattern = {}) {
  const family = pattern.family || 'sans-serif';
  if (facesWarmed.has(family) || unavailable) return;
  facesWarmed.add(family);
  // the face a layout will ask for first gets a `best` job beside the chains:
  // the one being asked for, or, warmed ahead, the regular
  const first = patternFor(pattern.weight === undefined && pattern.style === undefined ? { family, weight: 400, style: 'normal' } : pattern);
  warm(
    FACES.map(([weight, style]) => specFor({ family, weight, style })),
    first
  );
}

/**
 * The same match list as `matchSortedSync`, without blocking for it.
 *
 * For a caller that is not inside text layout — a font picker matching as
 * the user types, a preferences page, anything that can await — the sync
 * spawn is ~100ms of stalled event loop per new pattern and buys nothing.
 * This runs the identical command through `execFile` instead, shares the
 * spawn with any prewarm already in flight for the pattern, and fills the
 * same cache, so a later layout answers from memory.
 *
 * Unlike `prewarm` it reports: a missing fc-match rejects here rather than
 * resolving quietly and leaving the diagnosis to a blocking sync call
 * afterwards. Rejections carry `code: 'ERR_NTK_NO_FONTS'` exactly as the
 * sync throws do.
 *
 * @returns {Promise<Array<{path, postscriptName, family: string,
 *   families: string[], charset: string|null}>>}
 */
export async function matchSorted(pattern = {}) {
  const spec = specFor(pattern);
  const { fc } = spec;
  const cached = sortedCache.get(fc);
  if (cached) return cached;
  if (unavailable) throw noFontsError(unavailable);

  // A caller that awaits may be the first to ask anything — a font picker
  // with no source constructed — and nothing else would start the census
  if (census === undefined) spawnToFiles([]);
  let out;
  const pending = inflight.get(fc);
  if (pending?.base) {
    // a prewarm for the pattern: its answer once the child is gone, or — if
    // it left none — a spawn of our own, which is what reports why
    await pending.promise;
    out = answerSync(fc, pending) ?? undefined;
  }
  if (out === undefined) {
    try {
      out = await runFcMatch(fc);
    } catch (err) {
      throw fcMatchError(err);
    }
  }
  // the census decides the head where fontconfig's own cannot be shown to be
  // CSS's (`cssChain`): read once it is in, so that this never waits on it
  await censusSettled();
  // A sync call may have answered this pattern while the child ran. Its list
  // is the cached one, and candidates memoize their parsed charset, so hand
  // back what everyone else already holds rather than a fresh copy.
  return sortedCache.get(fc) ?? cacheMatches(spec, out);
}

/**
 * Full fontconfig match list for a pattern, best match first — this is the
 * system's font fallback chain, headed by the face CSS's font matching picks
 * (`cssChain`). Each candidate carries the unicode coverage fontconfig knows
 * about (`charset`, lazily parsed via `charsetHas`; null for a head the
 * chain did not have), so a fallback font for a codepoint can be chosen
 * without opening font files —
 * and the family name fontconfig already knows, so a *list* of matches can be
 * shown without opening them either (issue #273: `sans-serif` returns 139
 * candidates here, and `Font.loadSync` is ~1.2ms a file).
 *
 * Cached per pattern; one fc-match invocation (~50ms) per distinct pattern.
 * Synchronous because its main caller is text layout, which cannot await;
 * a caller that can should use `matchSorted` and not block on the spawn.
 *
 * @returns {Array<{path, postscriptName, family: string, families: string[],
 *   charset: string|null}>}
 */
export function matchSortedSync(pattern) {
  const spec = specFor(pattern);
  const { fc } = spec;
  const cached = sortedCache.get(fc);
  if (cached) return cached;
  if (unavailable) throw noFontsError(unavailable);

  // The family's other faces are the next asks (`prewarmFaces`): started
  // now, they run beside this one instead of after it.
  prewarmFaces(pattern);
  const pending = inflight.get(fc);
  if (pending?.base) {
    const out = answerSync(fc, pending);
    if (out !== null) return sortedCache.get(fc) ?? cacheMatches(spec, out);
  }
  let out;
  try {
    out = execFileSync(fcMatchFile(), [...fcMatchArgs, fc], fcMatchOpts);
  } catch (err) {
    throw fcMatchError(err);
  }
  return cacheMatches(spec, out);
}

/**
 * The best face for a pattern: `matchSortedSync(pattern)[0]`, without reading
 * the rest of the fallback chain where a prewarm's answer is waiting in its
 * file (`firstOfPrewarm`). A layout setting text in a face asks for this;
 * the first character it has to fall back for reads the chain whole.
 *
 * @returns {{path, postscriptName, family: string, families: string[],
 *   charset: string|null}}
 */
export function matchFirstSync(pattern) {
  const spec = specFor(pattern);
  const { fc } = spec;
  const cached = sortedCache.get(fc);
  if (cached) return cached[0];
  if (unavailable) throw noFontsError(unavailable);
  prewarmFaces(pattern);
  const best = bestInflight.get(fc);
  if (best) {
    const first = bestOfPrewarm(spec, best);
    if (first) return first;
  }
  const pending = inflight.get(fc);
  if (pending?.base) {
    const first = firstOfPrewarm(spec, pending);
    if (first) return first;
  }
  return matchSortedSync(pattern)[0];
}

/**
 * Resolve a font pattern ({family, weight, style}) to the best matching font
 * file. Returns { path, postscriptName, family, families } or throws if
 * nothing suitable is installed. Requires the fc-match CLI (fontconfig) —
 * usual on a Linux desktop, absent from slim containers and from stock
 * macOS. Where it is missing, hand ntk the fonts instead (see docs/fonts.md).
 */
export function listFontsSync(pattern) {
  const [best] = matchSortedSync(pattern);
  return {
    path: best.path,
    postscriptName: best.postscriptName,
    family: best.family,
    families: best.families
  };
}

/**
 * Does a fc-match candidate's charset cover a codepoint?
 * The charset string is fontconfig's range format: "20-7e a0-ff 131 ...".
 * A face whose coverage is not known here — one CSS's matching put at a
 * chain's head, which `-s` had trimmed (`cssChain`) — may: it is opened and
 * the font asked.
 */
export function charsetHas(candidate, codepoint) {
  if (candidate.charset === null) return true;
  if (candidate._ranges === null) {
    const ranges = [];
    for (const part of candidate.charset.split(' ')) {
      if (!part) continue;
      const dash = part.indexOf('-');
      if (dash === -1) {
        const v = parseInt(part, 16);
        ranges.push(v, v);
      } else {
        ranges.push(parseInt(part.slice(0, dash), 16), parseInt(part.slice(dash + 1), 16));
      }
    }
    candidate._ranges = ranges;
  }
  const r = candidate._ranges;
  let lo = 0;
  let hi = r.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (codepoint < r[mid * 2]) hi = mid - 1;
    else if (codepoint > r[mid * 2 + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * A CSS font weight on fontconfig's scale, which is not CSS's: regular is 80
 * there and black is 210. The table is fontconfig's own, and a weight between
 * two of its entries is as far between their fontconfig weights, so 450 is
 * 90, halfway from regular to medium. CSS takes 1 to 1000.
 *
 * Handed over as it was, 450 was a weight past twice black, and fontconfig
 * answered with the heaviest face a family has: Arial Bold, where a browser
 * sets 450 in Arial Regular.
 *
 * Fontconfig's table rather than one of the hundreds alone, because it is
 * the one a face's own weight went through: a face whose OS/2 weight is 350
 * is 55 in every fc-match answer, and only the same table puts a pattern
 * asking for 340 on the lighter side of it (`cssFace`).
 *
 * A whole number, because a pattern is a cache key and an fc-match of its
 * own: the weights an axis is animated through then share the ones they
 * round to.
 */
function normalizeWeight(weight) {
  if (weight === undefined) return undefined;
  if (weight === 'normal') return REGULAR;
  if (weight === 'bold') return 200;
  const n = parseInt(weight, 10);
  if (Number.isNaN(n)) return undefined;
  const css = Math.min(1000, Math.max(1, n));
  let i = 1;
  while (css > cssToFcWeight[i][0]) i++;
  const [lighterCss, lighter] = cssToFcWeight[i - 1];
  const [heavierCss, heavier] = cssToFcWeight[i];
  return Math.round(lighter + ((heavier - lighter) * (css - lighterCss)) / (heavierCss - lighterCss));
}
