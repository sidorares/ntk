// setTitle() must publish both the legacy latin-1 WM_NAME and the EWMH
// UTF-8 _NET_WM_NAME. Hermetic: the in-process pure-JS X server supports
// InternAtom / ChangeProperty / GetProperty, so the round-trip is verified
// server-side.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

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

const internAtom = (name) =>
  new Promise((resolve, reject) =>
    app.X.InternAtom(false, name, (err, atom) => (err ? reject(err) : resolve(atom)))
  );

const getProperty = (wid, prop) =>
  new Promise((resolve, reject) =>
    app.X.GetProperty(0, wid, prop, 0, 0, 1000, (err, res) => (err ? reject(err) : resolve(res)))
  );

// setTitle sends _NET_WM_NAME after two InternAtom round-trips — poll until
// the property materializes server-side
async function waitForProperty(wid, prop) {
  for (let i = 0; i < 50; i++) {
    const res = await getProperty(wid, prop);
    if (res.data.length) return res;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('property never appeared');
}

test('setTitle publishes _NET_WM_NAME as UTF8_STRING alongside WM_NAME', async () => {
  const title = 'héllo — ✓ 標題';
  const wnd = app.createWindow({ width: 40, height: 30, title });

  const [netWmName, utf8String] = await Promise.all([
    internAtom('_NET_WM_NAME'),
    internAtom('UTF8_STRING')
  ]);

  const net = await waitForProperty(wnd.id, netWmName);
  assert.equal(net.type, utf8String, '_NET_WM_NAME typed as UTF8_STRING');
  assert.deepEqual(net.data, Buffer.from(title, 'utf8'), 'full UTF-8 byte sequence stored');
  assert.equal(net.data.toString('utf8'), title, 'round-trips back to the original string');

  // legacy WM_NAME is still written (latin-1, so only assert presence/type)
  const legacy = await waitForProperty(wnd.id, app.X.atoms.WM_NAME);
  assert.equal(legacy.type, app.X.atoms.STRING, 'WM_NAME kept with STRING type');
  assert.ok(legacy.data.length > 0, 'WM_NAME non-empty');
  wnd.destroy();
});

test('setTitle after creation updates both properties', async () => {
  const wnd = app.createWindow({ width: 40, height: 30, title: 'first' });
  const netWmName = await internAtom('_NET_WM_NAME');
  await waitForProperty(wnd.id, netWmName);

  wnd.setTitle('второй ✓');
  for (let i = 0; i < 50; i++) {
    const res = await getProperty(wnd.id, netWmName);
    if (res.data.equals(Buffer.from('второй ✓', 'utf8'))) {
      wnd.destroy();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('_NET_WM_NAME was not updated');
});

// the _NET_WM_NAME write trails setTitle by two InternAtom round-trips; if
// the window dies first, the stale ChangeProperty must be dropped — on a
// real server it would BadWindow, and an unhandled X error wedges the
// whole connection (this hung CI: sidorares/ntk#60)
test('destroying a window right after setTitle leaves the connection usable', async () => {
  const wnd = app.createWindow({ width: 40, height: 30, title: 'ephemeral' });
  wnd.destroy(); // before the InternAtom replies arrive

  // connection must still round-trip and serve new windows afterwards
  const survivor = app.createWindow({ width: 40, height: 30, title: 'survivor' });
  const netWmName = await internAtom('_NET_WM_NAME');
  const net = await waitForProperty(survivor.id, netWmName);
  assert.deepEqual(net.data, Buffer.from('survivor', 'utf8'));
  survivor.destroy();
});
