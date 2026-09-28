// The frame clock of a window a direct GL context draws into (lib/window.js
// `_setGlClock`, lib/glswapchain.js). Such a window has no backing store and
// so no present of its own: its frames used to end on the fence and a
// `frameInterval` timer, a clock that is not the display's. Its swap chain
// presents every frame and hears each one complete, so those completions end
// the window's frames, as a backing store's do. Hermetic — the X server,
// Present, DRI3 and the GPU are stubs, and completions are injected by hand.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick, setTimeout as sleep } from 'node:timers/promises';

import { DEFAULT_GL_POLICY } from '../lib/gl.js';
import { GLSwapchain } from '../lib/glswapchain.js';
import Window from '../lib/window.js';

let nextId = 0xf000;

const PRESENT_OPCODE = 145;

function makeMockApp() {
  const calls = { presents: [], fences: [] };
  const Present = {
    majorOpcode: PRESENT_OPCODE,
    EventMask: { NoEvent: 0, ConfigureNotify: 1, CompleteNotify: 2, IdleNotify: 4 },
    CompleteKind: { Pixmap: 0, NotifyMSC: 1 },
    CompleteMode: { Copy: 0, Flip: 1, Skip: 2, SuboptimalCopy: 3 },
    events: { ConfigureNotify: 0, CompleteNotify: 1, IdleNotify: 2 },
    Pixmap(window, pixmap, opts) {
      calls.presents.push({ window, pixmap, opts });
    },
    SelectInput() {}
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
    FreePixmap() {},
    flush() {},
    // held, not answered: a test that wants the fence clock to advance
    // releases them, and one that does not can tell a fence was even sent
    GetInputFocus(cb) {
      calls.fences.push(cb);
    },
    InternAtom(o, name, cb) {
      cb(null, 1);
    },
    require(name, cb) {
      cb(new Error(`no ${name}`));
    }
  };
  const display = { client: X, screen: [{ root: 1, root_depth: 24, white_pixel: 0xffffff }] };
  return { app: { X, display, options: {} }, calls, Present };
}

/** A GPU surface that always has a buffer to give: three, round robin. */
function fakeGpu() {
  return {
    createSurface(width, height) {
      let next = 0;
      const seen = new Set();
      return {
        width,
        height,
        swap() {
          const key = (next++ % 3) + 1;
          const isNew = !seen.has(key);
          seen.add(key);
          return { key, isNew, fd: 3, width, height, stride: width * 4 };
        },
        release() {},
        destroy() {}
      };
    }
  };
}

/** The window `<glarea>` draws into — no backing store — with a live chain. */
function glWindow(args = {}) {
  const { app, calls, Present } = makeMockApp();
  const wnd = new Window(app, { width: 200, height: 100, backingStore: false, ...args });
  const chain = new GLSwapchain({
    window: wnd,
    gpu: fakeGpu(),
    dri: { GBM_USE: { SCANOUT: 1, RENDERING: 2, LINEAR: 4 } },
    // the server takes every buffer, at once
    DRI3: { PixmapFromBuffer: (pixmap, window, opts, cb) => cb(null) },
    Present,
    depth: 24,
    policy: { ...DEFAULT_GL_POLICY, mode: 'auto' }
  });
  // as the GLES context wires it (lib/renderingcontext_gles.js)
  wnd._setGenericEventSink(PRESENT_OPCODE, chain);
  chain.surfaceFor(200, 100);
  return { wnd, chain, calls };
}

/** A GL loop of the shape `<glarea frameLoop="always">` runs: draw, swap, again. */
function glLoop(wnd, chain, state = { frames: 0 }) {
  const step = () => {
    state.frames++;
    chain.swap();
    wnd.requestAnimationFrame(step);
  };
  wnd.requestAnimationFrame(step);
  return state;
}

/** The server reporting that the chain's last frame reached the display. */
function complete(wnd, calls, { msc = 1, ust = 1_000_000, mode = 0, kind = 0 } = {}) {
  wnd.emit('event', {
    type: 35,
    extension: PRESENT_OPCODE,
    evtype: 1, // CompleteNotify
    kind,
    mode,
    serial: calls.presents.at(-1)?.opts.serial ?? 0,
    ust,
    msc,
    wid: wnd.id
  });
}

test('a GL window’s frames run one per completion of its presents', async () => {
  const { wnd, chain, calls } = glWindow();
  assert.equal(wnd.frameClock, 'present', 'the chain’s presents are the clock');
  const state = glLoop(wnd, chain);
  await tick();
  assert.equal(state.frames, 1, 'the first frame runs immediately');
  assert.equal(calls.presents.length, 1);

  // nothing from the display: the loop waits for it, however long that is
  await sleep(60);
  assert.equal(state.frames, 1, 'no completion, no frame — not after three frameIntervals');
  assert.equal(calls.fences.length, 0, 'and no fence: the display is the clock');

  complete(wnd, calls, { msc: 1 });
  await tick();
  assert.equal(state.frames, 2, 'the completion runs the next frame');
  assert.equal(calls.presents.length, 2);
  wnd.destroy();
});

test('a GL loop runs at the display’s rate, and learns it', async () => {
  // The case this is for: a map panned by an animation drew 52 frames a
  // second on a 60Hz panel, its frames ended by a 16ms timer that fires
  // late and drifts against the vblanks the frames were shown at.
  const { wnd, chain, calls } = glWindow();
  const state = glLoop(wnd, chain);
  await tick();
  const PERIOD_US = 1_000_000 / 60;
  for (let i = 1; i <= 20; i++) {
    complete(wnd, calls, { msc: 100 + i, ust: 5_000_000 + Math.round(i * PERIOD_US) });
    await tick();
  }
  assert.equal(state.frames, 21, 'one frame a vblank, none skipped');
  assert.equal(calls.presents.length, 21);
  assert.ok(
    Math.abs(wnd.refreshInterval - 1000 / 60) < 0.05,
    `the period, from the completions: ${wnd.refreshInterval} ms`
  );
  assert.equal(wnd.droppedFrames, 0);
  wnd.destroy();
});

test('a flipped frame is a frame shown, not a reason to leave the clock', async () => {
  // The chain presents without Option.Copy so that the server may flip: a
  // flip is its ordinary way of showing a frame. The window's own present
  // path gives up on Present when one of *its* presents flips (it owns one
  // pixmap and is about to draw into it); the chain's must not be read so.
  const { wnd, chain, calls } = glWindow();
  const state = glLoop(wnd, chain);
  await tick();
  for (let i = 1; i <= 3; i++) {
    complete(wnd, calls, { msc: i, ust: 1_000_000 + i * 16_667, mode: 1 });
    await tick();
  }
  assert.equal(state.frames, 4, 'each flip ran the next frame');
  assert.equal(wnd.frameClock, 'present');
  wnd.destroy();
});

test('a completion that never comes hands a GL window to the fence, and back', async () => {
  const { wnd, chain, calls } = glWindow();
  const state = glLoop(wnd, chain);
  await tick();
  assert.equal(state.frames, 1);

  // nothing has answered this window yet, so it is given the short deadline
  await sleep(300);
  assert.equal(wnd.frameClock, 'fence', 'the watchdog gave up on the display');
  assert.ok(state.frames > 1, `and frames resumed: ${state.frames}`);
  assert.ok(calls.fences.length > 0, 'on the fence');

  for (const fence of calls.fences.splice(0)) fence(null, {});
  await tick();
  complete(wnd, calls, { msc: 1 });
  await tick();
  assert.equal(wnd.frameClock, 'present', 'completions are arriving again');
  wnd.destroy();
});

test('a chain destroyed with a frame in flight ends that frame', async () => {
  // Its completion is never reported once the chain is gone (the context
  // unregisters its event sink with it), and a frame nobody ends is a
  // window whose rAF never runs again.
  const { wnd, chain } = glWindow();
  const state = glLoop(wnd, chain);
  await tick();
  assert.equal(state.frames, 1);
  chain.destroy();
  wnd._setGenericEventSink(0, null);
  assert.equal(wnd.frameClock, 'fence', 'the clock went with the chain');
  await tick();
  assert.equal(state.frames, 2, 'the next frame ran');
  wnd.destroy();
});

test('a GL window pinned to the fence stays on it', async () => {
  const { wnd, chain, calls } = glWindow({ frameClock: 'fence', frameInterval: 0 });
  assert.equal(wnd.frameClock, 'fence');
  const state = glLoop(wnd, chain);
  for (let i = 0; i < 4; i++) await tick();
  assert.ok(calls.fences.length > 0, 'its frames are fenced');
  const frames = state.frames;
  for (const fence of calls.fences.splice(0)) fence(null, {});
  for (let i = 0; i < 4; i++) await tick();
  assert.ok(state.frames > frames, 'and the fence runs the next');
  wnd.destroy();
});

test('made-up vblanks send a GL window back to the fence', async () => {
  // A server whose Present has no display behind it makes the msc up from a
  // timer (lib/window.js _probeMsc); pacing to it buys nothing, for a GL
  // window as for any other.
  const { wnd, chain, calls } = glWindow();
  const state = glLoop(wnd, chain);
  await tick();
  const FAKE_MSC = 270_971_370;
  for (let msc = FAKE_MSC; msc <= FAKE_MSC + 16; msc++) {
    complete(wnd, calls, { msc, ust: msc * 16666 + 400 });
    await tick();
  }
  assert.equal(wnd.frameClock, 'fence');
  const frames = state.frames;
  // the fence ends each frame, and frameInterval spaces them
  for (let round = 0; round < 3; round++) {
    for (const fence of calls.fences.splice(0)) fence(null, {});
    await sleep(25);
  }
  assert.ok(state.frames > frames, `frames kept coming: ${state.frames}`);
  wnd.destroy();
});
