// 'resize' is ConfigureNotify, which fires for pure moves and reparents as
// much as for size changes (sidorares/ntk#184). The delivered event says
// which it was — ev.moved / ev.resized / ev.previous — so a consumer does
// not have to keep its own copy of the last geometry to find out, which is
// the mistake that cost react-x11 a full relayout per step of a window drag
// (sidorares/react-x11#183).
//
// Measured against the last *delivered* event, not the last raw one: a
// frame that coalesces two moves and a resize has to report both.
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
    GetGeometry(id, cb) {
      calls.getGeometry = cb;
    },
    GetInputFocus(cb) {
      fences.push(cb);
    }
  };
  const display = { client: X, screen: [{ root: 1, root_depth: 24, white_pixel: 0xffffff }] };
  return { app: { X, display }, fences, calls };
}

const configure = (width, height, x = 0, y = 0) => ({ type: 22, width, height, x, y });

/** Deliver one ConfigureNotify and let its frame run. */
async function send(wnd, fences, ev) {
  wnd.emit('event', ev);
  await tick();
  while (fences.length) fences.shift()(null);
  await tick();
}

test('a pure move is tagged moved, not resized', async () => {
  const { app, fences } = makeMockApp();
  const wnd = new Window(app, { width: 200, height: 100, x: 10, y: 20, frameInterval: 0 });
  const got = [];
  wnd.on('resize', (ev) => got.push(ev));

  await send(wnd, fences, configure(200, 100, 60, 70));

  assert.equal(got.length, 1);
  assert.equal(got[0].moved, true, 'the position changed');
  assert.equal(got[0].resized, false, 'the size did not');
  assert.deepEqual(got[0].previous, { x: 10, y: 20, width: 200, height: 100 });
  wnd.destroy();
});

test('a pure resize is tagged resized, not moved', async () => {
  const { app, fences } = makeMockApp();
  const wnd = new Window(app, { width: 200, height: 100, x: 10, y: 20, frameInterval: 0 });
  const got = [];
  wnd.on('resize', (ev) => got.push(ev));

  await send(wnd, fences, configure(640, 480, 10, 20));

  assert.equal(got[0].moved, false);
  assert.equal(got[0].resized, true);
  wnd.destroy();
});

test('a move-and-resize is tagged as both', async () => {
  const { app, fences } = makeMockApp();
  const wnd = new Window(app, { width: 200, height: 100, x: 10, y: 20, frameInterval: 0 });
  const got = [];
  wnd.on('resize', (ev) => got.push(ev));

  await send(wnd, fences, configure(640, 480, 60, 70));

  assert.equal(got[0].moved, true);
  assert.equal(got[0].resized, true);
  wnd.destroy();
});

test('a ConfigureNotify that changed nothing is tagged as neither', async () => {
  const { app, fences } = makeMockApp();
  const wnd = new Window(app, { width: 200, height: 100, x: 10, y: 20, frameInterval: 0 });
  const got = [];
  wnd.on('resize', (ev) => got.push(ev));

  // a reparent, or a WM restating the geometry it already gave us
  await send(wnd, fences, configure(200, 100, 10, 20));

  assert.equal(got.length, 1, 'still delivered — the event happened');
  assert.equal(got[0].moved, false);
  assert.equal(got[0].resized, false);
  wnd.destroy();
});

test('the baseline is the last delivered event, so coalescing cannot swallow a change', async () => {
  const { app, fences } = makeMockApp();
  const wnd = new Window(app, { width: 200, height: 100, x: 0, y: 0, frameInterval: 0 });
  const got = [];
  wnd.on('resize', (ev) => got.push(ev));

  // one frame's worth: two moves and then a resize. Per-hop flags would
  // report the last hop only — resized, not moved — and a listener that
  // re-anchors on moves would never hear about the 40px the window travelled.
  wnd.emit('event', configure(200, 100, 20, 0));
  wnd.emit('event', configure(200, 100, 40, 0));
  wnd.emit('event', configure(300, 100, 40, 0));
  await tick();
  while (fences.length) fences.shift()(null);

  assert.equal(got.length, 1, 'one delivery for the frame');
  assert.equal(got[0].coalesced.length, 3);
  assert.equal(got[0].moved, true, 'the net move across the frame');
  assert.equal(got[0].resized, true, 'and the net resize');
  assert.deepEqual(got[0].previous, { x: 0, y: 0, width: 200, height: 100 });
  wnd.destroy();
});

test('flags follow each delivery, so a drag reports move-only every frame', async () => {
  const { app, fences } = makeMockApp();
  const wnd = new Window(app, { width: 200, height: 100, x: 0, y: 0, frameInterval: 0 });
  const got = [];
  wnd.on('resize', (ev) => got.push(ev));

  for (let i = 1; i <= 5; i++) await send(wnd, fences, configure(200, 100, i * 10, 0));

  assert.equal(got.length, 5);
  assert.ok(
    got.every((ev) => ev.moved && !ev.resized),
    'every step of an opaque-move drag is a move'
  );
  assert.deepEqual(got.at(-1).previous, { x: 40, y: 0, width: 200, height: 100 });
  wnd.destroy();
});

test('without coalescing the flags are the same', async () => {
  const { app } = makeMockApp();
  const wnd = new Window(app, {
    width: 200,
    height: 100,
    x: 0,
    y: 0,
    coalesceEvents: false,
    frameSync: false
  });
  const got = [];
  wnd.on('resize', (ev) => got.push(ev));

  wnd.emit('event', configure(200, 100, 30, 0));
  wnd.emit('event', configure(260, 100, 30, 0));

  assert.deepEqual(
    got.map((ev) => [ev.moved, ev.resized]),
    [
      [true, false],
      [false, true]
    ]
  );
  wnd.destroy();
});

test('an adopted window reports both until its geometry is known', async () => {
  const { app, calls, fences } = makeMockApp();
  const wnd = new Window(app, { id: 0xbeef, frameInterval: 0 });
  const got = [];
  wnd.on('resize', (ev) => got.push(ev));

  assert.equal(wnd._deliveredGeom, null, 'nothing known before GetGeometry replies');
  await send(wnd, fences, configure(300, 200, 5, 5));
  assert.equal(got[0].moved, true, 'nothing can be ruled out');
  assert.equal(got[0].resized, true);
  assert.equal(got[0].previous, null);

  // the reply lands late; the event stream has already established a
  // baseline, so it must not overwrite one
  calls.getGeometry(null, { width: 300, height: 200, xPos: 5, yPos: 5, depth: 24 });
  await send(wnd, fences, configure(300, 200, 5, 5));
  assert.equal(got[1].moved, false, 'the baseline came from the events, not the reply');
  assert.equal(got[1].resized, false);
  wnd.destroy();
});

test('the backing store ignores moves and still follows resizes', async () => {
  const { app, fences, calls } = makeMockApp();
  const wnd = new Window(app, { width: 200, height: 100, x: 0, y: 0, frameInterval: 0 });
  wnd._enableBackingStore();
  assert.equal(calls.pixmaps.length, 1, 'one allocation up front');

  // an opaque-move drag: 20 ConfigureNotify, no size change
  for (let i = 1; i <= 20; i++) await send(wnd, fences, configure(200, 100, i * 5, 0));
  assert.equal(calls.pixmaps.length, 1, 'a drag reallocates nothing');
  assert.equal(wnd._backingValid, false, 'and does not invalidate what is drawn');

  // a real enlarge past the headroom still reallocates
  await send(wnd, fences, configure(900, 700, 100, 0));
  assert.equal(calls.pixmaps.length, 2, 'a resize still grows the backing');
  wnd.destroy();
});
