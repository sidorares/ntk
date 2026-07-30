#!/usr/bin/env node
// Will release-please be able to read this commit message?
//
// Squash-merge composes the commit from the PR title and description, and
// release-please parses the whole thing with @conventional-commits/parser. A
// message the grammar rejects is **silently skipped**: the Release workflow
// goes green, logs "No user facing commits found", and no release PR appears.
// That has now cost two releases — #85 and #103 — so this checks it in CI
// rather than trusting anyone to remember the rule.
//
// The usual offender is nested parentheses, which the grammar does not
// accept: `foo(a, b)` is fine, `premultiply(cssColorStraight(x))` is not.
// Whether a given line trips it depends on the surrounding context, which is
// exactly why this runs the real parser instead of a regex.
//
//   node scripts/check-release-message.mjs <file>
//   MESSAGE="..." node scripts/check-release-message.mjs
import { readFileSync } from 'node:fs';

import { parser, toConventionalChangelogFormat } from '@conventional-commits/parser';

const file = process.argv[2];
const message = file ? readFileSync(file, 'utf8') : (process.env.MESSAGE ?? '');

if (!message.trim()) {
  console.error('check-release-message: nothing to check (pass a file or set MESSAGE)');
  process.exit(2);
}

let ast;
try {
  ast = parser(message);
} catch (err) {
  const text = String(err.message);
  console.error('release-please could not parse this commit message.\n');
  console.error(text.split('\n')[0]);

  // point at the line the parser named, since the column alone is no help
  const at = /at (\d+):(\d+)/.exec(text);
  if (at) {
    const lines = message.split('\n');
    const n = Number(at[1]);
    const line = lines[n - 1];
    if (line !== undefined) {
      console.error(`\n  ${n} | ${line}`);
      console.error(`  ${' '.repeat(String(n).length)} | ${' '.repeat(Math.max(0, Number(at[2]) - 1))}^`);
    }
  }
  console.error(
    '\nA message it cannot read is skipped silently: the Release workflow goes\n' +
      'green and no release PR appears. Nested parentheses are the usual cause —\n' +
      'rewrite them, e.g. "premultiply of cssColorStraight" rather than\n' +
      'premultiply wrapping a call. See the Releases section of AGENTS.md.',
  );
  process.exit(1);
}

const commit = toConventionalChangelogFormat(ast);
const RELEASING = new Set(['feat', 'fix', 'perf', 'revert']);
const breaking = commit.notes.some((n) => n.title === 'BREAKING CHANGE');
const bumps = breaking || RELEASING.has(commit.type);

console.log(`parses: type=${commit.type}${breaking ? ' (breaking)' : ''}`);
console.log(
  bumps
    ? '  -> release-please will cut a version for this'
    : `  -> no version bump for "${commit.type}", which is expected for docs/chore/test/ci`,
);
