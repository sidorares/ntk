// Waiting for async content in tests.
//
// HtmlView loads images and SVGs in the background. A fixed `setTimeout` sleep
// is a race against that work rather than a wait for it: `node --test` runs
// test files in parallel, so under load the sleep can expire first and the
// assertions then see `img.w === 0`. That was a real intermittent failure, not
// a theoretical one.
//
// The widget calls `onInvalidate` when a resource resolves or fails, so
// `invalidation()` turns that into a promise — exact, and no slower than the
// work itself.
//
// Timeouts here are generous and exist only so a genuine hang fails with a
// message that names what it was waiting for.

const TIMEOUT = 10000;

/** Reject after `ms` unless `promise` settles first. */
export function withTimeout(promise, ms, what) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${what}`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/**
 * Widget options plus an awaitable for their async content:
 *
 *   const load = invalidation();
 *   const view = new HtmlView(null, { fonts, ...load.opts });
 *   view.setHtml('<img src="pic.svg">');
 *   await load.settled();
 *
 * `onInvalidate` fires once per resource that resolves *or* fails, so pass a
 * count to wait for a page with more than one.
 */
export function invalidation() {
  let seen = 0;
  let waiters = [];
  return {
    opts: {
      onInvalidate: () => {
        seen++;
        const wake = waiters;
        waiters = [];
        for (const resolve of wake) resolve();
      }
    },
    /** Resolve once `onInvalidate` has fired at least `count` times. */
    settled(count = 1, what = 'async content', ms = TIMEOUT) {
      const wait = async () => {
        while (seen < count) await new Promise((resolve) => waiters.push(resolve));
      };
      return withTimeout(wait(), ms, what);
    }
  };
}
