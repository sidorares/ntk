// `wnd.ready` and `wnd.getGeometry()` (sidorares/ntk#293): the public wait
// for a window adopted by id, whose geometry — and depth — only arrive when
// the constructor's GetGeometry replies. Before this there was no way to
// await it from outside ntk, while an error message told you to.
//
// Hermetic: node-x11's in-process pure-JS X server, two connections, so the
// adopted window really belongs to another client the way a compositor's or
// a window manager's do. The pure-JS server offers only depth 24, so the
// depth-32 case — the one that silently loses the alpha channel — is driven
// against a mock client instead.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';

import xserver from 'x11/lib/xserver/index.js';

import Window from '../lib/window.js';
import { StaticFontSource, createClient } from '../lib/index.js';

const { createServer, createStreamPair } = xserver;

const docsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');

let server = null;
let host = null; // the adopter: a compositor, a window manager
let guest = null; // the client whose windows it adopts

// Adopting a window that has gone is half of what is under test, so the X
// errors it earns are expected output, not noise to print — take them here
// instead of letting the default handler warn.
const xErrors = [];

const connect = async () => {
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);
  return createClient({
    stream: clientEnd,
    fontSource: new StaticFontSource(),
    onXError: (err) => xErrors.push(err)
  });
};

beforeEach(async () => {
  server = createServer({ width: 400, height: 300 });
  xErrors.length = 0;
  host = await connect();
  guest = await connect();
});

afterEach(() => {
  host?.X.terminate();
  guest?.X.terminate();
  server = host = guest = null;
});

/** drain the round trips a connection has in flight */
const settle = (app) => new Promise((resolve) => app.X.GetInputFocus(() => setImmediate(resolve)));

test('a window ntk created is ready without a round trip', async () => {
  const wnd = host.createWindow({ width: 40, height: 30, x: 5, y: 6 });

  let resolved = null;
  wnd.ready.then((w) => (resolved = w));
  await Promise.resolve(); // one microtask: no room for any I/O
  assert.equal(resolved, wnd, 'resolves with the window, and immediately');

  // which is what makes awaiting it unconditionally safe — code handed a
  // window from either source need not ask which kind it has
  assert.equal(await wnd.ready, wnd);
  wnd.destroy();
});

test('an adopted window is ready only once GetGeometry answers', async () => {
  const client = guest.createWindow({ width: 120, height: 80, x: 7, y: 9 });
  await settle(guest);

  const adopted = host.createWindow({ id: client.id });
  assert.equal(adopted.width, undefined, 'nothing is known yet');
  assert.equal(adopted.depth, 0, 'including the depth a picture format comes from');

  let resolved = null;
  adopted.ready.then((w) => (resolved = w));
  await Promise.resolve();
  assert.equal(resolved, null, 'the wait is a real reply, not a formality');

  assert.equal(await adopted.ready, adopted);
  assert.equal(adopted.width, 120);
  assert.equal(adopted.height, 80);
  assert.equal(adopted.x, 7);
  assert.equal(adopted.y, 9);
  assert.equal(adopted.depth, 24, 'the depth a 2d context binds its format from');

  client.destroy();
});

test('adopting a window that has already gone still becomes ready', async () => {
  const client = guest.createWindow({ width: 20, height: 20 });
  const id = client.id;
  client.destroy();
  await settle(guest);

  // a window manager racing a client that exits is the ordinary case, and a
  // wait that never ends would be worse than one that ends empty-handed
  const adopted = host.createWindow({ id });
  assert.equal(await adopted.ready, adopted);
  assert.equal(adopted.width, undefined, 'there was nothing to record');
});

test('getGeometry() asks the server and writes the answer back', async () => {
  const wnd = host.createWindow({ width: 64, height: 48, x: 3, y: 4 });
  assert.equal(wnd.depth, 0, 'CopyFromParent: only the server ever resolved this');

  const geometry = await wnd.getGeometry();
  assert.deepEqual(geometry, {
    x: 3,
    y: 4,
    width: 64,
    height: 48,
    depth: 24,
    borderWidth: 0,
    root: host.display.screen[0].root
  });
  assert.equal(wnd.depth, 24, 'and the window now knows its real depth');
  assert.equal(wnd.width, 64);
  wnd.destroy();
});

test('getGeometry() on an adopted window is the wait as well as the answer', async () => {
  const client = guest.createWindow({ width: 90, height: 70, x: 11, y: 12 });
  await settle(guest);

  const adopted = host.createWindow({ id: client.id });
  const geometry = await adopted.getGeometry();
  assert.equal(geometry.width, 90);
  assert.equal(geometry.height, 70);
  assert.equal(await adopted.ready, adopted, 'the pending wait is settled by this reply too');

  client.destroy();
});

test('getGeometry() reports a window that is gone rather than hanging', async () => {
  const client = guest.createWindow({ width: 20, height: 20 });
  const id = client.id;
  client.destroy();
  await settle(guest);

  const adopted = host.createWindow({ id });
  await assert.rejects(() => adopted.getGeometry(), 'the X error reaches the caller');
});

test('a late reply does not overwrite a baseline the event stream set', async () => {
  const client = guest.createWindow({ width: 100, height: 60, x: 1, y: 2 });
  await settle(guest);

  const adopted = host.createWindow({ id: client.id, frameInterval: 0 });
  // a ConfigureNotify beats the reply in: that is the delivered geometry, and
  // the reply is only what the window looked like, so it must not claim to be
  // the last thing 'resize' handlers saw (see _tagResize)
  adopted.emit('event', { type: 22, width: 100, height: 60, x: 1, y: 2 });
  await tick();
  await adopted.ready;
  assert.deepEqual(adopted._deliveredGeom, { x: 1, y: 2, width: 100, height: 60 });

  client.destroy();
});

// ---------------------------------------------------------------------
// what the wait is for: the picture format a 2d context binds
// ---------------------------------------------------------------------

let nextId = 0xa000;

/** A mock client, so the adopted window can answer depth 32 on demand. */
function makeMockApp() {
  const calls = { pictures: [], freed: [] };
  const Render = {
    rgb24: 'rgb24',
    rgba32: 'rgba32',
    a8: 'a8',
    CreatePicture(id, drawable, format) {
      calls.pictures.push({ id, drawable, format });
    },
    FreePicture(id) {
      calls.freed.push(id);
    }
  };
  const X = {
    _closing: false,
    stream: { destroyed: false, writableEnded: false },
    event_consumers: {},
    keycode2keysyms: {},
    AllocID: () => nextId++,
    ReleaseID() {},
    CreateWindow() {},
    DestroyWindow() {},
    ChangeWindowAttributes() {},
    CreateGC() {},
    CreatePixmap() {},
    FreePixmap() {},
    GetGeometry(id, cb) {
      calls.getGeometry = cb;
    },
    GetInputFocus() {}
  };
  const display = {
    client: X,
    Render,
    screen: [{ root: 1, root_depth: 24, white_pixel: 0xffffff }]
  };
  // the shared solid the default fillStyle asks for, stubbed so that
  // `calls.pictures` holds only the pictures bound to the target
  const app = { X, display, solidPicture: () => ({ id: nextId++ }) };
  return { app, calls };
}

const geometryReply = (depth) => ({
  windowid: 1,
  xPos: 0,
  yPos: 0,
  width: 64,
  height: 64,
  borderWidth: 0,
  depth
});

test('a context on an adopted window rebinds when the depth turns out to be 32', async () => {
  const { app, calls } = makeMockApp();
  const wnd = new Window(app, { id: 0xbeef, frameInterval: 0 });
  const ctx = wnd.getContext('2d');

  // depth 0 is indistinguishable from depth 24 at this point, so the only
  // format available is the opaque one — this is where the alpha channel
  // used to be lost for good
  assert.deepEqual(
    calls.pictures.map((p) => p.format),
    ['rgb24']
  );
  assert.equal(ctx._hasAlpha, false);

  calls.getGeometry(null, geometryReply(32));
  await wnd.ready;
  await tick();

  assert.deepEqual(
    calls.pictures.map((p) => p.format),
    ['rgb24', 'rgba32'],
    'the reply changes the format, so the picture is rebuilt'
  );
  assert.equal(calls.freed.length, 1, 'and the wrong one is freed');
  assert.equal(ctx._hasAlpha, true, 'clearRect can clear to transparent again');
  assert.equal(ctx.picture.format, 'rgba32');
});

test('the section the pattern docs send an adopting caller to exists', () => {
  // a cross-file anchor is the one kind of doc link nothing else in CI checks
  const window = readFileSync(join(docsDir, 'window.md'), 'utf8');
  assert.ok(/^## Adopted windows$/m.test(window), 'docs/window.md#adopted-windows');
  const context = readFileSync(join(docsDir, 'context-2d.md'), 'utf8');
  assert.ok(context.includes('window.md#adopted-windows'), 'and createPattern points at it');
});

test('a depth the reply does not change costs no second picture', async () => {
  const { app, calls } = makeMockApp();
  const wnd = new Window(app, { id: 0xbee0, frameInterval: 0 });
  wnd.getContext('2d');
  assert.equal(calls.pictures.length, 1);

  calls.getGeometry(null, geometryReply(24));
  await wnd.ready;
  await tick();

  assert.equal(calls.pictures.length, 1, 'rgb24 either way — nothing to redo');
  assert.equal(calls.freed.length, 0);
});
