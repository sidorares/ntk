// Selection-change events (XFixes SelectSelectionInput).
//
// Needs a real X server: node-x11's in-process server has no XFixes, which
// clipboard.test.js asserts separately as the documented fallback. Skipped
// when no display is reachable, like smoke.test.js.
//
// Deliberately loose about *how many* events arrive. On a real desktop other
// clients own the clipboard too — XQuartz's pasteboard bridge takes CLIPBOARD
// back the moment anything else claims it — so these assert that the change we
// caused was reported, not that nothing else happened.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createClient } from '../lib/index.js';

let app = null;
let skip = false;
let keepalive = null;

before(async () => {
  if (!process.env.DISPLAY) {
    skip = 'no DISPLAY set';
    return;
  }
  // a ref'd handle for the file's lifetime: waiting on an X event refs the
  // socket, but a dropped connection would otherwise let node exit mid-run
  // and the runner could only report every subtest as cancelledByParent
  keepalive = setInterval(() => {}, 1000);
  try {
    app = await createClient();
  } catch (err) {
    skip = `cannot connect to X server: ${err.message}`;
  }
});

after(async () => {
  clearInterval(keepalive);
  if (app) await app.close();
});

/** Resolve once `predicate` accepts an event, or reject after `ms`. */
function nextEvent(events, predicate, ms = 4000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      const hit = events.find(predicate);
      if (hit) {
        clearInterval(poll);
        return resolve(hit);
      }
      if (Date.now() - started > ms) {
        clearInterval(poll);
        reject(new Error(`no matching selection event within ${ms}ms`));
      }
    }, 25);
  });
}

test('a watcher hears another client take the selection', async (t) => {
  if (skip) return t.skip(skip);
  const events = [];
  const unwatch = await app.clipboard.watch('CLIPBOARD', (ev) => events.push(ev));
  const other = await createClient();
  try {
    await other.clipboard.write('from another client');
    const ev = await nextEvent(events, (e) => e.reason === 'new-owner');
    assert.equal(ev.selection, 'CLIPBOARD');
    assert.ok(ev.owner > 0, 'the new owner window is reported');
    assert.ok(ev.timestamp > 0, 'and the server timestamp that goes with it');
  } finally {
    unwatch();
    await other.close();
  }
});

test('unwatching stops delivery', async (t) => {
  if (skip) return t.skip(skip);
  const events = [];
  const unwatch = await app.clipboard.watch('CLIPBOARD', (ev) => events.push(ev));
  unwatch();
  const other = await createClient();
  try {
    await other.clipboard.write('nobody is listening');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(events, []);
  } finally {
    await other.close();
  }
});

test('unwatching twice is harmless', async (t) => {
  if (skip) return t.skip(skip);
  const unwatch = await app.clipboard.watch('CLIPBOARD', () => {});
  unwatch();
  unwatch();
});

test('two watchers on one selection both hear it', async (t) => {
  if (skip) return t.skip(skip);
  const a = [];
  const b = [];
  const unA = await app.clipboard.watch('CLIPBOARD', (ev) => a.push(ev));
  const unB = await app.clipboard.watch('CLIPBOARD', (ev) => b.push(ev));
  const other = await createClient();
  try {
    await other.clipboard.write('two listeners');
    await Promise.all([
      nextEvent(a, (e) => e.reason === 'new-owner'),
      nextEvent(b, (e) => e.reason === 'new-owner')
    ]);
  } finally {
    unA();
    unB();
    await other.close();
  }
});

test('dropping one of two watchers leaves the other listening', async (t) => {
  if (skip) return t.skip(skip);
  // the registration is shared, so releasing one watcher must not deregister
  // the selection out from under the other
  const kept = [];
  const unDropped = await app.clipboard.watch('CLIPBOARD', () => {});
  const unKept = await app.clipboard.watch('CLIPBOARD', (ev) => kept.push(ev));
  unDropped();
  const other = await createClient();
  try {
    await other.clipboard.write('still listening');
    await nextEvent(kept, (e) => e.reason === 'new-owner');
  } finally {
    unKept();
    await other.close();
  }
});

test('a throwing handler does not cost the others their event', async (t) => {
  if (skip) return t.skip(skip);
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...args) => warned.push(args.join(' '));
  const seen = [];
  const unBad = await app.clipboard.watch('CLIPBOARD', () => {
    throw new Error('handler blew up');
  });
  const unGood = await app.clipboard.watch('CLIPBOARD', (ev) => seen.push(ev));
  const other = await createClient();
  try {
    await other.clipboard.write('one bad listener');
    await nextEvent(seen, (e) => e.reason === 'new-owner');
    assert.ok(
      warned.some((w) => w.includes('handler blew up')),
      'and the failure is reported rather than swallowed'
    );
  } finally {
    console.warn = realWarn;
    unBad();
    unGood();
    await other.close();
  }
});

test('PRIMARY is watched independently of CLIPBOARD', async (t) => {
  if (skip) return t.skip(skip);
  const primary = [];
  const unwatch = await app.clipboard.watch('PRIMARY', (ev) => primary.push(ev));
  const other = await createClient();
  try {
    await other.clipboard.write('middle-click text', { selection: 'PRIMARY' });
    const ev = await nextEvent(primary, (e) => e.reason === 'new-owner');
    assert.equal(ev.selection, 'PRIMARY');
  } finally {
    unwatch();
    await other.close();
  }
});

test('watch needs a handler', async (t) => {
  if (skip) return t.skip(skip);
  await assert.rejects(() => app.clipboard.watch('CLIPBOARD'), /needs a handler/);
});
