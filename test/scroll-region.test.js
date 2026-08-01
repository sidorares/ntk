// Window.scrollRegion (sidorares/ntk#138): server-side scroll of the
// backing store. Two halves: request arithmetic against a mock X client
// (the frame-pacing pattern), and pixel truth against the in-process X
// server — the blitted band moves exactly, the exposed strip is untouched.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';

import xserver from 'x11/lib/xserver/index.js';

import Window from '../lib/window.js';
import { createClient } from '../lib/index.js';

let nextId = 0xa000;

function makeMockApp() {
  const calls = { copies: [] };
  const X = {
    _closing: false,
    stream: { destroyed: false, writableEnded: false },
    event_consumers: {},
    keycode2keysyms: {},
    AllocID: () => nextId++,
    ReleaseID() {},
    CreateWindow() {},
    DestroyWindow() {},
    ChangeWindowAttributes() {},
    CreateGC() {},
    CreatePixmap() {},
    FreePixmap() {},
    PolyFillRectangle() {},
    CopyArea(src, dst, gc, sx, sy, dx, dy, width, height) {
      calls.copies.push({ src, dst, gc, sx, sy, dx, dy, width, height });
    },
    GetInputFocus() {}
  };
  const display = { client: X, screen: [{ root: 1, root_depth: 24, white_pixel: 0xffffff }] };
  return { app: { X, display }, calls };
}

function backedWindow() {
  const { app, calls } = makeMockApp();
  const wnd = new Window(app, { width: 200, height: 100 });
  wnd.width = 200;
  wnd.height = 100;
  // stand in for what getContext('2d') normally allocates
  wnd._backing = { id: 0xb000, width: 200, height: 100 };
  wnd._presentGc = 0xc000;
  wnd._backingValid = true;
  return { wnd, calls };
}

test('scrolling up copies the surviving band in place and presents the region', async () => {
  const { wnd, calls } = backedWindow();
  const ok = wnd.scrollRegion({ x: 10, y: 10, width: 100, height: 80 }, 0, -20);
  assert.equal(ok, true);

  // the self-copy: rows 30..90 land on rows 10..70, backing -> backing,
  // with the graphicsExposures:0 present GC
  assert.equal(calls.copies.length, 1);
  assert.deepEqual(calls.copies[0], {
    src: 0xb000,
    dst: 0xb000,
    gc: 0xc000,
    sx: 10,
    sy: 30,
    dx: 10,
    dy: 10,
    width: 100,
    height: 60
  });

  // the present that follows covers the whole scrolled region, so the shift
  // reaches the window without the caller re-drawing the band
  await tick();
  assert.equal(calls.copies.length, 2);
  assert.deepEqual(calls.copies[1], {
    src: 0xb000,
    dst: wnd.id,
    gc: 0xc000,
    sx: 10,
    sy: 10,
    dx: 10,
    dy: 10,
    width: 100,
    height: 80
  });
});

test('a two-axis shift copies one rectangle, shifted both ways', () => {
  const { wnd, calls } = backedWindow();
  assert.equal(wnd.scrollRegion({ x: 0, y: 0, width: 200, height: 100 }, 30, -20), true);
  assert.deepEqual(calls.copies[0], {
    src: 0xb000,
    dst: 0xb000,
    gc: 0xc000,
    sx: 0,
    sy: 20,
    dx: 30,
    dy: 0,
    width: 170,
    height: 80
  });
});

test('the region is clamped to window ∩ backing before the shift', () => {
  const { wnd, calls } = backedWindow();
  // backing can be larger than the window after a shrink; the window wins
  wnd._backing.width = 400;
  wnd._backing.height = 300;
  assert.equal(wnd.scrollRegion({ x: -50, y: -50, width: 1000, height: 1000 }, 0, -10), true);
  assert.deepEqual(calls.copies[0], {
    src: 0xb000,
    dst: 0xb000,
    gc: 0xc000,
    sx: 0,
    sy: 10,
    dx: 0,
    dy: 0,
    width: 200,
    height: 90
  });
});

test('refusals: no backing, invalid backing, fractional, zero, nothing survives', () => {
  const { app } = makeMockApp();
  const bare = new Window(app, { width: 200, height: 100 });
  assert.equal(bare.scrollRegion({ x: 0, y: 0, width: 100, height: 100 }, 0, -10), false);

  const { wnd, calls } = backedWindow();
  wnd._backingValid = false; // resized, nothing painted yet
  assert.equal(wnd.scrollRegion({ x: 0, y: 0, width: 100, height: 100 }, 0, -10), false);
  wnd._backingValid = true;
  assert.equal(wnd.scrollRegion({ x: 0, y: 0, width: 100, height: 100 }, 0, -10.5), false);
  assert.equal(wnd.scrollRegion({ x: 0, y: 0, width: 100, height: 100 }, 0, 0), false);
  assert.equal(wnd.scrollRegion({ x: 0, y: 0, width: 100, height: 100 }, 0, -100), false);
  assert.equal(wnd.scrollRegion({ x: 0, y: 0, width: 100, height: 100 }, 120, 0), false);
  assert.equal(calls.copies.length, 0, 'every refusal is request-free');
});

// --- pixel truth against the in-process X server -------------------------

const readPixels = (ctx, w, h) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, w, h, (err, data) => (err ? reject(err) : resolve(data)))
  );

// BGRA readback -> [r, g, b]
const px = (image, w, x, y) => {
  const i = (y * w + x) * 4;
  return [image.data[i + 2], image.data[i + 1], image.data[i]];
};

test('pixels: the band lands shifted exactly, the exposed strip is untouched', async () => {
  const server = xserver.createServer({ width: 320, height: 240 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const app = await createClient({ stream: clientEnd });
  try {
    const wnd = app.createWindow({ width: 320, height: 240 });
    wnd.map();
    const ctx = wnd.getContext('2d');
    // three 20px bands inside the region that will scroll
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 320, 240);
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 40, 320, 20);
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(0, 60, 320, 20);
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(0, 80, 320, 20);
    await new Promise((resolve) => app.X.GetInputFocus(() => resolve()));

    assert.equal(wnd.scrollRegion({ x: 0, y: 20, width: 320, height: 120 }, 0, -20), true);
    await tick();
    await new Promise((resolve) => app.X.GetInputFocus(() => resolve()));

    const image = await readPixels(ctx, 320, 240);
    // the bands moved up by 20
    assert.deepEqual(px(image, 320, 160, 30), [255, 0, 0]);
    assert.deepEqual(px(image, 320, 160, 50), [0, 255, 0]);
    assert.deepEqual(px(image, 320, 160, 70), [0, 0, 255]);
    // the exposed strip (bottom 20 rows of the region) still holds its old
    // pixels — the blit does not invent content, the caller draws it
    assert.deepEqual(px(image, 320, 160, 130), [255, 255, 255]);
    // outside the region nothing moved
    assert.deepEqual(px(image, 320, 160, 10), [255, 255, 255]);
  } finally {
    await app.close();
  }
});
