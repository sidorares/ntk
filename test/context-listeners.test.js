// A context takes back what it put on its drawable when it is destroyed.
//
// Every 2d context listens on its window or pixmap for a new backing, a
// resize and destruction, and `destroy()` left all three listening. A
// surface drawn through `render()` gets a fresh context a call, so each call
// left three closures on the pixmap, and the dead context behind them, for
// as long as the surface lived: a fade redraws its group surface every
// frame, a graph its grid tile every pan step.
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource, Surface } from '../lib/index.js';

let app = null;

before(async () => {
  const server = xserver.createServer({ width: 200, height: 200 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  app = await createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
});

after(async () => {
  if (app) await app.close();
});

const listening = (drawable) =>
  ['_backing', 'resize', '_destroyed'].map((name) => drawable.listenerCount(name));

test('a surface drawn many times holds no listener for the contexts it drew with', () => {
  const surface = new Surface(app, { width: 16, height: 16 });
  const before = listening(surface.pixmap);
  for (let i = 0; i < 25; i++) {
    surface.render((ctx) => {
      ctx.fillStyle = 'red';
      ctx.fillRect(0, 0, 8, 8);
    });
  }
  assert.deepEqual(listening(surface.pixmap), before);
  surface.destroy();
});

test('window contexts destroyed take their listeners off the window', () => {
  const win = app.createWindow({ width: 40, height: 30 });
  // the first context also sets up the window's backing store, which keeps
  // a resize listener of its own for as long as the window lives
  win.getContext('2d').destroy();
  const before = listening(win);
  for (let i = 0; i < 12; i++) {
    const ctx = win.getContext('2d');
    ctx.destroy();
    ctx.destroy(); // twice is once
  }
  assert.deepEqual(listening(win), before);
  win.destroy?.();
});
