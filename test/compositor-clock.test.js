// Under a compositing manager a window leaves Present to it (lib/window.js
// `_preferFence`, lib/app.js `compositing`): the fence ends its frames and
// CopyArea blits them, as on a server whose vblanks are made up. Xwayland,
// `frameClock: 'present'` and a server with no compositor keep Present.
// Issue #402 has the measurements behind it. Hermetic: the server, Present
// and the compositor's selection are stubs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick, setTimeout as sleep } from 'node:timers/promises';

import App from '../lib/app.js';
import Window from '../lib/window.js';

let nextId = 0xe000;

const PRESENT_OPCODE = 145;
const BYPASS = 0x4242;

/** A connection with Present, whose compositor state the test sets. */
function makeMockApp({ compositing = null, xwayland = false } = {}) {
  const calls = { copies: 0, presents: [], fences: [], properties: [] };
  const Present = {
    majorOpcode: PRESENT_OPCODE,
    Option: { None: 0, Async: 1, Copy: 2, UST: 4, Suboptimal: 8 },
    EventMask: { NoEvent: 0, ConfigureNotify: 1, CompleteNotify: 2, IdleNotify: 4 },
    CompleteKind: { Pixmap: 0, NotifyMSC: 1 },
    CompleteMode: { Copy: 0, Flip: 1, Skip: 2, SuboptimalCopy: 3 },
    events: { ConfigureNotify: 0, CompleteNotify: 1, IdleNotify: 2 },
    Pixmap(window, pixmap, opts) {
      calls.presents.push({ window, pixmap, opts });
    },
    SelectInput() {}
  };
  const Fixes = { CreateRegion() {}, SetRegion() {}, DestroyRegion() {} };
  const X = {
    _closing: false,
    stream: { destroyed: false, writableEnded: false },
    event_consumers: {},
    keycode2keysyms: {},
    atoms: {},
    AllocID: () => nextId++,
    ReleaseID() {},
    CreateWindow() {},
    DestroyWindow() {},
    ChangeWindowAttributes() {},
    ChangeProperty(mode, wid, property, type, format, data) {
      calls.properties.push({ wid, property, data });
    },
    CreateGC() {},
    CreatePixmap() {},
    FreePixmap() {},
    PolyFillRectangle() {},
    CopyArea() {
      calls.copies++;
    },
    GetInputFocus(cb) {
      calls.fences.push(cb);
    },
    InternAtom(o, name, cb) {
      cb(null, name === '_NET_WM_BYPASS_COMPOSITOR' ? BYPASS : 1);
    },
    require(name, cb) {
      if (name === 'present') return cb(null, Present);
      if (name === 'fixes') return cb(null, Fixes);
      cb(new Error(`no ${name}`));
    }
  };
  const display = { client: X, screen: [{ root: 1, root_depth: 24, white_pixel: 0xffffff }] };
  // the window reads these off its app: what App#compositing and
  // App#xwayland answer once the server has
  const app = { X, display, options: {}, compositing, xwayland };
  return { app, calls };
}

async function presentWindow(args = {}, mock = {}) {
  const { app, calls } = makeMockApp(mock);
  const wnd = new Window(app, { width: 200, height: 100, ...args });
  wnd.width = 200;
  wnd.height = 100;
  wnd._backing = { id: 0xb300, width: 200, height: 100, destroy() {} };
  wnd._presentGc = 0xc300;
  await wnd.enablePresent();
  return { wnd, calls, app };
}

function complete(wnd, { msc = 1, ust = 1_000_000 } = {}) {
  wnd.emit('event', {
    type: 35,
    extension: PRESENT_OPCODE,
    evtype: 1, // CompleteNotify
    kind: 0,
    mode: 0,
    serial: wnd._presentSerial,
    ust,
    msc,
    wid: wnd.id
  });
}

function animate(wnd, state = { frames: 0 }) {
  const step = () => {
    state.frames++;
    wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 });
    wnd.requestAnimationFrame(step);
  };
  wnd.requestAnimationFrame(step);
  return state;
}

async function answerFences(calls, rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    for (const fence of calls.fences.splice(0)) fence(null, {});
    await sleep(25);
  }
}

test('under a compositor the fence ends frames and CopyArea blits them', async () => {
  const { wnd, calls } = await presentWindow({}, { compositing: true });
  assert.equal(wnd.frameClock, 'fence');
  const state = animate(wnd);
  await tick();
  await answerFences(calls);
  assert.ok(state.frames > 1, `frames ran: ${state.frames}`);
  assert.equal(calls.presents.length, 0, 'no present');
  assert.ok(calls.copies > 1, `each frame a CopyArea: ${calls.copies}`);
  wnd.destroy();
});

test('with no compositor a window presents, as it always has', async () => {
  const { wnd, calls } = await presentWindow({}, { compositing: false });
  assert.equal(wnd.frameClock, 'present');
  animate(wnd);
  await tick();
  assert.equal(calls.presents.length, 1);
  assert.equal(calls.copies, 0);
  wnd.destroy();
});

test('Xwayland keeps Present, whose clock is its compositor’s frame callback', async () => {
  const { wnd, calls } = await presentWindow({}, { compositing: true, xwayland: true });
  assert.equal(wnd.frameClock, 'present');
  animate(wnd);
  await tick();
  assert.equal(calls.presents.length, 1);
  wnd.destroy();
});

test("frameClock: 'present' keeps Present under a compositor", async () => {
  const { wnd, calls } = await presentWindow({ frameClock: 'present' }, { compositing: true });
  assert.equal(wnd.frameClock, 'present');
  animate(wnd);
  await tick();
  assert.equal(calls.presents.length, 1);
  wnd.destroy();
});

test('a compositor that starts mid-frame waits for the present in flight', async () => {
  // The present owns the backing store until it executes (#223): the first
  // CopyArea may not go out before its completion hands the store back.
  const { wnd, calls, app } = await presentWindow({}, { compositing: false });
  const state = animate(wnd);
  await tick();
  assert.equal(calls.presents.length, 1, 'a present in flight');
  app.compositing = true;
  wnd._compositingChanged();
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(calls.copies, 0, 'no CopyArea while it is in flight');
  assert.equal(state.frames, 1, 'and no frame drawn behind it');
  complete(wnd, { msc: 1 });
  await tick();
  await answerFences(calls);
  assert.ok(calls.copies > 0, 'CopyArea from the next frame on');
  assert.equal(calls.presents.length, 1, 'and no present after the switch');
  assert.equal(wnd.frameClock, 'fence');
  wnd.destroy();
});

test('a compositor that stops hands the window back to Present', async () => {
  const { wnd, calls, app } = await presentWindow({}, { compositing: true });
  const state = animate(wnd);
  await tick();
  await answerFences(calls);
  const frames = state.frames;
  app.compositing = false;
  wnd._compositingChanged();
  await answerFences(calls);
  assert.equal(wnd.frameClock, 'present');
  assert.ok(calls.presents.length >= 1, 'presents again');
  assert.ok(state.frames > frames, 'and frames kept coming');
  wnd.destroy();
});

test('a top-level window under a compositor asks not to be unredirected', async () => {
  // A compositor that unredirects a fullscreen window would put its CopyArea
  // blits on the scanout, where a copy can tear.
  const asked = (calls, wnd) =>
    calls.properties.filter((p) => p.wid === wnd.id && p.property === BYPASS);
  const { wnd, calls } = await presentWindow({}, { compositing: true });
  assert.deepEqual(
    asked(calls, wnd).map((p) => p.data),
    [[2]],
    '_NET_WM_BYPASS_COMPOSITOR = 2, once'
  );
  wnd.destroy();

  const none = await presentWindow({}, { compositing: false });
  assert.equal(asked(none.calls, none.wnd).length, 0, 'not without a compositor');
  none.app.compositing = true;
  none.wnd._compositingChanged();
  assert.equal(asked(none.calls, none.wnd).length, 1, 'asked when one starts');
  none.wnd.destroy();

  const pinned = await presentWindow({ frameClock: 'present' }, { compositing: true });
  assert.equal(asked(pinned.calls, pinned.wnd).length, 0, 'nor on Present by name');
  pinned.wnd.destroy();
});

// --- App#compositing: the selection a compositor owns ------------------------

/** every reply lands a tick later, the way a real server's does */
const reply = (cb, ...args) => setImmediate(() => cb(...args));

function makeApp({ owner = 0, xwayland = false } = {}) {
  const X = {
    _closing: false,
    stream: { destroyed: false, writableEnded: false },
    event_consumers: {},
    keycode2keysyms: {},
    atoms: {},
    on() {},
    AllocID: () => nextId++,
    ReleaseID() {},
    InternAtom(o, name, cb) {
      reply(cb, null, name === '_NET_WM_CM_S0' ? 0x1234 : 1);
    },
    QueryExtension(name, cb) {
      reply(cb, null, { present: name === 'XWAYLAND' && xwayland });
    },
    GetSelectionOwner(sel, cb) {
      reply(cb, null, sel === 0x1234 ? owner : 0);
    },
    require(name, cb) {
      reply(cb, new Error(`no ${name}`));
    }
  };
  const display = { client: X, screen: [{ root: 1, root_depth: 24, white_pixel: 0xffffff }] };
  const app = new App(display, {});
  const watchers = [];
  app._clipboard = {
    async watch(name, handler) {
      watchers.push({ name, handler });
      return () => {};
    }
  };
  return { app, watchers };
}

async function settle() {
  for (let i = 0; i < 8; i++) await tick();
}

test('App#compositing asks who owns _NET_WM_CM_S0, and follows it', async () => {
  const { app, watchers } = makeApp({ owner: 0x0a00001 });
  assert.equal(app.compositing, null, 'unknown until the server answers');
  await settle();
  assert.equal(app.compositing, true, 'a compositor owns the selection');
  assert.equal(app.xwayland, false);
  assert.deepEqual(
    watchers.map((w) => w.name),
    ['_NET_WM_CM_S0'],
    'and the selection is watched'
  );
  watchers[0].handler({ reason: 'destroyed', owner: 0 });
  assert.equal(app.compositing, false, 'its window gone, the compositor is');
  watchers[0].handler({ reason: 'new-owner', owner: 0x0b00001 });
  assert.equal(app.compositing, true, 'and a new one is noticed');
});

test('App#compositing: no owner is no compositor, and Xwayland says so', async () => {
  const none = makeApp({ owner: 0 });
  void none.app.compositing;
  await settle();
  assert.equal(none.app.compositing, false);
  const wayland = makeApp({ owner: 0x0a00001, xwayland: true });
  void wayland.app.compositing;
  await settle();
  assert.equal(wayland.app.compositing, true);
  assert.equal(wayland.app.xwayland, true);
});
