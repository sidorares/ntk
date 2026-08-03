// Blitting through the Present extension (lib/window.js) against a mock X
// client. The dirty rectangles of a frame become one PresentPixmap with an
// update region instead of one CopyArea each, and the CopyArea path stays
// correct so the two can alternate.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';

import Window from '../lib/window.js';

let nextId = 0xe000;

function makeMockApp({ present = true, fixes = true } = {}) {
  const calls = { copies: [], presents: [], regions: [], destroyedRegions: [] };
  const Present = {
    Option: { None: 0, Async: 1, Copy: 2, UST: 4, Suboptimal: 8 },
    Pixmap(window, pixmap, opts) {
      calls.presents.push({ window, pixmap, opts });
    }
  };
  const Fixes = {
    CreateRegion(region, rects) {
      calls.regions.push({ region, rects, created: true });
    },
    SetRegion(region, rects) {
      calls.regions.push({ region, rects });
    },
    DestroyRegion(region) {
      calls.destroyedRegions.push(region);
    }
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
    CopyArea(src, dst, gc, sx, sy, dx, dy, width, height) {
      calls.copies.push({ x: dx, y: dy, w: width, h: height });
    },
    GetInputFocus(cb) {
      cb(null, {});
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

async function presentWindow(opts) {
  const { app, calls } = makeMockApp(opts);
  const wnd = new Window(app, { width: 200, height: 100 });
  wnd.width = 200;
  wnd.height = 100;
  wnd._backing = { id: 0xb200, width: 200, height: 100, destroy() {} };
  wnd._presentGc = 0xc200;
  await wnd.enablePresent();
  return { wnd, calls };
}

test('a frame becomes one PresentPixmap instead of a CopyArea per rectangle', async () => {
  const { wnd, calls } = await presentWindow();
  // two rectangles far enough apart that the CopyArea path would keep them split
  wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 });
  wnd._markDirty({ x: 180, y: 90, w: 10, h: 10 });
  await tick();

  assert.deepEqual(calls.copies, [], 'no CopyArea');
  assert.equal(calls.presents.length, 1, 'one PresentPixmap');
  assert.equal(calls.presents[0].window, wnd.id);
  assert.equal(calls.presents[0].pixmap, wnd._backing.id);
  wnd.destroy();
});

test('the update region carries the exact rectangles, not their bounding box', async () => {
  const { wnd, calls } = await presentWindow();
  wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 });
  wnd._markDirty({ x: 180, y: 90, w: 10, h: 10 });
  await tick();

  const set = calls.regions.filter((r) => !r.created).at(-1);
  assert.ok(set, 'the region was set');
  assert.equal(set.rects.length, 2, 'both rectangles, not one box around them');
  // XFixes wants {x, y, width, height}; ntk tracks {x, y, w, h}
  assert.deepEqual(set.rects[0], { x: 0, y: 0, width: 10, height: 10 });
  assert.deepEqual(set.rects[1], { x: 180, y: 90, width: 10, height: 10 });
  assert.equal(calls.presents[0].opts.update, set.region, 'and it is the update region');
  wnd.destroy();
});

test('Option.Copy is always set, so the server never takes the backing pixmap', async () => {
  const { wnd, calls } = await presentWindow();
  wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 });
  await tick();
  const opts = calls.presents[0].opts;
  assert.equal(opts.options & 2, 2, 'Option.Copy');
  assert.ok(!opts.targetMsc, 'no explicit target msc: the next vblank is what we want');
  assert.ok(opts.serial > 0, 'serialised so completions can be correlated');
  wnd.destroy();
});

test('a second frame reuses the same region and bumps the serial', async () => {
  const { wnd, calls } = await presentWindow();
  wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 });
  await tick();
  wnd._frame.lastPresentAt = -Infinity; // let the next blit through the pacer
  wnd._markDirty({ x: 20, y: 20, w: 10, h: 10 });
  await tick();

  assert.equal(calls.presents.length, 2);
  assert.equal(
    calls.presents[0].opts.update,
    calls.presents[1].opts.update,
    'one region for the life of the window'
  );
  assert.ok(calls.presents[1].opts.serial > calls.presents[0].opts.serial);
  wnd.destroy();
});

test('falls back to CopyArea when Present is missing', async () => {
  const { wnd, calls } = await presentWindow({ present: false });
  wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 });
  await tick();
  assert.deepEqual(calls.presents, [], 'no present');
  assert.equal(calls.copies.length, 1, 'blitted with CopyArea');
  wnd.destroy();
});

test('falls back to CopyArea when XFixes is missing', async () => {
  const { wnd, calls } = await presentWindow({ fixes: false });
  wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 });
  await tick();
  assert.deepEqual(calls.presents, [], 'no present without a region to update');
  assert.equal(calls.copies.length, 1);
  wnd.destroy();
});

test('a window that did not opt in keeps using CopyArea', async () => {
  const { app, calls } = makeMockApp();
  const wnd = new Window(app, { width: 200, height: 100 });
  wnd.width = 200;
  wnd.height = 100;
  wnd._backing = { id: 0xb200, width: 200, height: 100, destroy() {} };
  wnd._presentGc = 0xc200;
  wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 });
  await tick();
  assert.deepEqual(calls.presents, []);
  assert.equal(calls.copies.length, 1);
  wnd.destroy();
});

test('destroy releases the update region', async () => {
  const { wnd, calls } = await presentWindow();
  const region = calls.regions.find((r) => r.created).region;
  wnd.destroy();
  assert.deepEqual(calls.destroyedRegions, [region]);
});

test('the sync-request acknowledgement still goes out on the Present path', async () => {
  // A window using both features must still answer the window manager. The
  // Present blit replaces the CopyArea loop, and an early return there would
  // skip the acknowledgement and stall the resize — silently, since neither
  // feature's own tests would notice.
  const { app, calls } = makeMockApp();
  const acks = [];
  const wnd = new Window(app, { width: 200, height: 100 });
  wnd.width = 200;
  wnd.height = 100;
  wnd._backing = { id: 0xb200, width: 200, height: 100, destroy() {} };
  wnd._presentGc = 0xc200;
  await wnd.enablePresent();
  // stand in for an armed sync request rather than driving the whole protocol
  wnd._syncCounter = 0xf000;
  wnd._sync = { SetCounter: (counter, value) => acks.push({ counter, value }) };
  wnd._syncPending = 0x2a;

  wnd._markDirty({ x: 0, y: 0, w: 10, h: 10 });
  await tick();

  assert.equal(calls.presents.length, 1, 'blitted with Present');
  assert.deepEqual(acks, [{ counter: 0xf000, value: 0x2a }], 'and still acknowledged');
  wnd.destroy();
});
