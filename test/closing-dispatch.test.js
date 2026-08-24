// Regression: the X event dispatch keeps delivering events that were already
// in the read buffer after app.close() has set the client's _closing flag, and
// node-x11 throws 'client is in closing state' synchronously at any request
// issued from then on. A routed 'child-event' built a Window for the event's
// target, whose constructor asks GetGeometry/GetWindowAttributes for an
// adopted id — so a SubstructureNotify arriving on the way out threw from
// inside the stream read handler, where nothing can catch it, and the process
// died with an uncaughtException (issue #321, found by react-x11's
// out-of-process frame panes exiting 1 instead of 0).
//
// Same family as test/window-title-close-race.test.js, one layer earlier: not
// a reply callback issuing a follow-up, but the event dispatch itself. The
// failure mode is an uncaught exception that takes the process down, so the
// assertion is mostly completing cleanly.
//
// Hermetic: in-process pure-JS X server, no $DISPLAY.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import x11 from 'x11';
import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';

const { createServer, createStreamPair } = xserver;

function freshServer() {
  const server = createServer({ width: 400, height: 300 });
  return async () => {
    const [serverEnd, clientEnd] = createStreamPair();
    server.addClientStream(serverEnd);
    return createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
  };
}

// let the notifications still in flight reach the closing client, and any
// callbacks scheduled behind them fire, before the test is declared done
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

test('a child-event arriving as the connection closes does not crash', async () => {
  const connect = freshServer();
  const watcher = await connect();
  const other = await connect();

  // adopt the root and ask to hear about its children — what any window
  // manager does, and what rootWindow() + a text-drawing app does by way of
  // the shared glyph cache
  const root = watcher.rootWindow();
  await root.selectInput(x11.eventMask.SubstructureNotify);

  // somebody else fills the root with windows; the watcher is told about each
  for (let i = 0; i < 40; i++) {
    const id = other.X.AllocID();
    other.X.CreateWindow(id, other.X.display.screen[0].root, 0, 0, 10, 10, 0, 0, 0, 0, {});
    other.X.MapWindow(id);
  }
  other.X.flush();

  // …and the watcher goes away while those notifications are still arriving,
  // which is what any short-lived process does at exit
  watcher.X.close();
  await settle();

  assert.ok(root, 'the create notifications drained without throwing');
  other.X.terminate();
});

test('adopting a window on a closing connection resolves ready, and does not throw', async () => {
  const connect = freshServer();
  const app = await connect();
  const rootId = app.display.screen[0].root;

  await app.close();

  // every adoption site — a routed child-event, xembed.js, sharedglyphs.js —
  // reaches this constructor from somewhere with no caller to catch
  const wnd = app.createWindow({ id: rootId });
  const settled = await Promise.race([
    wnd.ready,
    new Promise((resolve) => setTimeout(() => resolve(null), 200))
  ]);
  assert.equal(settled, wnd, 'ready resolves rather than waiting for a reply that cannot come');
  assert.equal(wnd.width, undefined, 'with the geometry unknown, as for a window already gone');
});

test('listening on an adopted window after close does not throw', async () => {
  const connect = freshServer();
  const app = await connect();
  const rootId = app.display.screen[0].root;
  const wnd = app.createWindow({ id: rootId });
  await wnd.ready;

  await app.close();

  // a new listener extends the server-side event mask, which is one more
  // request with nowhere to report a failure
  wnd.on('mousedown', () => {});
  await settle();
  assert.ok(wnd, 'the selection was dropped rather than thrown');
});
