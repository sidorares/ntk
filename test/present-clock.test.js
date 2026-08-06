// The frame clock running on the display instead of on the socket
// (lib/window.js). A window presenting through the Present extension ends its
// frames on CompleteNotify — the event the server sends when it has executed
// the copy at a vertical blank — so frames run at the output's rate whatever
// that rate is. Completions are injected by hand here, which lets one test
// model a 180Hz display and the next a server that never answers at all.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick, setTimeout as sleep } from 'node:timers/promises';

import Window from '../lib/window.js';

let nextId = 0xf000;

const PRESENT_OPCODE = 145;

function makeMockApp({ present = true, fixes = true } = {}) {
  const calls = { copies: 0, presents: [], selects: [], fences: [] };
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
    atoms: {},
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
      calls.copies++;
    },
    // held, not answered: a test that wants the fence clock to advance
    // releases them, and one that does not can tell a fence was even sent
    GetInputFocus(cb) {
      calls.fences.push(cb);
    },
    InternAtom(o, name, cb) {
      cb(null, 1);
    },
    require(name, cb) {
      if (name === 'present') return present ? cb(null, Present) : cb(new Error('no present'));
      if (name === 'fixes') return fixes ? cb(null, Fixes) : cb(new Error('no fixes'));
      cb(new Error(`no ${name}`));
    }
  };
  const display = { client: X, screen: [{ root: 1, root_depth: 24, white_pixel: 0xffffff }] };
  return { app: { X, display, options: {} }, calls };
}

async function presentWindow(args = {}, mock = {}) {
  const { app, calls } = makeMockApp(mock);
  const wnd = new Window(app, { width: 200, height: 100, ...args });
  wnd.width = 200;
  wnd.height = 100;
  wnd._backing = { id: 0xb200, width: 200, height: 100, destroy() {} };
  wnd._presentGc = 0xc200;
  await wnd.enablePresent();
  return { wnd, calls, app };
}

/** The server reporting that a frame reached the display. */
function complete(wnd, { msc = 1, ust = 1_000_000, mode = 0, kind = 0, serial } = {}) {
  wnd.emit('event', {
    type: 35,
    extension: PRESENT_OPCODE,
    evtype: 1, // CompleteNotify
    kind,
    mode,
    serial: serial ?? wnd._presentSerial,
    ust,
    msc,
    wid: wnd.id
  });
}

/** A repainting animation loop, of the shape an app actually writes. */
function animate(wnd, state = { frames: 0 }) {
  const step = () => {
    state.frames++;
    wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 });
    wnd.requestAnimationFrame(step);
  };
  wnd.requestAnimationFrame(step);
  return state;
}

test('a window on the Present path selects for the completions it clocks on', async () => {
  const { wnd, calls } = await presentWindow();
  assert.equal(calls.selects.length, 1, 'one PresentSelectInput');
  assert.equal(calls.selects[0].window, wnd.id);
  assert.equal(calls.selects[0].eventMask, 2, 'CompleteNotify, and not IdleNotify');
  assert.equal(wnd.frameClock, 'present', 'and reports the clock it is on');
  wnd.destroy();
});

test('frames run one per completion, not one per frameInterval', async () => {
  const { wnd, calls } = await presentWindow();
  const state = animate(wnd);
  await tick();
  assert.equal(state.frames, 1, 'the first frame runs immediately');
  assert.equal(calls.presents.length, 1);

  // nothing from the display: the loop stays where it is, however long we wait
  await sleep(60);
  assert.equal(state.frames, 1, 'no completion, no frame — not even after 3 frameIntervals');
  assert.equal(calls.fences.length, 0, 'and no fence: the display is the clock');

  complete(wnd, { msc: 1 });
  await tick();
  assert.equal(state.frames, 2, 'the completion is what runs the next frame');
  assert.equal(calls.presents.length, 2);
  wnd.destroy();
});

test('a 180Hz display drives 180 frames a second, unconfigured', async () => {
  const { wnd, calls } = await presentWindow();
  const state = animate(wnd);
  await tick();

  // 180Hz is 5.555ms; ust is microseconds on the server's clock
  const PERIOD_US = 1_000_000 / 180;
  for (let i = 1; i <= 20; i++) {
    complete(wnd, { msc: i, ust: 1_000_000 + Math.round(i * PERIOD_US) });
    await tick();
  }

  assert.equal(state.frames, 21, 'one frame per vblank, none skipped');
  assert.equal(calls.presents.length, 21);
  assert.ok(
    Math.abs(wnd.refreshInterval - 1000 / 180) < 0.05,
    `learnt the period from the display: ${wnd.refreshInterval} ms`
  );
  assert.equal(wnd.droppedFrames, 0);
  // the default frameInterval must not have capped any of this
  assert.equal(wnd.frameInterval, 16);
  wnd.destroy();
});

test('the refresh estimate reads the quick frames, not the average one', async () => {
  // On Xwayland the msc counts presents rather than vblanks, so a frame that
  // took 40ms reports 40ms between consecutive mscs — the display's period is
  // what the frames that kept up report, never the mean of them.
  const { wnd } = await presentWindow();
  animate(wnd);
  await tick();

  // the first completion has nothing to measure against, so the first gap
  // here is the one that establishes the period
  const gaps = [16_666, 16_666, 40_000, 16_666, 33_000, 16_666, 16_666, 50_000];
  let ust = 1_000_000;
  for (let i = 0; i < gaps.length; i++) {
    ust += gaps[i];
    complete(wnd, { msc: i + 1, ust });
    await tick();
  }
  assert.ok(
    Math.abs(wnd.refreshInterval - 16.666) < 0.01,
    `60Hz, not the 24ms average: ${wnd.refreshInterval}`
  );
  wnd.destroy();
});

test('a vblank the display went through without us is a dropped frame', async () => {
  const { wnd } = await presentWindow();
  animate(wnd);
  await tick();
  // a hardware msc counts vertical blanks, so a gap of 3 is two the window
  // was not ready for
  complete(wnd, { msc: 10, ust: 1_000_000 });
  await tick();
  assert.equal(wnd.droppedFrames, 0, 'the first frame had nothing to be late against');
  complete(wnd, { msc: 11, ust: 1_016_666 });
  await tick();
  assert.equal(wnd.droppedFrames, 0, 'kept up');
  complete(wnd, { msc: 14, ust: 1_066_664 });
  await tick();
  assert.equal(wnd.droppedFrames, 2, 'missed two');
  // and a gap that spans a miss does not get divided out into a fast display
  assert.ok(
    Math.abs(wnd.refreshInterval - 16.666) < 0.01,
    `still 60Hz, not 16.6ms: ${wnd.refreshInterval}`
  );
  wnd.destroy();
});

test('an idle gap between frames is not a dropped frame', async () => {
  const { wnd } = await presentWindow();
  // one frame, then quiet, then another — a click, a pause, another click.
  // The display's counter ran the whole time; the window was not late.
  wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 });
  await tick();
  complete(wnd, { msc: 1, ust: 1_000_000 });
  await tick();

  await sleep(150);
  wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 });
  await tick();
  complete(wnd, { msc: 10, ust: 1_150_000 });
  await tick();
  assert.equal(wnd.droppedFrames, 0, 'the app was idle, not late');
  wnd.destroy();
});

test('a frame that draws nothing still runs the next one', async () => {
  // No drawing means no present, so no completion is coming — the timer has
  // to cover it, or a compute-only rAF loop would stop after one frame (and,
  // with no gate left, a naive implementation would spin instead).
  const { wnd, calls } = await presentWindow();
  let frames = 0;
  const step = () => {
    frames++;
    wnd.requestAnimationFrame(step);
  };
  wnd.requestAnimationFrame(step);

  await sleep(70);
  assert.equal(calls.presents.length, 0, 'nothing was drawn, so nothing was presented');
  assert.ok(frames > 2, `the loop kept running: ${frames} frames`);
  assert.ok(frames < 60, `and was paced rather than spinning: ${frames} frames in 70ms`);
  wnd.destroy();
});

test('a completion that never comes falls back to the fence', async () => {
  const { wnd, calls } = await presentWindow();
  const state = animate(wnd);
  await tick();
  assert.equal(state.frames, 1);
  assert.equal(wnd.frameClock, 'present');

  // the server takes the present and says nothing — a Present that is a stub.
  // Nothing has answered this window yet, so it is given the short deadline.
  await sleep(300);
  assert.equal(wnd.frameClock, 'fence', 'the watchdog gave up on the display');
  assert.ok(state.frames > 1, `and frames resumed: ${state.frames}`);
  assert.ok(calls.fences.length > 0, 'on the fence clock');

  // ... and hands the clock back the moment a completion arrives
  for (const fence of calls.fences.splice(0)) fence(null, {});
  await tick();
  complete(wnd, { msc: 1 });
  await tick();
  assert.equal(wnd.frameClock, 'present', 'completions are arriving again');
  wnd.destroy();
});

test('a window the compositor is throttling is not treated as stalled', async () => {
  // A Wayland compositor answers an occluded window about once a second, by
  // simply not sending the frame callback that completes its present. That
  // window is right to stop rendering, and a watchdog that fired at frame
  // rate would wake it back up to draw pixels nobody can see.
  const { wnd, calls } = await presentWindow();
  animate(wnd);
  await tick();
  complete(wnd, { msc: 1, ust: 1_000_000 });
  await tick();

  await sleep(300);
  assert.equal(wnd.frameClock, 'present', 'still the display clock, just a slow one');
  assert.equal(calls.fences.length, 0, 'and no fence went out to hurry it along');
  wnd.destroy();
});

test("frameClock: 'fence' keeps the round-trip clock and asks for no events", async () => {
  const { wnd, calls } = await presentWindow({ frameClock: 'fence' });
  assert.deepEqual(calls.selects, [], 'no completions selected for a window that will not read them');
  assert.equal(wnd.frameClock, 'fence');
  wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 });
  await tick();
  assert.equal(calls.presents.length, 1, 'still presents — the request shape is unrelated');
  assert.equal(calls.fences.length, 1, 'and is clocked by the fence');
  wnd.destroy();
});

test('frameSync: false turns the vblank clock off with the fence', async () => {
  // "pacing that never waits on the server" has to include waiting for the
  // server to put a frame on the display.
  const { wnd, calls } = await presentWindow({ frameSync: false, frameInterval: 25 });
  assert.deepEqual(calls.selects, []);
  assert.equal(wnd.frameClock, 'fence');
  wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 });
  await tick();
  assert.equal(calls.fences.length, 0, 'no fence either');
  wnd.destroy();
});

test('an explicit frameInterval still caps the display', async () => {
  const { wnd, calls } = await presentWindow({ frameInterval: 40 });
  const state = animate(wnd);
  await tick();
  assert.equal(state.frames, 1);

  // a 60Hz display would offer 4 frames in this window; the cap allows one
  for (let i = 1; i <= 4; i++) {
    complete(wnd, { msc: i, ust: 1_000_000 + i * 16_666 });
    await tick();
  }
  assert.equal(state.frames, 1, 'held at the cap, not at the display rate');
  await sleep(60);
  assert.ok(state.frames > 1, `and released by it: ${state.frames}`);
  assert.ok(state.frames < 4, 'but not up to the display rate');
  wnd.destroy();
});

test('assigning frameInterval later counts as asking for a cap', async () => {
  const { wnd } = await presentWindow();
  assert.equal(wnd._frameIntervalExplicit, false, 'the default is not a cap');
  wnd.frameInterval = 33;
  assert.equal(wnd.frameInterval, 33);
  assert.equal(wnd._frameIntervalExplicit, true, 'but an assignment is');
  wnd.destroy();
});

test('a discrete input repaints immediately, and a second one coalesces', async () => {
  // The inter-blit interval exists to stop a burst blitting at round-trip
  // rate; an outstanding present says the same thing more accurately, and
  // without holding the first repaint for a frame of nothing.
  const { wnd, calls } = await presentWindow();
  assert.equal(wnd.frameInFlight(), false);

  wnd.emit('event', { type: 4, x: 1, y: 1 }); // mousedown
  wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 });
  await tick();
  assert.equal(calls.presents.length, 1, 'painted with the handler, not a frame later');
  assert.equal(wnd.frameInFlight(), true, 'and the display now owes us the frame');

  wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 });
  await tick();
  assert.equal(calls.presents.length, 1, 'the next one folds into the outstanding frame');

  complete(wnd, { msc: 1 });
  await tick();
  assert.equal(calls.presents.length, 2, 'and goes out when the display has caught up');
  assert.equal(wnd.frameInFlight(), true, 'which is itself a frame the display owes');

  complete(wnd, { msc: 2 });
  await tick();
  assert.equal(wnd.frameInFlight(), false, 'and nothing is owed once that lands');
  wnd.destroy();
});

test('a server that flips a Copy present is dropped back to CopyArea', async () => {
  // Option.Copy is what guarantees the backing pixmap is ours again after the
  // completion. A server that flips it anyway owns the pixmap we are about to
  // draw into, which would paint the screen directly.
  const errors = [];
  const { wnd, calls } = await presentWindow();
  wnd.app.options.onXError = (err) => errors.push(err);

  wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 });
  await tick();
  assert.equal(calls.presents.length, 1);

  complete(wnd, { msc: 1, mode: 1 }); // CompleteMode.Flip
  assert.equal(errors.length, 1, 'and says so');
  assert.match(errors[0].message, /flipped/);

  wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 });
  // back on the fence clock, so back behind its inter-blit interval too
  await sleep(40);
  assert.equal(calls.presents.length, 1, 'no further presents');
  assert.ok(calls.copies > 0, 'blits go through CopyArea instead');
  assert.equal(wnd.frameClock, 'fence');
  wnd.destroy();
});

test('a completion for a frame we are not clocking on is ignored', async () => {
  const { wnd } = await presentWindow();
  wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 });
  await tick();
  complete(wnd, { msc: 1, ust: 1_000_000 });
  const period = wnd.refreshInterval;
  // a stray completion (another client presenting to this window) must not
  // sample the clock or end a frame that is not outstanding
  complete(wnd, { msc: 9, ust: 9_000_000 });
  assert.equal(wnd.refreshInterval, period, 'the estimate is untouched');
  wnd.destroy();
});

test('destroy deletes the event context', async () => {
  const { wnd, calls } = await presentWindow();
  const eid = calls.selects[0].eid;
  wnd.destroy();
  const deleted = calls.selects.filter((s) => s.eventMask === 0);
  assert.equal(deleted.length, 1, 'an empty mask deletes it');
  assert.equal(deleted[0].eid, eid);
});

test('a DestroyNotify leaves the event context to the server', async () => {
  // the window is already gone: deleting the context explicitly would be a
  // request against an id that no longer exists
  const { wnd, calls } = await presentWindow();
  wnd.emit('event', { type: 17, wid: wnd.id }); // DestroyNotify
  assert.deepEqual(
    calls.selects.filter((s) => s.eventMask === 0),
    []
  );
});
