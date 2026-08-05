// Backing store headroom (sidorares/ntk#179): an interactive enlarge
// delivers a ConfigureNotify per frame, and an exact grow-only allocation
// crossed its previous maximum on every one of them — each frame paying for
// a CreatePixmap, a full white clear, a FreePixmap and a picture rebind.
// Dimensions round up to BACKING_GRANULARITY so the reuse check absorbs the
// intermediate steps. Mock X client, the frame-pacing pattern: fences are
// released by hand to model a server that keeps up with the drag.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';

import Window from '../lib/window.js';

let nextId = 0xa000;

function makeMockApp() {
  const calls = { pixmaps: [], freed: 0 };
  const fences = [];
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
    CreatePixmap(id, parent, depth, width, height) {
      calls.pixmaps.push({ id, width, height });
    },
    FreePixmap() {
      calls.freed++;
    },
    PolyFillRectangle() {},
    CopyArea() {},
    GetInputFocus(cb) {
      fences.push(cb);
    }
  };
  const display = { client: X, screen: [{ root: 1, root_depth: 24, white_pixel: 0xffffff }] };
  return { app: { X, display }, fences, calls };
}

const configure = (width, height) => ({ type: 22, width, height, x: 0, y: 0 });

test('a continuous enlarge reallocates the backing O(log) times, not per frame', async () => {
  const { app, fences, calls } = makeMockApp();
  const wnd = new Window(app, { width: 200, height: 100, frameInterval: 0 });
  wnd.width = 200;
  wnd.height = 100;
  // stands in for what getContext('2d') does on a window
  wnd._enableBackingStore();
  assert.equal(calls.pixmaps.length, 1, 'one allocation up front');
  assert.ok(wnd._backing.width >= 200 && wnd._backing.height >= 100, 'covers the window');

  // a drag enlarge: one ConfigureNotify per frame, each in its own tick so
  // none of them coalesce, with the fence released between frames
  for (let i = 1; i <= 10; i++) {
    wnd.emit('event', configure(200 + i * 8, 100 + i * 8));
    await tick();
    while (fences.length) fences.shift()(null);
    await tick();
  }
  const reallocs = calls.pixmaps.length - 1;
  assert.ok(reallocs <= 2, `10 grow steps caused ${reallocs} reallocations`);
  assert.ok(wnd._backing.width >= 280 && wnd._backing.height >= 180, 'still covers the window');
  // every superseded pixmap was freed — headroom trades requests, not memory
  assert.equal(calls.freed, reallocs);

  wnd.destroy();
});

test('a grow step inside the headroom leaves the backing pixmap alone', async () => {
  const { app, fences, calls } = makeMockApp();
  const wnd = new Window(app, { width: 200, height: 100, frameInterval: 0 });
  wnd.width = 200;
  wnd.height = 100;
  wnd._enableBackingStore();
  const backing = wnd._backing;

  wnd.emit('event', configure(208, 108));
  await tick();
  while (fences.length) fences.shift()(null);
  await tick();

  assert.equal(wnd._backing, backing, 'same pixmap');
  assert.equal(calls.pixmaps.length, 1);
  assert.equal(wnd._backingValid, false, 'the new area still needs a redraw');

  wnd.destroy();
});

// --- what the unpainted area is cleared to ------------------------------
//
// A pixmap's contents start undefined, so the backing store has to be written
// before it can be presented — but the colour used to be the screen's white
// full stop, with no way to change it. On a window that draws itself dark
// that is a white flash on every resize, and it survives until something
// damages the strip, because a grow inside the headroom reallocates nothing.

function clearingApp() {
  const { app, fences, calls } = makeMockApp();
  calls.gcs = [];
  calls.fills = [];
  calls.copies = [];
  app.X.CreateGC = (id, drawable, values) => calls.gcs.push({ id, values });
  app.X.ChangeGC = (id, values) => calls.gcs.push({ id, values, changed: true });
  app.X.PolyFillRectangle = (drawable, gc, rects) =>
    calls.fills.push({ drawable, rects });
  app.X.CopyArea = (src, dst, gc, sx, sy, dx, dy, width, height) =>
    calls.copies.push({ src, dst, width, height });
  return { app, fences, calls };
}

/** The foreground the clear GC is using, after any ChangeGC. */
const clearPixel = (calls) =>
  calls.gcs
    .filter((g) => g.values && 'foreground' in g.values)
    .map((g) => g.values.foreground)
    .pop();

test('the backing store clears to the window background, not to white', () => {
  const { app, calls } = clearingApp();
  const wnd = new Window(app, {
    width: 200,
    height: 100,
    backgroundPixel: 0x1e2228
  });
  wnd._enableBackingStore();

  assert.equal(clearPixel(calls), 0x1e2228, 'the colour the window asked for');
  wnd.destroy();
});

test('with no background asked for, white — and 0 on an ARGB window', () => {
  {
    const { app, calls } = clearingApp();
    const wnd = new Window(app, { width: 200, height: 100 });
    wnd._enableBackingStore();
    assert.equal(clearPixel(calls), 0xffffff, 'the screen white, as before');
    wnd.destroy();
  }
  {
    const { app, calls } = clearingApp();
    const wnd = new Window(app, { width: 200, height: 100, depth: 32 });
    wnd._enableBackingStore();
    assert.equal(clearPixel(calls), 0, 'transparent, not white');
    wnd.destroy();
  }
});

test('setBackgroundPixel recolours the headroom a later grow will expose', () => {
  const { app, calls } = clearingApp();
  const wnd = new Window(app, { width: 200, height: 100 });
  wnd._enableBackingStore();
  const backing = wnd._backing;
  calls.fills.length = 0;

  wnd.setBackgroundPixel(0x1e2228);

  assert.equal(clearPixel(calls), 0x1e2228, 'the clear GC followed');
  const filled = calls.fills.filter((f) => f.drawable === backing.id);
  assert.equal(filled.length, 1, 'the headroom was repainted');
  // the L outside the 200x100 window, and nothing inside it: that area holds
  // drawn content, and recolouring it would be a flash rather than a fix
  const rects = filled[0].rects;
  assert.deepEqual(
    rects,
    [200, 0, backing.width - 200, backing.height, 0, 100, 200, backing.height - 100],
    'right strip then bottom strip, both outside the window'
  );
  wnd.destroy();
});

test('a grow carries the drawn content across instead of clearing it', async () => {
  const { app, fences, calls } = clearingApp();
  const wnd = new Window(app, { width: 200, height: 100, frameInterval: 0 });
  wnd.width = 200;
  wnd.height = 100;
  wnd._enableBackingStore();
  const before = wnd._backing;
  calls.fills.length = 0;
  calls.copies.length = 0;

  // past the headroom, so this really reallocates
  wnd.emit('event', configure(600, 600));
  await tick();
  while (fences.length) fences.shift()(null);
  await tick();

  assert.notEqual(wnd._backing, before, 'reallocated');
  const carried = calls.copies.find((c) => c.dst === wnd._backing.id);
  assert.ok(carried, 'the old pixmap was copied into the new one');
  assert.equal(carried.src, before.id);
  assert.equal(carried.width, before.width);

  // only the L-shaped remainder is cleared; a full-pixmap fill here is what
  // made the whole window flash rather than just the new strip
  const cleared = calls.fills.filter((f) => f.drawable === wnd._backing.id);
  assert.equal(cleared.length, 1);
  assert.deepEqual(cleared[0].rects.slice(0, 2), [before.width, 0]);
  wnd.destroy();
});
