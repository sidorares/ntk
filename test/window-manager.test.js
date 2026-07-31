// The window manager side of ntk: claiming the role on the root, receiving
// substructure requests with enough information to answer them, and reading
// what other clients declare about their windows. Hermetic — node-x11's
// in-process pure-JS X server redirects the requests, so no display is
// needed.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import x11 from 'x11';
import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';

const { createServer, createStreamPair } = xserver;

const REDIRECT = x11.eventMask.SubstructureRedirect | x11.eventMask.SubstructureNotify;

let server = null;
let wm = null; // the window manager connection
let client = null; // an ordinary application connection

// Two connections to one server: `wm` claims the root, `client` behaves
// like any application that knows nothing about it. A fresh server per test
// keeps the root's redirect selection from leaking between them.
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

// terminate(), not close(): one of these tests deliberately gets a
// connection killed by the server, and a graceful close waits on a round
// trip that a dead socket will never answer
afterEach(() => {
  wm?.X.terminate();
  client?.X.terminate();
  server = wm = client = null;
});

// drain the round trips both connections have in flight
const settle = (app) =>
  new Promise((resolve) => app.X.GetInputFocus(() => setImmediate(resolve)));

const settleBoth = async () => {
  await settle(client);
  await settle(wm);
};

const nextEvent = (window, name) =>
  new Promise((resolve) => window.once(name, resolve));

test('selectInput claims the window manager role, and reports it taken', async () => {
  const root = wm.rootWindow();
  await root.selectInput(REDIRECT);

  const otherRoot = client.rootWindow();
  await assert.rejects(
    () => otherRoot.selectInput(x11.eventMask.SubstructureRedirect),
    (err) => err.error === 10, // BadAccess
    'a second window manager is refused'
  );
});

test('map_request arrives instead of the window being mapped', async () => {
  const root = wm.rootWindow();
  await root.selectInput(REDIRECT);

  const pending = nextEvent(root, 'map_request');
  const app = client.createWindow({ width: 120, height: 80 });
  app.map();

  const ev = await pending;
  assert.equal(ev.window.id, app.id, 'the client window');
  assert.equal(ev.parent.id, root.id, 'reparented under the root');

  const attrs = await ev.window.getAttributes();
  assert.equal(attrs.mapState, 0, 'still unmapped — ours to decide');
});

test('configure_request carries the geometry and the value mask', async () => {
  const root = wm.rootWindow();
  await root.selectInput(REDIRECT);

  const app = client.createWindow({ x: 5, y: 6, width: 120, height: 80 });
  await settle(client);

  const pending = nextEvent(root, 'configure_request');
  app.resize(300, 200);

  const ev = await pending;
  assert.equal(ev.window.id, app.id);
  assert.equal(ev.width, 300, 'the size the client asked for');
  assert.equal(ev.height, 200);
  // CWWidth | CWHeight — the mask is what tells x/y apart from
  // "the window's current x/y, which you must ignore"
  assert.equal(ev.mask, 0x0004 | 0x0008);
});

test('a frame is a window the client is reparented into', async () => {
  const root = wm.rootWindow();
  await root.selectInput(REDIRECT);

  const pending = nextEvent(root, 'map_request');
  const app = client.createWindow({ width: 100, height: 60 });
  app.map();
  const { window: managed } = await pending;

  const frame = wm.createWindow({ x: 20, y: 30, width: 106, height: 90 });
  managed.addToSaveSet();
  managed.reparentTo(frame, 3, 27);
  frame.map();
  managed.map();
  await settleBoth();

  const tree = await new Promise((resolve, reject) =>
    frame.queryTree((err, res) => (err ? reject(err) : resolve(res)))
  );
  assert.deepEqual(
    tree.children.map((w) => w.id),
    [managed.id],
    'the client now lives inside the frame'
  );

  const attrs = await managed.getAttributes();
  assert.equal(attrs.mapState, 2, 'viewable');
});

test('getTitle prefers _NET_WM_NAME and falls back to WM_NAME', async () => {
  const root = wm.rootWindow();
  const app = client.createWindow({ width: 40, height: 30 });
  await settle(client);

  const seen = wm.createWindow({ id: app.id });
  assert.equal(await seen.getTitle(), null, 'no title set yet');

  // WM_NAME only — the legacy latin-1 property
  app.X.ChangeProperty(0, app.id, app.X.atoms.WM_NAME, app.X.atoms.STRING, 8, 'legacy');
  await settleBoth();
  assert.equal(await seen.getTitle(), 'legacy');

  // setTitle writes both, and _NET_WM_NAME wins
  app.setTitle('modern ✻ utf8');
  await settleBoth();
  assert.equal(await seen.getTitle(), 'modern ✻ utf8');

  assert.ok(root.id, 'root still resolvable');
});

test('getSizeHints reads back what setSizeHints wrote', async () => {
  const app = client.createWindow({ width: 200, height: 150 });
  app.setSizeHints({
    minWidth: 120,
    minHeight: 90,
    maxWidth: 800,
    maxHeight: 600,
    widthInc: 6,
    heightInc: 13,
    baseWidth: 4,
    baseHeight: 2
  });
  await settle(client);

  const seen = wm.createWindow({ id: app.id });
  const hints = await seen.getSizeHints();
  assert.equal(hints.minWidth, 120);
  assert.equal(hints.minHeight, 90);
  assert.equal(hints.maxWidth, 800);
  assert.equal(hints.maxHeight, 600);
  assert.equal(hints.widthInc, 6);
  assert.equal(hints.heightInc, 13);
  assert.equal(hints.baseWidth, 4);
  assert.equal(hints.baseHeight, 2);
  assert.equal(hints.gravity, undefined, 'flag not set, key absent');
});

test('getSizeHints is an empty object when the window has no hints', async () => {
  const app = client.createWindow({ width: 60, height: 40 });
  await settle(client);
  const seen = wm.createWindow({ id: app.id });
  assert.deepEqual(await seen.getSizeHints(), {});
});

test('getProperty decodes strings, numbers and raw bytes, null when unset', async () => {
  const app = client.createWindow({ width: 60, height: 40 });
  app.setClass('inst', 'Class');
  await settle(client);

  const seen = wm.createWindow({ id: app.id });
  assert.equal(await seen.getProperty('WM_CLASS', { as: 'string' }), 'inst\0Class');

  const raw = await seen.getProperty('WM_CLASS');
  assert.ok(Buffer.isBuffer(raw.data), 'raw bytes by default');

  assert.equal(await seen.getProperty('_NET_WM_STATE'), null, 'unset property');

  app.setActions(); // writes WM_PROTOCOLS = [WM_DELETE_WINDOW]
  await settleBoth();
  const protocols = await seen.getProperty('WM_PROTOCOLS', { as: 'numbers' });
  const deleteAtom = await seen.atom('WM_DELETE_WINDOW');
  assert.deepEqual(protocols, [deleteAtom]);
});

test('setProperty round-trips through getProperty', async () => {
  const window = wm.createWindow({ width: 40, height: 30 });

  await window.setProperty('_NET_WM_NAME', 'hello ✻ world');
  assert.equal(
    await window.getProperty('_NET_WM_NAME', { as: 'string' }),
    'hello ✻ world'
  );

  const ids = [0x123456, 0x789abc];
  await window.setProperty('_NET_CLIENT_LIST', ids, { type: 'WINDOW' });
  assert.deepEqual(
    await window.getProperty('_NET_CLIENT_LIST', { as: 'numbers' }),
    ids
  );

  // the type atom is what EWMH readers check, so it has to be right
  const raw = await window.getProperty('_NET_CLIENT_LIST');
  assert.equal(raw.type, await window.atom('WINDOW'));
});

test('close asks politely when the client opted in, kills it when it did not', async () => {
  const polite = client.createWindow({ width: 40, height: 30 });
  polite.setActions();
  await settleBoth();

  const seenPolite = wm.createWindow({ id: polite.id });
  const message = nextEvent(polite, 'message');
  assert.equal(await seenPolite.close(), true, 'asked, not killed');

  const ev = await message;
  const deleteAtom = await seenPolite.atom('WM_DELETE_WINDOW');
  assert.equal(ev.data[0], deleteAtom, 'WM_DELETE_WINDOW');

  // a window that never advertised the protocol has no such path
  const silent = client.createWindow({ width: 40, height: 30 });
  await settleBoth();
  const seenSilent = wm.createWindow({ id: silent.id });
  assert.equal(await seenSilent.close(), false, 'killed outright');
});

test('a dialog is already transient by the time its map_request arrives', async () => {
  // ICCCM 4.1.2.6 expects WM_TRANSIENT_FOR to be set before the window is
  // mapped, and a window manager that reads it only on MapRequest — which
  // is the moment it decides placement and stacking — sees whatever is
  // there right then. Both atoms are predefined, so the write needs no
  // InternAtom round trip and cannot be overtaken by a map() on the next
  // line; going through the generic property path instead would lose this.
  const root = wm.rootWindow();
  await root.selectInput(REDIRECT);

  const owner = client.createWindow({ width: 200, height: 150 });
  const pending = nextEvent(root, 'map_request');
  const dialog = client.createWindow({ width: 120, height: 80, transientFor: owner });
  dialog.map();

  const ev = await pending;
  assert.equal(ev.window.id, dialog.id);
  assert.equal(
    await ev.window.getTransientFor(),
    owner.id,
    'the owner is known at MapRequest, not a round trip later'
  );
});

test('sendConfigureNotify tells a reparented client where it really is', async () => {
  const app = client.createWindow({ width: 100, height: 60 });
  await settle(client);

  const pending = nextEvent(app, 'resize');
  wm.createWindow({ id: app.id }).sendConfigureNotify({
    x: 40,
    y: 70,
    width: 100,
    height: 60
  });

  const ev = await pending;
  assert.equal(ev.x, 40, 'root-relative, not frame-relative');
  assert.equal(ev.y, 70);
  assert.equal(ev.width, 100);
  assert.equal(ev.height, 60);
});

test('create fires for windows appearing under a watched parent', async () => {
  const root = wm.rootWindow();
  await root.selectInput(REDIRECT);

  const pending = nextEvent(root, 'create');
  const app = client.createWindow({ width: 50, height: 50 });

  const ev = await pending;
  assert.equal(ev.window.id, app.id);
  assert.equal(ev.width, 50, 'the payload comes through');
  assert.equal(ev.overrideRedirect, false);
});

test('queryTree on the root reports no parent instead of inventing one', async () => {
  const root = wm.rootWindow();
  const before = await new Promise((resolve, reject) =>
    root.queryTree((err, res) => (err ? reject(err) : resolve(res)))
  );
  assert.equal(before.parent, null, 'the root has no parent');
  assert.equal(before.root.id, root.id);

  // QueryTree answers None (0) for the root's parent; wrapping that as a
  // window used to create a real 800x800 one on every call
  const after = await new Promise((resolve, reject) =>
    root.queryTree((err, res) => (err ? reject(err) : resolve(res)))
  );
  assert.equal(
    after.children.length,
    before.children.length,
    'querying the tree does not add to it'
  );

  assert.throws(() => wm.createWindow({ id: 0 }), /not a window id/);
});

test('an override-redirect window is never redirected', async () => {
  const root = wm.rootWindow();
  await root.selectInput(REDIRECT);

  let redirected = false;
  root.on('map_request', () => (redirected = true));

  const menu = client.createWindow({ width: 80, height: 40, overrideRedirect: true });
  menu.map();
  await settleBoth();

  assert.equal(redirected, false, 'menus bypass the window manager');
  const attrs = await wm.createWindow({ id: menu.id }).getAttributes();
  assert.equal(attrs.mapState, 2, 'mapped itself');
});
