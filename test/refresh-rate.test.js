// The default frame interval, taken from the display instead of guessed
// (lib/app.js). One RandR probe per connection finds the fastest active
// output, and windows still on the built-in default adopt its period —
// so an animation loop on a 165Hz screen is not held to the 62.5fps that a
// hardcoded 16ms implies.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';

import App from '../lib/app.js';
import { setDriAddon } from '../lib/gl.js';

// Hermetic by default: the probe's native fallback (nativeRefreshRate) must
// see the addon this file stubs, never a real x11-dri that happens to be
// installed on the machine running the tests.
beforeEach(() => setDriAddon(null));
afterEach(() => setDriAddon(undefined)); // back to the real loader

// nativeRefreshRate answers null off darwin before ever touching the addon,
// so the stub-fed fallback tests only mean something there. CI still runs
// every RandR-side test, including the 1Hz fixture degrading to the default.
const onDarwin = { skip: process.platform !== 'darwin' && 'nativeRefreshRate is darwin-only' };

let nextId = 0xd000;

/** A 165Hz mode, as RandR describes one. */
const MODE_165 = {
  id: 1,
  dot_clock: 585_360_000,
  h_total: 2400,
  v_total: 1478,
  modeflags: 0
};
/** 60Hz, for the second output. */
const MODE_60 = {
  id: 2,
  dot_clock: 148_500_000,
  h_total: 2200,
  v_total: 1125,
  modeflags: 0
};
/** What Xvfb reports: a mode with no pixel clock at all. */
const MODE_VIRTUAL = { id: 3, dot_clock: 0, h_total: 0, v_total: 0, modeflags: 0 };
/**
 * What XQuartz reports as the *current* mode: a dynamically-created
 * desktop-sized entry with dot_clock = width * height — exactly 1Hz. Real
 * timing exists in its canned mode list, but the CRTC points here (issue
 * #328). Copied verbatim from a live XQuartz dump.
 */
const MODE_XQUARTZ_1HZ = { id: 4, dot_clock: 12_902_400, h_total: 5120, v_total: 2520, modeflags: 0 };

/** every reply lands a tick later, the way a real server's does */
const reply = (cb, ...args) => setImmediate(() => cb(...args));

/** long enough for the probe's chain of round trips to finish */
async function settle() {
  for (let i = 0; i < 6; i++) await tick();
}

function makeApp({ randr = true, modeinfos = [MODE_165], crtcs = { 10: 1 } } = {}) {
  const Randr = {
    GetScreenResourcesCurrent(root, cb) {
      reply(cb, null, { config_timestamp: 1, crtcs: Object.keys(crtcs).map(Number), modeinfos });
    },
    GetCrtcInfo(crtc, ts, cb) {
      reply(cb, null, { mode: crtcs[crtc], width: 100, height: 100 });
    }
  };
  const X = {
    _closing: false,
    stream: { destroyed: false, writableEnded: false },
    event_consumers: {},
    keycode2keysyms: {},
    atoms: {},
    on() {},
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
    CopyArea() {},
    GetInputFocus() {},
    InternAtom(o, name, cb) {
      cb(null, 1);
    },
    require(name, cb) {
      if (name === 'randr') return randr ? reply(cb, null, Randr) : reply(cb, new Error('no randr'));
      reply(cb, new Error(`no ${name}`));
    }
  };
  const display = { client: X, screen: [{ root: 1, root_depth: 24, white_pixel: 0xffffff }] };
  return new App(display, {});
}

test('a window takes the display period, not a hardcoded 16ms', async () => {
  const app = makeApp();
  const wnd = app.createWindow({ width: 100, height: 100 });
  assert.equal(wnd.frameInterval, 16, 'the guess, until the display has answered');

  await settle();
  assert.ok(Math.abs(app.refreshRate - 165) < 0.5, `165Hz: ${app.refreshRate}`);
  assert.ok(
    Math.abs(wnd.frameInterval - 1000 / 165) < 0.01,
    `adopted by a window that predates the probe: ${wnd.frameInterval}`
  );
  const later = app.createWindow({ width: 100, height: 100 });
  assert.equal(later.frameInterval, wnd.frameInterval, 'and by one created after it');
  wnd.destroy();
  later.destroy();
});

test('an interval the caller asked for is never overwritten', async () => {
  const app = makeApp();
  const pinned = app.createWindow({ width: 100, height: 100, frameInterval: 50 });
  const assigned = app.createWindow({ width: 100, height: 100 });
  assigned.frameInterval = 40;

  await settle();
  assert.ok(app.refreshRate, 'the probe did answer');
  assert.equal(pinned.frameInterval, 50, 'passed as an option');
  assert.equal(assigned.frameInterval, 40, 'or assigned afterwards');
  pinned.destroy();
  assigned.destroy();
});

test('the fastest active output is the one that sets the ceiling', async () => {
  // a laptop panel next to a fast external monitor: the ceiling has to clear
  // the faster of them, since it only bounds the rate rather than setting it
  const app = makeApp({ modeinfos: [MODE_165, MODE_60], crtcs: { 10: 2, 11: 1 } });
  app.createWindow({ width: 100, height: 100 });
  await settle();
  assert.ok(Math.abs(app.refreshRate - 165) < 0.5, `165, not 60: ${app.refreshRate}`);
});

test('a crtc that is switched off is not a display', async () => {
  const app = makeApp({ modeinfos: [MODE_60], crtcs: { 10: 0, 11: 2 } });
  app.createWindow({ width: 100, height: 100 });
  await settle();
  assert.ok(Math.abs(app.refreshRate - 60) < 0.5, `the enabled one: ${app.refreshRate}`);
});

test('a mode with no pixel clock leaves the default alone', async () => {
  // Xvfb reports dot_clock, h_total and v_total all zero — which is CI, so
  // this is the path the test suite itself runs on
  const app = makeApp({ modeinfos: [MODE_VIRTUAL], crtcs: { 10: 3 } });
  const wnd = app.createWindow({ width: 100, height: 100 });
  await settle();
  assert.equal(app.refreshRate, null, 'no rate to be had');
  assert.equal(app.frameInterval, null);
  assert.equal(wnd.frameInterval, 16, 'so the window keeps the default');
  wnd.destroy();
});

test('a server without RandR leaves the default alone', async () => {
  const app = makeApp({ randr: false });
  const wnd = app.createWindow({ width: 100, height: 100 });
  await settle();
  assert.equal(app.refreshRate, null);
  assert.equal(wnd.frameInterval, 16);
  wnd.destroy();
});

test('an implausible rate is no answer, not a rate', async () => {
  // XQuartz's 1Hz current mode, with nothing native to fall back on: the
  // 1 must be discarded (a 1Hz display is not a display), not adopted and
  // not clamped — this is the shape that defeats `if (!rate)`, since 1 is
  // truthy. This is also the CI path on Linux, where the native layer
  // answers null by construction.
  const app = makeApp({ modeinfos: [MODE_XQUARTZ_1HZ], crtcs: { 10: 4 } });
  const wnd = app.createWindow({ width: 100, height: 100 });
  await settle();
  assert.equal(app.refreshRate, null, 'no rate to be had');
  assert.equal(wnd.frameInterval, 16, 'so the window keeps the default');
  wnd.destroy();
});

test("XQuartz's 1Hz current mode falls back to the native rate", onDarwin, async () => {
  setDriAddon({ apple: { refreshRate: () => 120 } });
  const app = makeApp({ modeinfos: [MODE_XQUARTZ_1HZ], crtcs: { 10: 4 } });
  const wnd = app.createWindow({ width: 100, height: 100 });
  await settle();
  assert.ok(Math.abs(app.refreshRate - 120) < 0.5, `the OS's 120Hz: ${app.refreshRate}`);
  assert.ok(
    Math.abs(wnd.frameInterval - 1000 / 120) < 0.01,
    `8.33ms, adopted by the window: ${wnd.frameInterval}`
  );
  wnd.destroy();
});

test('a server without RandR still gets the native rate', onDarwin, async () => {
  setDriAddon({ apple: { refreshRate: () => 120 } });
  const app = makeApp({ randr: false });
  app.createWindow({ width: 100, height: 100 });
  await settle();
  assert.ok(Math.abs(app.refreshRate - 120) < 0.5, `120Hz: ${app.refreshRate}`);
});

test('RandR stays authoritative when its answer is plausible', onDarwin, async () => {
  let asked = 0;
  setDriAddon({
    apple: {
      refreshRate: () => {
        asked++;
        return 120;
      }
    }
  });
  const app = makeApp(); // one output, a real 165Hz mode
  app.createWindow({ width: 100, height: 100 });
  await settle();
  assert.ok(Math.abs(app.refreshRate - 165) < 0.5, `RandR's 165, not the OS's 120: ${app.refreshRate}`);
  assert.equal(asked, 0, 'the native layer was never consulted');
});

test('an implausible native answer is discarded like an implausible RandR one', onDarwin, async () => {
  setDriAddon({ apple: { refreshRate: () => 1 } });
  const app = makeApp({ modeinfos: [MODE_VIRTUAL], crtcs: { 10: 3 } });
  const wnd = app.createWindow({ width: 100, height: 100 });
  await settle();
  assert.equal(app.refreshRate, null, 'no rate to be had');
  assert.equal(wnd.frameInterval, 16);
  wnd.destroy();
});

test('an addon predating apple.refreshRate leaves the default alone', onDarwin, async () => {
  setDriAddon({ apple: {} }); // x11-dri < 0.6.0
  const app = makeApp({ modeinfos: [MODE_VIRTUAL], crtcs: { 10: 3 } });
  const wnd = app.createWindow({ width: 100, height: 100 });
  await settle();
  assert.equal(app.refreshRate, null);
  assert.equal(wnd.frameInterval, 16);
  wnd.destroy();
});

test('the probe runs once per connection, however many windows ask', async () => {
  let probes = 0;
  const app = makeApp();
  const inner = app.X.require.bind(app.X);
  app.X.require = (name, cb) => {
    if (name === 'randr') probes++;
    inner(name, cb);
  };
  app.createWindow({ width: 100, height: 100 });
  app.createWindow({ width: 100, height: 100 });
  void app.refreshRate;
  void app.frameInterval;
  await settle();
  assert.equal(probes, 1);
});
