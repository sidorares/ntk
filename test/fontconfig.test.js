import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { listFontsSync, matchSortedSync, platformFamilies } from '../lib/fontconfig.js';
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
  const err = matchWithout('#!/bin/sh\nprintf "/usr/share/fonts/misc/fixed.pcf\\tFixed\\tFixed\\t20-7e\\n"\n');
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
 * script body; each becomes its own PATH directory, exposed to the probe as
 * BIN.<name>. EMPTY is a directory with no fc-match at all (the child starts
 * there), and PATTERN is the pattern FontManager.match('sans-serif') asks
 * fontconfig for — the one the prewarm must seed for a first paint to hit it.
 */
function prewarmProbe(body, stubs = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ntk-prewarm-'));
  const bins = {};
  for (const [name, stub] of Object.entries(stubs)) {
    const bin = join(dir, name);
    mkdirSync(bin);
    writeFileSync(join(bin, 'fc-match'), stub);
    chmodSync(join(bin, 'fc-match'), 0o755);
    bins[name] = bin;
  }
  const empty = join(dir, 'empty');
  mkdirSync(empty);
  const script = join(dir, 'probe.mjs');
  writeFileSync(
    script,
    `import { matchSorted, matchSortedSync, prewarm } from ${JSON.stringify(join(root, 'lib/fontconfig.js'))};\n` +
      `import { FontconfigFontSource } from ${JSON.stringify(join(root, 'lib/text/fontsource.js'))};\n` +
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
const counting = (path) =>
  '#!/bin/sh\n' +
  'for last; do :; done\n' +
  'echo "$last" >> "$0.spawns"\n' +
  `printf "${path}\\tStub\\tStub Family\\t20-7e\\n"\n`;

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
      "const spawns = readFileSync(join(BIN.slow, 'fc-match.spawns'), 'utf8').trim().split('\\n');\n" +
      'console.log(JSON.stringify({ duringRace: duringRace.path, after: after.path, spawns: spawns.length }));\n',
    {
      // sleep by absolute path — the stub's PATH has no coreutils
      slow:
        '#!/bin/sh\n' +
        'echo x >> "$0.spawns"\n' +
        '{ /bin/sleep 0.3 || /usr/bin/sleep 0.3; } 2>/dev/null\n' +
        'printf "/async/SHARED.ttf\\tShared\\tShared Family\\t20-7e\\n"\n'
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
      happy: '#!/bin/sh\nprintf "/sync/HAPPY.ttf\\tHappy\\tHappy Family\\t20-7e\\n"\n'
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
      "const spawns = readFileSync(join(BIN.count, 'fc-match.spawns'), 'utf8').trim().split('\\n');\n" +
      'console.log(JSON.stringify({ paths, spawns: spawns.length }));\n',
    { count: counting('/faces/A.ttf') }
  );
  assert.deepEqual(out.paths, ['/faces/A.ttf', '/faces/A.ttf', '/faces/A.ttf']);
  assert.equal(out.spawns, 4, 'one spawn a face');
});

test('prewarm for an already-cached pattern spawns nothing', () => {
  const out = prewarmProbe(
    "import { readFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      'process.env.PATH = BIN.count;\n' +
      'matchSortedSync(PATTERN);\n' +
      'await prewarm(PATTERN);\n' +
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
        'printf "/f/Hiragino.ttc\\tHiraginoSans-W4\\tHiragino Sans,\u30d2\u30e9\u30ae\u30ce\u89d2\u30b4\u30b7\u30c3\u30af,Hiragino Sans W4\\t20-7e a0-ff\\n"\n'
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
    { nameless: '#!/bin/sh\nprintf "/f/A.ttf\\tA\\t\\t20-7e\\n"\n' }
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
      "const spawns = readFileSync(join(BIN.slow, 'fc-match.spawns'), 'utf8').trim().split('\\n').length;\n" +
      'console.log(JSON.stringify({ path: list[0].path, spawns }));\n',
    {
      slow:
        '#!/bin/sh\n' +
        'echo x >> "$0.spawns"\n' +
        '{ /bin/sleep 0.3 || /usr/bin/sleep 0.3; } 2>/dev/null\n' +
        'printf "/shared/A.ttf\\tShared\\tShared Family\\t20-7e\\n"\n'
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
    { bitmap: '#!/bin/sh\nprintf "/usr/share/fonts/misc/fixed.pcf\\tFixed\\tFixed\\t20-7e\\n"\n' }
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
        'printf "/f/A.ttf\\tA\\tA\\t20-7e\\n"\n'
    }
  );
  const family = process.platform === 'darwin' ? 'Helvetica,sans-serif' : 'sans-serif';
  assert.deepEqual(out.patterns, [`${family}:weight=80`]);
  assert.equal(out.path, '/f/A.ttf');
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
