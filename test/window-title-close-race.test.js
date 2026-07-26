// Regression: setTitle() (and setActions()) issue follow-up requests from
// InternAtom reply callbacks. app.close() sets the client's _closing flag
// synchronously, then lets pending replies drain during its ping round-trip —
// a follow-up request issued from one of those reply callbacks used to throw
// 'client is in closing state' from inside the stream read handler, where no
// user code can catch it (found by react-x11's integration tests). The
// failure mode is an uncaught exception that takes down the process, so each
// test's assertion is simply completing cleanly.
//
// Hermetic: in-process pure-JS X server, no $DISPLAY.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';

const { createServer, createStreamPair } = xserver;

async function freshApp() {
  const server = createServer({ width: 320, height: 240 });
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);
  return createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
}

// let any stray reply callbacks scheduled behind the close fire before the
// test is declared done
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('closing the app right after setTitle does not crash', async () => {
  const app = await freshApp();
  const wnd = app.createWindow({ width: 50, height: 50, title: 'a' });
  wnd.setTitle('updated'); // kicks off the InternAtom chain
  await app.close(); // close before the replies drain
  await settle();
  assert.ok(wnd, 'survived the close with InternAtom replies in flight');
});

test('closing the app right after setActions does not crash', async () => {
  const app = await freshApp();
  const wnd = app.createWindow({ width: 50, height: 50 });
  wnd.setActions(); // WM_PROTOCOLS / WM_DELETE_WINDOW InternAtom chain
  await app.close();
  await settle();
  assert.ok(wnd, 'survived the close with InternAtom replies in flight');
});

test('setTitle on an already-closed app is a no-op, not a throw', async () => {
  const app = await freshApp();
  const wnd = app.createWindow({ width: 50, height: 50 });
  await app.close();
  wnd.setTitle('too late'); // must not throw synchronously either
  await settle();
  assert.ok(wnd);
});
