#!/usr/bin/env node
// Will release-please be able to read this commit message?
//
// Squash-merge composes the commit from the PR title and description, and
// release-please parses the whole thing with @conventional-commits/parser. A
// message the grammar rejects is **silently skipped**: the Release workflow
// goes green, logs "No user facing commits found", and no release PR appears.
// That has now cost three releases — #85, #103 and #278 — so this checks it in
// CI rather than trusting anyone to remember the rules.
//
// Two ways in, and the second is why this does not just parse the text it is
// given:
//
//   1. nested parentheses, which the grammar does not accept: `foo(a, b)` is
//      fine, `premultiply(cssColorStraight(x))` is not
//   2. a parenthetical that GitHub's squash **wraps**, leaving the `(` on one
//      line and the `)` on the next — which the grammar rejects just as
//      firmly, and which is invisible in the PR body, where the line is whole
//
// (2) is what skipped #278: the body line
//
//   *(rendered by this branch: `node examples/shadows.js`, captured headless into a pixmap with `getImageData`)*
//
// parses on its own and fails once it is 72 columns wide. So the message is
// checked twice, as written and as the squash would write it.
//
// Whether a given line trips the grammar depends on the surrounding context,
// which is exactly why this runs the real parser instead of a regex.
//
//   node scripts/check-release-message.mjs <file>
//   MESSAGE="..." node scripts/check-release-message.mjs
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { parser, toConventionalChangelogFormat } from '@conventional-commits/parser';

/** the column GitHub's squash wraps a commit body at */
export const SQUASH_WIDTH = 72;

/**
 * The message as the squash commit will hold it: the subject is left alone,
 * and every body line longer than `width` is word-wrapped, greedily and never
 * mid-token — a URL past the margin stays on one long line of its own.
 *
 * Close enough to GitHub's own wrapping that a body which will break in the
 * squash breaks here too — which is the whole job. It is not byte-identical:
 * GitHub also appends the PR number to the subject, and the squash UI is free
 * to change its mind about blank lines.
 */
export function wrapLikeSquash(message, width = SQUASH_WIDTH) {
  const [subject, ...body] = message.split('\n');
  const wrap = (line) => {
    if (line.length <= width) return [line];
    const out = [];
    let cur = '';
    for (const word of line.split(' ')) {
      if (!cur.length) cur = word;
      else if (cur.length + 1 + word.length <= width) cur += ` ${word}`;
      else {
        out.push(cur);
        cur = word;
      }
    }
    out.push(cur);
    return out;
  };
  return [subject, ...body.flatMap(wrap)].join('\n');
}

/**
 * Parse one message. Returns the commit release-please would see, or the
 * error it choked on with the line and column it named.
 */
export function parseMessage(message) {
  let ast;
  try {
    ast = parser(message);
  } catch (err) {
    const text = String(err.message);
    const at = /at (\d+):(\d+)/.exec(text);
    return {
      ok: false,
      reason: text.split('\n')[0],
      line: at ? Number(at[1]) : null,
      column: at ? Number(at[2]) : null,
    };
  }
  const commit = toConventionalChangelogFormat(ast);
  return {
    ok: true,
    type: commit.type,
    breaking: commit.notes.some((n) => n.title === 'BREAKING CHANGE'),
  };
}

function report(message, failure, wrapped) {
  console.error('release-please could not parse this commit message.\n');
  console.error(failure.reason);
  if (wrapped) {
    console.error(
      `\nThis is the message *as the squash commit will hold it* — the body\n` +
        `wrapped at ${SQUASH_WIDTH} columns. It parses as written, which is why the line\n` +
        `below may look fine in the PR: the wrap is what splits it.`,
    );
  }

  // point at the line the parser named, since the column alone is no help
  if (failure.line !== null) {
    const line = message.split('\n')[failure.line - 1];
    if (line !== undefined) {
      console.error(`\n  ${failure.line} | ${line}`);
      console.error(
        `  ${' '.repeat(String(failure.line).length)} | ${' '.repeat(Math.max(0, failure.column - 1))}^`,
      );
    }
  }
  console.error(
    '\nA message it cannot read is skipped silently: the Release workflow goes\n' +
      'green and no release PR appears. Two causes — nested parentheses, and a\n' +
      'parenthesis left open at the end of a line. Rewrite them, e.g.\n' +
      '"premultiply of cssColorStraight" rather than premultiply wrapping a\n' +
      'call, and keep an aside short enough to survive the wrap. See the\n' +
      'Releases section of AGENTS.md.',
  );
}

function main() {
  const file = process.argv[2];
  const message = file ? readFileSync(file, 'utf8') : (process.env.MESSAGE ?? '');

  if (!message.trim()) {
    console.error('check-release-message: nothing to check (pass a file or set MESSAGE)');
    process.exit(2);
  }

  // as written, then as the squash will write it — a message can pass the
  // first and fail the second, which is the whole reason for the second
  const wrapped = wrapLikeSquash(message);
  for (const [text, isWrapped] of [
    [message, false],
    [wrapped, true],
  ]) {
    const result = parseMessage(text);
    if (!result.ok) {
      report(text, result, isWrapped);
      process.exit(1);
    }
    if (isWrapped) {
      console.log(`parses: type=${result.type}${result.breaking ? ' (breaking)' : ''}`);
      const RELEASING = new Set(['feat', 'fix', 'perf', 'revert']);
      console.log(
        result.breaking || RELEASING.has(result.type)
          ? '  -> release-please will cut a version for this'
          : `  -> no version bump for "${result.type}", which is expected for docs/chore/test/ci`,
      );
    }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
