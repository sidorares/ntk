// The keydown path end to end: a real key event over the wire, decoded
// against the connection's keyboard map. Hermetic — node-x11's in-process
// pure-JS X server delivers the events, and SendEvent supplies the state bits
// a layout switch would set, which no server-side action can produce here.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';

const { createServer, createStreamPair } = xserver;

let server = null;
let app = null;

const KEYCODE = 38; // 'a' on an evdev keymap
const a = 0x0061;
const A = 0x0041;
const cyrillicEf = 0x06c6;
const cyrillicEF = 0x06e6;

const SHIFT = 1;
const LOCK = 2;
const group = (n) => n << 13;

before(async () => {
  server = createServer({ width: 320, height: 240 });
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);
  app = await createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
  // createClient issues GetKeyboardMapping and fills keycode2keysyms from the
  // reply, so wait for that to land before replacing a row — otherwise the
  // server's two-symbol default arrives afterwards and quietly wins
  await new Promise((resolve) => app.X.GetInputFocus(() => setImmediate(resolve)));
  // stand in for a `us,ru` keymap: four keysyms on the key, which is what
  // GetKeyboardMapping reports once a second layout is loaded
  app.X.keycode2keysyms[KEYCODE] = [a, A, cyrillicEf, cyrillicEF];
});

after(async () => {
  if (app) await app.close();
});

/** Deliver a KeyPress to `wnd` carrying `state`, and resolve with the event. */
const press = (wnd, state) =>
  new Promise((resolve) => {
    wnd.once('keydown', resolve);
    app.X.SendEvent(wnd.id, 0, 0, {
      name: 'KeyPress',
      keycode: KEYCODE,
      time: 0,
      root: app.display.screen[0].root,
      wid: wnd.id,
      child: 0,
      rootx: 0,
      rooty: 0,
      x: 0,
      y: 0,
      buttons: state,
      sameScreen: 1
    });
  });

test('a key event types the character of the active layout group', async () => {
  const wnd = app.createWindow({ width: 40, height: 40 });

  assert.equal(String.fromCodePoint((await press(wnd, 0)).codepoint), 'a');
  assert.equal(String.fromCodePoint((await press(wnd, SHIFT)).codepoint), 'A');

  // the layout switch: no keysym changed and no MappingNotify was sent, only
  // these two bits moved
  assert.equal(String.fromCodePoint((await press(wnd, group(1))).codepoint), 'ф');
  assert.equal(String.fromCodePoint((await press(wnd, group(1) | SHIFT)).codepoint), 'Ф');
  assert.equal(String.fromCodePoint((await press(wnd, group(1) | LOCK)).codepoint), 'Ф');
});

test('the event carries the keysym, the group and the shortcut keysym', async () => {
  const wnd = app.createWindow({ width: 40, height: 40 });

  const ev = await press(wnd, group(1));
  assert.equal(ev.keysym, cyrillicEf, 'what was typed');
  assert.equal(ev.baseKeysym, a, 'what a Ctrl+A accelerator should match');
  assert.equal(ev.group, 1);
});

test('an unmapped keycode leaves the event without a codepoint', async () => {
  const wnd = app.createWindow({ width: 40, height: 40 });

  const ev = await new Promise((resolve) => {
    wnd.once('keydown', resolve);
    app.X.SendEvent(wnd.id, 0, 0, {
      name: 'KeyPress',
      keycode: 250, // nothing on this keycode
      time: 0,
      root: app.display.screen[0].root,
      wid: wnd.id,
      child: 0,
      rootx: 0,
      rooty: 0,
      x: 0,
      y: 0,
      buttons: 0,
      sameScreen: 1
    });
  });
  assert.equal(ev.codepoint, undefined);
  assert.equal(ev.keysym, undefined);
});

test('keyup decodes the same way keydown does', async () => {
  // a text field that acts on keyup, or any code comparing the two, saw a
  // keysym on one and nothing on the other
  const wnd = app.createWindow({ width: 40, height: 40 });

  const ev = await new Promise((resolve) => {
    wnd.once('keyup', resolve);
    app.X.SendEvent(wnd.id, 0, 0, {
      name: 'KeyRelease',
      keycode: KEYCODE,
      time: 0,
      root: app.display.screen[0].root,
      wid: wnd.id,
      child: 0,
      rootx: 0,
      rooty: 0,
      x: 0,
      y: 0,
      buttons: group(1),
      sameScreen: 1
    });
  });
  assert.equal(String.fromCodePoint(ev.codepoint), 'ф');
  assert.equal(ev.baseKeysym, a);
});
