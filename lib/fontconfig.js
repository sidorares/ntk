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

// css weight -> fontconfig weight constants
const cssToFcWeight = {
  100: 0, // thin
  200: 40, // extralight
  300: 50, // light
  400: 80, // regular
  500: 100, // medium
  600: 180, // demibold
  700: 200, // bold
  800: 205, // extrabold
  900: 210 // black
};

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

function patternFor({ family, weight, style }) {
  let fc = family || 'sans-serif';
  const fcWeight = normalizeWeight(weight);
  if (fcWeight !== undefined) fc += `:weight=${fcWeight}`;
  if (style && style.includes('italic')) fc += ':slant=italic';
  return fc;
}

// One command shared by the sync and async paths, so a prewarmed cache entry
// is byte-for-byte what the sync call would have computed.
//
// `%{family}` is a *list*: fontconfig keeps every name a face answers to,
// localized aliases included (`Hiragino Sans`, `ヒラギノ角ゴシック`, and the
// style-suffixed forms of both are one face), and `--format` joins them with
// commas. The fields are tab-separated so a comma inside one costs nothing,
// and `charset` stays last because it is by far the longest.
const fcMatchArgs = [
  '-s',
  '--format',
  '%{file}\t%{postscriptname}\t%{family}\t%{charset}\n'
];
const fcMatchOpts = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };

/** fc-match -s output -> candidates, filtered to formats fontkit can parse */
function parseMatches(out) {
  const list = [];
  for (const line of out.split('\n')) {
    const [path, postscriptName, family, charset] = line.split('\t');
    if (path && supported.test(path)) {
      // `families` keeps fontconfig's whole list, in its order; `family` is
      // the first of them, which is the name fontconfig leads with for the
      // current locale and the one to show in a UI.
      const families = family ? family.split(',').filter(Boolean) : [];
      list.push({
        path,
        postscriptName,
        family: families[0] || '',
        families,
        charset: charset || '',
        _ranges: null
      });
    }
  }
  return list;
}

/**
 * fc-match output -> the cached candidate list for a pattern. Throws for
 * output that parses to nothing usable, which is a fontconfig answer rather
 * than a fontconfig failure and so is diagnosed separately.
 */
function cacheMatches(fc, out) {
  const list = parseMatches(out);
  if (list.length === 0) {
    throw noFontsError(
      `fontconfig matched no font ntk can parse for "${fc}" (needs ` +
        '.ttf/.otf/.woff/.woff2/.ttc/.dfont — bitmap .pcf/.bdf fonts are not usable)'
    );
  }
  sortedCache.set(fc, list);
  return list;
}

const inflight = new Map();

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
  if (pending) return pending;
  const cp = childProcess();
  if (!cp) return Promise.reject(noFontsError(NOT_NODE));

  const promise = new Promise((resolve, reject) => {
    cp.execFile('fc-match', [...fcMatchArgs, fc], fcMatchOpts, (err, out, stderr) => {
      inflight.delete(fc);
      if (!err) return resolve(out);
      // execFile hands stderr to the callback; execFileSync hangs it on the
      // error, which is where the shared diagnosis reads it from
      if (err.stderr === undefined) err.stderr = stderr;
      reject(err);
    });
  });
  inflight.set(fc, promise);
  return promise;
}

/**
 * Seed the match cache for a pattern ahead of time, off the event loop.
 *
 * matchSortedSync is deliberately synchronous — it answers from inside text
 * layout — so the first layout for a pattern pays the fc-match spawn (~50ms)
 * as a first-paint stall. Starting the same command here with a non-blocking
 * execFile, while the X connection is still being set up, moves that cost off
 * the critical path (issue #182).
 *
 * Never rejects and never reports: a prewarm is an optimization, and an app
 * that never renders text must not crash — or even warn — over a missing
 * fc-match. An app that does render text reaches the sync path, which
 * diagnoses the failure properly. For the same reason nothing here touches
 * `unavailable`: the first sync throw keeps its original spawn error as
 * `cause`.
 *
 * A sync call racing this one wins — the child's result is discarded
 * whenever the pattern is already cached by the time it exits.
 *
 * `matchSorted` is the reporting variant: same spawn, same cache, but it
 * awaits an answer and so has somewhere to put a failure.
 *
 * @returns {Promise<void>} resolves once the cache is seeded or the attempt
 *   abandoned
 */
export function prewarm(pattern = {}) {
  const fc = patternFor(pattern);
  if (sortedCache.has(fc) || unavailable) return Promise.resolve();
  return runFcMatch(fc).then(
    (out) => {
      if (!sortedCache.has(fc)) {
        const list = parseMatches(out);
        if (list.length > 0) sortedCache.set(fc, list);
      }
    },
    () => {}
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
 *   families: string[], charset: string}>>}
 */
export async function matchSorted(pattern = {}) {
  const fc = patternFor(pattern);
  const cached = sortedCache.get(fc);
  if (cached) return cached;
  if (unavailable) throw noFontsError(unavailable);

  let out;
  try {
    out = await runFcMatch(fc);
  } catch (err) {
    throw fcMatchError(err);
  }
  // A sync call may have answered this pattern while the child ran. Its list
  // is the cached one, and candidates memoize their parsed charset, so hand
  // back what everyone else already holds rather than a fresh copy.
  return sortedCache.get(fc) ?? cacheMatches(fc, out);
}

/**
 * Full fontconfig match list for a pattern, best match first — this is the
 * system's font fallback chain. Each candidate carries the unicode coverage
 * fontconfig knows about (`charset`, lazily parsed via `charsetHas`), so a
 * fallback font for a codepoint can be chosen without opening font files —
 * and the family name fontconfig already knows, so a *list* of matches can be
 * shown without opening them either (issue #273: `sans-serif` returns 139
 * candidates here, and `Font.loadSync` is ~1.2ms a file).
 *
 * Cached per pattern; one fc-match invocation (~50ms) per distinct pattern.
 * Synchronous because its main caller is text layout, which cannot await;
 * a caller that can should use `matchSorted` and not block on the spawn.
 *
 * @returns {Array<{path, postscriptName, family: string, families: string[],
 *   charset: string}>}
 */
export function matchSortedSync(pattern) {
  const fc = patternFor(pattern);
  const cached = sortedCache.get(fc);
  if (cached) return cached;
  if (unavailable) throw noFontsError(unavailable);

  let out;
  try {
    out = execFileSync('fc-match', [...fcMatchArgs, fc], fcMatchOpts);
  } catch (err) {
    throw fcMatchError(err);
  }
  return cacheMatches(fc, out);
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
 */
export function charsetHas(candidate, codepoint) {
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

function normalizeWeight(weight) {
  if (weight === undefined) return undefined;
  if (weight === 'normal') return cssToFcWeight[400];
  if (weight === 'bold') return cssToFcWeight[700];
  const n = parseInt(weight, 10);
  if (Number.isNaN(n)) return undefined;
  return cssToFcWeight[n] !== undefined ? cssToFcWeight[n] : n;
}
