// Release a server-side resource, tolerating a connection that is closing or
// already gone — the X server frees all of a client's resources on disconnect,
// so there is nothing left to do and nothing worth throwing about. This
// matters for FinalizationRegistry callbacks, which run after app.close() if
// wrappers get garbage collected late and have no user code around them to
// catch.
export function safeRelease(X, fn) {
  if (X._closing || !X.stream || X.stream.destroyed || X.stream.writableEnded) return;
  try {
    fn();
  } catch {
    // connection raced shut between the check and the request
  }
}
