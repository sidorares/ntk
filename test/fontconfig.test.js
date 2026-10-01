import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { fcMatchFile, listFontsSync, matchSortedSync, platformFamilies } from '../lib/fontconfig.js';
import FontManager from '../lib/text/fontmanager.js';

let hasFontconfig = true;
try {
  execFileSync('fc-match', ['--version'], { stdio: 'ignore' });
} catch {
  hasFontconfig = false;
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Ask a child process to match a font with `fc-match` replaced by `stub`
 * (or absent entirely), and report the error it got.
 *
 * PATH is pointed at an empty directory rather than cleared: with no PATH at
 * all, execvp falls back to a compiled-in default path and finds the real
 * fc-match, which would quietly make these tests assert nothing.
 */
function matchWithout(stub) {
  const bin = mkdtempSync(join(tmpdir(), 'ntk-nofc-'));
  if (stub) {
    const path = join(bin, 'fc-match');
    writeFileSync(path, stub);
    chmodSync(path, 0o755);
  }
  const script = join(bin, 'probe.mjs');
  writeFileSync(
    script,
    `import FontManager from ${JSON.stringify(join(root, 'lib/text/fontmanager.js'))};\n` +
      'try {\n' +
      "  new FontManager().match('sans-serif');\n" +
      "  console.log(JSON.stringify({ ok: true }));\n" +
      '} catch (err) {\n' +
      '  console.log(JSON.stringify({ code: err.code, message: err.message, cause: err.cause?.code }));\n' +
      '}\n'
  );
  const run = spawnSync(process.execPath, [script], { env: { PATH: bin }, encoding: 'utf8' });
  assert.equal(run.status, 0, `probe failed: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

test('resolves sans-serif to a parseable font file', { skip: !hasFontconfig && 'fc-match not installed' }, () => {
  const match = listFontsSync({ family: 'sans-serif', style: 'normal', weight: 'normal' });
  assert.match(match.path, /\.(ttf|otf|woff|woff2|ttc|dfont)$/i);
});

// Issue #273: a ranked match list is the natural thing to *show*, and naming
// it by opening every file costs ~1.2ms a face over 139 of them. fontconfig
// knows the names already, so the format string asks for them.

test('a match is named, not just located', { skip: !hasFontconfig && 'fc-match not installed' }, () => {
  const match = listFontsSync({ family: 'sans-serif', style: 'normal', weight: 'normal' });
  assert.ok(match.family, 'the best match carries a family name');
  assert.equal(match.family, match.families[0], 'family is the first of the aliases');
});

test('every candidate in the chain is named', { skip: !hasFontconfig && 'fc-match not installed' }, () => {
  const ranked = matchSortedSync({ family: 'sans-serif', style: 'normal', weight: 'normal' });
  assert.ok(ranked.length > 0);
  for (const c of ranked) {
    assert.equal(typeof c.family, 'string', `${c.path} has a family`);
    assert.ok(c.family.length > 0, `${c.path} has a non-empty family`);
  }
});

test('resolves bold and italic patterns', { skip: !hasFontconfig && 'fc-match not installed' }, () => {
  const bold = listFontsSync({ family: 'sans-serif', style: 'normal', weight: 'bold' });
  const italic = listFontsSync({ family: 'sans-serif', style: 'italic', weight: 400 });
  assert.ok(bold.path);
  assert.ok(italic.path);
});

// The environments issue #121 is about. These run everywhere, with or
// without fontconfig, because they put a stub on the child's PATH — what
// used to happen here was a bare `spawnSync fc-match ENOENT` thrown from
// inside the first text layout, naming neither ntk nor fonts nor a fix.

test('a missing fc-match says what is wrong and how to fix it', () => {
  const err = matchWithout(null);
  assert.equal(err.code, 'ERR_NTK_NO_FONTS');
  assert.equal(err.cause, 'ENOENT', 'the original spawn failure is preserved');
  assert.match(err.message, /fc-match CLI \(fontconfig\) is not installed/);
  assert.match(err.message, /fontSource/, 'names the option that fixes it');
  assert.match(err.message, /apt-get|apk add/, 'and the cheaper fix where there is a package manager');
  assert.match(err.message, /docs\/fonts\.md#environments-without-fontconfig/);
});

test('fontconfig installed with no font packages is its own message', () => {
  // Alpine with fontconfig and no font package: exits 1 on stderr, so the
  // spawn succeeds and the "not installed" wording would be a lie
  const err = matchWithout('#!/bin/sh\necho "No fonts installed on the system" >&2\nexit 1\n');
  assert.equal(err.code, 'ERR_NTK_NO_FONTS');
  assert.match(err.message, /fc-match exited 1: No fonts installed on the system/);
});

test('fonts fc-match found but fontkit cannot parse are named as such', () => {
  // a bitmap-only image: fc-match exits 0 and lists .pcf files
  const err = matchWithout('#!/bin/sh\nprintf "/usr/share/fonts/misc/fixed.pcf\\tFixed\\tFixed\\t80\\t0\\t100\\t20-7e\\n"\n');
  assert.equal(err.code, 'ERR_NTK_NO_FONTS');
  assert.match(err.message, /matched no font ntk can parse/);
  assert.match(err.message, /bitmap \.pcf\/\.bdf fonts are not usable/);
});

// The prewarm (issue #182): the fc-match spawn for the default pattern runs
// asynchronously when the fontconfig source is chosen, so the first text
// layout finds the match cache already seeded instead of blocking first
// paint on a child process. These run everywhere, fc-match or not: each
// probe puts a stub on its child's PATH, and — because both exec paths read
// process.env at spawn time — swaps PATH mid-script to tell the async spawn
// apart from the sync one.

/**
 * Run a probe script in a child process. `stubs` maps a name to an fc-match
 * script body — or to `{ 'fc-match': body, 'fc-list': body }` for a
 * directory with both; each becomes its own PATH directory, exposed to the
 * probe as BIN.<name>. EMPTY is a directory with no fc-match at all (the child starts
 * there), and PATTERN is the pattern FontManager.match('sans-serif') asks
 * fontconfig for — the one the prewarm must seed for a first paint to hit it.
 * `await settled()` waits until every child the probe started has exited: a
 * prewarm's jobs run side by side, so an answer the probe did not ask for can
 * still be on its way when the ones it asked for are in.
 */
function prewarmProbe(body, stubs = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ntk-prewarm-'));
  const bins = {};
  for (const [name, stub] of Object.entries(stubs)) {
    const bin = join(dir, name);
    mkdirSync(bin);
    for (const [program, body] of Object.entries(typeof stub === 'string' ? { 'fc-match': stub } : stub)) {
      writeFileSync(join(bin, program), body);
      chmodSync(join(bin, program), 0o755);
    }
    bins[name] = bin;
  }
  const empty = join(dir, 'empty');
  mkdirSync(empty);
  const script = join(dir, 'probe.mjs');
  writeFileSync(
    script,
    `import { charsetHas, matchFirstSync, matchSorted, matchSortedSync, prewarm, prewarmPatterns } from ${JSON.stringify(join(root, 'lib/fontconfig.js'))};\n` +
      `import { FontconfigFontSource } from ${JSON.stringify(join(root, 'lib/text/fontsource.js'))};\n` +
      "import probeCp from 'node:child_process';\n" +
      'const probeSpawn = probeCp.spawn;\n' +
      'const running = new Set();\n' +
      'probeCp.spawn = (...args) => {\n' +
      '  const child = probeSpawn.apply(probeCp, args);\n' +
      '  running.add(child);\n' +
      "  const gone = () => running.delete(child);\n" +
      "  child.once('exit', gone).once('error', gone);\n" +
      '  return child;\n' +
      '};\n' +
      'const settled = async () => {\n' +
      '  while (running.size > 0) await new Promise((resolve) => setTimeout(resolve, 5));\n' +
      '};\n' +
      `const BIN = ${JSON.stringify(bins)};\n` +
      `const EMPTY = ${JSON.stringify(empty)};\n` +
      "const PATTERN = { family: 'sans-serif', weight: 400, style: 'normal' };\n" +
      body
  );
  const run = spawnSync(process.execPath, [script], { env: { PATH: empty }, encoding: 'utf8' });
  assert.equal(run.status, 0, `probe failed: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

// prints one match and logs the pattern it was asked for next to itself, a
// line an invocation, so a probe can assert a spawn did not happen rather than
// merely not crash. $0 stands in for dirname: the probe's PATH holds only stub
// directories, no coreutils.
// A line is the kind of match and its pattern: `sorted` for the fallback
// chain (fc-match -s), `best` for the one face fontconfig picks. A `best`
// answers last, on purpose: nothing a probe asks waits for it, so a count
// read before settled() missed it on a slow runner and nowhere else.
const counting = (path) =>
  '#!/bin/sh\n' +
  'kind=best; for last; do [ "$last" = -s ] && kind=sorted; done\n' +
  'if [ $kind = best ]; then { /bin/sleep 0.05 || /usr/bin/sleep 0.05; } 2>/dev/null; fi\n' +
  'echo "$kind $last" >> "$0.spawns"\n' +
  `printf "${path}\\tStub\\tStub Family\\t80\\t0\\t100\\t20-7e\\n"\n`;

/** How many lines of a counting stub's log are of each kind. */
const kinds = (lines) => ({
  sorted: lines.filter((l) => l.startsWith('sorted ')).length,
  best: lines.filter((l) => l.startsWith('best ')).length
});

test('prewarm seeds the cache the sync path reads', () => {
  const out = prewarmProbe(
    'process.env.PATH = BIN.warm;\n' +
      'await prewarm(PATTERN);\n' +
      'process.env.PATH = EMPTY; // any spawn after this point would throw ENOENT\n' +
      'const [best] = matchSortedSync(PATTERN);\n' +
      'console.log(JSON.stringify({ path: best.path }));\n',
    { warm: counting('/warmed/A.ttf') }
  );
  assert.equal(out.path, '/warmed/A.ttf');
});

test('a sync call takes the answer of a prewarm in flight rather than spawning again', () => {
  // The first text layout runs inside a render, which holds the event loop:
  // a prewarm answered only through the loop landed after it, and the
  // layout spawned fc-match a second time. Its answer is on disk too now.
  const out = prewarmProbe(
    "import { readFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      'process.env.PATH = BIN.slow;\n' +
      'const warmed = prewarm(PATTERN); // spawns now, answers in ~300ms\n' +
      'process.env.PATH = EMPTY; // a spawn of the sync call\'s own would throw ENOENT\n' +
      'const [duringRace] = matchSortedSync(PATTERN);\n' +
      'await warmed;\n' +
      'const [after] = matchSortedSync(PATTERN);\n' +
      'await settled();\n' +
      "const spawns = readFileSync(join(BIN.slow, 'fc-match.spawns'), 'utf8').trim().split('\\n');\n" +
      'console.log(JSON.stringify({ duringRace: duringRace.path, after: after.path, spawns: spawns.length }));\n',
    {
      // sleep by absolute path — the stub's PATH has no coreutils
      slow:
        '#!/bin/sh\n' +
        'echo x >> "$0.spawns"\n' +
        '{ /bin/sleep 0.3 || /usr/bin/sleep 0.3; } 2>/dev/null\n' +
        'printf "/async/SHARED.ttf\\tShared\\tShared Family\\t80\\t0\\t100\\t20-7e\\n"\n'
    }
  );
  assert.equal(out.duringRace, '/async/SHARED.ttf');
  assert.equal(out.after, '/async/SHARED.ttf');
  // the prewarm alone: the family's other faces, which the miss started,
  // ran with no fc-match on the PATH, and a spawn of the sync call's own
  // would have thrown
  assert.equal(out.spawns, 1);
});

test('a prewarm that fails leaves the sync call to ask fc-match itself', () => {
  const out = prewarmProbe(
    'process.env.PATH = BIN.unhappy;\n' +
      'const warmed = prewarm(PATTERN);\n' +
      'process.env.PATH = BIN.happy;\n' +
      'const [best] = matchSortedSync(PATTERN);\n' +
      'await warmed;\n' +
      'console.log(JSON.stringify({ path: best.path }));\n',
    {
      unhappy: '#!/bin/sh\necho "No fonts installed on the system" >&2\nexit 1\n',
      happy: '#!/bin/sh\nprintf "/sync/HAPPY.ttf\\tHappy\\tHappy Family\\t80\\t0\\t100\\t20-7e\\n"\n'
    }
  );
  assert.equal(out.path, '/sync/HAPPY.ttf');
});

test('a miss prewarms the other faces of its family', () => {
  // bold first, the way a document reaches its first heading: regular,
  // italic and bold italic start beside it and answer the asks after it
  const out = prewarmProbe(
    "import { readFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      'process.env.PATH = BIN.count;\n' +
      "const face = (weight, style) => ({ family: 'serif', weight, style });\n" +
      "matchSortedSync(face(700, 'normal'));\n" +
      'process.env.PATH = EMPTY; // any spawn after this point would throw ENOENT\n' +
      "const paths = [face(400, 'normal'), face(400, 'italic'), face(700, 'italic')].map((f) => matchSortedSync(f)[0].path);\n" +
      'await settled();\n' +
      "const spawns = readFileSync(join(BIN.count, 'fc-match.spawns'), 'utf8').trim().split('\\n');\n" +
      'console.log(JSON.stringify({ paths, spawns }));\n',
    { count: counting('/faces/A.ttf') }
  );
  assert.deepEqual(out.paths, ['/faces/A.ttf', '/faces/A.ttf', '/faces/A.ttf']);
  assert.deepEqual(kinds(out.spawns), { sorted: 4, best: 1 }, 'a chain a face, and the best of the one asked for');
  assert.ok(out.spawns.includes('best serif:weight=200'), `the asked face's best: ${out.spawns}`);
});

test("a source's prewarm has a family's faces before a layout asks for them", () => {
  // FontManager#prewarm, for a family the caller knows is coming: its four
  // faces start off the loop, and the asks after them spawn nothing
  const out = prewarmProbe(
    "import { readFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      'process.env.PATH = BIN.count;\n' +
      "new FontconfigFontSource().prewarm('monospace');\n" +
      'process.env.PATH = EMPTY; // an ask that spawned would throw ENOENT\n' +
      "const face = (weight, style) => ({ family: 'monospace', weight, style });\n" +
      "const faces = [face(400, 'normal'), face(700, 'normal'), face(400, 'italic'), face(700, 'italic')];\n" +
      'const paths = faces.map((f) => matchSortedSync(f)[0].path);\n' +
      'await settled();\n' +
      "const spawns = readFileSync(join(BIN.count, 'fc-match.spawns'), 'utf8').trim().split('\\n');\n" +
      "console.log(JSON.stringify({ paths, mono: spawns.filter((s) => s.includes('monospace')) }));\n",
    { count: counting('/faces/M.ttf') }
  );
  assert.deepEqual(out.paths, ['/faces/M.ttf', '/faces/M.ttf', '/faces/M.ttf', '/faces/M.ttf']);
  assert.deepEqual(kinds(out.mono), { sorted: 4, best: 1 }, 'a chain a face, all from the prewarm');
  assert.ok(out.mono.includes('best monospace:weight=80'), 'warmed ahead, the regular gets its best');
});

test("a source's prewarm has the faces it names before a layout asks for them", () => {
  // outside the four a family is warmed in — a menu's medium — and started
  // together, in one child
  const out = prewarmProbe(
    "import cp from 'node:child_process';\n" +
      "import { readFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      'const spawn = cp.spawn;\n' +
      'let children = 0;\n' +
      'cp.spawn = (...args) => (children++, spawn.apply(cp, args));\n' +
      'process.env.PATH = BIN.count;\n' +
      'const source = new FontconfigFontSource();\n' +
      "source.prewarm('sans-serif', [{ weight: 500, style: 'normal' }, { weight: 600, style: 'normal' }]);\n" +
      'process.env.PATH = EMPTY; // an ask that spawned would throw ENOENT\n' +
      "const paths = [500, 600].map((weight) => matchSortedSync({ family: 'sans-serif', weight, style: 'normal' })[0].path);\n" +
      'await settled();\n' +
      "const matches = readFileSync(join(BIN.count, 'fc-match.spawns'), 'utf8').trim().split('\\n');\n" +
      "console.log(JSON.stringify({ paths, children, medium: matches.filter((m) => /weight=(100|180)$/.test(m)).length }));\n",
    { count: counting('/faces/N.ttf') }
  );
  assert.deepEqual(out.paths, ['/faces/N.ttf', '/faces/N.ttf']);
  assert.equal(out.medium, 2, 'each named face matched once');
  assert.equal(out.children, 2, "the source's own four, then the two named");
});

test("a family's faces are matched from one child of the process", () => {
  // Node forks the whole process to spawn, at a cost that grows with its
  // heap, so the four matches of a family share one shell. Three families:
  // the source's own, one a caller warms, one a layout misses on.
  const out = prewarmProbe(
    "import cp from 'node:child_process';\n" +
      "import { readFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      'const spawn = cp.spawn;\n' +
      'let children = 0;\n' +
      'cp.spawn = (...args) => (children++, spawn.apply(cp, args));\n' +
      'process.env.PATH = BIN.count;\n' +
      "new FontconfigFontSource().prewarm('monospace');\n" +
      "matchSortedSync({ family: 'serif', weight: 700, style: 'normal' });\n" +
      'process.env.PATH = EMPTY; // an ask that spawned would throw ENOENT\n' +
      "const face = (family, weight, style) => ({ family, weight, style });\n" +
      'const paths = [];\n' +
      "for (const family of ['sans-serif', 'monospace', 'serif'])\n" +
      "  for (const [weight, style] of [[400, 'normal'], [700, 'normal'], [400, 'italic'], [700, 'italic']])\n" +
      '    paths.push(matchSortedSync(face(family, weight, style))[0].path);\n' +
      'await settled();\n' +
      "const matches = readFileSync(join(BIN.count, 'fc-match.spawns'), 'utf8').trim().split('\\n');\n" +
      'console.log(JSON.stringify({ paths: new Set(paths).size, answered: paths.length, children, matches }));\n',
    { count: counting('/faces/F.ttf') }
  );
  assert.equal(out.answered, 12);
  assert.equal(out.paths, 1, 'every face answered from the stub');
  assert.deepEqual(kinds(out.matches), { sorted: 12, best: 3 }, 'a chain a face, and a best a family');
  assert.equal(out.children, 3, 'one child a family');
});

test("a prewarm's answers stay in their files until a layout asks for one", () => {
  // read and parsed as each child exited, a family's answers were 9 ms of
  // the main thread while the connection was set up, for faces most apps
  // never set
  const out = prewarmProbe(
    "import fs from 'node:fs';\n" +
      'const read = fs.readFileSync;\n' +
      'let answers = 0;\n' +
      "fs.readFileSync = function (file, ...rest) { if (String(file).endsWith('.out')) answers++; return read.call(this, file, ...rest); };\n" +
      'process.env.PATH = BIN.count;\n' +
      "const face = (weight, style) => ({ family: 'serif', weight, style });\n" +
      "await prewarmPatterns([face(400, 'normal'), face(700, 'normal'), face(400, 'italic'), face(700, 'italic')]);\n" +
      'const beforeAsk = answers;\n' +
      'process.env.PATH = EMPTY; // an ask that spawned would throw ENOENT\n' +
      "const [best] = matchSortedSync(face(700, 'normal'));\n" +
      'console.log(JSON.stringify({ beforeAsk, afterAsk: answers, path: best.path }));\n',
    { count: counting('/lazy/A.ttf') }
  );
  assert.equal(out.beforeAsk, 0, 'nothing read before a layout asked');
  assert.equal(out.afterAsk, 1, 'the face asked for, and only it');
  assert.equal(out.path, '/lazy/A.ttf');
});

test('a prewarm whose child died without an answer does not keep a layout waiting', () => {
  // the stub kills the subshell it runs in, so no status is ever written;
  // the sync call must see the child is gone rather than poll for 3 s
  const out = prewarmProbe(
    'process.env.PATH = BIN.dies;\n' +
      'await prewarmPatterns([PATTERN]);\n' +
      'process.env.PATH = BIN.happy;\n' +
      'const t0 = performance.now();\n' +
      'const [best] = matchSortedSync(PATTERN);\n' +
      'console.log(JSON.stringify({ ms: performance.now() - t0, path: best.path }));\n',
    {
      dies: '#!/bin/sh\nkill -9 $PPID\n',
      happy: '#!/bin/sh\nprintf "/sync/HAPPY.ttf\\tHappy\\tHappy Family\\t80\\t0\\t100\\t20-7e\\n"\n'
    }
  );
  assert.equal(out.path, '/sync/HAPPY.ttf');
  assert.ok(out.ms < 1000, `the sync call waited ${out.ms} ms`);
});

test("a face's match reads the head of a prewarm's answer, and the chain waits for a fallback", () => {
  // an answer is the whole fallback chain with each face's coverage — 634 KB
  // for sans-serif on a Linux desktop — and a layout setting text in the
  // face needs its first line
  const out = prewarmProbe(
    "import fs from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      "const lines = ['/head/First.ttf\\tFirst\\tFirst Family\\t80\\t0\\t100\\t20-7e'];\n" +
      "for (let i = 0; i < 20000; i++) lines.push(`/chain/F${i}.ttf\\tF${i}\\tF Family\\t80\\t0\\t100\\t20-7e 80-ff`);\n" +
      "fs.writeFileSync(join(BIN.big, 'answer.txt'), lines.join('\\n') + '\\n');\n" +
      'const whole = fs.readFileSync;\n' +
      'const readSync = fs.readSync;\n' +
      'let answers = 0;\n' +
      'let headBytes = 0;\n' +
      "fs.readFileSync = function (file, ...rest) { if (String(file).endsWith('.out')) answers++; return whole.call(this, file, ...rest); };\n" +
      'fs.readSync = function (...args) { const n = readSync.apply(this, args); headBytes += n; return n; };\n' +
      'process.env.PATH = BIN.big;\n' +
      'await prewarmPatterns([PATTERN]);\n' +
      'process.env.PATH = EMPTY; // an ask that spawned would throw ENOENT\n' +
      'const first = matchFirstSync(PATTERN);\n' +
      'const beforeChain = { answers, headBytes };\n' +
      'const chain = matchSortedSync(PATTERN);\n' +
      'console.log(JSON.stringify({ first: first.path, beforeChain, answers, chain: chain.length, chainFirst: chain[0].path }));\n',
    { big: '#!/bin/sh\nexec /bin/cat "${0%/*}/answer.txt"\n' }
  );
  assert.equal(out.first, '/head/First.ttf');
  assert.equal(out.beforeChain.answers, 0, 'the answer was not read whole');
  assert.ok(out.beforeChain.headBytes < 64 * 1024, `read ${out.beforeChain.headBytes} bytes of its head`);
  assert.equal(out.chain, 20001, 'the chain, when asked, is all of it');
  assert.equal(out.chainFirst, out.first);
  assert.equal(out.answers, 1);
});

test('a layout takes the best face before its chain is in', () => {
  // fontconfig answers "which face" in about half the time it answers the
  // whole fallback chain, and a layout that asks for a family its component
  // warmed while rendering waits on the prewarm
  const out = prewarmProbe(
    'process.env.PATH = BIN.slowchain;\n' +
      "new FontconfigFontSource().prewarm('monospace');\n" +
      'process.env.PATH = EMPTY; // an ask that spawned would throw ENOENT\n' +
      "const regular = { family: 'monospace', weight: 400, style: 'normal' };\n" +
      'const t0 = performance.now();\n' +
      'const first = matchFirstSync(regular);\n' +
      'const firstMs = performance.now() - t0;\n' +
      'const chain = matchSortedSync(regular);\n' +
      'console.log(JSON.stringify({ first: first.path, firstMs, chain: chain.map((c) => c.path) }));\n',
    {
      // sleep by absolute path — the stub's PATH has no coreutils
      slowchain:
        '#!/bin/sh\n' +
        'for a; do if [ "$a" = -s ]; then\n' +
        '  { /bin/sleep 0.6 || /usr/bin/sleep 0.6; } 2>/dev/null\n' +
        '  printf "/mono/M.ttf\\tM\\tM Family\\t80\\t0\\t100\\t20-7e\\n/fallback/F.ttf\\tF\\tF Family\\t80\\t0\\t100\\t20-7e 3000-30ff\\n"\n' +
        '  exit 0\n' +
        'fi; done\n' +
        'printf "/mono/M.ttf\\tM\\tM Family\\t80\\t0\\t100\\t20-7e\\n"\n'
    }
  );
  assert.equal(out.first, '/mono/M.ttf');
  assert.ok(out.firstMs < 400, `the face came from the best job, in ${out.firstMs.toFixed(0)} ms`);
  assert.deepEqual(out.chain, ['/mono/M.ttf', '/fallback/F.ttf'], 'and the chain is the chain');
});

test("a face's match skips the head's faces ntk cannot open", () => {
  const out = prewarmProbe(
    'process.env.PATH = BIN.bitmap;\n' +
      'await prewarmPatterns([PATTERN]);\n' +
      'console.log(JSON.stringify({ first: matchFirstSync(PATTERN).path, chain: matchSortedSync(PATTERN)[0].path }));\n',
    {
      bitmap:
        '#!/bin/sh\n' +
        'printf "/misc/fixed.pcf\\tFixed\\tFixed\\t80\\t0\\t100\\t20-7e\\n/good/B.ttf\\tB\\tB Family\\t80\\t0\\t100\\t20-7e\\n"\n'
    }
  );
  assert.equal(out.first, '/good/B.ttf');
  assert.equal(out.chain, out.first);
});

test('prewarm for an already-cached pattern spawns nothing', () => {
  const out = prewarmProbe(
    "import { readFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      'process.env.PATH = BIN.count;\n' +
      'matchSortedSync(PATTERN);\n' +
      'await prewarm(PATTERN);\n' +
      'await settled();\n' +
      "const asked = readFileSync(join(BIN.count, 'fc-match.spawns'), 'utf8').trim().split('\\n');\n" +
      'console.log(JSON.stringify({ asked }));\n',
    { count: counting('/counted/A.ttf') }
  );
  // the miss started the family's other faces too; none is asked for twice
  assert.equal(new Set(out.asked).size, out.asked.length, `asked ${out.asked}`);
});

test('a missing fc-match leaves prewarm silent and the sync diagnosis intact', () => {
  const out = prewarmProbe(
    'await prewarm(PATTERN); // PATH is still EMPTY: the spawn fails with ENOENT\n' +
      'let result;\n' +
      'try {\n' +
      '  matchSortedSync(PATTERN);\n' +
      '  result = { ok: true };\n' +
      '} catch (err) {\n' +
      '  result = { code: err.code, cause: err.cause?.code };\n' +
      '}\n' +
      'console.log(JSON.stringify(result));\n'
  );
  assert.equal(out.code, 'ERR_NTK_NO_FONTS');
  assert.equal(out.cause, 'ENOENT', 'the sync throw still carries its own spawn failure');
});

test('constructing FontconfigFontSource prewarms the default family’s bold and italic too', () => {
  const out = prewarmProbe(
    'process.env.PATH = BIN.warm;\n' +
      'new FontconfigFontSource();\n' +
      'process.env.PATH = EMPTY; // any spawn after this point would throw ENOENT\n' +
      "const face = (weight, style) => ({ family: 'sans-serif', weight, style });\n" +
      "const paths = [face(700, 'normal'), face(400, 'italic'), face(700, 'italic')].map((f) => matchSortedSync(f)[0].path);\n" +
      'console.log(JSON.stringify({ paths }));\n',
    { warm: counting('/constructed/B.ttf') }
  );
  assert.deepEqual(out.paths, ['/constructed/B.ttf', '/constructed/B.ttf', '/constructed/B.ttf']);
});

test('constructing FontconfigFontSource starts the prewarm', () => {
  const out = prewarmProbe(
    'process.env.PATH = BIN.warm;\n' +
      'new FontconfigFontSource();\n' +
      'process.env.PATH = EMPTY;\n' +
      '// fire-and-forget from the constructor, so poll for the seeded cache\n' +
      'let path = null;\n' +
      'for (let i = 0; i < 200 && !path; i++) {\n' +
      '  try {\n' +
      '    path = matchSortedSync(PATTERN)[0].path;\n' +
      '  } catch {\n' +
      '    await new Promise((r) => setTimeout(r, 25));\n' +
      '  }\n' +
      '}\n' +
      'console.log(JSON.stringify({ path }));\n',
    { warm: counting('/constructed/A.ttf') }
  );
  assert.equal(out.path, '/constructed/A.ttf');
});

// Families are a list in fontconfig — localized aliases and style-suffixed
// forms of one face — and `--format` joins them with commas. Runs everywhere:
// the stub is the fc-match on the child's PATH.
test('a family list keeps its order, and the field after it still parses', () => {
  const out = prewarmProbe(
    'process.env.PATH = BIN.hiragino;\n' +
      'const [best] = matchSortedSync(PATTERN);\n' +
      'console.log(JSON.stringify({ family: best.family, families: best.families, charset: best.charset }));\n',
    {
      hiragino:
        '#!/bin/sh\n' +
        'printf "/f/Hiragino.ttc\\tHiraginoSans-W4\\tHiragino Sans,\u30d2\u30e9\u30ae\u30ce\u89d2\u30b4\u30b7\u30c3\u30af,Hiragino Sans W4\\t80\\t0\\t100\\t20-7e a0-ff\\n"\n'
    }
  );
  assert.equal(out.family, 'Hiragino Sans');
  assert.deepEqual(out.families, ['Hiragino Sans', '\u30d2\u30e9\u30ae\u30ce\u89d2\u30b4\u30b7\u30c3\u30af', 'Hiragino Sans W4']);
  assert.equal(out.charset, '20-7e a0-ff', 'charset is still the last field');
});

test('a face fontconfig cannot name is not a parse failure', () => {
  const out = prewarmProbe(
    'process.env.PATH = BIN.nameless;\n' +
      'const [best] = matchSortedSync(PATTERN);\n' +
      'console.log(JSON.stringify({ path: best.path, family: best.family, families: best.families }));\n',
    { nameless: '#!/bin/sh\nprintf "/f/A.ttf\\tA\\t\\t80\\t0\\t100\\t20-7e\\n"\n' }
  );
  assert.equal(out.path, '/f/A.ttf', 'the match is still usable');
  assert.equal(out.family, '');
  assert.deepEqual(out.families, []);
});

// The async entry point (issue #274): the same fc-match, the same cache, for
// a caller that is not text layout — a font picker matching as the user
// types has no reason to block the event loop for ~100ms per new pattern.

test('matchSorted answers off the event loop and seeds the sync cache', () => {
  const out = prewarmProbe(
    "import { readFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      'process.env.PATH = BIN.count;\n' +
      'const list = await matchSorted(PATTERN);\n' +
      'process.env.PATH = EMPTY; // any spawn after this point would throw ENOENT\n' +
      'const [best] = matchSortedSync(PATTERN);\n' +
      'await settled();\n' +
      "const spawns = readFileSync(join(BIN.count, 'fc-match.spawns'), 'utf8').trim().split('\\n').length;\n" +
      'console.log(JSON.stringify({ async: list[0].path, sync: best.path, spawns }));\n',
    { count: counting('/awaited/A.ttf') }
  );
  assert.equal(out.async, '/awaited/A.ttf');
  assert.equal(out.sync, '/awaited/A.ttf', 'the sync path answers from the cache it seeded');
  assert.equal(out.spawns, 1);
});

test('matchSorted joins an in-flight prewarm rather than spawning again', () => {
  const out = prewarmProbe(
    "import { readFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      'process.env.PATH = BIN.slow;\n' +
      'const warmed = prewarm(PATTERN); // spawns now, answers in ~300ms\n' +
      'const list = await matchSorted(PATTERN); // must wait on that child, not start one\n' +
      'await warmed;\n' +
      'await settled();\n' +
      "const spawns = readFileSync(join(BIN.slow, 'fc-match.spawns'), 'utf8').trim().split('\\n').length;\n" +
      'console.log(JSON.stringify({ path: list[0].path, spawns }));\n',
    {
      slow:
        '#!/bin/sh\n' +
        'echo x >> "$0.spawns"\n' +
        '{ /bin/sleep 0.3 || /usr/bin/sleep 0.3; } 2>/dev/null\n' +
        'printf "/shared/A.ttf\\tShared\\tShared Family\\t80\\t0\\t100\\t20-7e\\n"\n'
    }
  );
  assert.equal(out.path, '/shared/A.ttf');
  assert.equal(out.spawns, 1, 'one child serves both callers');
});

// The error path is the point of the exercise: prewarm deliberately stays
// silent, so `await prewarm(); matchSortedSync()` would pay a *blocking*
// spawn exactly when fontconfig is missing — the failure case blocking is
// backwards. matchSorted reports its own failure instead.
test('a missing fc-match rejects matchSorted, and is not re-spawned after', () => {
  const out = prewarmProbe(
    '// PATH is still EMPTY: the spawn fails with ENOENT\n' +
      'const results = [];\n' +
      'try {\n' +
      '  await matchSorted(PATTERN);\n' +
      '  results.push({ ok: true });\n' +
      '} catch (err) {\n' +
      '  results.push({ code: err.code, cause: err.cause?.code });\n' +
      '}\n' +
      'try {\n' +
      '  matchSortedSync(PATTERN);\n' +
      '  results.push({ ok: true });\n' +
      '} catch (err) {\n' +
      '  results.push({ code: err.code, cause: err.cause?.code });\n' +
      '}\n' +
      'console.log(JSON.stringify(results));\n'
  );
  const [async_, sync] = out;
  assert.equal(async_.code, 'ERR_NTK_NO_FONTS');
  assert.equal(async_.cause, 'ENOENT', 'the rejection carries the original spawn failure');
  assert.equal(sync.code, 'ERR_NTK_NO_FONTS');
  assert.equal(
    sync.cause,
    undefined,
    'the async failure memoized the missing binary: no second spawn, blocking or otherwise'
  );
});

// execFileSync reports an exit code in `status`, execFile in `code` — the
// same diagnosis has to read both, or a fontconfig that ran and said no
// surfaces as a raw exec error from the async path.
test('matchSorted reports an unhappy fc-match the same way the sync path does', () => {
  const out = prewarmProbe(
    'process.env.PATH = BIN.nofonts;\n' +
      'let result;\n' +
      'try {\n' +
      '  await matchSorted(PATTERN);\n' +
      '  result = { ok: true };\n' +
      '} catch (err) {\n' +
      '  result = { code: err.code, message: err.message };\n' +
      '}\n' +
      'console.log(JSON.stringify(result));\n',
    { nofonts: '#!/bin/sh\necho "No fonts installed on the system" >&2\nexit 1\n' }
  );
  assert.equal(out.code, 'ERR_NTK_NO_FONTS');
  assert.match(out.message, /fc-match exited 1: No fonts installed on the system/);
});

test('matchSorted rejects for matches ntk cannot parse', () => {
  const out = prewarmProbe(
    'process.env.PATH = BIN.bitmap;\n' +
      'let result;\n' +
      'try {\n' +
      '  await matchSorted(PATTERN);\n' +
      '  result = { ok: true };\n' +
      '} catch (err) {\n' +
      '  result = { code: err.code, message: err.message };\n' +
      '}\n' +
      'console.log(JSON.stringify(result));\n',
    { bitmap: '#!/bin/sh\nprintf "/usr/share/fonts/misc/fixed.pcf\\tFixed\\tFixed\\t80\\t0\\t100\\t20-7e\\n"\n' }
  );
  assert.equal(out.code, 'ERR_NTK_NO_FONTS');
  assert.match(out.message, /matched no font ntk can parse/);
});

test('FontconfigFontSource.matchSortedAsync is the same list as matchSorted', () => {
  const out = prewarmProbe(
    'process.env.PATH = BIN.warm;\n' +
      'const source = new FontconfigFontSource();\n' +
      'const list = await source.matchSortedAsync(PATTERN);\n' +
      'process.env.PATH = EMPTY;\n' +
      'const same = source.matchSorted(PATTERN) === list;\n' +
      'console.log(JSON.stringify({ path: list[0].path, same }));\n',
    { warm: counting('/source/A.ttf') }
  );
  assert.equal(out.path, '/source/A.ttf');
  assert.equal(out.same, true, 'both spellings answer with the one cached list');
});

test('the docs anchor the error points at exists', () => {
  // nothing else in CI checks a doc anchor referenced from a string literal
  const docs = readFileSync(join(root, 'docs/fonts.md'), 'utf8');
  assert.match(docs, /^## Environments without fontconfig$/m);
});

// On a Mac, Homebrew's fontconfig answers `sans-serif` with Hiragino Sans, a
// Japanese face whose Cyrillic and Greek are full-width: a map label "Мост"
// came out as four em-wide cells, М о с т. The advances were right — CoreText
// sets that face exactly the same way — the face was wrong. Browsers give
// sans-serif Helvetica there, and so does ntk now; everywhere else the list
// reaches fc-match untouched.

test('on macOS, sans-serif names Helvetica ahead of itself', () => {
  assert.equal(platformFamilies('sans-serif', 'darwin'), 'Helvetica,sans-serif');
  assert.equal(platformFamilies('Inter, sans-serif', 'darwin'), 'Inter,Helvetica,sans-serif');
  assert.equal(
    platformFamilies('SANS-SERIF', 'darwin'),
    'Helvetica,SANS-SERIF',
    'a generic is a keyword, and keywords are case-insensitive'
  );
  assert.equal(
    platformFamilies('Helvetica Neue, sans-serif', 'darwin'),
    'Helvetica Neue,Helvetica,sans-serif'
  );
  assert.equal(
    platformFamilies('Helvetica, sans-serif', 'darwin'),
    'Helvetica, sans-serif',
    'a list that already names it first needs nothing'
  );
});

test('only that generic, and only on macOS', () => {
  // serif and monospace land on PT Serif and Andale Mono there, which set
  // Cyrillic and Greek at their own widths — nothing to correct
  for (const family of ['serif', 'monospace', 'Inter', 'Menlo, monospace']) {
    assert.equal(platformFamilies(family, 'darwin'), family);
  }
  for (const platform of ['linux', 'freebsd', 'win32']) {
    assert.equal(platformFamilies('sans-serif', platform), 'sans-serif');
    assert.equal(platformFamilies('Inter, sans-serif', platform), 'Inter, sans-serif');
  }
});

// The pattern fc-match is actually handed, through the same code path a
// first text layout takes — so the answer above is the one fontconfig sees,
// and the prewarm and the sync lookup still agree on the cache key.
test('the pattern fc-match receives is the platform list', () => {
  const out = prewarmProbe(
    "import { readFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      'process.env.PATH = BIN.args;\n' +
      'await prewarm(PATTERN);\n' +
      'process.env.PATH = EMPTY; // the sync lookup must hit what the prewarm seeded\n' +
      'const [best] = matchSortedSync(PATTERN);\n' +
      "const patterns = readFileSync(join(BIN.args, 'fc-match.args'), 'utf8').trim().split('\\n');\n" +
      'console.log(JSON.stringify({ patterns, path: best.path }));\n',
    {
      // records its last argument, which is the pattern
      args:
        '#!/bin/sh\n' +
        'for a in "$@"; do last="$a"; done\n' +
        'echo "$last" >> "$0.args"\n' +
        'printf "/f/A.ttf\\tA\\tA\\t80\\t0\\t100\\t20-7e\\n"\n'
    }
  );
  // each name escaped as fontconfig's syntax reads it: a `-` starts a size
  const family = process.platform === 'darwin' ? 'Helvetica,sans\\-serif' : 'sans\\-serif';
  assert.deepEqual(out.patterns, [`${family}:weight=80`]);
  assert.equal(out.path, '/f/A.ttf');
});

// fontconfig's weights are not CSS's: regular is 80 there and black 210. A
// weight that is not one of the hundreds went over as it was, so 450 was a
// weight past twice black, and the face was the heaviest the family has:
// text a page sets at `font-weight: 450` came out in Arial Bold, where a
// browser sets it in Arial Regular.
test('a weight between two of the hundreds is between their weights in the pattern', () => {
  const cases = [
    [450, 90], // halfway from regular (80) to medium (100)
    [550, 140],
    [650, 190],
    [425, 85],
    [850, 208], // 207.5: a pattern's weight is a whole number
    ['450', 90],
    // fontconfig's own table, which a face's OS/2 weight goes through:
    // demilight and book sit between light and regular, so a face of 350
    // is 55 and an ask for 340 is on its lighter side
    [350, 55],
    [380, 75],
    [340, 54],
    // CSS takes 1 to 1000, and so does the table: extrablack is 215
    [950, 213],
    [1000, 215],
    [1, 0],
    // the hundreds and the keywords, as they were
    [400, 80],
    [500, 100],
    ['600', 180],
    ['normal', 80],
    ['bold', 200]
  ];
  const out = prewarmProbe(
    "import { readFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      'process.env.PATH = BIN.args;\n' +
      // a family a case, so that two cases with one answer are two patterns:
      // a pattern already asked for is not asked for again
      `for (const [i, weight] of ${JSON.stringify(cases.map(([weight]) => weight))}.entries()) {\n` +
      "  await prewarm({ family: 'F' + i, weight, style: 'normal' });\n" +
      '}\n' +
      "const patterns = readFileSync(join(BIN.args, 'fc-match.args'), 'utf8').trim().split('\\n');\n" +
      'console.log(JSON.stringify({ patterns }));\n',
    {
      args: '#!/bin/sh\nfor a in "$@"; do last="$a"; done\necho "$last" >> "$0.args"\nprintf "/f/A.ttf\\tA\\tA\\t80\\t0\\t100\\t20-7e\\n"\n'
    }
  );
  assert.deepEqual(
    out.patterns,
    cases.map(([, fcWeight], i) => `F${i}:weight=${fcWeight}`)
  );
});

let hasHelvetica = false;
if (hasFontconfig && process.platform === 'darwin') {
  try {
    const family = execFileSync('fc-match', ['--format', '%{family}', 'Helvetica'], { encoding: 'utf8' });
    hasHelvetica = /^Helvetica(,|$)/.test(family);
  } catch {
    // no answer is no Helvetica
  }
}

test(
  'on macOS, sans-serif sets Cyrillic at its own widths, and CJK still falls back',
  { skip: !hasHelvetica && 'needs macOS, fontconfig and Helvetica' },
  () => {
    const fonts = new FontManager();
    const style = { family: 'sans-serif', size: 22, weight: 400, style: 'normal' };
    const face = fonts.match('sans-serif', style);
    assert.equal(face.familyName, 'Helvetica');

    // Hiragino Sans set this word as four 22px cells, 88px; Helvetica covers
    // Cyrillic itself, and the run is as wide as its own advances say
    const shaped = fonts.shape('Мост', style);
    assert.equal(shaped.runs.length, 1);
    assert.equal(shaped.runs[0].font, face, 'no fallback needed');
    const own = [...'Мост'].reduce((sum, ch) => sum + face.advanceOf(face.glyphIdFor(ch.codePointAt(0)), 22), 0);
    assert.ok(Math.abs(shaped.width - own) <= 1, `${shaped.width}px against its own ${own}px`);
    assert.ok(shaped.width < 4 * 22 * 0.75, `proportional, not em-wide cells: ${shaped.width}px`);

    // a codepoint Helvetica lacks still goes down fontconfig's sans-serif list
    const fallback = fonts.shape('字', style).runs[0].font;
    assert.notEqual(fallback, face);
    assert.ok(fallback.hasGlyph(0x5b57), `${fallback.familyName} covers 字`);
  }
);

// Spawned by its bare name, fc-match was found by the system's PATH search,
// which on macOS spawns in every directory ahead of the one that has it: 45
// ms a spawn where the path itself takes 15, inside the first text layout.
test('fc-match is spawned by its path, found once for each PATH', () => {
  const env = process.env;
  const saved = env.PATH;
  const empty = mkdtempSync(join(tmpdir(), 'ntk-fcpath-empty-'));
  const decoy = mkdtempSync(join(tmpdir(), 'ntk-fcpath-decoy-'));
  const bin = mkdtempSync(join(tmpdir(), 'ntk-fcpath-bin-'));
  // what is not a program to run is passed over: a directory by the name,
  // and a file nobody may execute
  mkdirSync(join(decoy, 'fc-match'));
  const later = mkdtempSync(join(tmpdir(), 'ntk-fcpath-later-'));
  writeFileSync(join(later, 'fc-match'), '#!/bin/sh\n');
  chmodSync(join(later, 'fc-match'), 0o644);
  writeFileSync(join(bin, 'fc-match'), '#!/bin/sh\n');
  chmodSync(join(bin, 'fc-match'), 0o755);
  try {
    env.PATH = [empty, decoy, later, bin].join(':');
    assert.equal(fcMatchFile(), join(bin, 'fc-match'));
    // and looked up again when PATH changes
    env.PATH = empty;
    assert.equal(fcMatchFile(), 'fc-match', 'not found: the bare name, which reports as before');
    env.PATH = bin;
    assert.equal(fcMatchFile(), join(bin, 'fc-match'));
  } finally {
    env.PATH = saved;
  }
});


test('fontconfig: a family name with a hyphen in it does not cut the list after it short', { skip: !hasFontconfig }, () => {
  // In fontconfig's pattern syntax a `-` starts the point size. Unescaped,
  // `tablet-gothic-condensed, "arial narrow", arial` was the family `tablet`
  // and a size fc-match could not read, and every family after it was lost:
  // the face was fontconfig's default, where a browser takes the next family
  // the list names that is installed
  const [installed] = matchSortedSync({ family: 'serif', style: 'normal', weight: 'normal' });
  assert.ok(installed?.family, 'fontconfig has a serif face');
  const [first] = matchSortedSync({
    family: `no-such-hyphenated-family, "${installed.family}"`,
    style: 'normal',
    weight: 'normal'
  });
  assert.equal(first?.family, installed.family, 'the family after the unknown one is the face');
});

test('fontconfig: a weight of 450 is not the bold of a family', { skip: !hasFontconfig && 'fc-match not installed' }, (t) => {
  // what fontconfig makes of the weight the pattern carries: the face
  // nearest it, which for 450 is the regular — or a medium, where the family
  // has one, as CSS has it too. As `weight=450` it was the bold.
  const face = (family, weight) => {
    const [best] = matchSortedSync({ family, weight, style: 'normal' });
    return `${best.path} ${best.postscriptName}`;
  };
  const [{ family }] = matchSortedSync({ family: 'sans-serif', weight: 400, style: 'normal' });
  const regular = face(family, 400);
  const medium = face(family, 500);
  const bold = face(family, 700);
  if (bold === regular || bold === medium) return t.skip(`${family} has no bold of its own`);
  assert.ok([regular, medium].includes(face(family, 450)), `${family} at 450: ${face(family, 450)}`);
});

// CSS Fonts 4 §5.2 looks for a weight in a direction first: for 400 to 500,
// up to 500, then lighter, then heavier; below 400 lighter first; above 500
// heavier first. Fontconfig takes the face nearest in weight on its own scale,
// after the slant and before the width, so 520 in Arial was its regular and
// 900 in Helvetica Neue its condensed black. These run everywhere: an
// fc-match stub that answers the way fontconfig does, and an fc-list stub
// listing the faces, as fontconfig's own would.

// fontconfig's weight for a face's OS/2 weight (FcWeightFromOpenType), for
// the weights the families below have
const FC_WEIGHT = { 100: 0, 200: 40, 275: 47.5, 300: 50, 400: 80, 500: 100, 600: 180, 700: 200, 800: 205, 900: 210 };

/** a face as the stubs list it: weight in CSS's terms, `[lo, hi]` for a variable font's range */
const face = (path, ps, families, weight, slant = 0, width = 100) => ({ path, ps, families, weight, slant, width });

const ARIAL = [face('/f/Arial.ttf', 'ArialMT', 'Arial', 400), face('/f/Arial Bold.ttf', 'Arial-BoldMT', 'Arial', 700)];
const HELVETICA = [
  face('/f/Helvetica.ttc', 'Helvetica-Light', 'Helvetica', 300),
  face('/f/Helvetica.ttc', 'Helvetica', 'Helvetica', 400),
  face('/f/Helvetica.ttc', 'Helvetica-Bold', 'Helvetica', 700),
  face('/f/Helvetica.ttc', 'Helvetica-LightOblique', 'Helvetica', 300, 110),
  face('/f/Helvetica.ttc', 'Helvetica-Oblique', 'Helvetica', 400, 110),
  face('/f/Helvetica.ttc', 'Helvetica-BoldOblique', 'Helvetica', 700, 110)
];
const HELVETICA_NEUE = [
  ['UltraLight', 100],
  ['Thin', 200],
  ['Light', 300],
  ['', 400],
  ['Medium', 500],
  ['Bold', 700]
].map(([style, weight]) => face('/f/HelveticaNeue.ttc', `HelveticaNeue${style && '-' + style}`, 'Helvetica Neue', weight))
  .concat([
    face('/f/HelveticaNeue.ttc', 'HelveticaNeue-CondensedBold', 'Helvetica Neue', 700, 0, 75),
    face('/f/HelveticaNeue.ttc', 'HelveticaNeue-CondensedBlack', 'Helvetica Neue', 900, 0, 75)
  ]);
const AVENIR_NEXT = [
  face('/f/Avenir Next.ttc', 'AvenirNext-UltraLight', 'Avenir Next,Avenir Next Ultra Light', 275),
  face('/f/Avenir Next.ttc', 'AvenirNext-UltraLightItalic', 'Avenir Next,Avenir Next Ultra Light', 275, 100),
  face('/f/Avenir Next.ttc', 'AvenirNext-Regular', 'Avenir Next', 400),
  face('/f/Avenir Next.ttc', 'AvenirNext-Medium', 'Avenir Next,Avenir Next Medium', 500),
  face('/f/Avenir Next.ttc', 'AvenirNext-DemiBold', 'Avenir Next,Avenir Next Demi Bold', 600),
  face('/f/Avenir Next.ttc', 'AvenirNext-Bold', 'Avenir Next', 700),
  face('/f/Avenir Next.ttc', 'AvenirNext-Heavy', 'Avenir Next,Avenir Next Heavy', 900)
];
// no italics, and fontconfig answers an italic ask with an upright face it
// will slant itself — 90-synthetic.conf says so in the answer: oblique
const HIRAGINO = [
  ['W0', 100],
  ['W1', 200],
  ['W3', 300],
  ['W4', 400],
  ['W6', 600]
].map(([w, weight]) => face('/f/Hiragino.ttc', `HiraginoSans-${w}`, 'Hiragino Sans', weight));
// a variable font beside its named instances, all one file
const STIX = [
  face('/f/STIXTwoText.ttf', '', 'STIX Two Text', [400, 700]),
  face('/f/STIXTwoText.ttf', 'STIXTwoText', 'STIX Two Text', 400),
  face('/f/STIXTwoText.ttf', 'STIXTwoTextRoman-Medium', 'STIX Two Text', 500),
  face('/f/STIXTwoText.ttf', 'STIXTwoTextRoman-Bold', 'STIX Two Text', 700)
];

const fcWeightOf = (weight) =>
  Array.isArray(weight) ? `[${FC_WEIGHT[weight[0]]} ${FC_WEIGHT[weight[1]]}]` : String(FC_WEIGHT[weight]);
const fcRange = (weight) => (Array.isArray(weight) ? weight.map((w) => FC_WEIGHT[w]) : [FC_WEIGHT[weight], FC_WEIGHT[weight]]);

/**
 * The face fontconfig answers with: the family's, a named instance before a
 * variable font's own pattern, then by slant, then by the weight nearest,
 * then by width, the first of equals — the order its matcher compares them
 * in.
 */
function fontconfigPick(faces, name, fcWeight, italic) {
  const asked = italic ? 100 : 0;
  const away = ([lo, hi], v) => (v < lo ? lo - v : v > hi ? v - hi : 0);
  let best = null;
  let bestKey = null;
  for (const f of faces.filter((f) => f.families.split(',').includes(name))) {
    const key = [
      Array.isArray(f.weight) ? 1 : 0,
      Math.abs(f.slant - asked),
      away(fcRange(f.weight), fcWeight),
      Math.abs(f.width - 100)
    ];
    const before = bestKey && key.findIndex((k, i) => k !== bestKey[i]);
    if (!best || (before !== -1 && key[before] < bestKey[before])) [best, bestKey] = [f, key];
  }
  return best;
}

/**
 * The faces CSS Fonts 4 §5.2 picks — font-stretch, then font-style, then
 * font-weight — computed on the faces' own CSS weights, nothing of ntk's or
 * fontconfig's in it. More than one where they tie.
 */
function cssPicks(faces, name, weight, italic) {
  let set = faces.filter((f) => f.families.split(',').includes(name));
  if (set.some((f) => f.width === 100)) set = set.filter((f) => f.width === 100);
  const slant = (italic ? [100, 110, 0] : [0, 110, 100]).find((s) => set.some((f) => f.slant === s));
  set = set.filter((f) => f.slant === slant);
  const range = (f) => (Array.isArray(f.weight) ? f.weight : [f.weight, f.weight]);
  // a face's place in the order CSS looks in, lowest first
  const place = (f) => {
    const [lo, hi] = range(f);
    if (lo <= weight && weight <= hi) return 0;
    const x = hi < weight ? hi : lo;
    if (weight >= 400 && weight <= 500) {
      if (x > weight && x <= 500) return x - weight;
      return x < weight ? 1000 + weight - x : 2000 + x - weight;
    }
    if (weight < 400) return x < weight ? weight - x : 1000 + x - weight;
    return x > weight ? x - weight : 1000 + weight - x;
  };
  const first = Math.min(...set.map(place));
  return set.filter((f) => place(f) === first);
}

const fcLine = (f, slant = f.slant, charset = '20-7e') =>
  `${f.path}\\t${f.ps}\\t${f.families}\\t${fcWeightOf(f.weight)}\\t${slant}\\t${f.width}\\t${charset}`;

/**
 * An fc-match that answers for `names` the way fontconfig does
 * (`fontconfigPick`), at the CSS `weights` asked and a family's four faces',
 * in `styles`; `-s` adds a fallback face behind it, as a chain would have.
 * It logs each pattern asked, and `synthetic` slants an upright face matched
 * for an italic ask in its answer, as 90-synthetic.conf does.
 */
function fontconfigStub(faces, names, { weights = WEIGHTS, styles = ['normal'], synthetic = false } = {}) {
  let sh =
    '#!/bin/sh\n' +
    'kind=best; for last; do [ "$last" = -s ] && kind=sorted; done\n' +
    'echo "$kind $last" >> "$0.spawns"\n' +
    'case "$last" in\n';
  const asked = [...new Set([...weights, 400, 700].map(patternWeight))];
  for (const name of names) {
    for (const italic of styles.map((style) => style === 'italic')) {
      for (const w of asked) {
        const f = fontconfigPick(faces, name, w, italic);
        const slant = synthetic && italic && f.slant === 0 ? 110 : f.slant;
        sh += `'${name}:weight=${w}${italic ? ':slant=italic' : ''}') printf '${fcLine(f, slant)}\\n' ;;\n`;
      }
    }
  }
  sh += '*) exit 1 ;;\nesac\n';
  sh += `[ $kind = sorted ] && printf '/f/Fallback.ttf\\tFallback\\tFallback\\t80\\t0\\t100\\t3000-30ff\\n'\n`;
  return sh;
}

/** an fc-list that lists `faces` in the fields ntk asks for, after `delay` seconds */
const fcListStub = (faces, delay = 0) =>
  '#!/bin/sh\n' +
  (delay ? `{ /bin/sleep ${delay} || /usr/bin/sleep ${delay}; } 2>/dev/null\n` : '') +
  `printf '${faces.map((f) => fcLine(f).split('\\t').slice(0, 6).join('\\t')).join('\\n')}\\n'\n`;

/**
 * The probe's asks, and `faces`: what each came back as, from the async
 * match (side by side, for time) and from the sync ones a layout makes,
 * which answer from what it cached.
 */
const sweep = (asks) =>
  `const asks = ${JSON.stringify(asks)};\n` +
  'const lists = await Promise.all(asks.map(([family, weight, style]) => matchSorted({ family, weight, style })));\n' +
  'const faces = asks.map(([family, weight, style], i) => [\n' +
  '  lists[i][0].postscriptName,\n' +
  '  matchFirstSync({ family, weight, style }).postscriptName,\n' +
  '  matchSortedSync({ family, weight, style })[0].postscriptName\n' +
  ']);\n';

const WEIGHTS = Array.from({ length: 81 }, (_, i) => 100 + i * 10);

/** the weight a pattern carries for a CSS weight: fontconfig's table, rounded (the test above) */
function patternWeight(css) {
  const table = [[0, 0], [100, 0], [200, 40], [300, 50], [350, 55], [380, 75], [400, 80], [500, 100], [600, 180], [700, 200], [800, 205], [900, 210], [1000, 215]];
  let i = 1;
  while (css > table[i][0]) i++;
  const [[a, fa], [b, fb]] = [table[i - 1], table[i]];
  return Math.round(fa + ((fb - fa) * (css - a)) / (b - a));
}

test('a weight is the face CSS picks, looking in its direction first, not the nearest', () => {
  const families = [
    ['Arial', ARIAL],
    ['Helvetica', HELVETICA],
    ['Helvetica Neue', HELVETICA_NEUE],
    ['Avenir Next', AVENIR_NEXT]
  ];
  const all = families.flatMap(([, faces]) => faces);
  const asks = families.flatMap(([family]) => WEIGHTS.map((weight) => [family, weight, 'normal']));
  const out = prewarmProbe(
    'process.env.PATH = BIN.fc;\n' + sweep(asks) + 'console.log(JSON.stringify({ faces }));\n',
    {
      fc: {
        'fc-match': fontconfigStub(all, families.map(([family]) => family)),
        'fc-list': fcListStub(all)
      }
    }
  );
  const wrong = [];
  let corrected = 0;
  asks.forEach(([family, weight], i) => {
    const faces = families.find(([f]) => f === family)[1];
    const want = cssPicks(faces, family, weight, false).map((f) => f.ps);
    const [head, ...sync] = out.faces[i];
    if (!want.includes(head) || sync.some((s) => s !== head)) wrong.push(`${family} ${weight}: ${out.faces[i]}, CSS ${want}`);
    // the weights the issue measured, where fontconfig's nearest is not CSS's
    if (!want.includes(fontconfigPick(faces, family, patternWeight(weight), false).ps)) corrected++;
  });
  assert.deepEqual(wrong, []);
  assert.ok(corrected >= 60, `the sweep covers the weights fontconfig alone gets wrong (${corrected})`);
  const at = (family, weight) => out.faces[asks.findIndex(([f, w]) => f === family && w === weight)][0];
  assert.equal(at('Arial', 520), 'Arial-BoldMT', 'past 500 CSS looks heavier first');
  assert.equal(at('Helvetica', 380), 'Helvetica-Light', 'below 400 lighter first');
  assert.equal(at('Helvetica Neue', 420), 'HelveticaNeue-Medium', 'between 400 and 500, up to 500 first');
  assert.equal(at('Helvetica Neue', 850), 'HelveticaNeue-Bold', 'the normal width before any weight of another');
  assert.equal(at('Avenir Next', 800), 'AvenirNext-Heavy', 'a hundred fontconfig ties on is CSS’s heavier one');
});

test('an italic ask takes oblique next, and upright in a family with neither', () => {
  // Hiragino Sans has no slanted faces, and fontconfig's answer says oblique
  // for an upright face it will slant itself: ranked by that, W1 beat the
  // family's own W0 at 160
  const families = [
    ['Helvetica', HELVETICA],
    ['Avenir Next', AVENIR_NEXT],
    ['Hiragino Sans', HIRAGINO]
  ];
  const all = families.flatMap(([, faces]) => faces);
  const asks = families.flatMap(([family]) => WEIGHTS.map((weight) => [family, weight, 'italic']));
  const out = prewarmProbe('process.env.PATH = BIN.fc;\n' + sweep(asks) + 'console.log(JSON.stringify({ faces }));\n', {
    fc: {
      'fc-match': fontconfigStub(all, families.map(([family]) => family), { styles: ['italic'], synthetic: true }),
      'fc-list': fcListStub(all)
    }
  });
  const wrong = [];
  asks.forEach(([family, weight], i) => {
    const want = cssPicks(families.find(([f]) => f === family)[1], family, weight, true).map((f) => f.ps);
    const [head, ...sync] = out.faces[i];
    if (!want.includes(head) || sync.some((s) => s !== head)) wrong.push(`${family} ${weight}: ${out.faces[i]}, CSS ${want}`);
  });
  assert.deepEqual(wrong, []);
  const at = (family, weight) => out.faces[asks.findIndex(([f, w]) => f === family && w === weight)][0];
  assert.equal(at('Hiragino Sans', 160), 'HiraginoSans-W0');
  assert.equal(at('Helvetica', 380), 'Helvetica-LightOblique');
});

test('without fc-list there is no census, and the face is fontconfig’s nearest', () => {
  // the census is an fc-list beside the prewarm's fc-matches: where there is
  // none, nothing fails, and the answer is the one fontconfig gives
  const out = prewarmProbe(
    'process.env.PATH = BIN.fc;\n' + sweep([['Arial', 520, 'normal'], ['Arial', 700, 'normal']]) + 'console.log(JSON.stringify({ faces }));\n',
    { fc: fontconfigStub(ARIAL, ['Arial']) }
  );
  assert.deepEqual(out.faces, [
    ['ArialMT', 'ArialMT', 'ArialMT'],
    ['Arial-BoldMT', 'Arial-BoldMT', 'Arial-BoldMT']
  ]);
});

test('a face fontconfig can be shown to pick as CSS does never waits for the census', () => {
  // The census lists every face, 45 ms on a Mac, and starts beside the first
  // prewarm. A face fontconfig answers at the weight asked — 400 and 700 in
  // a family with both — is CSS's whatever else the family has, so the
  // first layout does not wait on it; 520, which fontconfig answers with the
  // regular, waits, and is the bold.
  const out = prewarmProbe(
    'process.env.PATH = BIN.fc;\n' +
      'const timed = (weight) => {\n' +
      '  const t0 = performance.now();\n' +
      "  const { postscriptName } = matchFirstSync({ family: 'Arial', weight, style: 'normal' });\n" +
      '  return [postscriptName, performance.now() - t0];\n' +
      '};\n' +
      'const regular = timed(400);\n' +
      'const bold = timed(700);\n' +
      'const between = timed(520);\n' +
      'await settled();\n' +
      'console.log(JSON.stringify({ regular, bold, between }));\n',
    { fc: { 'fc-match': fontconfigStub(ARIAL, ['Arial']), 'fc-list': fcListStub(ARIAL, 1.5) } }
  );
  assert.equal(out.regular[0], 'ArialMT');
  assert.equal(out.bold[0], 'Arial-BoldMT');
  assert.ok(out.regular[1] + out.bold[1] < 1000, `the regular and the bold took ${out.regular[1]} and ${out.bold[1]} ms`);
  assert.equal(out.between[0], 'Arial-BoldMT', 'and the census, once in, decides 520');
});

test('a prewarmed weight is answered as CSS picks it, from the prewarm alone', () => {
  // the census rides in the prewarm's child, and the pattern is the one
  // fontconfig would be asked for anyway: a layout after the prewarm spawns
  // nothing, and the prewarm and the layout agree on the cache key
  const out = prewarmProbe(
    "import cp from 'node:child_process';\n" +
      "import { readFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      'const spawn = cp.spawn;\n' +
      'let children = 0;\n' +
      'cp.spawn = (...args) => (children++, spawn.apply(cp, args));\n' +
      'process.env.PATH = BIN.fc;\n' +
      "await prewarmPatterns([{ family: 'Arial', weight: 520, style: 'normal' }]);\n" +
      'await settled();\n' +
      'const warmed = children;\n' +
      'process.env.PATH = EMPTY; // an ask that spawned would throw ENOENT\n' +
      "const first = matchFirstSync({ family: 'Arial', weight: 520, style: 'normal' }).postscriptName;\n" +
      "const chain = matchSortedSync({ family: 'Arial', weight: 520, style: 'normal' }).map((c) => c.postscriptName);\n" +
      "const asked = readFileSync(join(BIN.fc, 'fc-match.spawns'), 'utf8').trim().split('\\n');\n" +
      'console.log(JSON.stringify({ first, chain, asked, warmed }));\n',
    { fc: { 'fc-match': fontconfigStub(ARIAL, ['Arial']), 'fc-list': fcListStub(ARIAL) } }
  );
  assert.equal(out.first, 'Arial-BoldMT');
  assert.deepEqual(out.chain, ['Arial-BoldMT', 'ArialMT', 'Fallback'], 'the chain is headed by the same face');
  assert.deepEqual(out.asked, ['sorted Arial:weight=116'], 'one match, for the pattern the weight translates to');
  assert.equal(out.warmed, 1, 'and one child, the census in it');
});

test('a face -s trimmed from the chain heads it, its coverage left to the font', () => {
  // fc-match -s leaves out a face whose coverage the faces before it give,
  // which is a family's bold behind its regular: the census has it, but not
  // its coverage, so a fallback opens it rather than passing it over
  const out = prewarmProbe(
    'process.env.PATH = BIN.fc;\n' +
      "const chain = matchSortedSync({ family: 'Arial', weight: 520, style: 'normal' });\n" +
      'console.log(JSON.stringify({\n' +
      '  chain: chain.map((c) => [c.postscriptName, c.charset]),\n' +
      '  covers: [charsetHas(chain[0], 0x41), charsetHas(chain[1], 0x3042), charsetHas(chain[2], 0x3042)]\n' +
      '}));\n',
    { fc: { 'fc-match': fontconfigStub(ARIAL, ['Arial']), 'fc-list': fcListStub(ARIAL) } }
  );
  assert.deepEqual(out.chain, [
    ['Arial-BoldMT', null],
    ['ArialMT', '20-7e'],
    ['Fallback', '3000-30ff']
  ]);
  assert.deepEqual(out.covers, [true, false, true]);
});

test('a weight a variable font’s axis holds is set on it, through the face fontconfig picked', () => {
  // CSS's pick is the variable font itself, whose range holds 450; the
  // instance fontconfig answered with is the same file, and the weight goes
  // on the axis whichever face of it is opened
  const out = prewarmProbe(
    'process.env.PATH = BIN.fc;\n' + sweep([450, 520, 800].map((w) => ['STIX Two Text', w, 'normal'])) + 'console.log(JSON.stringify({ faces }));\n',
    { fc: { 'fc-match': fontconfigStub(STIX, ['STIX Two Text']), 'fc-list': fcListStub(STIX) } }
  );
  assert.deepEqual(
    out.faces.map(([head]) => head),
    ['STIXTwoText', 'STIXTwoTextRoman-Medium', 'STIXTwoTextRoman-Bold']
  );
});

test('a family named by one of its faces’ names is the faces that name holds', () => {
  // `Avenir Next Ultra Light` is the name a face's style-linked family
  // goes by: two faces, where `Avenir Next` is all of them — which name the
  // pattern matched by is the family CSS chooses within
  const out = prewarmProbe(
    'process.env.PATH = BIN.fc;\n' +
      sweep([
        ['Avenir Next Ultra Light', 520, 'normal'],
        ['Avenir Next', 520, 'normal']
      ]) +
      'console.log(JSON.stringify({ faces }));\n',
    {
      fc: {
        'fc-match': fontconfigStub(AVENIR_NEXT, ['Avenir Next Ultra Light', 'Avenir Next']),
        'fc-list': fcListStub(AVENIR_NEXT)
      }
    }
  );
  assert.deepEqual(
    out.faces.map(([head]) => head),
    ['AvenirNext-UltraLight', 'AvenirNext-DemiBold']
  );
});

let hasFcList = false;
try {
  execFileSync('fc-list', ['--version'], { stdio: 'ignore' });
  hasFcList = hasFontconfig;
} catch {
  // no fc-list, no census
}

// fontconfig's weights back on CSS's scale (FcWeightToOpenType)
const FC_TO_CSS = [[0, 100], [40, 200], [50, 300], [55, 350], [75, 380], [80, 400], [100, 500], [180, 600], [200, 700], [205, 800], [210, 900], [215, 1000]];
function cssWeightOf(fc) {
  let i = 1;
  while (i < FC_TO_CSS.length - 1 && fc > FC_TO_CSS[i][0]) i++;
  const [[a, ca], [b, cb]] = [FC_TO_CSS[i - 1], FC_TO_CSS[i]];
  return Math.round(ca + ((cb - ca) * (Math.min(fc, b) - a)) / (b - a));
}

test(
  'fontconfig: a weight is the face CSS picks from the faces fc-list lists',
  { skip: !hasFcList && 'fc-match and fc-list not installed' },
  async () => {
    // what the issue measured, as a test: each weight from 100 to 900 in
    // tens, against CSS's rule run on the weights the family's faces have
    const { matchSorted: match } = await import('../lib/fontconfig.js');
    const installed = (family) => execFileSync('fc-list', [`:family=${family}`], { encoding: 'utf8' }).trim() !== '';
    const asks = [
      ['sans-serif', 'normal'],
      ['sans-serif', 'italic'],
      ...(process.platform === 'darwin'
        ? ['Arial', 'Verdana', 'Helvetica', 'Helvetica Neue', 'Avenir Next'].filter(installed).map((f) => [f, 'normal'])
        : [])
    ];
    const wrong = [];
    for (const [family, style] of asks) {
      const heads = (await Promise.all(WEIGHTS.map((weight) => match({ family, weight, style })))).map((l) => l[0]);
      // the family the pattern matched: the name asked for, or a generic's
      const name = heads[0].families.find((f) => f.toLowerCase() === family.toLowerCase()) ?? heads[0].family;
      const listed = execFileSync(
        'fc-list',
        ['--format', '%{postscriptname}\t%{file}\t%{weight}\t%{slant}\t%{width}\n', `:family=${name}`],
        { encoding: 'utf8' }
      );
      const range = (text) => {
        const v = text.replace(/[[\]]/g, '').split(' ').map(Number);
        return [v[0], v[v.length - 1]];
      };
      const faces = listed
        .trim()
        .split('\n')
        .map((line) => line.split('\t'))
        .filter(([, path]) => /\.(ttf|otf|woff|woff2|ttc|dfont)$/i.test(path))
        .map(([ps, path, weight, slant, width]) => {
          const [lo, hi] = range(weight).map(cssWeightOf);
          const [narrow, wide] = range(width);
          return face(path, ps, name, lo === hi ? lo : [lo, hi], Number(slant), narrow <= 100 && wide >= 100 ? 100 : narrow);
        });
      WEIGHTS.forEach((weight, i) => {
        const picks = cssPicks(faces, name, weight, style === 'italic');
        const head = heads[i];
        // a variable font's own pattern is CSS's where its axis holds the
        // weight, and the instance fontconfig answered with is its file
        const ok = picks.some((f) => f.ps === head.postscriptName || (Array.isArray(f.weight) && f.path === head.path));
        if (!ok) wrong.push(`${family} ${style} ${weight}: ${head.postscriptName}, CSS ${picks.map((f) => f.ps)}`);
      });
    }
    assert.deepEqual(wrong, []);
  }
);
