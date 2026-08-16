// Waiting on async work in tests, with a timeout that actually fires.
//
// A fixed `setTimeout` sleep is a race against the work rather than a wait
// for it: `node --test` runs test files in parallel, so under load the sleep
// expires first and the assertions see a half-finished state. That was a real
// intermittent failure, not a theoretical one.
//
// Timeouts here are generous and exist only so a genuine hang fails with a
// message that names what it was waiting for.

/**
 * Reject after `ms` unless `promise` settles first.
 *
 * The timer is deliberately **not** `unref()`ed. An unref'd timer cannot hold
 * the event loop, so if the thing being awaited is not itself holding it
 * either — a dropped socket stops refing the moment it closes — then the loop
 * drains, node exits mid-run, and `node --test` reports every subtest as
 * `cancelledByParent`
 * with "Promise resolution is still pending but the event loop has already
 * resolved". That names neither the test nor the cause. A timeout that cannot
 * fire is unarmed exactly when it is needed.
 *
 * Holding the loop costs nothing here because the timer is cleared as soon as
 * the promise settles, which is what `unref` was reaching for.
 */
export function withTimeout(promise, ms, what) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${what}`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}
