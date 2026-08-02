// node:child_process is fetched lazily (not via static import) so that
// browser bundles of the package never try to resolve it; in non-node
// environments use a custom FontSource instead (see text/fontsource.js).
function childProcess() {
  return globalThis.process?.getBuiltinModule?.('node:child_process');
}

function execFileSync(...args) {
  const cp = childProcess();
  if (!cp) {
    throw noFontsError(
      'fontconfig matching needs node (the fc-match CLI) and this is not a node environment'
    );
  }
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
 * Did the spawn itself fail, as opposed to fc-match running and being
 * unhappy? `status` is null only when the child never ran, and these are the
 * codes that mean "no usable binary at this name" rather than a transient
 * failure worth reporting verbatim.
 */
function isSpawnFailure(err) {
  return (
    err.status == null && ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(err.code)
  );
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
const fcMatchArgs = ['-s', '--format', '%{file}\t%{postscriptname}\t%{charset}\n'];
const fcMatchOpts = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };

/** fc-match -s output -> candidates, filtered to formats fontkit can parse */
function parseMatches(out) {
  const list = [];
  for (const line of out.split('\n')) {
    const [path, postscriptName, charset] = line.split('\t');
    if (path && supported.test(path)) {
      list.push({ path, postscriptName, charset: charset || '', _ranges: null });
    }
  }
  return list;
}

const prewarming = new Map();

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
 * @returns {Promise<void>} resolves once the cache is seeded or the attempt
 *   abandoned
 */
export function prewarm(pattern = {}) {
  const fc = patternFor(pattern);
  if (sortedCache.has(fc) || unavailable) return Promise.resolve();
  const inflight = prewarming.get(fc);
  if (inflight) return inflight;
  const cp = childProcess();
  if (!cp) return Promise.resolve();

  const promise = new Promise((resolve) => {
    cp.execFile('fc-match', [...fcMatchArgs, fc], fcMatchOpts, (err, out) => {
      prewarming.delete(fc);
      if (!err && !sortedCache.has(fc)) {
        const list = parseMatches(out);
        if (list.length > 0) sortedCache.set(fc, list);
      }
      resolve();
    });
  });
  prewarming.set(fc, promise);
  return promise;
}

/**
 * Full fontconfig match list for a pattern, best match first — this is the
 * system's font fallback chain. Each candidate carries the unicode coverage
 * fontconfig knows about (`charset`, lazily parsed via `charsetHas`), so a
 * fallback font for a codepoint can be chosen without opening font files.
 *
 * Cached per pattern; one fc-match invocation (~50ms) per distinct pattern.
 *
 * @returns {Array<{path, postscriptName, charset: string}>}
 */
export function matchSortedSync(pattern) {
  const fc = patternFor(pattern);
  let list = sortedCache.get(fc);
  if (list) return list;
  if (unavailable) throw noFontsError(unavailable);

  let out;
  try {
    out = execFileSync('fc-match', [...fcMatchArgs, fc], fcMatchOpts);
  } catch (err) {
    if (err.code === 'ERR_NTK_NO_FONTS') throw err; // no child_process at all
    if (isSpawnFailure(err)) {
      unavailable = 'the fc-match CLI (fontconfig) is not installed here';
      throw noFontsError(unavailable, err);
    }
    if (err.status != null) {
      // fontconfig is installed and said no — an image with fontconfig but no
      // font package answers "No fonts installed on the system" and exits 1.
      // Not memoized: unlike a missing binary this can depend on the pattern.
      const stderr = String(err.stderr || '').trim().split('\n')[0];
      throw noFontsError(`fc-match exited ${err.status}${stderr ? `: ${stderr}` : ''}`, err);
    }
    throw err;
  }

  list = parseMatches(out);
  if (list.length === 0) {
    throw noFontsError(
      `fontconfig matched no font ntk can parse for "${fc}" (needs ` +
        '.ttf/.otf/.woff/.woff2/.ttc/.dfont — bitmap .pcf/.bdf fonts are not usable)'
    );
  }
  sortedCache.set(fc, list);
  return list;
}

/**
 * Resolve a font pattern ({family, weight, style}) to the best matching font
 * file. Returns { path, postscriptName } or throws if nothing suitable is
 * installed. Requires the fc-match CLI (fontconfig) — usual on a Linux
 * desktop, absent from slim containers and from stock macOS. Where it is
 * missing, hand ntk the fonts instead (see docs/fonts.md).
 */
export function listFontsSync(pattern) {
  const [best] = matchSortedSync(pattern);
  return { path: best.path, postscriptName: best.postscriptName };
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
