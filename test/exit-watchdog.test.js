// The test suite's exit watchdog (test/helpers/exit-watchdog.js), run the way
// `npm test` runs it: a `node --test` of its own, with the watchdog passed by
// --import, over a file written for the occasion.
//
// What it is for is a file whose tests all pass and whose process then never
// exits. `node --test` reports a file only once its process is gone, so that
// file printed nothing, every file after it queued behind it, and CI sat at
// the last file that did finish until the six-hour job limit. In October 2026
// that was test/smoke.test.js, on Node 18.19, 22 and 24: it kept its X
// connection open once a stray protocol error had marked it lost.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const watchdog = fileURLToPath(new URL('./helpers/exit-watchdog.js', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'ntk-exit-watchdog-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** `node --test` over one file of `source`, with the watchdog at `graceMs` */
function runUnderWatchdog(name, source, graceMs) {
  writeFileSync(join(dir, name), source);
  // this process is a test file's own, and a runner that inherited the mark
  // would take itself for one too
  const env = { ...process.env, NTK_EXIT_WATCHDOG_MS: String(graceMs) };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', watchdog, '--test', name], { cwd: dir, env });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

test('a file that leaves a timer running is failed, and says so', async () => {
  // twenty seconds is long past the watchdog's 0.2 here, and short enough that
  // a watchdog which stopped working fails this test rather than stalling it
  const { code, output } = await runUnderWatchdog(
    'leaves-a-timer.test.mjs',
    "import { test } from 'node:test';\ntest('passes', () => { setTimeout(() => {}, 20_000); });\n",
    200
  );
  assert.equal(code, 1, output);
  assert.match(output, /leaves-a-timer\.test\.mjs: still running 0\.2s after its tests finished, held open by a timer/);
});

test('a file that closes what it opened in its own after hook is left alone', async () => {
  // the watchdog's hook is registered first and so runs first: it must only
  // arm the timer, never judge what the file's own teardown has yet to undo
  const { code, output } = await runUnderWatchdog(
    'closes-in-after.test.mjs',
    "import { after, test } from 'node:test';\nconst timer = setInterval(() => {}, 1000);\n" +
      "test('passes', () => {});\nafter(() => clearInterval(timer));\n",
    200
  );
  assert.equal(code, 0, output);
  assert.doesNotMatch(output, /still running/);
});
