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

function patternFor({ family, weight, style }) {
  let fc = platformFamilies(family || 'sans-serif');
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

// fc -> { promise, base }: one child per pattern however many callers ask.
// `base` is where a prewarm writes its answer (`spawnToFiles`), null for a
// child whose answer only reaches the event loop.
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

// What a prewarm's child runs: fc-match with its answer in a file, then —
// once that file is complete — the exit status in another, which is what a
// synchronous caller waits for (`answerSync`). Nothing but shell builtins
// runs after fc-match, so a PATH that holds fc-match alone is enough.
const PREWARM_SCRIPT = 'fc-match "$@" > "$0.out" 2> "$0.err"; echo $? > "$0.done"';

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

/** The status and answer a prewarm left, once it has left them; null while
 *  it is still running. */
function readPrewarm(base) {
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
  const status = Number(done);
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
 * Null where files cannot be used; the caller prewarms the old way.
 */
function spawnToFiles(fc) {
  const cp = childProcess();
  const base = cp ? prewarmBase() : null;
  if (base === null) return null;
  let child;
  try {
    child = cp.spawn('/bin/sh', ['-c', PREWARM_SCRIPT, base, ...fcMatchArgs, fc], {
      stdio: 'ignore'
    });
  } catch {
    return null;
  }
  const entry = { promise: null, base, answer: undefined };
  entry.promise = new Promise((resolve, reject) => {
    const settle = () => {
      if (inflight.get(fc) === entry) inflight.delete(fc);
      // answered already, by a synchronous caller that could not wait
      if (entry.answer === undefined) {
        const left = readPrewarm(base);
        removePrewarm(base);
        entry.answer = left && left.status === 0 ? left.out : null;
      }
      if (entry.answer !== null) resolve(entry.answer);
      else reject(new Error(`fc-match for "${fc}" did not answer`));
    };
    child.once('error', settle);
    child.once('exit', settle);
  });
  inflight.set(fc, entry);
  return entry;
}

// the synchronous path's nap while a prewarm finishes
const nap = new Int32Array(new SharedArrayBuffer(4));

// How long the synchronous path waits on a prewarm before asking fc-match
// itself. fc-match answers in tens of milliseconds, and a prewarm that is
// running has a head start on any spawn that could replace it.
const PREWARM_WAIT_MS = 3000;

/**
 * An in-flight prewarm's answer, waited for synchronously: its stdout, or
 * null if it failed or took too long — the caller then spawns fc-match
 * itself, which is also what reports why.
 */
function answerSync(fc, entry) {
  const deadline = performance.now() + PREWARM_WAIT_MS;
  let left = readPrewarm(entry.base);
  while (left === null && performance.now() < deadline) {
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
 * @returns {Promise<void>} resolves once the cache is seeded or the attempt
 *   abandoned
 */
export function prewarm(pattern = {}) {
  const fc = patternFor(pattern);
  if (sortedCache.has(fc) || unavailable) return Promise.resolve();
  const pending = inflight.get(fc)?.promise ?? spawnToFiles(fc)?.promise ?? runFcMatch(fc);
  return pending.then(
    (out) => {
      if (!sortedCache.has(fc)) {
        const list = parseMatches(out);
        if (list.length > 0) sortedCache.set(fc, list);
      }
    },
    () => {}
  );
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
 * waited on five of them, 600 ms on XQuartz. Started together they run side
 * by side, and each later ask finds its answer there.
 */
export function prewarmFaces(pattern = {}) {
  const family = pattern.family || 'sans-serif';
  if (facesWarmed.has(family) || unavailable) return;
  facesWarmed.add(family);
  for (const [weight, style] of FACES) prewarm({ family, weight, style });
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
  const pending = inflight.get(fc);
  if (pending?.base) {
    // a prewarm running for the pattern: its answer, or — if it has none —
    // a spawn of our own, which is what reports why
    out = await pending.promise.catch(() => undefined);
  }
  if (out === undefined) {
    try {
      out = await runFcMatch(fc);
    } catch (err) {
      throw fcMatchError(err);
    }
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

  // The family's other faces are the next asks (`prewarmFaces`): started
  // now, they run beside this one instead of after it.
  prewarmFaces(pattern);
  const pending = inflight.get(fc);
  if (pending?.base) {
    const out = answerSync(fc, pending);
    if (out !== null) return sortedCache.get(fc) ?? cacheMatches(fc, out);
  }
  let out;
  try {
    out = execFileSync(fcMatchFile(), [...fcMatchArgs, fc], fcMatchOpts);
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
