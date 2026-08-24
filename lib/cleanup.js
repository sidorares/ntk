/**
 * Whether a request issued now would throw rather than reach the server.
 * node-x11 throws *synchronously* ("client is in closing state") once
 * `close()` has begun, and a destroyed or ended stream is the same state one
 * step further along.
 *
 * The check matters wherever a request is issued from somewhere with no
 * caller to catch: a FinalizationRegistry callback, a paced frame's timer, or
 * the X event dispatch itself — events already in the read buffer keep being
 * delivered after `close()` (issue #321).
 */
export function connectionGone(X) {
  return !!(X._closing || !X.stream || X.stream.destroyed || X.stream.writableEnded);
}

// Issue requests — typically releasing a server-side resource — tolerating a
// connection that is closing or already gone. The X server frees all of a
// client's resources on disconnect, so there is nothing left to do and
// nothing worth throwing about. This matters wherever the requests have no
// caller around them to catch: FinalizationRegistry callbacks, which run
// after app.close() if wrappers get garbage collected late, a paced frame's
// timer, and the X event dispatch (issue #321).
export function safeRelease(X, fn) {
  if (connectionGone(X)) return;
  try {
    fn();
  } catch {
    // connection raced shut between the check and the request
  }
}
