// An adopted window opting into a backing store and Present
// (sidorares/ntk#294). `{ id }` alone still means "another client paints
// these pixels" — but the Composite overlay window and a window handed over
// by an embedding host are ours completely, and saying so is what turns
// double buffering and the vblank-paced blit back on for them.
//
// Hermetic: node-x11's in-process pure-JS X server with two connections, so
// the adopted window really belongs to another client, plus a mock client
// for the Present half (the pure-JS server has no Present extension).
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
let host = null; // the adopter: a compositor, an embedding host
let guest = null; // the client whose window it adopts

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

/** a window belonging to the other client, ready to be adopted by `host` */
const foreignWindow = async (opts = {}) => {
  const client = guest.createWindow({ width: 120, height: 80, ...opts });
  await settle(guest);
  return client;
};

test('an adopted window is still not double-buffered by default', async () => {
  const client = await foreignWindow();
  const adopted = host.createWindow({ id: client.id });
  const ctx = adopted.getContext('2d');
  await adopted.ready;
  await tick();

  assert.equal(adopted._backing, null, 'someone else paints these pixels');
  assert.equal(ctx._target, adopted, 'so the context draws straight to the window');
  client.destroy();
});

test('backingStore: true gives an adopted window a backing pixmap', async () => {
  const client = await foreignWindow();
  const adopted = host.createWindow({ id: client.id, backingStore: true });

  // the allocation needs the geometry, the depth and the visual the
  // constructor asked for, so it cannot have happened yet
  assert.equal(adopted._backing, null, 'nothing is known about the window yet');

  await adopted.ready;
  await tick();

  assert.ok(adopted._backing, 'the pixmap lands once the replies do');
  assert.ok(adopted._backing.width >= 120 && adopted._backing.height >= 80, 'big enough');
  assert.equal(adopted._backing.depth, 24, "the window's own depth");
  assert.equal(adopted._backing.visualId, adopted.visualId, "and its visual (#295)");
  client.destroy();
});

test('a 2d context taken before the replies re-binds to the pixmap', async () => {
  const client = await foreignWindow();
  const adopted = host.createWindow({ id: client.id, backingStore: true });
  const ctx = adopted.getContext('2d');
  assert.equal(ctx._target, adopted, 'the window itself, until there is a pixmap');

  await adopted.ready;
  await tick();
  assert.equal(ctx._target, adopted._backing, 'the "_backing" event re-binds it');

  // and drawing goes to the pixmap, not the window: nothing is on screen
  // until the frame is blitted
  ctx.fillStyle = 'rgb(10, 200, 30)';
  ctx.fillRect(0, 0, 20, 20);
  assert.equal(adopted._dirty, true, 'a frame is pending');
  client.destroy();
});

test('opting in after the fact works too: getContext is the other entry point', async () => {
  const client = await foreignWindow();
  // `present: true` alone also declares ownership — presenting needs a pixmap
  const adopted = host.createWindow({ id: client.id, present: true });
  await adopted.ready;
  adopted.getContext('2d');
  await tick();

  assert.ok(adopted._backing, 'the context asks for the buffer Present blits from');
  client.destroy();
});

test('backingStore: false still wins over an ownership claim', async () => {
  const client = await foreignWindow();
  const adopted = host.createWindow({ id: client.id, present: true, backingStore: false });
  adopted.getContext('2d');
  await adopted.ready;
  await tick();

  assert.equal(adopted._backing, null);
  client.destroy();
});

test('an adopted window that has gone gets no pixmap, and does not throw', async () => {
  const client = await foreignWindow();
  const id = client.id;
  client.destroy();
  await settle(guest);

  const adopted = host.createWindow({ id, backingStore: true });
  await adopted.ready;
  await tick();

  // `ready` settles either way, with the geometry never filled in — a
  // CreatePixmap of undefined by undefined is not the way to discover that
  assert.equal(adopted.width, undefined);
  assert.equal(adopted._backing, null);
  await settle(host);
});

test('setBackgroundPixel writes the window attribute only where we own it', async () => {
  const client = await foreignWindow();
  const attrs = [];
  const patch = (app) => {
    const real = app.X.ChangeWindowAttributes.bind(app.X);
    app.X.ChangeWindowAttributes = (id, values, cb) => {
      if (values.backgroundPixel !== undefined) attrs.push({ id, values });
      return real(id, values, cb);
    };
  };

  const plain = host.createWindow({ id: client.id });
  patch(host);
  plain.setBackgroundPixel(0x1e2228);
  assert.deepEqual(attrs, [], "another client's attributes are not ours to change");

  const owned = host.createWindow({ id: client.id, backingStore: true });
  assert.equal(owned, plain, 'the same wrapper — adoption is cached by id');
  // so drive the owned case on a wrapper of its own
  const second = await foreignWindow({ width: 40, height: 40 });
  const mine = host.createWindow({ id: second.id, backingStore: true });
  mine.setBackgroundPixel(0x1e2228);
  assert.equal(attrs.length, 1, 'declared ours, so the attribute is written');
  assert.equal(attrs[0].id, second.id);

  client.destroy();
  second.destroy();
});

test('the docs section describing the opt-in exists', () => {
  const window = readFileSync(join(docsDir, 'window.md'), 'utf8');
  assert.ok(/^## Adopted windows$/m.test(window), 'docs/window.md#adopted-windows');
  assert.ok(
    window.includes('createWindow({ id, backingStore: true })'),
    'and it spells the opt-in out'
  );
});

// ---------------------------------------------------------------------
// the Present half, against a mock client
// ---------------------------------------------------------------------

let nextId = 0xd000;

function makeMockApp() {
  const calls = { selects: [], presents: [] };
  const Present = {
    majorOpcode: 145,
    Option: { None: 0, Async: 1, Copy: 2 },
    EventMask: { NoEvent: 0, ConfigureNotify: 1, CompleteNotify: 2, IdleNotify: 4 },
    Pixmap(window, pixmap, opts) {
      calls.presents.push({ window, pixmap, opts });
    },
    SelectInput(eid, window, eventMask) {
      calls.selects.push({ eid, window, eventMask });
    }
  };
  const Fixes = {
    CreateRegion() {},
    SetRegion() {},
    DestroyRegion() {}
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
    PolyFillRectangle() {},
    CopyArea() {},
    GetGeometry(id, cb) {
      calls.getGeometry = cb;
    },
    GetWindowAttributes(id, cb) {
      calls.getAttributes = cb;
    },
    GetInputFocus() {},
    require(name, cb) {
      if (name === 'present') return cb(null, Present);
      if (name === 'fixes') return cb(null, Fixes);
      cb(new Error(`no ${name}`));
    }
  };
  const display = {
    client: X,
    Render: { rgb24: 'rgb24', rgba32: 'rgba32', a8: 'a8', CreatePicture() {}, FreePicture() {} },
    screen: [{ root: 1, root_depth: 24, white_pixel: 0xffffff }]
  };
  return { app: { X, display, options: {}, solidPicture: () => ({ id: nextId++ }) }, calls };
}

const geometryReply = () => ({
  windowid: 1,
  xPos: 0,
  yPos: 0,
  width: 64,
  height: 48,
  borderWidth: 0,
  depth: 24
});

test('present: true is honoured eagerly on an adopted window', async () => {
  const { app, calls } = makeMockApp();
  const wnd = new Window(app, { id: 0xf001, present: true, frameInterval: 0 });
  await wnd._presentPromise;

  assert.ok(wnd._presentExt, 'Present needs nothing of the window but its id');
  assert.equal(calls.selects.length, 1, 'and the completion events the clock runs on');
  assert.equal(calls.selects[0].window, wnd.id);
});

test('an adopted window opted into a backing store presents from it', async () => {
  const { app, calls } = makeMockApp();
  const wnd = new Window(app, { id: 0xf002, backingStore: true, frameInterval: 0 });
  wnd.getContext('2d');
  calls.getGeometry(null, geometryReply());
  calls.getAttributes(null, { visual: 34 });
  await wnd.ready;
  await tick();
  await wnd._presentPromise;

  assert.ok(wnd._backing, 'double buffered');
  wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 });
  await tick();
  assert.equal(calls.presents.length, 1, 'and blitted with Present, not CopyArea');
  assert.equal(calls.presents[0].pixmap, wnd._backing.id);
});

test('present: false keeps an owned adopted window on CopyArea', async () => {
  const { app, calls } = makeMockApp();
  const wnd = new Window(app, {
    id: 0xf003,
    backingStore: true,
    present: false,
    frameInterval: 0
  });
  wnd.getContext('2d');
  calls.getGeometry(null, geometryReply());
  calls.getAttributes(null, { visual: 34 });
  await wnd.ready;
  await tick();

  assert.ok(wnd._backing, 'still double buffered');
  assert.equal(wnd._presentExt, null, 'the opt-out is independent of the ownership claim');
});

test('a plain adopted window asks for neither', async () => {
  const { app, calls } = makeMockApp();
  const wnd = new Window(app, { id: 0xf004, frameInterval: 0 });
  wnd.getContext('2d');
  calls.getGeometry(null, geometryReply());
  calls.getAttributes(null, { visual: 34 });
  await wnd.ready;
  await tick();

  assert.equal(wnd._backing, null);
  assert.equal(wnd._presentExt, null);
  assert.deepEqual(calls.selects, []);
});
