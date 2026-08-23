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
 *
 * A timeout ends *this* wait, never the work behind it: a promise cannot be
 * cancelled, so whatever it was making still arrives, unowned and unwatched.
 * Where that is a live X connection the socket refs the event loop forever —
 * every test skips, the file reports, and then `node --test` simply never
 * exits (seen on #316: a 20-minute stall on two matrix legs, on its way to
 * the six-hour job limit). Pass `dispose` for anything holding a resource and
 * the late arrival is handed to it instead of being dropped on the floor:
 *
 *     withTimeout(createClient(), 5000, 'connecting', (app) => app.close())
 *
 * `dispose` runs at most once, only on the timeout path — a promise that
 * rejects on its own left nothing to dispose of — and anything it throws is
 * swallowed, since by then nobody is waiting to hear it.
 */
export function withTimeout(promise, ms, what, dispose) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (dispose) Promise.resolve(promise).then(dispose).catch(() => {});
      reject(new Error(`timeout after ${ms}ms: ${what}`));
    }, ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}
