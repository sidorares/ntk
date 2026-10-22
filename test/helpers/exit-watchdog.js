// Loaded into every test file's process: `npm test` passes it to
// `node --test` with --import, which hands it on to each file it runs.
//
// A test file whose tests have all finished but whose process does not exit
// stalls `node --test` without a word. The runner reports a file only once
// its process is gone, so the stuck file prints nothing at all, and every
// file after it waits behind it — on CI, up to GitHub's six-hour job limit,
// with a log that ends at whichever file finished last. Something is still
// holding the event loop: a socket nobody closed, a ref'd timer, a child.
// `--test-timeout` cannot see it, since no test is running, and
// `--test-force-exit` would end the process and say nothing.
//
// So once a file's tests are done this arms a timer. It is unref'd, so a
// process that exits on its own never hears from it; one that is still
// running GRACE_MS later says what holds it and exits with a failure, which
// `node --test` reports against the file.

import { relative } from 'node:path';
import { after } from 'node:test';

// far beyond any teardown here; its own test shortens it
const GRACE_MS = Number(process.env.NTK_EXIT_WATCHDOG_MS) || 30_000;

// What is keeping the loop alive, by kind: `Socket (Pipe)` is a unix-socket
// connection such as an X display's, `ChildProcess (Process)` a spawn. The
// file's stdout and stderr are pipes to the runner and always open, so they
// are left out (stdin is not touched: reading process.stdin creates it).
// _getActiveHandles is undocumented but has been there since node 0.x; the
// public getActiveResourcesInfo cannot tell those pipes from a leaked one.
function holding() {
  const stdio = [process.stdout, process.stderr];
  const handles = process._getActiveHandles().filter((h) => !stdio.includes(h));
  const held = handles.map((h) => {
    const kind = h.constructor?.name ?? 'handle';
    const inner = h._handle?.constructor?.name;
    return inner && inner !== kind ? `${kind} (${inner})` : kind;
  });
  // timers are not handles; the watchdog's own is unref'd and not counted
  for (const r of process.getActiveResourcesInfo()) if (r === 'Timeout') held.push('a timer');
  return held.join(', ') || 'nothing node can name';
}

// the runner loads this too, and has no tests of its own to wait for; the
// processes it runs files in are the ones it marks
if (process.env.NODE_TEST_CONTEXT) {
  after(() => {
    setTimeout(() => {
      const file = relative(process.cwd(), process.argv[1] ?? '?');
      process.stderr.write(
        `${file}: still running ${GRACE_MS / 1000}s after its tests finished, held open by ${holding()}. ` +
          'Something it opened was never closed: an X connection, a timer or a child process.\n'
      );
      process.exit(1);
    }, GRACE_MS).unref();
  });
}
