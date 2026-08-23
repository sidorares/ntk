// The test suite's own timeout helper (test/helpers/async.js).
//
// The interesting behaviour is what happens *after* the deadline. A promise
// cannot be cancelled, so the work keeps going and eventually hands back
// whatever it was making — a live X connection, in nearly every caller here.
// Nobody is awaiting it by then, so unless it is disposed of its socket refs
// the event loop forever: every test in the file skips, the file reports, and
// `node --test` never exits (issue #254; a matrix leg on #316 sat there for
// 20 minutes on its way to the six-hour job limit).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { withTimeout } from './helpers/async.js';

test('resolves through when the promise wins', async () => {
  let disposed = 0;
  const value = await withTimeout(Promise.resolve('quick'), 1000, 'the quick thing', () => disposed++);
  assert.equal(value, 'quick');
  await sleep(10);
  assert.equal(disposed, 0, 'nothing arrived late, so nothing to dispose of');
});

test('the timeout error names what it was waiting for', async () => {
  await assert.rejects(withTimeout(sleep(1000), 5, 'the slow thing'), /timeout after 5ms: the slow thing/);
});

test('a value that arrives after the deadline is handed to dispose', async () => {
  const resource = { closed: false, close() { this.closed = true; } };
  const late = sleep(20).then(() => resource);
  await assert.rejects(
    withTimeout(late, 5, 'a resource', (arrived) => arrived.close()),
    /timeout after 5ms/
  );
  assert.equal(resource.closed, false, 'not closed before it exists');
  await late;
  await sleep(5);
  assert.equal(resource.closed, true, 'the late arrival was closed for us');
});

test('a promise that rejects on its own disposes of nothing', async () => {
  let disposed = 0;
  const boom = sleep(20).then(() => Promise.reject(new Error('boom')));
  await assert.rejects(withTimeout(boom, 5, 'a failure', () => disposed++), /timeout after 5ms/);
  await sleep(20);
  assert.equal(disposed, 0, 'there is no resource behind a rejection');
});

test('a dispose that throws does not become an unhandled rejection', async () => {
  const unhandled = [];
  const watch = (err) => unhandled.push(err);
  process.on('unhandledRejection', watch);
  try {
    await assert.rejects(
      withTimeout(sleep(10).then(() => 'late'), 1, 'a resource', () => {
        throw new Error('close failed');
      }),
      /timeout after 1ms/
    );
    await sleep(30);
  } finally {
    process.off('unhandledRejection', watch);
  }
  assert.deepEqual(unhandled, [], 'by then nobody is listening, so it must be swallowed');
});
