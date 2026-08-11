// XI2 device events: the scroll bookkeeping a wheel delta needs, and the
// routing that turns a Generic Event into an ntk one.
//
// Hermetic. The wire half — XISelectEvents and the server's own decoding —
// belongs to node-x11 and is tested there; what is ntk's is the arithmetic on
// absolute valuators, which device an accumulator belongs to, and what comes
// out of `wnd.on(...)`. The extension object is stubbed for exactly that
// reason: a server that has XI2 is not something a test can arrange, and
// XQuartz reports scroll increments no synthetic event could reproduce.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';
import {
  ScrollTracker,
  coreState,
  normalizeXI2Types,
  scrollAxes,
  toNtkEvent
} from '../lib/xi2.js';

const { createServer, createStreamPair } = xserver;

// XI2 protocol constants, as node-x11 attaches them to the extension object
const XI_OPCODE = 131;
const EventType = {
  DeviceChanged: 1,
  KeyPress: 2,
  KeyRelease: 3,
  ButtonPress: 4,
  ButtonRelease: 5,
  Motion: 6,
  TouchBegin: 18,
  TouchUpdate: 19,
  TouchEnd: 20
};
const POINTER_EMULATED = 1 << 16;

// a master pointer whose current slave is a touchpad: two scroll axes,
// fifteen units to the notch (what libinput reports for a wheel)
const DEVICES = [
  {
    deviceId: 2,
    name: 'Virtual core pointer',
    classes: [
      { type: 2, sourceId: 6, number: 0, label: 0, min: -1, max: -1, value: 0 },
      { type: 3, sourceId: 6, number: 4, scrollType: 1, flags: 0, increment: 15 },
      { type: 3, sourceId: 6, number: 5, scrollType: 2, flags: 0, increment: 15 }
    ]
  },
  { deviceId: 3, name: 'Virtual core keyboard', classes: [] }
];

test('normalizeXI2Types names what it can deliver, and why a Raw event is not it', () => {
  assert.deepEqual(normalizeXI2Types(['Motion', 'ButtonPress']), ['Motion', 'ButtonPress']);
  assert.deepEqual(normalizeXI2Types('Motion'), ['Motion']);
  assert.deepEqual(normalizeXI2Types([]), []);

  assert.throws(() => normalizeXI2Types(['RawMotion']), (err) => {
    assert.match(err.message, /RawMotion/);
    assert.match(err.message, /root/, 'says why a raw event cannot be routed to a window');
    assert.match(err.message, /Motion, ButtonPress/, 'lists what can be selected');
    return true;
  });
  // decodable by the server, but not by node-x11: selecting it would cost the
  // core Enter/Leave and deliver an undecoded body in exchange
  assert.throws(() => normalizeXI2Types(['Enter']), /undecoded/);
});

test('scrollAxes reads the Scroll classes, and skips an axis with no increment', () => {
  const axes = scrollAxes(DEVICES[0]);
  assert.deepEqual([...axes.keys()], [4, 5]);
  assert.equal(axes.get(4).vertical, true);
  assert.equal(axes.get(5).vertical, false);
  assert.equal(axes.get(4).increment, 15);

  assert.equal(scrollAxes(DEVICES[1]).size, 0);
  assert.equal(
    scrollAxes({ classes: [{ type: 3, number: 4, scrollType: 1, increment: 0 }] }).size,
    0,
    'a notch zero units long would divide by zero'
  );
});

const motionEvent = (valuators, extra = {}) => ({
  type: 35,
  extension: XI_OPCODE,
  evtype: EventType.Motion,
  name: 'XIMotion',
  deviceId: 2,
  sourceId: 6,
  time: 1000,
  detail: 0,
  root: 1,
  child: 0,
  rootx: 100,
  rooty: 200,
  x: 10,
  y: 20,
  buttons: [],
  flags: 0,
  mods: { base: 0, latched: 0, locked: 0, effective: 0 },
  group: { base: 0, latched: 0, locked: 0, effective: 0 },
  valuators,
  ...extra
});

test('a scroll delta is the change in an absolute valuator, and the first one seeds', () => {
  const tracker = new ScrollTracker();
  const axes = scrollAxes(DEVICES[0]);

  // the axis has been accumulating since the device was plugged in — reading
  // it as a delta would scroll a thousand notches on the first event
  assert.deepEqual(
    tracker.delta(motionEvent({ 4: 1500 }), axes),
    { deltaX: 0, deltaY: 0, moved: false },
    'seeds, reports no distance'
  );

  assert.deepEqual(tracker.delta(motionEvent({ 4: 1515 }), axes), {
    deltaX: 0,
    deltaY: 1,
    moved: true
  });
  assert.deepEqual(
    tracker.delta(motionEvent({ 4: 1510 }), axes),
    { deltaX: 0, deltaY: -1 / 3, moved: true },
    'a touchpad moves a fraction of a notch at a time'
  );
  assert.equal(
    tracker.delta(motionEvent({ 5: 30 }), axes).moved,
    false,
    'the other axis seeds on its own'
  );
  assert.deepEqual(tracker.delta(motionEvent({ 5: 45 }), axes), {
    deltaX: 1,
    deltaY: 0,
    moved: true
  });

  assert.equal(
    tracker.delta(motionEvent({ 0: 12 }), axes),
    null,
    'a plain pointer axis is not scroll'
  );
  assert.equal(
    tracker.delta(motionEvent({ 4: 1600 }), new Map()),
    null,
    'a device with no scroll class'
  );
  assert.deepEqual(
    tracker.delta(motionEvent({ 4: 1510 }), axes),
    { deltaX: 0, deltaY: 0, moved: false },
    'an axis that did not move is still a scroll event, not a pointer move'
  );
});

test('a negative increment is a device declaring its axis inverted', () => {
  const tracker = new ScrollTracker();
  const axes = scrollAxes({ classes: [{ type: 3, number: 4, scrollType: 1, increment: -1 }] });
  tracker.delta(motionEvent({ 4: 10 }), axes);
  assert.deepEqual(tracker.delta(motionEvent({ 4: 11 }), axes), {
    deltaX: 0,
    deltaY: -1,
    moved: true
  });
});

test('accumulators are per source device, and a device change reseeds them', () => {
  const tracker = new ScrollTracker();
  const axes = scrollAxes(DEVICES[0]);
  tracker.delta(motionEvent({ 4: 1500 }), axes);
  assert.deepEqual(tracker.delta(motionEvent({ 4: 1530 }), axes), {
    deltaX: 0,
    deltaY: 2,
    moved: true
  });

  // the user let go of the touchpad and turned the wheel: same master, other
  // slave, and its axis is nowhere near 1530
  assert.equal(tracker.delta(motionEvent({ 4: 12 }, { sourceId: 9 }), axes).moved, false);
  assert.deepEqual(tracker.delta(motionEvent({ 4: 27 }, { sourceId: 9 }), axes), {
    deltaX: 0,
    deltaY: 1,
    moved: true
  });

  tracker.reset(2);
  assert.equal(
    tracker.delta(motionEvent({ 4: 27 }, { sourceId: 9 }), axes).moved,
    false,
    'seeds again'
  );
});

test('coreState packs XI2 modifiers, buttons and group the way core X reports them', () => {
  assert.equal(coreState(motionEvent({})), 0);
  assert.equal(
    coreState(motionEvent({}, { mods: { effective: 4 }, buttons: [1, 3] })),
    4 | (1 << 8) | (1 << 10),
    'Control, plus buttons 1 and 3 held'
  );
  assert.equal(
    coreState(motionEvent({}, { group: { effective: 1 } })),
    1 << 13,
    'the XKB group lives in bits 13-14, which is where the keyboard decoder reads it'
  );
  assert.equal(
    coreState(motionEvent({}, { buttons: [8] })),
    0,
    'core state has no bit for buttons past 5'
  );
});

test('a translated event keeps the core fields and adds the sub-pixel ones', () => {
  const ev = toNtkEvent('mousedown', motionEvent({}, { detail: 3, x: 10.75, y: 20.5 }));
  assert.equal(ev.type, 4, 'ButtonPress, as a handler switching on ev.type expects');
  assert.equal(ev.keycode, 3, 'core X calls the button number keycode');
  assert.equal(ev.x, 11, 'integers, as core X reports them');
  assert.equal(ev.y, 21);
  assert.equal(ev.preciseX, 10.75, 'and the precision XI2 adds, alongside');
  assert.equal(ev.deviceId, 2);
  assert.equal(ev.sourceId, 6);
  assert.equal(ev.xi2, true);

  const touch = toNtkEvent('touchstart', motionEvent({}, { detail: 7 }));
  assert.equal(touch.touchId, 7, 'the same field is a touch id here');
  assert.equal(touch.keycode, undefined);
});

// --- routing, against a real Window on the hermetic server -----------------

let server = null;
let client = null;

const connect = async () => {
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);
  return createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
};

beforeEach(async () => {
  server = createServer({ width: 400, height: 300 });
  client = await connect();
});

afterEach(() => {
  client?.X.terminate();
  server = client = null;
});

/**
 * A window with XI2 selected, without an X server that has XI2: the
 * extension and the device list are stubbed, and everything downstream of
 * them is the real thing.
 */
const xi2Window = async (app, { types, devices = DEVICES } = {}) => {
  const selections = [];
  app.xinput = () =>
    Promise.resolve({
      majorOpcode: XI_OPCODE,
      xi2: { majorVersion: 2, minorVersion: 2 },
      AllDevices: 0,
      AllMasterDevices: 1,
      EventType,
      XISelectEvents: (wid, masks) => selections.push({ wid, masks })
    });
  app.inputDevices = () => Promise.resolve(devices);
  const wnd = app.createWindow({ width: 100, height: 100, backingStore: false });
  assert.equal(await wnd.selectXI2(types), true);
  return { wnd, selections };
};

const next = (wnd, name) => new Promise((resolve) => wnd.once(name, resolve));

test('selectXI2 asks for the caller\'s events plus the one that invalidates the cache', async () => {
  const { wnd, selections } = await xi2Window(client);
  assert.equal(selections.length, 1);
  assert.equal(selections[0].wid, wnd.id);
  assert.equal(selections[0].masks.deviceId, 1, 'every master device');
  assert.deepEqual(selections[0].masks.mask, [
    'Motion',
    'ButtonPress',
    'ButtonRelease',
    'DeviceChanged'
  ]);

  const perDevice = await xi2Window(client, { types: ['Motion'] });
  assert.deepEqual(perDevice.selections[0].masks.mask, ['Motion', 'DeviceChanged']);
});

test('selectXI2([]) deselects and puts the window back on core events', async () => {
  const { wnd, selections } = await xi2Window(client);
  assert.equal(await wnd.selectXI2([]), true);
  assert.equal(selections[1].masks.mask, 0, 'an empty mask is how XI2 says stop');

  // a core ButtonPress of button 4 is a wheel again
  const wheel = next(wnd, 'wheel');
  wnd.emit('event', { type: 4, keycode: 4, x: 1, y: 2, buttons: 0 });
  assert.equal((await wheel).deltaY, -1);
});

test('a window with no XI2 server keeps its core wheel', async () => {
  const wnd = client.createWindow({ width: 100, height: 100, backingStore: false });
  client.xinput = () => Promise.resolve(null);
  assert.equal(await wnd.selectXI2(), false, 'says so rather than pretending');

  const seen = [];
  wnd.on('wheel', (ev) => seen.push(ev));
  wnd.emit('event', { type: 4, keycode: 5, x: 1, y: 2, buttons: 0 });
  wnd.emit('event', { type: 4, keycode: 6, x: 1, y: 2, buttons: 0 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(
    seen.map((ev) => [ev.deltaX, ev.deltaY, ev.smooth, ev.deltaMode]),
    [
      [0, 1, false, 'line'],
      [-1, 0, false, 'line']
    ],
    'buttons 5 and 6: one notch down, one notch left'
  );
});

test('a scroll valuator becomes a wheel event, and not also a mouse move', async () => {
  const { wnd } = await xi2Window(client);
  const moves = [];
  wnd.on('mousemove', (ev) => moves.push(ev));

  wnd.emit('event', motionEvent({ 4: 1500 }, { wid: wnd.id })); // seeds
  const wheel = next(wnd, 'wheel');
  wnd.emit('event', motionEvent({ 4: 1505 }, { wid: wnd.id }));

  const ev = await wheel;
  assert.equal(ev.deltaY, 1 / 3, 'a third of a notch, which no core event could say');
  assert.equal(ev.deltaX, 0);
  assert.equal(ev.smooth, true);
  assert.equal(ev.deltaMode, 'line');
  assert.equal(ev.deviceId, 2);
  assert.equal(ev.sourceId, 6);
  assert.equal(ev.window, wnd);
  assert.equal(ev.target, wnd);
  assert.deepEqual(moves, [], 'the pointer did not move; only the wheel did');
});

test('an XI2 motion that is not a scroll is still a mousemove', async () => {
  const { wnd } = await xi2Window(client);
  const move = next(wnd, 'mousemove');
  wnd.emit('event', motionEvent({ 0: 30, 1: 40 }, { wid: wnd.id, x: 30.5, y: 40.25 }));
  const ev = await move;
  assert.equal(ev.x, 31);
  assert.equal(ev.preciseX, 30.5);
  assert.equal(ev.xi2, true);
});

test('the emulated wheel click is dropped, so a notch is not counted twice', async () => {
  const { wnd } = await xi2Window(client);
  const seen = [];
  wnd.on('wheel', (ev) => seen.push(ev.source));
  wnd.on('mousedown', () => seen.push('mousedown'));

  // what the server sends for one smooth notch: the valuator, and a button
  // press for clients that cannot read it
  wnd.emit('event', motionEvent({ 4: 1500 }, { wid: wnd.id }));
  wnd.emit('event', motionEvent({ 4: 1515 }, { wid: wnd.id }));
  wnd.emit(
    'event',
    motionEvent({}, {
      wid: wnd.id,
      evtype: EventType.ButtonPress,
      detail: 5,
      flags: POINTER_EMULATED
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(seen, ['valuator'], 'one notch, once');
});

test('a wheel with no scroll class behind it still arrives, one notch at a time', async () => {
  // an old driver, or a mouse the server has no smooth scrolling for: the
  // button press is not emulating anything, so it is the event
  const { wnd } = await xi2Window(client, { devices: [DEVICES[1]] });
  const seen = [];
  wnd.on('wheel', (ev) => seen.push(ev));
  wnd.on('mousedown', (ev) => seen.push(ev));

  wnd.emit(
    'event',
    motionEvent({}, { wid: wnd.id, evtype: EventType.ButtonPress, detail: 4, flags: 0 })
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(seen.length, 2);
  assert.equal(seen[0].deltaY, -1);
  assert.equal(seen[0].smooth, false);
  assert.equal(seen[1].keycode, 4, 'and the button press itself, as core X would have sent it');
});

test('a frame of scrolling adds up, rather than reporting only its last step', async () => {
  const { wnd } = await xi2Window(client);
  wnd.emit('event', motionEvent({ 4: 1500 }, { wid: wnd.id }));
  const wheel = next(wnd, 'wheel');
  for (const value of [1503, 1506, 1509, 1512]) {
    wnd.emit('event', motionEvent({ 4: value }, { wid: wnd.id, time: 1000 + value }));
  }
  const ev = await wheel;
  assert.equal(ev.deltaY, 12 / 15, 'four fifths of a notch, not the last fifth');
  assert.equal(ev.coalesced.length, 4);
  assert.equal(ev.time, 2512, 'and it happened where the last one did');
});

test('XI2 key events carry the keysym decoding core ones do', async () => {
  const { wnd } = await xi2Window(client, { types: ['KeyPress'] });
  // the hermetic server has no keyboard layout to speak of; what matters here
  // is that the XI2 path reads the same map the core one does
  const keycode = 38;
  client.X.keycode2keysyms[keycode] = [0x61, 0x41]; // 'a', 'A'

  const key = next(wnd, 'keydown');
  wnd.emit(
    'event',
    motionEvent({}, { wid: wnd.id, evtype: EventType.KeyPress, name: 'XIKeyPress', detail: keycode })
  );
  const ev = await key;
  assert.equal(ev.keycode, keycode);
  assert.equal(ev.codepoint, 0x61);
  assert.equal(ev.keysym, 0x61);
});

test('a device change drops the accumulators built on the old device', async () => {
  const { wnd } = await xi2Window(client);
  const first = next(wnd, 'wheel');
  wnd.emit('event', motionEvent({ 4: 1500 }, { wid: wnd.id }));
  wnd.emit('event', motionEvent({ 4: 1515 }, { wid: wnd.id })); // one notch
  assert.equal((await first).deltaY, 1);

  wnd.emit(
    'event',
    motionEvent({}, { wid: wnd.id, evtype: EventType.DeviceChanged, name: 'XIDeviceChanged' })
  );

  const seen = [];
  wnd.on('wheel', (ev) => seen.push(ev.deltaY));
  // the new slave's axis starts somewhere else entirely
  wnd.emit('event', motionEvent({ 4: 40 }, { wid: wnd.id }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(seen, [], 'no 97-notch jump from subtracting across the switch');

  const wheel = next(wnd, 'wheel');
  wnd.emit('event', motionEvent({ 4: 55 }, { wid: wnd.id }));
  assert.equal((await wheel).deltaY, 1);
});

test('Present keeps its Generic Events while XI2 has its own', async () => {
  const { wnd } = await xi2Window(client);
  const routed = [];
  wnd._geHandlers.set(200, (ev) => routed.push(ev.evtype));
  wnd.emit('event', { type: 35, extension: 200, evtype: 1 });
  wnd.emit('event', { type: 35, extension: 201, evtype: 1 }); // nobody's
  assert.deepEqual(routed, [1], 'routed by extension opcode, not first-come');
});
