// EWMH _NET_WM_STATE: fullscreen, maximize, skip-taskbar and the rest.
// The interesting part is that there are two ways to change it and they are
// not interchangeable — a mapped window asks the window manager, an unmapped
// one declares its initial state by writing the property (EWMH 7.7) — so
// these tests run both paths against node-x11's in-process pure-JS X server
// and watch what actually goes on the wire.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import x11 from 'x11';
import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';

const { createServer, createStreamPair } = xserver;

let server = null;
let wm = null; // stands in for the window manager: watches the root
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

const atom = (app, name) =>
  new Promise((resolve, reject) =>
    app.X.InternAtom(false, name, (err, id) => (err ? reject(err) : resolve(id)))
  );

/** Advertise `names` in the root's _NET_SUPPORTED, as a window manager would. */
const advertise = async (names) => {
  const ids = await Promise.all(names.map((n) => atom(wm, `_NET_WM_STATE_${n.toUpperCase()}`)));
  await wm.rootWindow().setProperty('_NET_SUPPORTED', ids, { type: 'ATOM' });
  await settleBoth();
  return ids;
};

/** Create a window and wait until the server really has it mapped. */
const mappedWindow = async (args = {}) => {
  const wnd = client.createWindow({ width: 60, height: 40, ...args });
  const up = nextEvent(wnd, 'map');
  wnd.map();
  await up;
  await settleBoth();
  return wnd;
};

// ---------------------------------------------------------------------
// The unmapped path: declare the state by writing the property
// ---------------------------------------------------------------------

test('an unmapped window declares its state by writing the property', async () => {
  const wnd = client.createWindow({ width: 60, height: 40 });
  await wnd.setWmState('fullscreen');

  assert.deepEqual(await wnd.getWmStates(), ['fullscreen']);
});

test('the unmapped path accumulates instead of replacing', async () => {
  // _NET_WM_STATE is a list, so a plain Replace with one atom drops the rest
  const wnd = client.createWindow({ width: 60, height: 40 });
  await wnd.addWmState('fullscreen');
  await wnd.addWmState('skip_taskbar');

  assert.deepEqual((await wnd.getWmStates()).sort(), ['fullscreen', 'skip_taskbar']);

  await wnd.removeWmState('fullscreen');
  assert.deepEqual(await wnd.getWmStates(), ['skip_taskbar']);
});

test('two unmapped changes in the same tick both land', async () => {
  const wnd = client.createWindow({ width: 60, height: 40 });
  await Promise.all([wnd.addWmState('above'), wnd.addWmState('sticky')]);

  assert.deepEqual((await wnd.getWmStates()).sort(), ['above', 'sticky']);
});

test("toggle flips each state on the unmapped path", async () => {
  const wnd = client.createWindow({ width: 60, height: 40 });
  await wnd.setWmState('fullscreen', 'toggle');
  assert.deepEqual(await wnd.getWmStates(), ['fullscreen']);

  await wnd.setWmState('fullscreen', 'toggle');
  assert.deepEqual(await wnd.getWmStates(), []);
});

test("'maximized' expands to the vertical and horizontal pair", async () => {
  // EWMH maximizes one axis at a time, which is why its message has room
  // for two states rather than one
  const wnd = client.createWindow({ width: 60, height: 40 });
  await wnd.setWmState('maximized');

  assert.deepEqual((await wnd.getWmStates()).sort(), ['maximized_horz', 'maximized_vert']);
});

// ---------------------------------------------------------------------
// The mapped path: ask the window manager
// ---------------------------------------------------------------------

test('a mapped window asks the window manager instead of writing the property', async () => {
  await wm.rootWindow().selectInput(x11.eventMask.SubstructureNotify);
  const [fullscreen] = await advertise(['fullscreen']);
  const netWmState = await atom(wm, '_NET_WM_STATE');

  const wnd = await mappedWindow();
  const seen = wm.createWindow({ id: wnd.id });
  const pending = nextEvent(seen, 'message');

  assert.equal(await wnd.setWmState('fullscreen'), true, 'the WM advertises it');
  const ev = await pending;

  assert.equal(ev.message_type, netWmState);
  assert.deepEqual(ev.data, [1 /* add */, fullscreen, 0, 1 /* application */, 0]);
  // and it did NOT write the property: the window manager owns it on a
  // mapped window, and a client writing it there is ignored at best
  await settleBoth();
  assert.deepEqual(await wnd.getWmStates(), [], 'nothing written behind the WM back');
});

test('both maximize atoms travel in one message', async () => {
  await wm.rootWindow().selectInput(x11.eventMask.SubstructureNotify);
  const [vert, horz] = await advertise(['maximized_vert', 'maximized_horz']);

  const wnd = await mappedWindow();
  const pending = nextEvent(wm.createWindow({ id: wnd.id }), 'message');
  await wnd.setWmState('maximized', 'add');

  const ev = await pending;
  assert.deepEqual(ev.data.slice(0, 3), [1, vert, horz], 'both slots used');
});

test('more than two states at once is refused, not silently truncated', async () => {
  const wnd = client.createWindow({ width: 60, height: 40 });
  await assert.rejects(
    () => wnd.setWmState(['fullscreen', 'above', 'sticky']),
    /at most 2 states/
  );
  await assert.rejects(() => wnd.setWmState('fullscreen', 'maybe'), /add, remove or toggle/);
});

// ---------------------------------------------------------------------
// _NET_SUPPORTED
// ---------------------------------------------------------------------

test('a state the window manager does not advertise reports false', async () => {
  await advertise(['above']);
  const wnd = await mappedWindow();

  assert.equal(await wnd.setWmState('above'), true);
  assert.equal(await wnd.setWmState('fullscreen'), false, 'nothing is listening for it');
});

test('an unmapped window still declares a state no window manager advertises', async () => {
  // there may be no window manager running yet; the property is how a
  // client says what it wants before one arrives to read it
  const wnd = client.createWindow({ width: 60, height: 40 });
  assert.equal(await wnd.setWmState('fullscreen'), false, 'reported honestly');
  assert.deepEqual(await wnd.getWmStates(), ['fullscreen'], 'and written anyway');
});

// ---------------------------------------------------------------------
// Reading back, and hearing about changes
// ---------------------------------------------------------------------

test('getWmStates names states this build has never heard of', async () => {
  const wnd = client.createWindow({ width: 60, height: 40 });
  const vendor = await atom(client, '_NET_WM_STATE_SOMETHING_NEW');
  await wnd.setProperty('_NET_WM_STATE', [vendor], { type: 'ATOM' });

  assert.deepEqual(await wnd.getWmStates(), ['something_new']);
});

test("statechange fires when the window manager changes the window's state", async () => {
  // the user hits the maximize button or a fullscreen hotkey: the state
  // changes behind the application's back, and this is the only way an app
  // that mirrors it in its own UI stays honest
  const wnd = await mappedWindow();
  const heard = nextEvent(wnd, 'statechange');
  await settleBoth();

  // the window manager owns the property on a mapped window
  await wm.createWindow({ id: wnd.id }).setProperty('_NET_WM_STATE', [
    await atom(wm, '_NET_WM_STATE_FULLSCREEN'),
    await atom(wm, '_NET_WM_STATE_FOCUSED')
  ], { type: 'ATOM' });

  const states = await heard;
  assert.deepEqual(states.slice().sort(), ['focused', 'fullscreen']);
});

test('setAlwaysOnTop still works, and now takes the mapped path', async () => {
  await wm.rootWindow().selectInput(x11.eventMask.SubstructureNotify);
  const [above] = await advertise(['above']);

  const wnd = await mappedWindow();
  const pending = nextEvent(wm.createWindow({ id: wnd.id }), 'message');
  wnd.setAlwaysOnTop(true);

  const ev = await pending;
  assert.deepEqual(ev.data.slice(0, 2), [1, above]);
});
