// The 'close' event: WM_DELETE_WINDOW as a question an application can
// answer, rather than a ClientMessage it has to decode.
//
// Both sides are exercised for real — a second client on the same in-process
// server plays the window manager and calls `close()`, so the protocol runs
// end to end rather than being simulated by emitting the event by hand.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource, Window } from '../lib/index.js';

let server = null;
let app = null; // the application
let wm = null; // a second client, playing the window manager

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  server = xserver.createServer({ width: 200, height: 200 });
  const mk = async () => {
    const [serverEnd, clientEnd] = xserver.createStreamPair();
    server.addClientStream(serverEnd);
    return createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
  };
  app = await mk();
  wm = await mk();
});

after(async () => {
  if (app) await app.close();
  if (wm) await wm.close();
});

/** a window with a 'close' listener, and the wm's handle on the same id */
async function pair(onClose) {
  const wnd = app.createWindow({ width: 40, height: 40 });
  wnd.on('close', onClose);
  await sleep(30); // let addProtocol's read-modify-write reach the server
  return { wnd, asWm: new Window(wm, { id: wnd.id }) };
}

describe("on('close')", () => {
  test('listening advertises WM_DELETE_WINDOW without being asked', async () => {
    // the ergonomics point: opting in is the same act as handling it
    const wnd = app.createWindow({ width: 40, height: 40 });
    assert.equal(await wnd.getProperty('WM_PROTOCOLS'), null, 'nothing advertised yet');

    wnd.on('close', () => {});
    await sleep(30);

    const protocols = await wnd.getProperty('WM_PROTOCOLS', { as: 'numbers' });
    const del = await wnd.atom('WM_DELETE_WINDOW');
    assert.ok(protocols.includes(del));
    wnd.destroy();
  });

  test('a second listener does not rewrite the property', async () => {
    const wnd = app.createWindow({ width: 40, height: 40 });
    wnd.on('close', () => {});
    wnd.on('close', () => {});
    await sleep(30);
    const protocols = await wnd.getProperty('WM_PROTOCOLS', { as: 'numbers' });
    assert.equal(protocols.length, 1, 'one atom, not one per listener');
    wnd.destroy();
  });

  test('other protocols the window declared survive', async () => {
    const wnd = app.createWindow({ width: 40, height: 40 });
    await wnd.addProtocol('WM_TAKE_FOCUS');
    wnd.on('close', () => {});
    await sleep(30);

    const protocols = await wnd.getProperty('WM_PROTOCOLS', { as: 'numbers' });
    assert.equal(protocols.length, 2);
    assert.ok(protocols.includes(await wnd.atom('WM_TAKE_FOCUS')));
    assert.ok(protocols.includes(await wnd.atom('WM_DELETE_WINDOW')));
    wnd.destroy();
  });

  test('a window manager asking politely fires it', async () => {
    let fired = 0;
    const { wnd, asWm } = await pair(() => fired++);

    assert.equal(await asWm.close(), true, 'asked rather than killed');
    await sleep(30);
    assert.equal(fired, 1);
  });

  test('the default action is to destroy the window', async () => {
    const { wnd, asWm } = await pair(() => {});
    await asWm.close();
    await sleep(30);
    assert.equal(wnd._destroyed, true);
  });

  test('preventDefault keeps the window alive', async () => {
    // an unsaved-changes dialog is exactly this, and unlike beforeunload on
    // the web, declining is entirely normal here
    let asked = 0;
    const { wnd, asWm } = await pair((ev) => {
      asked++;
      ev.preventDefault();
    });

    await asWm.close();
    await sleep(30);
    assert.equal(asked, 1);
    assert.equal(wnd._destroyed, false, 'still open');

    // and asking again still works — declining is not a one-off
    await asWm.close();
    await sleep(30);
    assert.equal(asked, 2);
    assert.equal(wnd._destroyed, false);
    wnd.destroy();
  });

  test('defaultPrevented reports what happened', async () => {
    const seen = [];
    const { wnd, asWm } = await pair((ev) => {
      seen.push(ev.defaultPrevented);
      ev.preventDefault();
      seen.push(ev.defaultPrevented);
    });
    await asWm.close();
    await sleep(30);
    assert.deepEqual(seen, [false, true]);
    wnd.destroy();
  });

  test('one listener vetoing is enough', async () => {
    const wnd = app.createWindow({ width: 40, height: 40 });
    wnd.on('close', () => {}); // indifferent
    wnd.on('close', (ev) => ev.preventDefault()); // objects
    await sleep(30);

    await new Window(wm, { id: wnd.id }).close();
    await sleep(30);
    assert.equal(wnd._destroyed, false);
    wnd.destroy();
  });

  test('the event carries the timestamp the request was stamped with', async () => {
    let ev = null;
    const { wnd, asWm } = await pair((e) => {
      ev = e;
      e.preventDefault();
    });
    await asWm.close();
    await sleep(30);
    assert.equal(typeof ev.time, 'number');
    assert.equal(ev.target, wnd);
    assert.equal(ev.window, wnd);
    wnd.destroy();
  });
});

describe("on('close') and the raw message event", () => {
  test('a message that is not WM_DELETE_WINDOW does not close anything', async () => {
    const { wnd, asWm } = await pair(() => {});
    const wmProtocols = await wnd.atom('WM_PROTOCOLS');
    const ping = await wnd.atom('_NET_WM_PING');

    // _NET_WM_PING arrives down the same WM_PROTOCOLS channel
    wm.X.SendClientMessage(wnd.id, wnd.id, wmProtocols, 32, [ping, 1, wnd.id, 0, 0], 0);
    await sleep(30);
    assert.equal(wnd._destroyed, false, 'a ping is not a close request');
    wnd.destroy();
  });

  test('a message with an unrelated type is left alone', async () => {
    const { wnd } = await pair(() => {});
    const other = await wnd.atom('_NET_WM_STATE');
    const del = await wnd.atom('WM_DELETE_WINDOW');

    wm.X.SendClientMessage(wnd.id, wnd.id, other, 32, [del, 0, 0, 0, 0], 0);
    await sleep(30);
    assert.equal(wnd._destroyed, false, 'matched on data alone, ignoring the type');
    wnd.destroy();
  });

  test('the raw message event still fires, and first', async () => {
    // apps that decoded ClientMessage themselves keep working
    const order = [];
    const wnd = app.createWindow({ width: 40, height: 40 });
    wnd.on('message', () => order.push('message'));
    wnd.on('close', (ev) => {
      order.push('close');
      ev.preventDefault();
    });
    await sleep(30);

    await new Window(wm, { id: wnd.id }).close();
    await sleep(30);
    assert.deepEqual(order, ['message', 'close']);
    wnd.destroy();
  });

  test('with no close listener nothing is destroyed behind the app’s back', async () => {
    // the pre-existing way: advertise the protocol, handle 'message' yourself
    const wnd = app.createWindow({ width: 40, height: 40 });
    await wnd.addProtocol('WM_DELETE_WINDOW');
    let messages = 0;
    wnd.on('message', () => messages++);
    await sleep(30);

    await new Window(wm, { id: wnd.id }).close();
    await sleep(30);
    assert.equal(messages, 1, 'the message arrived');
    assert.equal(wnd._destroyed, false, 'and ntk did not act on it');
    wnd.destroy();
  });
});

describe('the window manager side', () => {
  test('a window that never listened is killed rather than asked', async () => {
    const wnd = app.createWindow({ width: 40, height: 40 });
    await sleep(20);
    assert.equal(await new Window(wm, { id: wnd.id }).close(), false);
  });
});
