// Event coalescing and frame pacing (lib/window.js) against a mock X
// client — no server needed. Raw X events are fed straight into the
// window's 'event' stream; fence replies (GetInputFocus) are released by
// hand, which lets the tests model an arbitrarily slow connection.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick, setTimeout as sleep } from 'node:timers/promises';

import Window from '../lib/window.js';
import { withTimeout } from './helpers/async.js';

// the wrapper cache is keyed per connection, so ids only have to be unique
// within one mock app — keeping them unique across all of them anyway makes
// a stray cross-connection lookup in a failing test obvious
let nextId = 0xa000;

function makeMockApp() {
  const calls = { CopyArea: 0, copies: [] };
  const fences = []; // pending GetInputFocus callbacks, released by tests
  // Waiters for the next blit. A blit held back by the minimum inter-blit
  // interval lands on a timer, so `await tick()` is not enough to observe it;
  // awaiting the blit itself works whether it is immediate or deferred, and
  // fails loudly (named) if it is dropped altogether.
  let copyWaiters = [];
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
      const wake = copyWaiters;
      copyWaiters = [];
      for (const resolve of wake) resolve();
    },
    GetInputFocus(cb) {
      fences.push(cb);
    }
  };
  const display = { client: X, screen: [{ root: 1, root_depth: 24, white_pixel: 0xffffff }] };
  const nextCopy = () =>
    withTimeout(new Promise((resolve) => copyWaiters.push(resolve)), 2000, 'blit');
  return { app: { X, display }, fences, calls, nextCopy };
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

// frameInFlight() — the gate a toolkit paints a discrete input's response
// through. What it has to get right is the *transitions*: false while the
// server is caught up, true from the moment a frame's fence goes out until
// its reply lands.
test('frameInFlight tracks the fence across a frame', async () => {
  const { app, fences } = makeMockApp();
  const wnd = new Window(app, { frameInterval: 0 });
  assert.equal(wnd.frameInFlight(), false, 'nothing drawn yet, nothing to wait for');

  wnd.requestAnimationFrame(() => {});
  await tick();
  assert.equal(fences.length, 1);
  assert.equal(wnd.frameInFlight(), true, 'the frame sent its fence');

  fences.shift()(null);
  assert.equal(wnd.frameInFlight(), false, 'the server caught up');
  wnd.destroy();
});

test('a discrete handler that draws sees the gate open, then closed', async () => {
  const { app, fences, calls } = makeMockApp();
  const wnd = new Window(app, { frameInterval: 0 });
  wnd._enableBackingStore();
  const gate = [];
  wnd.on('mousedown', () => {
    gate.push(wnd.frameInFlight());
    wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 }); // as painting would
  });

  // three notches of a wheel arriving faster than the server can answer
  wnd.emit('event', { type: 4, x: 1, y: 1, keycode: 4 });
  wnd.emit('event', { type: 4, x: 1, y: 1, keycode: 4 });
  wnd.emit('event', { type: 4, x: 1, y: 1, keycode: 4 });
  assert.deepEqual(gate, [false, true, true], 'open for the first, shut behind it');
  assert.equal(calls.CopyArea, 1, 'only the first press blitted');

  fences.shift()(null);
  assert.equal(calls.CopyArea, 2, 'the rest caught up in one blit');
  wnd.destroy();
});

// The same gate with the minimum inter-blit interval in play — which is the
// default, and the case #195 added. On a local server the fence for one notch
// is answered long before the next notch is read, so the fence alone reads
// "draw it now" for the whole burst; the interval is what actually holds the
// blits back, and the gate has to say so or every notch does its painting for
// a present that coalesces the work away.
test('the gate shuts behind a deferred blit, not just behind the fence', async () => {
  const { wnd, calls, fences, nextCopy } = backedWindow({ frameInterval: 20 });
  const gate = [];
  wnd.on('mousedown', () => {
    const shut = wnd.frameInFlight();
    gate.push(shut);
    if (!shut) wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 }); // as painting would
  });
  const notch = () => wnd.emit('event', { type: 4, x: 1, y: 1, keycode: 4 });

  // one notch to start the interval running: nothing gates this one, so it
  // blits with the handler's own requests and arms a fence
  notch();
  assert.equal(calls.CopyArea, 1, 'the first notch blitted');
  fences.shift()(null); // as a local server does, between one notch and the next
  const settled = nextCopy();

  // three more, all inside the interval the first one started
  notch();
  notch();
  notch();
  assert.deepEqual(gate, [false, false, true, true], 'shut once a blit is queued');
  assert.equal(calls.CopyArea, 1, 'and nothing more went out inside the burst');

  await settled;
  assert.equal(calls.CopyArea, 2, 'the burst caught up in one deferred blit');
  fences.shift()(null);
  assert.equal(wnd.frameInFlight(), false, 'and the gate is open again');
  wnd._teardownFrame();
});

test('frameInFlight stays false when frameSync is off', async () => {
  const { app, fences } = makeMockApp();
  const wnd = new Window(app, { frameSync: false, frameInterval: 0 });
  wnd.requestAnimationFrame(() => {});
  await tick();
  assert.equal(fences.length, 0, 'no fence is ever sent');
  assert.equal(wnd.frameInFlight(), false, 'so a caller gating on it never defers');
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

function backedWindow(args) {
  const { app, fences, calls, nextCopy } = makeMockApp();
  const wnd = new Window(app, { width: 200, height: 100, ...args });
  wnd.width = 200;
  wnd.height = 100;
  // the backing store is normally allocated by getContext('2d'); there is no
  // real context here, so stand one in and drive _markDirty directly
  wnd._backing = { id: 0xb000, width: 200, height: 100 };
  wnd._presentGc = 0xc000;
  return { wnd, fences, calls, nextCopy };
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
  const { wnd, fences, calls, nextCopy } = backedWindow();
  wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 });
  await tick();
  assert.deepEqual(calls.copies[0], { x: 0, y: 0, w: 10, h: 10 });
  // release the fence the first present armed, so the second is not deferred
  while (fences.length) fences.shift()();
  // the second blit follows the first inside one frameInterval, so it is held
  // back by the minimum inter-blit interval — wait for the blit, not a tick
  const blitted = nextCopy();
  wnd._markDirty({ x: 100, y: 50, w: 10, h: 10 });
  await blitted;
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

// Minimum inter-blit interval (issue #180).
//
// Discrete events blit at the end of their handler rather than waiting for the
// next paced frame — that latency is the point. But nothing used to bound how
// often that could happen: on a local server the fence answers in a few
// hundred microseconds, so a stream of discrete events blitted hundreds of
// times a second, and under a compositor every blit is a recomposite. The
// first blit after a quiet moment is still immediate; the ones behind it are
// held back to one per `frameInterval` and coalesce.

test('the first blit after a quiet moment is immediate', async () => {
  const { wnd, calls } = backedWindow();
  // no await: the latency-critical path must not even wait for a microtask
  wnd._markDirtyNow = true;
  wnd._dirty = true;
  wnd._dirtyRegion = [{ x: 0, y: 0, w: 10, h: 10 }];
  wnd._present();
  assert.equal(calls.CopyArea, 1, 'blitted synchronously');
});

test('a burst of discrete blits is paced to one per frameInterval', async () => {
  const { wnd, fences, calls } = backedWindow({ frameInterval: 20, frameSync: false });
  const start = Date.now();
  // ~10 "events", each in its own turn, well inside one interval
  for (let i = 0; i < 10; i++) {
    wnd._dirty = true;
    wnd._dirtyRegion = [{ x: i, y: 0, w: 5, h: 5 }];
    wnd._present();
    await sleep(2);
  }
  const elapsed = Date.now() - start;
  assert.equal(fences.length, 0, 'frameSync: false sends no fence, so only the interval paces');
  // shape, not an exact count: one blit per interval plus the immediate first
  assert.ok(
    calls.CopyArea <= Math.ceil(elapsed / 20) + 1,
    `paced: ${calls.CopyArea} blits in ${elapsed}ms at a 20ms interval`
  );
  assert.ok(calls.CopyArea < 10, `fewer blits than events (got ${calls.CopyArea})`);
});

test('the last blit of a burst still lands', async () => {
  const { wnd, calls, nextCopy } = backedWindow({ frameInterval: 20, frameSync: false });
  wnd._dirty = true;
  wnd._dirtyRegion = [{ x: 0, y: 0, w: 5, h: 5 }];
  wnd._present(); // immediate
  const settled = nextCopy();
  // a second mark right behind it is deferred, and nothing else follows: the
  // deferral timer is the only thing that can still put it on screen
  wnd._dirty = true;
  wnd._dirtyRegion = [{ x: 150, y: 80, w: 20, h: 15 }];
  wnd._present();
  await settled;
  assert.equal(calls.CopyArea, 2, 'the deferred blit was not dropped');
  assert.deepEqual(
    calls.copies[1],
    { x: 150, y: 80, w: 20, h: 15 },
    'and it carried the final region'
  );
  assert.equal(wnd._dirty, false, 'no dirt left behind');
  assert.equal(wnd._presentPending, false, 'no present left pending');
});

test('regions marked during a deferral coalesce into the one present that follows', async () => {
  const { wnd, calls, nextCopy } = backedWindow({ frameInterval: 20, frameSync: false });
  wnd._dirty = true;
  wnd._dirtyRegion = [{ x: 0, y: 0, w: 5, h: 5 }];
  wnd._present(); // immediate, starts the interval
  const first = calls.CopyArea;
  const settled = nextCopy();
  wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 });
  wnd._markDirty({ x: 180, y: 90, w: 10, h: 10 });
  await settled;
  await tick();
  // one present, which may still split into a copy per rectangle (_blitList) —
  // what matters is that both marks made it into that single deferred present
  const after = calls.copies.slice(first);
  const covers = (x, y) =>
    after.some((r) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h);
  assert.ok(covers(5, 5), `the top-left mark was blitted (got ${JSON.stringify(after)})`);
  assert.ok(covers(185, 95), `the bottom-right mark was blitted (got ${JSON.stringify(after)})`);
  assert.equal(wnd._dirty, false, 'nothing left dirty');
});

test('frameInterval: 0 keeps the old unpaced blit behaviour', async () => {
  const { wnd, calls } = backedWindow({ frameInterval: 0, frameSync: false });
  for (let i = 0; i < 5; i++) {
    wnd._dirty = true;
    wnd._dirtyRegion = [{ x: i, y: 0, w: 5, h: 5 }];
    wnd._present();
  }
  assert.equal(calls.CopyArea, 5, 'every present blits when the timer gate is off');
});

test('destroy() cancels a blit held back by the interval', async () => {
  const { wnd, calls } = backedWindow({ frameInterval: 20, frameSync: false });
  wnd._dirty = true;
  wnd._dirtyRegion = [{ x: 0, y: 0, w: 5, h: 5 }];
  wnd._present(); // immediate
  wnd._dirty = true;
  wnd._dirtyRegion = [{ x: 50, y: 50, w: 5, h: 5 }];
  wnd._present(); // deferred
  const before = calls.CopyArea;
  wnd._teardownFrame();
  await sleep(60);
  assert.equal(calls.CopyArea, before, 'the deferred blit did not fire after teardown');
});
