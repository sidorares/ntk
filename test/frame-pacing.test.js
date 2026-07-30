// Event coalescing and frame pacing (lib/window.js) against a mock X
// client — no server needed. Raw X events are fed straight into the
// window's 'event' stream; fence replies (GetInputFocus) are released by
// hand, which lets the tests model an arbitrarily slow connection.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick, setTimeout as sleep } from 'node:timers/promises';

import Window from '../lib/window.js';

// the wrapper cache is keyed per connection, so ids only have to be unique
// within one mock app — keeping them unique across all of them anyway makes
// a stray cross-connection lookup in a failing test obvious
let nextId = 0xa000;

function makeMockApp() {
  const calls = { CopyArea: 0, copies: [] };
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
    CopyArea(src, dst, gc, sx, sy, dx, dy, width, height) {
      calls.CopyArea++;
      calls.copies.push({ x: dx, y: dy, w: width, h: height });
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


// --- how much of the backing store a present copies ---------------------
//
// A blit used to be the whole window however little had changed, so a repaint
// of two tab headers copied a megapixel to move 4k of it. A drawing operation
// reports the region it could have touched — its clip rectangle — and the
// present copies the union of those instead.

function backedWindow() {
  const { app, fences, calls } = makeMockApp();
  const wnd = new Window(app, { width: 200, height: 100 });
  wnd.width = 200;
  wnd.height = 100;
  // the backing store is normally allocated by getContext('2d'); there is no
  // real context here, so stand one in and drive _markDirty directly
  wnd._backing = { id: 0xb000, width: 200, height: 100 };
  wnd._presentGc = 0xc000;
  return { wnd, fences, calls };
}

test('a present copies only the region the drawing reported', async () => {
  const { wnd, calls } = backedWindow();
  wnd._markDirty({ x: 10, y: 20, w: 30, h: 12 });
  await tick();
  assert.equal(calls.CopyArea, 1);
  assert.deepEqual(calls.copies[0], { x: 10, y: 20, w: 30, h: 12 });
});

test('reported regions union, and the union is what gets copied', async () => {
  const { wnd, calls } = backedWindow();
  wnd._markDirty({ x: 10, y: 10, w: 10, h: 10 });
  wnd._markDirty({ x: 50, y: 40, w: 20, h: 20 });
  await tick();
  assert.equal(calls.CopyArea, 1, 'still one blit');
  assert.deepEqual(
    calls.copies[0],
    { x: 10, y: 10, w: 60, h: 50 },
    'the bounding box of both'
  );
});

test('drawing that reports no region copies the whole window', async () => {
  const { wnd, calls } = backedWindow();
  // an unclipped context cannot say where it drew
  wnd._markDirty(undefined);
  await tick();
  assert.deepEqual(calls.copies[0], { x: 0, y: 0, w: 200, h: 100 });
});

test('one unreported operation gives up the bound for the whole frame', async () => {
  const { wnd, calls } = backedWindow();
  // This is the direction that has to be safe: a small clipped draw followed
  // by an unclipped one must not blit only the small rect, or the unclipped
  // drawing never reaches the screen. "Unbounded" absorbs.
  wnd._markDirty({ x: 10, y: 10, w: 10, h: 10 });
  wnd._markDirty(undefined);
  wnd._markDirty({ x: 20, y: 20, w: 10, h: 10 });
  await tick();
  assert.deepEqual(calls.copies[0], { x: 0, y: 0, w: 200, h: 100 });
});

test('the region does not leak into the next frame', async () => {
  const { wnd, fences, calls } = backedWindow();
  wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 });
  await tick();
  assert.deepEqual(calls.copies[0], { x: 0, y: 0, w: 10, h: 10 });
  // release the fence the first present armed, so the second is not deferred
  while (fences.length) fences.shift()();
  wnd._markDirty({ x: 100, y: 50, w: 10, h: 10 });
  await tick();
  assert.equal(calls.CopyArea, 2);
  assert.deepEqual(
    calls.copies[1],
    { x: 100, y: 50, w: 10, h: 10 },
    'the second frame copies its own region, not the union with the first'
  );
});

test('a reported region is clamped to the window', async () => {
  const { wnd, calls } = backedWindow();
  // a clip can extend past the surface; CopyArea sizes are unsigned
  wnd._markDirty({ x: -20, y: -5, w: 400, h: 300 });
  await tick();
  assert.deepEqual(calls.copies[0], { x: 0, y: 0, w: 200, h: 100 });
});
