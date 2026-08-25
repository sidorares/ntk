// PointerMotionHint against a real X server (issue #319).
//
// The half a mock cannot supply: whether the server actually stops talking.
// With the hint selected it may send one MotionNotify carrying detail
// NotifyHint and then say nothing more until the client asks — measured on
// XQuartz, 600 pointer warps produced exactly one event from a client that
// never asked, and continuous motion from one that does. Only a server
// decides that, so only a server can show the fix works.
//
// Skipped where there is no DISPLAY.
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
    app = await withTimeout(createClient(), 5000, 'connecting to X server', (late) => late.close());
  } catch (err) {
    skip = `cannot connect to X server: ${err.message}`;
  }
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

/** A round trip, which is also long enough for a frame to have run. */
const settle = () =>
  new Promise((resolve) => app.X.GetInputFocus(() => setTimeout(resolve, 25)));

/**
 * Move the pointer to a spot in the window and wait for the move to be
 * reported there.
 *
 * Matched on the coordinates rather than on "an event arrived", because a
 * real server has a real pointer on it and the suite runs its files in
 * parallel: someone brushing the touchpad, or another test warping the
 * pointer into its own window, is otherwise a failure. Re-warping on each
 * try is what makes that recoverable.
 */
const warpTo = async (wnd, x, y, seen) => {
  const before = seen.length;
  for (let tries = 0; tries < 20; tries++) {
    app.X.WarpPointer(0, wnd.id, 0, 0, 0, 0, x, y);
    await settle();
    if (seen.slice(before).some((ev) => ev.x === x && ev.y === y)) return true;
  }
  return false;
};

const SPOTS = [
  [30, 40],
  [70, 55],
  [120, 90],
  [45, 130],
  [150, 25]
];

test('a window that asks for hinted motion keeps hearing about it', async (t) => {
  if (skip) return t.skip(skip);
  const wnd = app.createWindow({ width: 200, height: 200, backingStore: false });
  const moves = [];
  wnd.on('mousemove', (ev) => moves.push(ev));
  await mapAndWait(wnd);
  await warpTo(wnd, 10, 10, moves); // pointer inside before anything is measured

  wnd.setMouseHintOnly(true);
  await settle();
  const reached = [];
  for (const [x, y] of SPOTS) {
    if (await warpTo(wnd, x, y, moves)) reached.push([x, y]);
  }
  // the bug: the server sends one NotifyHint and waits to be asked, so a
  // client that never asks sees the first of these and nothing after it
  assert.deepEqual(
    reached,
    SPOTS,
    'every hinted move was reported — one that leaves the hint unanswered gets only the first'
  );

  wnd.setMouseHintOnly(false);
  await settle();
  assert.ok(await warpTo(wnd, 60, 60, moves), 'and turning it off leaves plain motion working');
  wnd.destroy();
});
