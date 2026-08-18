// The guard in scripts/check-release-message.mjs, which stands between a PR
// description and a release that silently does not happen.
//
// Both cases below are real. The nested call is #103's; the split parenthetical
// is #278's, and it is the one the guard used to miss — the line is whole in
// the PR body and only breaks once the squash wraps it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  SQUASH_WIDTH,
  parseMessage,
  wrapLikeSquash,
} from '../scripts/check-release-message.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/check-release-message.mjs', import.meta.url));

/** run the guard as CI runs it; returns its exit code and stderr */
function guard(message) {
  const file = join(mkdtempSync(join(tmpdir(), 'ntk-relmsg-')), 'message.txt');
  writeFileSync(file, message);
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout), stderr: String(err.stderr) };
  }
}

// the aside that got away, from PR #278's description
const ASIDE =
  '*(rendered by this branch: `node examples/shadows.js`, captured headless into a pixmap with `getImageData`)*';

test('the subject line is never wrapped, however long it is', () => {
  const subject = `feat(context2d): ${'x'.repeat(200)}`;
  assert.equal(wrapLikeSquash(`${subject}\n\nbody`).split('\n')[0], subject);
});

test('body lines wrap at the squash column, on spaces only', () => {
  const long = `${'word '.repeat(40).trim()}`;
  const lines = wrapLikeSquash(`feat: x\n\n${long}`).split('\n').slice(2);
  assert.ok(lines.length > 1, 'a 199-character line is wrapped');
  for (const line of lines) assert.ok(line.length <= SQUASH_WIDTH, `"${line}" fits`);
  assert.equal(lines.join(' '), long, 'and nothing is lost or added but the breaks');
});

test('a token wider than the column keeps its own line rather than being split', () => {
  const url = `https://github.com/user-attachments/assets/${'0'.repeat(60)}`;
  const lines = wrapLikeSquash(`feat: x\n\nsee ![img](${url})`).split('\n').slice(2);
  assert.equal(lines.length, 2, 'the short words wrap off the front');
  assert.ok(lines[1].includes(url), 'the unbreakable token survives whole');
});

test('a parenthetical that survives as written breaks once the squash wraps it', () => {
  const message = `feat(context2d): shadows\n\n${ASIDE}\n`;
  assert.equal(parseMessage(message).ok, true, 'the PR body parses — this is the false negative');

  const wrapped = wrapLikeSquash(message);
  const failure = parseMessage(wrapped);
  assert.equal(failure.ok, false, 'and the commit GitHub writes from it does not');
  assert.equal(
    wrapped.split('\n')[failure.line - 1],
    '*(rendered by this branch: `node examples/shadows.js`, captured headless',
    'the guard names the line the wrap left an open paren on',
  );
});

test('the guard fails on it, and says the wrap is why', () => {
  const { code, stderr } = guard(`feat(context2d): shadows\n\n${ASIDE}\n`);
  assert.equal(code, 1);
  assert.match(stderr, /could not parse/);
  assert.match(stderr, /as the squash commit will hold it/);
});

test('nested parentheses still fail, wrapped or not (#103)', () => {
  // the real line from #103 — an invented one may well parse, which is why
  // the guard runs the parser rather than looking for nested parens itself
  const message =
    'feat: export cssColorStraight and premultiply\n\n' +
    '`premultiply(cssColorStraight(x))` equals `cssColor(x)`.\n';
  assert.equal(parseMessage(message).ok, false);
  assert.equal(guard(message).code, 1);
});

test('an ordinary message passes, and is reported as releasing', () => {
  const { code, stdout } = guard(
    'feat(context2d): shadows, with the blur run as two passes\n\n' +
      'The four canvas properties, applied to fill, stroke and fillText. The\n' +
      'blur runs as two 1d passes rather than one 2d kernel.\n',
  );
  assert.equal(code, 0);
  assert.match(stdout, /parses: type=feat/);
  assert.match(stdout, /will cut a version/);
});

test('a chore parses but is reported as not releasing', () => {
  const { code, stdout } = guard('chore: bump the lockfile\n');
  assert.equal(code, 0);
  assert.match(stdout, /no version bump for "chore"/);
});
