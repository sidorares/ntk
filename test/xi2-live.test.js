// XI2 against a real X server: does selecting it actually change what
// arrives, and does what arrives still look like the event ntk documents?
//
// The half that needs a server is exactly the half a stub cannot check —
// that an XI2 selection *replaces* this client's core events for the same
// types, which is a server delivery rule rather than anything ntk decides.
// The scroll arithmetic is hermetic, in xi2.test.js; a wheel cannot be faked
// here at all, because no request generates one (XTEST fakes buttons, not
// valuators).
//
// Skipped where there is no DISPLAY, and where the server has no XI2.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createClient } from '../lib/index.js';
import { withTimeout } from './helpers/async.js';

let app = null;
let skip = false;
let keepalive = null;

before(async () => {
  if (!process.env.DISPLAY) {
    skip = 'no DISPLAY set';
    return;
  }
  keepalive = setInterval(() => {}, 1000);
  try {
    app = await withTimeout(createClient(), 5000, 'connecting to X server');
  } catch (err) {
    skip = `cannot connect to X server: ${err.message}`;
    return;
  }
  const XI = await app.xinput();
  if (!XI || !XI.xi2) skip = 'the server has no XI2';
});

after(async () => {
  clearInterval(keepalive);
  await app?.close();
});

/** Map and wait until the server will deliver pointer events to the window. */
const mapAndWait = (wnd) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, 1000);
    wnd.once('expose', () => {
      clearTimeout(timer);
      setTimeout(resolve, 50);
    });
    wnd.map();
  });

/**
 * Move the pointer inside the window — a motion event no input device has to
 * make — and hand back the event it produced.
 *
 * Matched on the coordinates rather than taken as the last event to arrive,
 * because a real server has a real pointer on it: someone brushing the
 * touchpad while the suite runs is otherwise a failure. Motion is coalesced
 * per frame, so this waits for frames rather than for a fixed sleep.
 */
const warp = async (wnd, x, y, seen) => {
  const before = seen.length;
  app.X.WarpPointer(0, wnd.id, 0, 0, 0, 0, x, y);
  for (let tries = 0; tries < 20; tries++) {
    await new Promise((resolve) => app.X.GetInputFocus(() => setTimeout(resolve, 25)));
    const match = seen.slice(before).find((ev) => ev.x === x && ev.y === y);
    if (match) return match;
  }
  throw new Error(`no motion event at ${x},${y} after warping there`);
};

test('inputDevices reports the master pointer and its classes', async (t) => {
  if (skip) return t.skip(skip);
  const devices = await app.inputDevices();
  assert.ok(devices.length >= 2, 'a server has at least a virtual pointer and keyboard');
  const master = devices.find((device) => device.use === 1); // DeviceType.MasterPointer
  assert.ok(master, 'there is a master pointer');
  assert.ok(master.classes.length, 'whose axes and buttons are described');
  assert.equal(await app.inputDevices(), devices, 'cached — this is read per scroll event');
});

test('an XI2 selection takes over the events it names, and only those', async (t) => {
  if (skip) return t.skip(skip);
  const wnd = app.createWindow({ width: 200, height: 200, backingStore: false });
  const moves = [];
  wnd.on('mousemove', (ev) => moves.push(ev));
  await mapAndWait(wnd);

  const core = await warp(wnd, 20, 20, moves);
  assert.equal(core.xi2, undefined, 'core MotionNotify, before anything is selected');

  assert.equal(await wnd.selectXI2(['Motion']), true);
  const xi2 = await warp(wnd, 120, 130, moves);
  assert.equal(xi2.xi2, true, 'the same gesture now arrives as XIMotion');
  assert.equal(xi2.y, 130, 'in the window coordinates a core event would have reported');
  assert.ok(xi2.deviceId > 0, 'and says which device it came from, which core X cannot');
  assert.equal(typeof xi2.preciseX, 'number');

  // deselecting hands the core events back
  assert.equal(await wnd.selectXI2([]), true);
  assert.equal((await warp(wnd, 40, 45, moves)).xi2, undefined);

  wnd.destroy();
});

test('selecting XI2 leaves the events it did not name on the core path', async (t) => {
  if (skip) return t.skip(skip);
  const wnd = app.createWindow({ width: 200, height: 200, backingStore: false });
  const seen = [];
  wnd.on('mousemove', (ev) => seen.push(ev));
  // Enter/Leave are still core events: XI2's are undecoded, so selectXI2
  // refuses to take them over and the window keeps the ones it can read
  wnd.on('mouseover', (ev) => seen.push(ev));
  await mapAndWait(wnd);
  assert.equal(await wnd.selectXI2(['Motion']), true);

  await warp(wnd, 10, 10, seen);
  const motion = await warp(wnd, 150, 150, seen);
  assert.equal(motion.xi2, true, 'motion is XI2 now');
  assert.ok(
    seen.every((ev) => ev.type !== 7 || !ev.xi2),
    'and an EnterNotify is still an EnterNotify'
  );

  wnd.destroy();
});
