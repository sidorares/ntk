// Keyboard focus: X FocusIn/FocusOut arriving as 'focus'/'blur' events, and
// wnd.focus() taking it. Hermetic — node-x11's in-process pure-JS X server
// tracks the focus window and delivers the events, so no display is needed.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import x11 from 'x11';
import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';

const { createServer, createStreamPair } = xserver;

let app = null;

before(async () => {
  const server = createServer({ width: 320, height: 240 });
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);
  app = await createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
});

after(async () => {
  if (app) await app.close();
});

const settle = () =>
  new Promise((resolve) => app.X.GetInputFocus(() => setImmediate(resolve)));

const focusedWindow = () =>
  new Promise((resolve, reject) =>
    app.X.GetInputFocus((err, res) => (err ? reject(err) : resolve(res.focus)))
  );

test('focus and blur events follow the input focus', async () => {
  const log = [];
  const a = app.createWindow({ width: 60, height: 40, onFocus: () => log.push('a:focus') });
  const b = app.createWindow({ width: 60, height: 40 });
  a.on('blur', () => log.push('a:blur'));
  b.on('focus', () => log.push('b:focus'));
  a.map();
  b.map();
  await settle();

  a.focus();
  await settle();
  assert.equal(await focusedWindow(), a.id, 'the server moved the focus');
  assert.deepEqual(log, ['a:focus']);

  b.focus();
  await settle();
  assert.deepEqual(log, ['a:focus', 'a:blur', 'b:focus'], 'blur then focus');

  a.destroy();
  b.destroy();
});

test('the FocusChange mask is selected by the handler, at creation or later', async () => {
  const created = app.createWindow({ width: 40, height: 30, onBlur: () => {} });
  assert.ok(created.eventMask & x11.eventMask.FocusChange, 'from the onBlur arg');

  const later = app.createWindow({ width: 40, height: 30 });
  assert.equal(later.eventMask & x11.eventMask.FocusChange, 0, 'not before');
  later.on('focus', () => {});
  assert.ok(later.eventMask & x11.eventMask.FocusChange, 'after on("focus")');

  created.destroy();
  later.destroy();
});

test('queryFocus reports the window the server gives keys to', async () => {
  const wnd = app.createWindow({ width: 40, height: 30 });
  wnd.map();
  await settle();
  wnd.focus();
  await settle();

  const focus = await new Promise((resolve, reject) =>
    wnd.queryFocus((err, res) => (err ? reject(err) : resolve(res.focus)))
  );
  assert.equal(focus, wnd.id);
  wnd.destroy();
});
