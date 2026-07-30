// Waiting for async content in tests.
//
// HtmlView and MarkdownView load images, SVGs and mermaid models in the
// background. A fixed `setTimeout` sleep is a race against that work rather
// than a wait for it: `node --test` runs test files in parallel, so under load
// the sleep can expire first and the assertions then see `img.w === 0`. That
// was a real intermittent failure, not a theoretical one.
//
// Which helper applies depends on whether the widget signals completion:
//
//   - the success paths call `onInvalidate` (ntk >= 3.4.0) when content
//     arrives, so `invalidation()` turns that into a promise — exact, and no
//     slower than the work itself;
//   - the failure paths do not all notify. MarkdownView leaves an unsupported
//     mermaid fence as `entry.failed` without invalidating, so there is no
//     event to await and `until()` polls the real predicate instead. Still
//     deterministic: it settles when the parse rejects, not on a clock.
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

/** Poll `predicate` until it holds — for the paths that never notify. */
export async function until(predicate, what = 'condition', ms = TIMEOUT) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout after ${ms}ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
