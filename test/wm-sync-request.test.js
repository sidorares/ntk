// _NET_WM_SYNC_REQUEST (EWMH 6.2) against a mock X client.
//
// The protocol is one rule — echo back the number the window manager sent,
// once the resize has been painted — and one failure mode: an acknowledgement
// that never goes out leaves the window manager waiting, which stalls the
// interactive resize. So these tests are mostly about *ordering* (the counter
// is set after the copies, never before) and about the paths where nothing
// repaints at all.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick, setTimeout as sleep } from 'node:timers/promises';

import Window from '../lib/window.js';

let nextId = 0xd000;

function makeMockApp({ withSync = true } = {}) {
  const calls = { order: [], setCounter: [], created: [], destroyed: [], props: [] };
  const Sync = {
    CreateCounter(id, value) {
      calls.created.push({ id, value });
    },
    SetCounter(counter, value) {
      calls.order.push('SetCounter');
      calls.setCounter.push({ counter, value });
    },
    DestroyCounter(counter) {
      calls.destroyed.push(counter);
    }
  };
  const atoms = { WM_PROTOCOLS: 100, CARDINAL: 6 };
  let nextAtom = 500;
  const named = {};
  const X = {
    _closing: false,
    stream: { destroyed: false, writableEnded: false },
    event_consumers: {},
    keycode2keysyms: {},
    atoms,
    AllocID: () => nextId++,
    ReleaseID() {},
    CreateWindow() {},
    DestroyWindow() {},
    ChangeWindowAttributes() {},
    ChangeProperty(mode, wid, atom, type, format, data) {
      calls.props.push({ atom, type, format, data });
    },
    GetProperty(del, wid, atom, type, offset, len, cb) {
      cb(null, { data: Buffer.alloc(0), type: 0, format: 0 });
    },
    CreateGC() {},
    CreatePixmap() {},
    FreePixmap() {},
    PolyFillRectangle() {},
    CopyArea() {
      calls.order.push('CopyArea');
    },
    GetInputFocus(cb) {
      cb(null, {});
    },
    InternAtom(onlyIfExists, name, cb) {
      // node-x11 caches interned atoms per connection, so a name already in
      // X.atoms keeps its id — including the ones seeded above
      if (!named[name]) named[name] = atoms[name] ?? ++nextAtom;
      atoms[name] = named[name];
      cb(null, named[name]);
    },
    require(name, cb) {
      if (name === 'sync' && withSync) return cb(null, Sync);
      cb(new Error(`no ${name}`));
    }
  };
  const display = { client: X, screen: [{ root: 1, root_depth: 24, white_pixel: 0xffffff }] };
  return { app: { X, display, options: {} }, calls, named };
}

async function syncWindow(opts) {
  const { app, calls, named } = makeMockApp(opts);
  const wnd = new Window(app, { width: 200, height: 100 });
  wnd.width = 200;
  wnd.height = 100;
  wnd._backing = { id: 0xb100, width: 200, height: 100, destroy() {} };
  wnd._presentGc = 0xc100;
  await wnd.enableSyncRequest();
  return { wnd, calls, named, app };
}

// the ClientMessage a window manager sends before each ConfigureNotify
const syncMessage = (syncAtom, lo, hi = 0) => ({
  type: 33,
  format: 32,
  message_type: 100, // WM_PROTOCOLS
  data: [syncAtom, 0, lo, hi, 0]
});

test('enableSyncRequest publishes the counter before advertising the protocol', async () => {
  const { wnd, calls, named } = await syncWindow();
  assert.equal(calls.created.length, 1, 'a counter was created');
  assert.equal(calls.created[0].value, 0, 'starting at 0');
  const counterProp = calls.props.find((p) => p.atom === named._NET_WM_SYNC_REQUEST_COUNTER);
  assert.ok(counterProp, '_NET_WM_SYNC_REQUEST_COUNTER was written');
  assert.equal(counterProp.format, 32);
  assert.deepEqual(counterProp.data, [calls.created[0].id], 'holds the counter xid');
  wnd.destroy();
});

test('the acknowledgement is sent after the copies, carrying the exact value', async () => {
  const { wnd, calls, named } = await syncWindow();
  wnd.emit('event', syncMessage(named._NET_WM_SYNC_REQUEST, 0x2a));
  assert.deepEqual(calls.setCounter, [], 'nothing acknowledged before the repaint');

  wnd._markDirty({ x: 0, y: 0, w: 50, h: 50 });
  await tick();

  assert.deepEqual(
    calls.order.slice(-2),
    ['CopyArea', 'SetCounter'],
    'the counter is set after the blit, not before'
  );
  assert.equal(calls.setCounter.length, 1);
  assert.equal(calls.setCounter[0].value, 0x2a);
  wnd.destroy();
});

test('a 64-bit request number is recomposed from its two halves', async () => {
  const { wnd, calls, named } = await syncWindow();
  wnd.emit('event', syncMessage(named._NET_WM_SYNC_REQUEST, 0x2a, 1)); // hi=1
  wnd._markDirty();
  await tick();
  assert.equal(calls.setCounter[0].value, 0x10000002a);
  wnd.destroy();
});

test('only the last request is acknowledged', async () => {
  const { wnd, calls, named } = await syncWindow();
  wnd.emit('event', syncMessage(named._NET_WM_SYNC_REQUEST, 11));
  wnd.emit('event', syncMessage(named._NET_WM_SYNC_REQUEST, 12));
  wnd.emit('event', syncMessage(named._NET_WM_SYNC_REQUEST, 13));
  wnd._markDirty();
  await tick();
  assert.equal(calls.setCounter.length, 1, 'one acknowledgement, not three');
  assert.equal(calls.setCounter[0].value, 13, 'the newest request number');
  wnd.destroy();
});

test('a request that triggers no repaint is still acknowledged by the watchdog', async () => {
  const { wnd, calls, named } = await syncWindow();
  wnd.emit('event', syncMessage(named._NET_WM_SYNC_REQUEST, 7));
  // nothing is marked dirty: a move, or a resize to the size we already are
  await sleep(120); // longer than the watchdog (2x frameInterval, min 32ms)
  assert.equal(calls.setCounter.length, 1, 'the window manager was not left waiting');
  assert.equal(calls.setCounter[0].value, 7);
  wnd.destroy();
});

test('messages that are not sync requests are ignored', async () => {
  const { wnd, calls, named } = await syncWindow();
  // a WM_DELETE_WINDOW-shaped message on the same message_type
  wnd.emit('event', { type: 33, format: 32, message_type: 100, data: [999, 0, 5, 0, 0] });
  // and a sync-atom message with the wrong format
  wnd.emit('event', { type: 33, format: 8, message_type: 100, data: [named._NET_WM_SYNC_REQUEST, 0, 5, 0, 0] });
  wnd._markDirty();
  await tick();
  await sleep(80);
  assert.deepEqual(calls.setCounter, [], 'nothing acknowledged');
  wnd.destroy();
});

test('a window without the opt-in never touches a counter', async () => {
  const { app, calls } = makeMockApp();
  const wnd = new Window(app, { width: 200, height: 100 });
  wnd.width = 200;
  wnd.height = 100;
  wnd._backing = { id: 0xb100, width: 200, height: 100, destroy() {} };
  wnd._presentGc = 0xc100;
  wnd.emit('event', syncMessage(501, 5));
  wnd._markDirty();
  await tick();
  assert.deepEqual(calls.created, [], 'no counter created');
  assert.deepEqual(calls.setCounter, [], 'nothing acknowledged');
  wnd.destroy();
});

test('destroy releases the counter, unblocking a window manager waiting on it', async () => {
  const { wnd, calls } = await syncWindow();
  const counter = calls.created[0].id;
  wnd.destroy();
  assert.deepEqual(calls.destroyed, [counter]);
});

test('a server without SYNC degrades silently', async () => {
  const { app, calls, named } = makeMockApp({ withSync: false });
  const wnd = new Window(app, { width: 200, height: 100 });
  wnd.width = 200;
  wnd.height = 100;
  await wnd.enableSyncRequest(); // must resolve, not reject
  assert.deepEqual(calls.created, [], 'no counter');
  assert.equal(wnd._syncCounter, null, 'and none recorded on the window');
  // a sync request now arrives anyway: it must be ignored, not throw
  wnd.emit('event', syncMessage(named._NET_WM_SYNC_REQUEST ?? 999, 5));
  await sleep(80);
  assert.deepEqual(calls.setCounter, [], 'nothing acknowledged, nothing thrown');
  wnd.destroy();
});
