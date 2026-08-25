// PointerMotionHint, the client's half of it (lib/window.js, issue #319).
//
// The hint is a conversation: the server sends one MotionNotify with detail
// NotifyHint and then waits to be asked where the pointer went. These tests
// drive that from a mock X client — hint events are fed into the window's
// raw event stream and QueryPointer replies are released by hand, so a poll
// can be held outstanding for as long as an assertion needs it. What no mock
// can check is that a real server actually goes quiet after the hint; that is
// motion-hint-live.test.js.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';

import x11 from 'x11';

import Window from '../lib/window.js';

let nextId = 0xc000;

function makeMockApp() {
  const polls = []; // QueryPointer callbacks, released by tests
  const fences = []; // GetInputFocus callbacks — the frame clock
  const masks = []; // every eventMask written to the server
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
    ChangeWindowAttributes(wid, values) {
      if (typeof values.eventMask === 'number') masks.push(values.eventMask);
    },
    ChangeProperty() {},
    CreateGC() {},
    CreatePixmap() {},
    FreePixmap() {},
    PolyFillRectangle() {},
    CopyArea() {},
    QueryPointer(wid, cb) {
      polls.push(cb);
    },
    GetInputFocus(cb) {
      fences.push(cb);
    }
  };
  const display = { client: X, screen: [{ root: 1, root_depth: 24, white_pixel: 0xffffff }] };
  return { app: { X, display }, polls, fences, masks };
}

/** A core MotionNotify. `keycode` is where node-x11 puts the detail byte. */
const motion = (x, y, keycode = 0) => ({
  type: 6,
  x,
  y,
  rootx: x,
  rooty: y,
  time: 1000 + x,
  keycode
});
const hinted = (x, y) => motion(x, y, 1);

/** What QueryPointer replies with — node-x11's field names, not the event's. */
const pointerAt = (x, y, extra = {}) => ({
  sameScreen: 1,
  root: 1,
  child: 0,
  rootX: x,
  rootY: y,
  childX: x,
  childY: y,
  keyMask: 0,
  ...extra
});

/** Let the frame clock run again: a fence reply ends the frame it paced. */
const releaseFences = async (fences) => {
  for (const cb of fences.splice(0)) cb(null, {});
  await tick();
};

test('a hinted move is delivered, and answered with the QueryPointer that re-arms it', async () => {
  const { app, polls } = makeMockApp();
  const wnd = new Window(app, { frameInterval: 0 });
  const got = [];
  wnd.on('mousemove', (ev) => got.push(ev));

  wnd.emit('event', hinted(10, 20));
  assert.equal(polls.length, 0, 'nothing asked synchronously: the poll is paced by the frame');

  await tick();
  assert.equal(got.length, 1, 'the hint carries a real position, so it is a move like any other');
  assert.deepEqual([got[0].x, got[0].y], [10, 20]);
  assert.equal(polls.length, 1, 'and the frame asks the server where the pointer is now');
  wnd.destroy();
});

test('the poll delivers the motion the hint suppressed', async () => {
  const { app, polls, fences } = makeMockApp();
  const wnd = new Window(app, { frameInterval: 0 });
  const got = [];
  wnd.on('mousemove', (ev) => got.push(ev));

  wnd.emit('event', hinted(10, 20));
  await tick();
  // the pointer moved on after the hint was generated, and that motion
  // produced no event — it is exactly what the hint held back
  polls[0](null, pointerAt(33, 44, { keyMask: 0x100, child: 7 }));
  // the answer is an event like any other on a paced window: it lands in the
  // frame after the one that asked
  await releaseFences(fences);

  assert.equal(got.length, 2);
  const [, polled] = got;
  assert.deepEqual([polled.x, polled.y], [33, 44], 'window-relative, from the reply');
  assert.deepEqual([polled.rootx, polled.rooty], [33, 44]);
  assert.equal(polled.buttons, 0x100, "the reply's modifier/button state");
  assert.equal(polled.child, 7);
  assert.equal(polled.synthetic, true, 'built from a reply, not read off the wire');
  assert.equal(polled.time, 1010, 'stamped with the hint that prompted it — a reply has no time');
  assert.equal(polled.window, wnd);
  assert.equal(polled.target, wnd);
  wnd.destroy();
});

test('a poll that finds the pointer where the hint left it delivers nothing', async () => {
  const { app, polls } = makeMockApp();
  const wnd = new Window(app, { frameInterval: 0 });
  const got = [];
  wnd.on('mousemove', (ev) => got.push(ev));

  wnd.emit('event', hinted(10, 20));
  await tick();
  polls[0](null, pointerAt(10, 20));
  await tick();
  assert.equal(got.length, 1, 'the pointer sat still: there is no second move to report');
  wnd.destroy();
});

test('a poll finding the pointer on another screen is not a position', async () => {
  const { app, polls } = makeMockApp();
  const wnd = new Window(app, { frameInterval: 0 });
  const got = [];
  wnd.on('mousemove', (ev) => got.push(ev));

  wnd.emit('event', hinted(10, 20));
  await tick();
  // core QueryPointer: with the pointer on another screen the window-relative
  // coordinates and `child` are zero by protocol, which is not the origin
  polls[0](null, pointerAt(0, 0, { sameScreen: 0 }));
  await tick();
  assert.equal(got.length, 1);
  wnd.destroy();
});

test('an unhinted motion stream asks the server nothing', async () => {
  const { app, polls } = makeMockApp();
  const wnd = new Window(app, { frameInterval: 0 });
  wnd.on('mousemove', () => {});

  wnd.emit('event', motion(1, 1));
  wnd.emit('event', motion(2, 2));
  await tick();
  assert.equal(polls.length, 0, 'the server is talking freely; there is nothing to re-arm');
  wnd.destroy();
});

test('a burst of hints costs one round trip, not one each', async () => {
  const { app, polls, fences } = makeMockApp();
  const wnd = new Window(app, { frameInterval: 0 });
  const got = [];
  wnd.on('mousemove', (ev) => got.push(ev));

  wnd.emit('event', hinted(1, 1));
  wnd.emit('event', hinted(2, 2));
  wnd.emit('event', hinted(3, 3));
  await tick();
  assert.equal(got.length, 1, 'coalesced to one move');
  assert.equal(got[0].coalesced.length, 3);
  assert.equal(polls.length, 1, 'and one poll for the frame');

  // a later frame with a poll still outstanding does not stack another one
  wnd.emit('event', hinted(4, 4));
  await releaseFences(fences);
  assert.equal(polls.length, 1, 'still just the one in flight');

  // once it answers, the frame that follows picks the re-arm back up
  polls[0](null, pointerAt(5, 5));
  await releaseFences(fences);
  assert.equal(polls.length, 2);
  wnd.destroy();
});

test('setMouseHintOnly writes the bit, and clearing it drops a pending re-arm', async () => {
  const { app, polls, masks } = makeMockApp();
  const wnd = new Window(app, { frameInterval: 0 });
  wnd.on('mousemove', () => {});
  masks.length = 0;

  wnd.setMouseHintOnly(true);
  assert.equal(masks.length, 1);
  assert.ok(masks[0] & x11.eventMask.PointerMotionHint, 'the hint bit is selected');
  assert.equal(wnd.setMouseHintOnly(true), wnd, 'idempotent, and chainable');
  assert.equal(masks.length, 1, 'a bit already set is not written again');

  // a hint arrives, and the caller turns the hint off before the frame runs
  wnd.emit('event', hinted(10, 20));
  wnd.setMouseHintOnly(false);
  assert.equal(masks.length, 2);
  assert.ok(!(masks[1] & x11.eventMask.PointerMotionHint), 'and cleared again');
  await tick();
  assert.equal(polls.length, 0, 'nothing is waiting on an answer any more');
  wnd.destroy();
});

test('with coalescing off there is no frame to pace the poll, so it goes out at once', async () => {
  const { app, polls } = makeMockApp();
  const wnd = new Window(app, { coalesceEvents: false });
  const got = [];
  wnd.on('mousemove', (ev) => got.push(ev));

  wnd.emit('event', hinted(10, 20));
  assert.deepEqual(
    got.map((ev) => [ev.x, ev.y]),
    [[10, 20]],
    'delivered immediately, as an uncoalesced window promises'
  );
  assert.equal(polls.length, 1);
  polls[0](null, pointerAt(11, 21));
  assert.deepEqual(got.map((ev) => [ev.x, ev.y]), [
    [10, 20],
    [11, 21]
  ]);
  wnd.destroy();
});

test('a destroyed window neither polls nor delivers a poll already in flight', async () => {
  const { app, polls } = makeMockApp();
  const wnd = new Window(app, { frameInterval: 0 });
  const got = [];
  wnd.on('mousemove', (ev) => got.push(ev));

  wnd.emit('event', hinted(10, 20));
  await tick();
  assert.equal(polls.length, 1);
  wnd.destroy();
  polls[0](null, pointerAt(33, 44));
  await tick();
  assert.equal(got.length, 1, 'the reply outlived the window it was about');
});
