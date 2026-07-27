// Window manager hints: WM_NORMAL_HINTS (size limits), WM_CLASS,
// _NET_WM_WINDOW_TYPE. Hermetic: runs against node-x11's in-process
// pure-JS X server and reads the properties back over the wire.
import assert from 'node:assert/strict';
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

const FLAG = { PMinSize: 16, PMaxSize: 32, PResizeInc: 64, PAspect: 128, PBaseSize: 256, PWinGravity: 512 };

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
