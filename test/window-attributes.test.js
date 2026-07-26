// createWindow() must forward X window attributes from its args into the
// CreateWindow value list (they used to be silently dropped). Hermetic:
// runs against node-x11's in-process pure-JS X server, and verifies the
// attributes server-side with a GetWindowAttributes round-trip.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import x11 from 'x11';
import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';

const { createServer, createStreamPair } = xserver;

let app = null;

before(async () => {
  const server = createServer({ width: 320, height: 240 });
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);
  app = await createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
});

after(async () => {
  if (app) await app.close();
});

const getAttributes = (wid) =>
  new Promise((resolve, reject) =>
    app.X.GetWindowAttributes(wid, (err, attrs) => (err ? reject(err) : resolve(attrs)))
  );

test('overrideRedirect: true reaches the server', async () => {
  const wnd = app.createWindow({ width: 40, height: 30, overrideRedirect: true });
  const attrs = await getAttributes(wnd.id);
  assert.equal(attrs.overrideRedirect, 1, 'override-redirect set on the server window');
  // untouched defaults survive: NorthWest bit gravity
  assert.equal(attrs.bitGravity, 1, 'default NorthWest bit gravity kept');
  wnd.destroy();
});

test('defaults still apply when no attributes are passed', async () => {
  const wnd = app.createWindow({ width: 40, height: 30 });
  const attrs = await getAttributes(wnd.id);
  assert.equal(attrs.overrideRedirect, 0);
  assert.equal(attrs.bitGravity, 1, 'NorthWest bit gravity default');
  assert.ok(attrs.myEventMasks & x11.eventMask.StructureNotify, 'computed event mask in place');
  wnd.destroy();
});

test('explicit attributes override the defaults', async () => {
  const wnd = app.createWindow({
    width: 40,
    height: 30,
    bitGravity: 5, // Center
    winGravity: 10 // Static
  });
  const attrs = await getAttributes(wnd.id);
  assert.equal(attrs.bitGravity, 5, 'bitGravity override forwarded');
  assert.equal(attrs.winGravity, 10, 'winGravity forwarded');
  wnd.destroy();
});

test('explicit eventMask bits are OR-ed into the computed mask', async () => {
  const wnd = app.createWindow({
    width: 40,
    height: 30,
    eventMask: x11.eventMask.PropertyChange
  });
  const attrs = await getAttributes(wnd.id);
  assert.ok(attrs.myEventMasks & x11.eventMask.PropertyChange, 'requested bit present');
  assert.ok(attrs.myEventMasks & x11.eventMask.StructureNotify, 'computed StructureNotify kept');
  assert.equal(wnd.eventMask, attrs.myEventMasks, 'client-side bookkeeping matches the server');
  wnd.destroy();
});
