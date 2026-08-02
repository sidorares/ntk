import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { listFontsSync } from '../lib/fontconfig.js';

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
  const err = matchWithout('#!/bin/sh\nprintf "/usr/share/fonts/misc/fixed.pcf\\tFixed\\t20-7e\\n"\n');
  assert.equal(err.code, 'ERR_NTK_NO_FONTS');
  assert.match(err.message, /matched no font ntk can parse/);
  assert.match(err.message, /bitmap \.pcf\/\.bdf fonts are not usable/);
});

test('the docs anchor the error points at exists', () => {
  // nothing else in CI checks a doc anchor referenced from a string literal
  const docs = readFileSync(join(root, 'docs/fonts.md'), 'utf8');
  assert.match(docs, /^## Environments without fontconfig$/m);
});
