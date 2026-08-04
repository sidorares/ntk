// Window manager hints: WM_NORMAL_HINTS (size limits and placement),
// WM_HINTS, WM_CLASS, WM_PROTOCOLS, WM_TRANSIENT_FOR, _NET_WM_WINDOW_TYPE.
// Hermetic: runs against node-x11's in-process pure-JS X server and reads
// the properties back over the wire.
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';

const { createServer, createStreamPair } = xserver;

let server = null;
let app = null;

before(async () => {
  server = createServer({ width: 320, height: 240 });
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);
  app = await createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
});

after(async () => {
  if (app) await app.close();
});

const roundtrip = () =>
  new Promise((resolve, reject) => app.X.GetInputFocus((err) => (err ? reject(err) : resolve())));

/** Several round trips, so deferred InternAtom -> ChangeProperty chains land. */
const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) await roundtrip();
};

const getProp = (wid, atom, type = 0) =>
  new Promise((resolve, reject) =>
    app.X.GetProperty(0, wid, atom, type, 0, 1024, (err, prop) => (err ? reject(err) : resolve(prop)))
  );

const intern = (name) =>
  new Promise((resolve, reject) =>
    app.X.InternAtom(false, name, (err, atom) => (err ? reject(err) : resolve(atom)))
  );

/** WM_NORMAL_HINTS is 18 CARD32s; return them as a plain array. */
const readHints = async (wid) => {
  const prop = await getProp(wid, app.X.atoms.WM_NORMAL_HINTS);
  const words = [];
  for (let i = 0; i + 4 <= prop.data.length; i += 4) words.push(prop.data.readUInt32LE(i));
  return words;
};

const FLAG = {
  USPosition: 1,
  USSize: 2,
  PPosition: 4,
  PSize: 8,
  PMinSize: 16,
  PMaxSize: 32,
  PResizeInc: 64,
  PAspect: 128,
  PBaseSize: 256,
  PWinGravity: 512
};

/** WM_HINTS is 9 CARD32s; return them as a plain array. */
const readWmHints = async (wid) => {
  const prop = await getProp(wid, app.X.atoms.WM_HINTS);
  const words = [];
  for (let i = 0; i + 4 <= prop.data.length; i += 4) words.push(prop.data.readUInt32LE(i));
  return words;
};

const HINT = {
  Input: 1,
  State: 2,
  IconPixmap: 4,
  IconWindow: 8,
  IconPosition: 16,
  IconMask: 32,
  WindowGroup: 64,
  Urgency: 256
};

/** Run `fn` with console.warn captured, returning what it said. */
const captureWarnings = async (fn) => {
  const said = [];
  const original = console.warn;
  console.warn = (...args) => said.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return said;
};

test('setSizeHints writes min/max into WM_NORMAL_HINTS', async () => {
  const wnd = app.createWindow({ width: 200, height: 100 });
  wnd.setSizeHints({ minWidth: 120, minHeight: 80, maxWidth: 640, maxHeight: 480 });
  await settle();

  const w = await readHints(wnd.id);
  assert.equal(w.length, 18, 'XSizeHints is 18 words');
  assert.equal(w[0] & FLAG.PMinSize, FLAG.PMinSize, 'PMinSize set');
  assert.equal(w[0] & FLAG.PMaxSize, FLAG.PMaxSize, 'PMaxSize set');
  assert.equal(w[0] & FLAG.PResizeInc, 0, 'PResizeInc not set');
  assert.deepEqual([w[5], w[6]], [120, 80], 'min width/height');
  assert.deepEqual([w[7], w[8]], [640, 480], 'max width/height');
});

test('resizable: false pins min and max to the current size', async () => {
  const wnd = app.createWindow({ width: 321, height: 123 });
  wnd.setSizeHints({ resizable: false });
  await settle();

  const w = await readHints(wnd.id);
  assert.equal(w[0] & (FLAG.PMinSize | FLAG.PMaxSize), FLAG.PMinSize | FLAG.PMaxSize);
  assert.deepEqual([w[5], w[6]], [321, 123], 'min == current size');
  assert.deepEqual([w[7], w[8]], [321, 123], 'max == current size');
});

test('setSizeHints carries increments, aspect, base size and gravity', async () => {
  const wnd = app.createWindow({ width: 200, height: 100 });
  wnd.setSizeHints({
    widthInc: 8,
    heightInc: 16,
    minAspect: [4, 3],
    maxAspect: [16, 9],
    baseWidth: 12,
    baseHeight: 34,
    gravity: 5
  });
  await settle();

  const w = await readHints(wnd.id);
  const expected = FLAG.PResizeInc | FLAG.PAspect | FLAG.PBaseSize | FLAG.PWinGravity;
  assert.equal(w[0] & expected, expected, 'all four flags set');
  assert.equal(w[0] & FLAG.PMinSize, 0, 'PMinSize left unset');
  assert.deepEqual([w[9], w[10]], [8, 16], 'resize increments');
  assert.deepEqual([w[11], w[12], w[13], w[14]], [4, 3, 16, 9], 'aspect ratios');
  assert.deepEqual([w[15], w[16]], [12, 34], 'base size');
  assert.equal(w[17], 5, 'win gravity');
});

test('setClass writes WM_CLASS as two NUL-terminated strings', async () => {
  const wnd = app.createWindow({ width: 20, height: 20 });
  wnd.setClass('react-x11', 'React-X11');
  await settle();

  const prop = await getProp(wnd.id, app.X.atoms.WM_CLASS);
  assert.equal(prop.data.toString('latin1'), 'react-x11\0React-X11\0');
});

test('setClass defaults the class name to the instance name', async () => {
  const wnd = app.createWindow({ width: 20, height: 20 });
  wnd.setClass('solo');
  await settle();

  const prop = await getProp(wnd.id, app.X.atoms.WM_CLASS);
  assert.equal(prop.data.toString('latin1'), 'solo\0solo\0');
});

test('setWindowType expands a short name to the EWMH atom', async () => {
  const wnd = app.createWindow({ width: 20, height: 20 });
  wnd.setWindowType('dialog');
  await settle();

  const [typeAtom, dialogAtom] = await Promise.all([
    intern('_NET_WM_WINDOW_TYPE'),
    intern('_NET_WM_WINDOW_TYPE_DIALOG')
  ]);
  const prop = await getProp(wnd.id, typeAtom);
  assert.equal(prop.data.length, 4, 'one atom');
  assert.equal(prop.data.readUInt32LE(0), dialogAtom);
});

test('setWindowType accepts a fallback list, most preferred first', async () => {
  const wnd = app.createWindow({ width: 20, height: 20 });
  wnd.setWindowType(['dropdown_menu', '_NET_WM_WINDOW_TYPE_MENU']);
  await settle();

  const [typeAtom, dropdown, menu] = await Promise.all([
    intern('_NET_WM_WINDOW_TYPE'),
    intern('_NET_WM_WINDOW_TYPE_DROPDOWN_MENU'),
    intern('_NET_WM_WINDOW_TYPE_MENU')
  ]);
  const prop = await getProp(wnd.id, typeAtom);
  assert.equal(prop.data.length, 8, 'two atoms');
  assert.equal(prop.data.readUInt32LE(0), dropdown, 'preferred type first');
  assert.equal(prop.data.readUInt32LE(4), menu, 'fallback second');
});

test('constructor args apply the hints at creation', async () => {
  const wnd = app.createWindow({
    width: 300,
    height: 200,
    wmClass: ['demo', 'Demo'],
    windowType: 'utility',
    sizeHints: { minWidth: 100, minHeight: 50 }
  });
  await settle();

  const w = await readHints(wnd.id);
  assert.deepEqual([w[5], w[6]], [100, 50], 'sizeHints applied');

  const cls = await getProp(wnd.id, app.X.atoms.WM_CLASS);
  assert.equal(cls.data.toString('latin1'), 'demo\0Demo\0');

  const [typeAtom, utility] = await Promise.all([
    intern('_NET_WM_WINDOW_TYPE'),
    intern('_NET_WM_WINDOW_TYPE_UTILITY')
  ]);
  const type = await getProp(wnd.id, typeAtom);
  assert.equal(type.data.readUInt32LE(0), utility);
});

test('resizable: false via constructor args uses the created size', async () => {
  const wnd = app.createWindow({ width: 444, height: 222, resizable: false });
  await settle();

  const w = await readHints(wnd.id);
  assert.deepEqual([w[5], w[6]], [444, 222]);
  assert.deepEqual([w[7], w[8]], [444, 222]);
});

// ---------------------------------------------------------------------
// WM_NORMAL_HINTS placement flags, and the empty write
// ---------------------------------------------------------------------

test('an explicit geometry sets the program-position and program-size flags', async () => {
  const wnd = app.createWindow({ width: 200, height: 100 });
  wnd.setSizeHints({ x: 30, y: 40, width: 200, height: 100 });
  await settle();

  const w = await readHints(wnd.id);
  assert.equal(w[0] & FLAG.PPosition, FLAG.PPosition, 'PPosition set');
  assert.equal(w[0] & FLAG.PSize, FLAG.PSize, 'PSize set');
  assert.equal(w[0] & FLAG.USPosition, 0, 'the program chose it, not the user');
  assert.deepEqual([w[1], w[2]], [30, 40], 'x, y');
  assert.deepEqual([w[3], w[4]], [200, 100], 'width, height');
});

test("position: 'user' outranks the program flag and defaults to the window's geometry", async () => {
  // "the user asked for this" is the stronger claim: a window manager may
  // override its own placement policy for it, where PPosition is a hint
  const wnd = app.createWindow({ x: 11, y: 22, width: 60, height: 70 });
  wnd.setSizeHints({ position: 'user', size: 'user' });
  await settle();

  const w = await readHints(wnd.id);
  assert.equal(w[0] & FLAG.USPosition, FLAG.USPosition);
  assert.equal(w[0] & FLAG.USSize, FLAG.USSize);
  assert.equal(w[0] & (FLAG.PPosition | FLAG.PSize), 0, 'not both at once');
  assert.deepEqual([w[1], w[2], w[3], w[4]], [11, 22, 60, 70]);
});

test('setSizeHints with nothing it recognises writes no property, and says so', async () => {
  const wnd = app.createWindow({ width: 50, height: 50 });
  const said = await captureWarnings(async () => {
    wnd.setSizeHints({});
    await settle();
  });

  // flags = 0 is a legal WM_NORMAL_HINTS meaning "I declare nothing", which
  // is exactly as useful as never writing it and much harder to notice
  const prop = await getProp(wnd.id, app.X.atoms.WM_NORMAL_HINTS);
  assert.equal(prop.type, 0, 'property absent, not present and empty');
  assert.equal(said.length, 1);
  assert.match(said[0], /sets no WM_NORMAL_HINTS flag/);
});

test('resizable: true alone is a legitimate no-op and stays quiet', async () => {
  const wnd = app.createWindow({ width: 50, height: 50 });
  const said = await captureWarnings(async () => {
    wnd.setSizeHints({ resizable: true });
    await settle();
  });
  assert.deepEqual(said, [], 'no constraints is the absence of the property');
});

// ---------------------------------------------------------------------
// WM_HINTS
// ---------------------------------------------------------------------

test('setWmHints writes the input model, initial state and urgency', async () => {
  const wnd = app.createWindow({ width: 40, height: 40 });
  wnd.setWmHints({ input: true, initialState: 'iconic', urgent: true });
  await settle();

  const w = await readWmHints(wnd.id);
  assert.equal(w.length, 9, 'XWMHints is 9 words');
  assert.equal(w[0] & HINT.Input, HINT.Input);
  assert.equal(w[0] & HINT.State, HINT.State);
  assert.equal(w[0] & HINT.Urgency, HINT.Urgency);
  assert.equal(w[1], 1, 'input true');
  assert.equal(w[2], 3, 'IconicState');
  assert.equal(w[0] & HINT.IconPixmap, 0, 'nothing invented for fields not passed');
});

test('setWmHints carries icon, group and icon position', async () => {
  const wnd = app.createWindow({ width: 40, height: 40 });
  const icon = app.createPixmap({ width: 16, height: 16 });
  const group = app.createWindow({ width: 10, height: 10 });
  wnd.setWmHints({ icon, iconMask: 0x1234, iconWindow: group, iconX: 7, iconY: 9, windowGroup: group });
  await settle();

  const w = await readWmHints(wnd.id);
  const expected = HINT.IconPixmap | HINT.IconWindow | HINT.IconPosition | HINT.IconMask | HINT.WindowGroup;
  assert.equal(w[0] & expected, expected, 'every flag its field needs');
  assert.equal(w[3], icon.id, 'a Pixmap resolves to its id');
  assert.equal(w[4], group.id, 'so does a Window');
  assert.deepEqual([w[5], w[6]], [7, 9]);
  assert.equal(w[7], 0x1234, 'a bare XID is taken as-is');
  assert.equal(w[8], group.id);
  icon.destroy();
});

test('urgent: false clears the flag rather than being ignored as empty', async () => {
  // the one call that legitimately produces a flags word of 0: "the user has
  // looked". Refusing to write it would leave the taskbar flashing.
  const wnd = app.createWindow({ width: 40, height: 40 });
  wnd.setWmHints({ urgent: true });
  await settle();
  assert.equal((await readWmHints(wnd.id))[0] & HINT.Urgency, HINT.Urgency);

  const said = await captureWarnings(async () => {
    wnd.setWmHints({ urgent: false });
    await settle();
  });
  assert.equal((await readWmHints(wnd.id))[0] & HINT.Urgency, 0, 'attention withdrawn');
  assert.deepEqual(said, []);
});

test('getWmHints reads back what setWmHints wrote', async () => {
  const wnd = app.createWindow({ width: 40, height: 40 });
  wnd.setWmHints({ input: false, initialState: 'normal', iconX: 3, iconY: 4 });
  await settle();

  assert.deepEqual(await wnd.getWmHints(), {
    urgent: false,
    input: false,
    initialState: 'normal',
    iconX: 3,
    iconY: 4
  });
});

// ---------------------------------------------------------------------
// WM_PROTOCOLS — the clobber this PR exists to fix
// ---------------------------------------------------------------------

test('a second protocol does not erase the first', async () => {
  const wnd = app.createWindow({ width: 40, height: 40 });
  await wnd.addProtocol('WM_DELETE_WINDOW');
  await wnd.addProtocol('WM_TAKE_FOCUS');

  const [del, focus] = await Promise.all([
    intern('WM_DELETE_WINDOW'),
    intern('WM_TAKE_FOCUS')
  ]);
  const protocols = await wnd.getProperty('WM_PROTOCOLS', { as: 'numbers' });
  assert.deepEqual(protocols.slice().sort(), [del, focus].sort(), 'both, in one property');
});

test('setActions still opts into WM_DELETE_WINDOW, and survives a later add', async () => {
  const wnd = app.createWindow({ width: 40, height: 40 });
  wnd.setActions();
  await settle(8);
  await wnd.addProtocol('_NET_WM_PING');

  const names = await wnd.getProtocols();
  assert.deepEqual(names.slice().sort(), ['WM_DELETE_WINDOW', '_NET_WM_PING'].sort());
});

test('two adds in the same tick both land', async () => {
  // each would otherwise read the list before the other wrote it, and the
  // second write would drop the first
  const wnd = app.createWindow({ width: 40, height: 40 });
  await Promise.all([wnd.addProtocol('WM_DELETE_WINDOW'), wnd.addProtocol('WM_TAKE_FOCUS')]);

  const names = await wnd.getProtocols();
  assert.deepEqual(names.slice().sort(), ['WM_DELETE_WINDOW', 'WM_TAKE_FOCUS'].sort());
});

test('setProtocols replaces, removeProtocol subtracts', async () => {
  const wnd = app.createWindow({ width: 40, height: 40 });
  await wnd.setProtocols(['WM_DELETE_WINDOW', 'WM_TAKE_FOCUS', '_NET_WM_PING']);
  assert.equal((await wnd.getProtocols()).length, 3);

  await wnd.removeProtocol('WM_TAKE_FOCUS');
  const names = await wnd.getProtocols();
  assert.deepEqual(names.slice().sort(), ['WM_DELETE_WINDOW', '_NET_WM_PING'].sort());

  await wnd.setProtocols('WM_TAKE_FOCUS');
  assert.deepEqual(await wnd.getProtocols(), ['WM_TAKE_FOCUS'], 'a bare name works too');
});

test('adding to a window adopted by id keeps the list its own client wrote', async () => {
  const owner = app.createWindow({ width: 40, height: 40 });
  await owner.setProtocols(['WM_DELETE_WINDOW']);

  // drop the wrapper from the cache so the next one is genuinely fresh:
  // constructing a Window for a known id otherwise returns the instance
  // that already knows what it wrote. A window adopted by id — the
  // window-manager case — knows nothing, and has to ask the server before
  // it can add without losing what is there.
  owner._forget();
  const seen = app.createWindow({ id: owner.id });
  assert.notEqual(seen, owner, 'a fresh wrapper, not the cached one');
  await seen.addProtocol('WM_TAKE_FOCUS');

  const names = await seen.getProtocols();
  assert.deepEqual(names.slice().sort(), ['WM_DELETE_WINDOW', 'WM_TAKE_FOCUS'].sort());
});

// ---------------------------------------------------------------------
// WM_TRANSIENT_FOR
// ---------------------------------------------------------------------

test('setTransientFor names the owner, and null clears it', async () => {
  const owner = app.createWindow({ width: 100, height: 80 });
  const dialog = app.createWindow({ width: 60, height: 40 });
  dialog.setTransientFor(owner);
  await settle();

  const prop = await getProp(dialog.id, app.X.atoms.WM_TRANSIENT_FOR);
  assert.equal(prop.type, app.X.atoms.WINDOW, 'type WINDOW, which is what a WM checks');
  assert.equal(prop.format, 32);
  assert.equal(prop.data.length, 4, 'one XID');
  assert.equal(prop.data.readUInt32LE(0), owner.id);
  assert.equal(await dialog.getTransientFor(), owner.id);

  dialog.setTransientFor(null);
  await settle();
  assert.equal(await dialog.getTransientFor(), null, 'deleted, not set to zero');
});

test("setTransientFor accepts an XID and 'root' for the window group", async () => {
  const dialog = app.createWindow({ width: 60, height: 40 });
  dialog.setTransientFor(0x1234);
  await settle();
  assert.equal(await dialog.getTransientFor(), 0x1234);

  dialog.setTransientFor('root');
  await settle();
  assert.equal(await dialog.getTransientFor(), app.display.screen[0].root);
});

test('setTransientFor on an override-redirect window warns that nothing will read it', async () => {
  const menu = app.createWindow({ width: 60, height: 40, overrideRedirect: true });
  const said = await captureWarnings(async () => {
    menu.setTransientFor(app.display.screen[0].root);
    await settle();
  });
  assert.equal(said.length, 1);
  assert.match(said[0], /override-redirect/);
});

// ---------------------------------------------------------------------
// setHints and the creation-time form
// ---------------------------------------------------------------------

test('setHints spreads keys across the properties they belong to', async () => {
  const owner = app.createWindow({ width: 100, height: 80 });
  const wnd = app.createWindow({ width: 40, height: 40 });
  wnd.setHints({ maxWidth: 900, urgent: true, transientFor: owner });
  await settle();

  assert.equal((await readHints(wnd.id))[7], 900, 'WM_NORMAL_HINTS');
  assert.equal((await readWmHints(wnd.id))[0] & HINT.Urgency, HINT.Urgency, 'WM_HINTS');
  assert.equal(await wnd.getTransientFor(), owner.id, 'WM_TRANSIENT_FOR');
});

test('setHints accumulates, where the struct writers replace', async () => {
  const wnd = app.createWindow({ width: 40, height: 40 });
  wnd.setHints({ input: true, minWidth: 120 });
  wnd.setHints({ urgent: true, maxWidth: 900 });
  await settle();

  const wm = await readWmHints(wnd.id);
  assert.equal(wm[0] & HINT.Input, HINT.Input, 'the earlier input hint survives');
  assert.equal(wm[0] & HINT.Urgency, HINT.Urgency);
  const size = await readHints(wnd.id);
  assert.equal(size[0] & FLAG.PMinSize, FLAG.PMinSize, 'and the earlier min size');
  assert.deepEqual([size[5], size[7]], [120, 900]);

  // the direct writer is documented as whole-struct, and behaves that way
  wnd.setWmHints({ urgent: true });
  await settle();
  assert.equal((await readWmHints(wnd.id))[0] & HINT.Input, 0);
});

test('setHints names a key it does not understand instead of dropping it', async () => {
  const wnd = app.createWindow({ width: 40, height: 40 });
  const said = await captureWarnings(async () => {
    wnd.setHints({ maxWdith: 900 });
    await settle();
  });
  assert.equal(said.length, 1);
  assert.match(said[0], /maxWdith/);
});

test('createWindow takes hint names at the top level and under hints', async () => {
  const owner = app.createWindow({ width: 100, height: 80 });
  const dialog = app.createWindow({
    width: 360,
    height: 170,
    transientFor: owner,
    maxWidth: 800,
    urgent: true,
    hints: { minWidth: 200, position: 'user' }
  });
  await settle();

  const size = await readHints(dialog.id);
  assert.equal(size[7], 800, 'top-level maxWidth');
  assert.equal(size[5], 200, 'hints.minWidth — one property, written once');
  assert.equal(size[0] & FLAG.USPosition, FLAG.USPosition, 'hints.position');
  assert.equal((await readWmHints(dialog.id))[0] & HINT.Urgency, HINT.Urgency);
  assert.equal(await dialog.getTransientFor(), owner.id);
});

// ---------------------------------------------------------------------
// _NET_WM_PID / WM_CLIENT_MACHINE
// ---------------------------------------------------------------------

test('a top-level window declares its process and host', async () => {
  const wnd = app.createWindow({ width: 40, height: 40 });
  await settle();

  const machine = await getProp(wnd.id, app.X.atoms.WM_CLIENT_MACHINE);
  assert.equal(machine.data.toString('latin1'), hostname());
  const pid = await wnd.getProperty('_NET_WM_PID', { as: 'numbers' });
  assert.deepEqual(pid, [process.pid]);
});

test('child windows and pid: false stay anonymous', async () => {
  const parent = app.createWindow({ width: 80, height: 80 });
  const child = parent.createWindow({ width: 20, height: 20 });
  const opted = app.createWindow({ width: 40, height: 40, pid: false });
  await settle();

  // EWMH asks for these on top-level windows; a child window is an
  // implementation detail nothing correlates a process with
  assert.equal((await getProp(child.id, app.X.atoms.WM_CLIENT_MACHINE)).type, 0);
  assert.equal(await child.getProperty('_NET_WM_PID'), null);
  assert.equal((await getProp(opted.id, app.X.atoms.WM_CLIENT_MACHINE)).type, 0);
});
