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
// present copies those instead.
//
// They are kept as a list of rectangles, not one box around them all, so that
// two repaints at opposite corners do not drag everything between them along.
// The list is capped, and collapsed back to its box when splitting would not
// save enough to pay for the extra requests.

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

test('regions far apart are copied separately, not as one box', async () => {
  const { wnd, calls } = backedWindow();
  wnd._markDirty({ x: 10, y: 10, w: 10, h: 10 });
  wnd._markDirty({ x: 50, y: 40, w: 20, h: 20 });
  await tick();
  assert.equal(calls.CopyArea, 2, 'one blit each');
  assert.deepEqual(calls.copies, [
    { x: 10, y: 10, w: 10, h: 10 },
    { x: 50, y: 40, w: 20, h: 20 }
  ]);
  // the point of the exercise: 500px copied where the box around both is 3000
  const copied = calls.copies.reduce((sum, r) => sum + r.w * r.h, 0);
  assert.equal(copied, 500);
});

test('regions that nearly fill their box are copied as the box', async () => {
  const { wnd, calls } = backedWindow();
  // side-by-side tab headers: two 20x10 rects with a 2px gap. Splitting saves
  // 20 of 420 pixels, which is not worth a second request.
  wnd._markDirty({ x: 10, y: 10, w: 20, h: 10 });
  wnd._markDirty({ x: 32, y: 10, w: 20, h: 10 });
  await tick();
  assert.equal(calls.CopyArea, 1, 'collapsed to one blit');
  assert.deepEqual(calls.copies[0], { x: 10, y: 10, w: 42, h: 10 });
});

// Nesting is checked on the list itself rather than through the copies,
// because the collapse rule would hide a redundant entry: two rectangles that
// nest are copied as their box either way, and their box is the outer one. The
// list length is the property that matters — the cap is a budget, and spending
// it on rectangles that cover each other is what forces the real ones to merge.
test('a region already covered by another does not lengthen the list', async () => {
  const { wnd, calls } = backedWindow();
  // the overwhelmingly common case: consecutive operations under one clip all
  // report the same rectangle, or one nested inside it
  wnd._markDirty({ x: 10, y: 10, w: 40, h: 40 });
  wnd._markDirty({ x: 20, y: 20, w: 10, h: 10 });
  // checked here rather than at the end: re-reporting the outer rectangle
  // would collapse the list again by covering both entries, so it would hide a
  // nested entry that had been kept
  assert.equal(wnd._dirtyRegion.length, 1, 'the nested rectangle was dropped');
  wnd._markDirty({ x: 10, y: 10, w: 40, h: 40 });
  assert.equal(wnd._dirtyRegion.length, 1);
  await tick();
  assert.equal(calls.CopyArea, 1);
  assert.deepEqual(calls.copies[0], { x: 10, y: 10, w: 40, h: 40 });
});

test('a region covering an earlier one replaces it', async () => {
  const { wnd, calls } = backedWindow();
  wnd._markDirty({ x: 20, y: 20, w: 10, h: 10 });
  wnd._markDirty({ x: 10, y: 10, w: 40, h: 40 });
  assert.equal(wnd._dirtyRegion.length, 1);
  await tick();
  assert.equal(calls.CopyArea, 1, 'not two overlapping copies');
  assert.deepEqual(calls.copies[0], { x: 10, y: 10, w: 40, h: 40 });
});

test('a far-apart region survives a flood of nested ones', async () => {
  const { wnd, calls } = backedWindow();
  // What the nesting checks buy: 30 operations under one clip, plus one small
  // repaint in the far corner. Without them the cap fills with rectangles that
  // cover each other and the corner gets merged into the rest.
  wnd._markDirty({ x: 0, y: 0, w: 60, h: 60 });
  for (let i = 0; i < 30; i++) {
    wnd._markDirty({ x: 2 + (i % 20), y: 2 + (i % 20), w: 10, h: 10 });
  }
  wnd._markDirty({ x: 180, y: 90, w: 10, h: 10 });
  await tick();
  assert.equal(calls.CopyArea, 2, 'the corner is still its own copy');
  assert.deepEqual(calls.copies, [
    { x: 0, y: 0, w: 60, h: 60 },
    { x: 180, y: 90, w: 10, h: 10 }
  ]);
});

test('the number of copies stays capped however many regions are reported', async () => {
  const { wnd, calls } = backedWindow();
  // 40 scattered 2x2 rects, more than the cap. Whatever the merging does, it
  // may not exceed the cap and may not lose a reported pixel.
  const reported = [];
  for (let i = 0; i < 40; i++) {
    const rect = { x: (i * 7) % 190, y: (i * 11) % 90, w: 2, h: 2 };
    reported.push(rect);
    wnd._markDirty(rect);
  }
  await tick();
  assert.ok(calls.CopyArea >= 1, 'something was copied');
  assert.ok(calls.CopyArea <= 8, `at most the cap, got ${calls.CopyArea}`);
  for (const r of reported) {
    const inside = calls.copies.some(
      (c) => r.x >= c.x && r.y >= c.y && r.x + r.w <= c.x + c.w && r.y + r.h <= c.y + c.h
    );
    assert.ok(inside, `${JSON.stringify(r)} is inside some copy`);
  }
});

test('an unbounded region still absorbs a list of rectangles', async () => {
  const { wnd, calls } = backedWindow();
  // the same safety property as the single-rect version, now that "current"
  // can be a list: an unreported operation has to discard the whole list
  wnd._markDirty({ x: 10, y: 10, w: 10, h: 10 });
  wnd._markDirty({ x: 150, y: 80, w: 10, h: 10 });
  wnd._markDirty(undefined);
  await tick();
  assert.equal(calls.CopyArea, 1);
  assert.deepEqual(calls.copies[0], { x: 0, y: 0, w: 200, h: 100 });
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
