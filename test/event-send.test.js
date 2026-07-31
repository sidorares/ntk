// Outgoing events: ntk builds them as objects and lets node-x11 pack the 32
// wire bytes (x11 >= 3.4). These tests pin the parts a packer cannot check
// for us — that each event carries the right fields, and that each one goes
// out with the event mask its convention requires. Hermetic: node-x11's
// in-process pure-JS X server delivers them.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import x11 from 'x11';
import xserver from 'x11/lib/xserver/index.js';

import { App, createClient, StaticFontSource } from '../lib/index.js';

const { createServer, createStreamPair } = xserver;

const REDIRECT = x11.eventMask.SubstructureRedirect | x11.eventMask.SubstructureNotify;

let server = null;
let wm = null;
let client = null;

const connect = async () => {
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);
  return createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
};

beforeEach(async () => {
  server = createServer({ width: 400, height: 300 });
  wm = await connect();
  client = await connect();
});

afterEach(() => {
  wm?.X.terminate();
  client?.X.terminate();
  server = wm = client = null;
});

const settle = (app) =>
  new Promise((resolve) => app.X.GetInputFocus(() => setImmediate(resolve)));

const settleBoth = async () => {
  await settle(client);
  await settle(wm);
};

const nextEvent = (window, name) => new Promise((resolve) => window.once(name, resolve));

test('sendConfigureNotify carries negative root coordinates as signed 16-bit', async () => {
  // a client scrolled partly off the left/top edge is where the sign
  // matters: read as unsigned, -12 becomes 65524 and the client concludes
  // it is somewhere off the far side of the screen
  const app = client.createWindow({ width: 100, height: 60 });
  await settle(client);

  const pending = nextEvent(app, 'resize');
  wm.createWindow({ id: app.id }).sendConfigureNotify({ x: -12, y: -3, width: 100, height: 60 });

  const ev = await pending;
  assert.equal(ev.x, -12, 'negative x survives the round trip');
  assert.equal(ev.y, -3);
});

test('a WM_DELETE_WINDOW message reaches the owner, not a bystander watching the window', async () => {
  // mask 0 means "the client that created this window". Sending it with a
  // real mask instead would deliver the close request to whoever selected
  // that mask — a window manager framing the window would ask itself to
  // close, and the application would never hear about it.
  const app = client.createWindow({ width: 40, height: 30 });
  app.setActions();
  await settleBoth();

  const seen = wm.createWindow({ id: app.id });
  await seen.selectInput(x11.eventMask.StructureNotify);

  let bystanderHeard = false;
  seen.on('message', () => {
    bystanderHeard = true;
  });
  const message = nextEvent(app, 'message');

  assert.equal(await seen.close(), true, 'asked politely');
  const ev = await message;

  assert.equal(ev.type, 33, 'ClientMessage');
  assert.equal(ev.format, 32);
  assert.equal(ev.data[0], await app.atom('WM_DELETE_WINDOW'));
  assert.equal(ev.data[1], 0, 'CurrentTime');
  await settleBoth();
  assert.equal(bystanderHeard, false, 'the watching window manager is not the addressee');
});

test('setAlwaysOnTop asks the window manager with a five-word EWMH message', async () => {
  const root = wm.rootWindow();
  const [netWmState, above] = await Promise.all([
    root.atom('_NET_WM_STATE'),
    root.atom('_NET_WM_STATE_ABOVE')
  ]);
  // the WM advertises the state, so the EWMH path is taken rather than the
  // Apple-WM fallback
  await root.setProperty('_NET_SUPPORTED', [above], { type: 'ATOM' });
  await root.selectInput(REDIRECT);
  await settleBoth();

  const app = client.createWindow({ width: 40, height: 30 });
  await settleBoth();
  // the message travels via the root's substructure mask but names the
  // client window in its own window field, and ntk routes events by that
  // field — so a window manager sees it on its wrapper for the client
  // window, which is the object it would be acting on anyway, not on root
  const pending = nextEvent(wm.createWindow({ id: app.id }), 'message');
  app.setAlwaysOnTop(true);

  const ev = await pending;
  assert.equal(ev.type, 33, 'ClientMessage');
  assert.equal(ev.format, 32);
  assert.equal(ev.wid, app.id, 'names the window whose state changes, not the root');
  assert.equal(ev.message_type, netWmState);
  assert.deepEqual(ev.data, [1 /* _NET_WM_STATE_ADD */, above, 0 /* no second state */, 1 /* application */, 0]);
});

test('an MSBFirst connection is refused rather than silently mis-decoded', async () => {
  // node-x11 declares the host byte order but encodes LSBFirst regardless,
  // so this connection was already broken before ntk saw it
  assert.throws(
    () => new App({ byte_order: 1 }),
    /MSBFirst/,
    'big-endian says so'
  );
  // an older x11 has no byte_order field at all; that must not throw
  assert.doesNotThrow(() => new App({ client: { on() {} }, byte_order: undefined }));
});
