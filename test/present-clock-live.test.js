// The frame clock on a server whose vertical blanks are made up, against a
// real X server (issue #366).
//
// The half a mock cannot supply is the server's own arithmetic. XQuartz, Xvfb
// and every other server whose driver gives Present no vertical blank compute
// the msc from their clock, and a window has to recognise that from the
// completions it is actually sent — then still get its pixels onto the window
// once it has left Present for CopyArea. Where a display is behind Present the
// same test checks the other side: its counter is nothing of the kind, and
// every frame goes out as a present.
//
// Skipped where there is no DISPLAY, or no Present.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

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

/**
 * Is this completion's msc the server's clock rounded to a 60Hz tick, the way
 * xserver's present_fake.c makes it up? Written out here rather than taken
 * from lib/, so that the test states the server's arithmetic on its own.
 */
const madeUp = (ev) =>
  [16666, 16667].some((interval) => {
    const offset = ev.ust - ev.msc * interval;
    return offset >= -8333 && offset < interval - 8333;
  });

const mapAndWait = (wnd) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, 1000);
    wnd.once('expose', () => {
      clearTimeout(timer);
      resolve();
    });
    wnd.map();
  });

/** One pixel of the window itself, not of its backing store. */
const pixelAt = (wnd, x, y) =>
  withTimeout(
    new Promise((resolve, reject) =>
      app.X.GetImage(2, wnd.id, x, y, 1, 1, 0xffffffff, (err, img) =>
        err ? reject(err) : resolve([...img.data.subarray(0, 3)])
      )
    ),
    5000,
    'reading the window back'
  );

test("a window takes its server's vertical blanks for what they are", async (t) => {
  if (skip) return t.skip(skip);
  // In the corner, clear of the windows other files map at the origin while
  // this one runs, and override-redirect so that nothing moves it from there:
  // GetImage reads what is on the screen, whoever put it there.
  const size = 48;
  const screen = app.display.screen[0];
  const wnd = app.createWindow({
    width: size,
    height: size,
    x: screen.pixel_width - size - 8,
    y: screen.pixel_height - size - 8,
    overrideRedirect: true
  });
  const ctx = wnd.getContext('2d');
  await wnd.enablePresent();
  const P = wnd._presentExt;
  if (!P) {
    wnd.destroy();
    return t.skip('no Present extension on this server');
  }
  await mapAndWait(wnd);

  const blits = { presents: 0, copies: 0 };
  const sendPixmap = P.Pixmap;
  const sendCopy = app.X.CopyArea;
  P.Pixmap = function (...args) {
    blits.presents++;
    return sendPixmap.apply(this, args);
  };
  app.X.CopyArea = function (src, dst, ...rest) {
    if (dst === wnd.id) blits.copies++;
    return sendCopy.call(this, src, dst, ...rest);
  };
  const completions = [];
  wnd.on('event', (ev) => {
    if (ev.type === 35 && ev.evtype === P.events.CompleteNotify && ev.kind === 0) completions.push(ev);
  });

  try {
    // Red and blue equal throughout, so what is read back does not depend
    // on the order the server keeps its channels in.
    let frames = 0;
    let running = true;
    const step = () => {
      ctx.fillStyle = frames++ % 2 ? 'rgb(40, 90, 40)' : 'rgb(40, 150, 40)';
      ctx.fillRect(0, 0, size, size);
      if (running) wnd.requestAnimationFrame(step);
    };
    wnd.requestAnimationFrame(step);
    // until the window has left the made-up clock, or a completion has shown
    // there is a display behind this one
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      if (blits.copies > 0 || completions.some((ev) => !madeUp(ev))) break;
      await sleep(20);
    }
    if (!completions.length) return t.skip('the server never completed a present');

    if (completions.every(madeUp)) {
      // XQuartz, Xvfb: a timer, not a display
      assert.equal(wnd.frameClock, 'fence', 'the fence ends frames on a made-up vblank');
      const span = completions.at(-1).msc - completions[0].msc;
      assert.ok(span >= 16, `after a quarter of a second of the counter: ${span} ticks`);
      const { presents, copies } = blits;
      const before = frames;
      await sleep(150);
      assert.ok(frames > before, `and the animation goes on: ${frames - before} frames`);
      assert.equal(blits.presents, presents, 'with no presents');
      assert.ok(blits.copies > copies, 'but CopyArea blits');
    } else {
      assert.equal(blits.copies, 0, 'a display is behind Present, and every frame is a present');
    }

    // whichever path it took, the window shows the frame drawn last
    running = false;
    await withTimeout(
      new Promise((resolve) =>
        wnd.requestAnimationFrame(() => {
          ctx.fillStyle = 'rgb(200, 60, 200)';
          ctx.fillRect(0, 0, size, size);
          // runs once the frame that blitted this has gone out: on a
          // display's clock once it has ended, on the fence possibly while
          // it is still unanswered (two frames in flight) — which is enough,
          // since the GetImage below queues behind that frame's CopyArea
          wnd.requestAnimationFrame(resolve);
        })
      ),
      5000,
      'the last frame'
    );
    assert.deepEqual(await pixelAt(wnd, size / 2, size / 2), [200, 60, 200]);
  } finally {
    P.Pixmap = sendPixmap;
    app.X.CopyArea = sendCopy;
    wnd.destroy();
  }
});
