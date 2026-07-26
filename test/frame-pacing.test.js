// Event coalescing and frame pacing (lib/window.js) against a mock X
// client — no server needed. Raw X events are fed straight into the
// window's 'event' stream; fence replies (GetInputFocus) are released by
// hand, which lets the tests model an arbitrarily slow connection.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick, setTimeout as sleep } from 'node:timers/promises';

import Window from '../lib/window.js';

// ids must be unique across all mock connections: Window.cache is static
let nextId = 0xa000;

function makeMockApp() {
  const calls = { CopyArea: 0 };
  const fences = []; // pending GetInputFocus callbacks, released by tests
  const X = {
    _closing: false,
    stream: { destroyed: false, writableEnded: false },
    event_consumers: {},
    keycode2keysyms: {},
    atoms: { WM_NAME: 39, STRING: 31 },
    AllocID: () => nextId++,
    ReleaseID() {},
    CreateWindow() {},
    DestroyWindow() {},
    ChangeWindowAttributes() {},
    ChangeProperty() {},
    CreateGC() {},
    CreatePixmap() {},
    FreePixmap() {},
    PolyFillRectangle() {},
    CopyArea() {
      calls.CopyArea++;
    },
    GetInputFocus(cb) {
      fences.push(cb);
    }
  };
  const display = { client: X, screen: [{ root: 1, root_depth: 24, white_pixel: 0xffffff }] };
  return { app: { X, display }, fences, calls };
}

const motion = (x, y) => ({ type: 6, x, y });
const configure = (width, height, x = 0, y = 0) => ({ type: 22, width, height, x, y });
const expose = (x, y, width, height, count) => ({ type: 12, x, y, width, height, count });

test('a burst of mousemove coalesces into one event carrying the trail', async () => {
  const { app } = makeMockApp();
  const wnd = new Window(app, { frameInterval: 0 });
  const got = [];
  wnd.on('mousemove', (ev) => got.push(ev));

  wnd.emit('event', motion(1, 1));
  wnd.emit('event', motion(2, 2));
  wnd.emit('event', motion(3, 3));
  assert.equal(got.length, 0, 'nothing delivered synchronously');

  await tick();
  assert.equal(got.length, 1);
  assert.equal(got[0].x, 3);
  assert.equal(got[0].y, 3);
  assert.equal(got[0].coalesced.length, 3);
  assert.deepEqual(
    got[0].coalesced.map((ev) => ev.x),
    [1, 2, 3]
  );
  wnd.destroy();
});

test('expose events merge damage: bounding box + individual rects', async () => {
  const { app } = makeMockApp();
  const wnd = new Window(app, { frameInterval: 0 });
  const got = [];
  wnd.on('expose', (ev) => got.push(ev));

  wnd.emit('event', expose(10, 10, 20, 20, 1));
  wnd.emit('event', expose(50, 50, 10, 10, 0));

  await tick();
  assert.equal(got.length, 1);
  assert.deepEqual(
    [got[0].x, got[0].y, got[0].width, got[0].height],
    [10, 10, 50, 50],
    'bounding box of both rects'
  );
  assert.equal(got[0].rects.length, 2);
  assert.deepEqual(got[0].rects[1], { x: 50, y: 50, width: 10, height: 10 });
  wnd.destroy();
});

test('resize keeps the last state; geometry properties update immediately', async () => {
  const { app } = makeMockApp();
  const wnd = new Window(app, { frameInterval: 0 });
  const got = [];
  wnd.on('resize', (ev) => got.push(ev));

  wnd.emit('event', configure(300, 200));
  wnd.emit('event', configure(640, 480));
  assert.equal(wnd.width, 640, 'wnd.width is current before the event is delivered');
  assert.equal(wnd.height, 480);

  await tick();
  assert.equal(got.length, 1);
  assert.equal(got[0].width, 640);
  assert.equal(got[0].coalesced.length, 2);
  wnd.destroy();
});

test('a discrete event flushes buffered state events first, preserving order', async () => {
  const { app } = makeMockApp();
  const wnd = new Window(app, { frameInterval: 0 });
  const order = [];
  wnd.on('mousemove', (ev) => order.push(`move:${ev.x}`));
  wnd.on('mousedown', () => order.push('down'));

  wnd.emit('event', motion(1, 1));
  wnd.emit('event', motion(2, 2));
  wnd.emit('event', { type: 4, x: 2, y: 2, keycode: 1 });
  assert.deepEqual(order, ['move:2', 'down'], 'delivered synchronously, moves first');

  await tick();
  assert.deepEqual(order, ['move:2', 'down'], 'no duplicate delivery');
  wnd.destroy();
});

test('coalesceEvents: false restores immediate per-event delivery', async () => {
  const { app } = makeMockApp();
  const wnd = new Window(app, { coalesceEvents: false });
  const got = [];
  wnd.on('mousemove', (ev) => got.push(ev.x));

  wnd.emit('event', motion(1, 1));
  wnd.emit('event', motion(2, 2));
  wnd.emit('event', motion(3, 3));
  assert.deepEqual(got, [1, 2, 3]);
  assert.equal(got[3], undefined);
  wnd.destroy();
});

test('requestAnimationFrame frames wait for the server fence', async () => {
  const { app, fences } = makeMockApp();
  const wnd = new Window(app, { frameInterval: 0 });
  let frames = 0;
  const loop = () => {
    frames++;
    wnd.requestAnimationFrame(loop);
  };
  wnd.requestAnimationFrame(loop);

  await tick();
  assert.equal(frames, 1, 'first frame runs right away');
  assert.equal(fences.length, 1, 'fence sent after the frame');

  await tick();
  await tick();
  assert.equal(frames, 1, 'next frame gated on the unanswered fence');

  fences.shift()(null); // server ack
  await tick();
  await tick();
  assert.equal(frames, 2, 'frame runs once the server caught up');
  assert.ok(typeof wnd.frameLatency === 'number' && wnd.frameLatency >= 0);

  wnd.cancelAnimationFrame(wnd.requestAnimationFrame(() => frames++));
  fences.shift()(null);
  await tick();
  await tick();
  assert.equal(frames, 3, 'only the still-registered callback ran');
  wnd.destroy();
});

test('presents defer while a fence is in flight, blit on ack', async () => {
  const { app, fences, calls } = makeMockApp();
  const wnd = new Window(app, { frameInterval: 0 });
  wnd._enableBackingStore();

  wnd._markDirty();
  await tick();
  assert.equal(calls.CopyArea, 1, 'first present goes out immediately');
  assert.equal(fences.length, 1);

  wnd._markDirty();
  await tick();
  await tick();
  assert.equal(calls.CopyArea, 1, 'second blit held back by the fence');

  fences.shift()(null);
  assert.equal(calls.CopyArea, 2, 'deferred blit sent on the ack');
  wnd.destroy();
});

test('frameInterval paces flushes when the fence is disabled', async () => {
  const { app, fences } = makeMockApp();
  const wnd = new Window(app, { frameSync: false, frameInterval: 25 });
  let count = 0;
  wnd.on('mousemove', () => count++);

  wnd.emit('event', motion(1, 1));
  await tick();
  assert.equal(count, 1, 'first flush is immediate');

  wnd.emit('event', motion(2, 2));
  wnd.emit('event', motion(3, 3));
  await tick();
  assert.equal(count, 1, 'second flush waits for the frame interval');

  await sleep(60);
  assert.equal(count, 2);
  assert.equal(fences.length, 0, 'frameSync: false sends no fence requests');
  wnd.destroy();
});

test('interactive resize drives one paced draw per frame', async () => {
  const { app, fences, calls } = makeMockApp();
  const wnd = new Window(app, { frameInterval: 0, width: 100, height: 100 });
  wnd._enableBackingStore();
  let draws = 0;
  wnd.on('draw', () => {
    draws++;
    wnd._markDirty(); // as a rendering context would
  });

  wnd.emit('event', configure(120, 120));
  wnd.emit('event', configure(140, 140));
  await tick();
  await tick();
  assert.equal(draws, 1, 'one redraw for the burst');
  assert.equal(calls.CopyArea, 1, 'one blit for the burst');

  // more resizes stream in while the server is behind
  wnd.emit('event', configure(160, 160));
  wnd.emit('event', configure(180, 180));
  await tick();
  await tick();
  assert.equal(draws, 1, 'held back by the fence');

  fences.shift()(null);
  await tick();
  await tick();
  assert.equal(draws, 2, 'one catch-up redraw at the final size');
  assert.equal(wnd.width, 180);
  wnd.destroy();
});
