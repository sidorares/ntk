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
