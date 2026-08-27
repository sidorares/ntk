// What wrapping a window costs the server, and what selectInput writes.
// X event masks are absolute per client, so a selection ntk makes on a
// window it did not create replaces whatever this connection had on it:
// adopting a window must therefore ask for nothing (issue #322), and a
// selection already held must not go out again. Hermetic — node-x11's
// in-process pure-JS X server answers the GetWindowAttributes each
// assertion reads the server's side of the story from.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import x11 from 'x11';
import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';
import Window from '../lib/window.js';

const { createServer, createStreamPair } = xserver;

let server = null;
let app = null;
let other = null; // a second connection, for the masks only one client may hold

const connect = async () => {
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);
  return createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
};

// a fresh server per test: the root's selections are per connection, and a
// leaked SubstructureRedirect would decide the next test's outcome
beforeEach(async () => {
  server = createServer({ width: 400, height: 300 });
  app = await connect();
});

afterEach(() => {
  app?.X.terminate();
  other?.X.terminate();
  server = app = other = null;
});

const maskOf = (client, wid) =>
  new Promise((resolve, reject) =>
    client.X.GetWindowAttributes(wid, (err, attrs) =>
      err ? reject(err) : resolve(attrs.myEventMasks)
    )
  );

const settle = (client) =>
  new Promise((resolve) => client.X.GetInputFocus(() => setImmediate(resolve)));

// counts the writes rather than trusting the resulting mask: a request that
// rewrites the mask it found is invisible in the attributes afterwards
const countWrites = (client) => {
  const real = client.X.ChangeWindowAttributes;
  const calls = { n: 0 };
  client.X.ChangeWindowAttributes = (...args) => {
    calls.n++;
    return real.apply(client.X, args);
  };
  calls.restore = () => {
    client.X.ChangeWindowAttributes = real;
  };
  return calls;
};

test('adopting a window selects nothing and keeps what the connection had', async () => {
  const rootId = app.display.screen[0].root;
  app.X.ChangeWindowAttributes(rootId, { eventMask: x11.eventMask.PropertyChange });
  await settle(app);

  const writes = countWrites(app);
  const root = app.rootWindow();
  await settle(app);
  writes.restore();

  assert.equal(writes.n, 0, 'wrapping a window is not a request');
  assert.equal(root.eventMask, 0, 'and ntk claims no selection of its own');
  assert.equal(
    await maskOf(app, rootId),
    x11.eventMask.PropertyChange,
    'the selection made before the adoption survives it'
  );
});

test('a created window still selects StructureNotify, and adopting it costs nothing', async () => {
  const wnd = app.createWindow({ width: 40, height: 30 });
  await settle(app);
  assert.ok(
    (await maskOf(app, wnd.id)) & x11.eventMask.StructureNotify,
    'CreateWindow carried the mask ntk needs'
  );

  const writes = countWrites(app);
  const again = new Window(app, { id: wnd.id });
  await settle(app);
  writes.restore();
  assert.equal(again, wnd, 'the same wrapper comes back');
  assert.equal(writes.n, 0);
});

test("ntk's own bookkeeping still runs on an adopted window that is listened to", async () => {
  other = await connect();
  const theirs = other.createWindow({ width: 40, height: 30 });
  await settle(other);

  const adopted = new Window(app, { id: theirs.id });
  const mapped = new Promise((resolve) => adopted.once('map', resolve));
  // the caller asking is what selects — after which the internal handlers
  // that were installed silently see the same events
  await adopted.selectInput(x11.eventMask.StructureNotify);
  theirs.map();
  await mapped;
  assert.equal(adopted._mapped, true, "the 'map' handler ran");
});

test('selectInput does not write a mask the connection already holds', async () => {
  const wnd = app.createWindow({ width: 40, height: 30 });
  await settle(app);

  const writes = countWrites(app);
  // StructureNotify came with CreateWindow, so this adds nothing
  const resolved = await wnd.selectInput(x11.eventMask.StructureNotify);
  writes.restore();

  assert.equal(writes.n, 0, 'no request for a selection already held');
  assert.equal(resolved, wnd, 'and it still resolves with the window');
});

test('selectInput writes when it adds a bit, and ORs into the rest', async () => {
  const wnd = app.createWindow({ width: 40, height: 30 });
  await wnd.selectInput(x11.eventMask.PropertyChange);

  const mask = await maskOf(app, wnd.id);
  assert.ok(mask & x11.eventMask.PropertyChange, 'the new bit');
  assert.ok(mask & x11.eventMask.StructureNotify, 'and the one it was added to');
});

test('a refused selection is not remembered as held', async () => {
  other = await connect();
  await other.rootWindow().selectInput(x11.eventMask.SubstructureRedirect);

  const root = app.rootWindow();
  const refused = (err) => err.error === 10; // BadAccess
  await assert.rejects(
    () => root.selectInput(x11.eventMask.SubstructureRedirect),
    refused,
    'another window manager owns the screen'
  );
  assert.equal(
    root.eventMask & x11.eventMask.SubstructureRedirect,
    0,
    'the bit the server refused is not in the tracked mask'
  );
  // the second ask must reach the server too — a skipped write that
  // resolved would report the role as taken when it is not
  await assert.rejects(
    () => root.selectInput(x11.eventMask.SubstructureRedirect),
    refused,
    'and asking again still asks'
  );
});

test('a handler whose selection is refused leaves the mask honest', async () => {
  other = await connect();
  await other.rootWindow().selectInput(x11.eventMask.SubstructureRedirect);

  const errors = [];
  app.options.onXError = (err) => errors.push(err);
  const root = app.rootWindow();
  root.on('map_request', () => {});
  await settle(app);

  assert.ok(errors.length > 0, 'the failure reached the app error hook');
  assert.ok(
    errors.every((err) => err.error === 10),
    'as BadAccess'
  );
  assert.equal(root.eventMask & x11.eventMask.SubstructureRedirect, 0);
  await assert.rejects(
    () => root.selectInput(x11.eventMask.SubstructureRedirect),
    (err) => err.error === 10
  );
});

// The other direction (issue #318): `on()` raises the mask and `off()` does
// not lower it, so until deselectInput there was no way to stop being sent
// an event — a window that no longer wants hover kept paying for motion for
// the rest of its life. What the API has to get right is the refusal: bits
// several event names share, and bits ntk's own machinery needs.

test('deselectInput lowers a selection nothing is listening for', async () => {
  const wnd = app.createWindow({ width: 40, height: 30 });
  await wnd.selectInput(x11.eventMask.PropertyChange);
  assert.ok((await maskOf(app, wnd.id)) & x11.eventMask.PropertyChange);

  const kept = await wnd.deselectInput(x11.eventMask.PropertyChange);

  assert.equal(kept, 0, 'nothing held it back');
  assert.equal(wnd.eventMask & x11.eventMask.PropertyChange, 0, 'gone from the tracked mask');
  assert.equal(
    (await maskOf(app, wnd.id)) & x11.eventMask.PropertyChange,
    0,
    'and from the server'
  );
  assert.ok(
    (await maskOf(app, wnd.id)) & x11.eventMask.StructureNotify,
    'the bits it was not asked about are untouched'
  );
});

test('a bit a live listener still needs is kept and reported, not cleared', async () => {
  const wnd = app.createWindow({ width: 40, height: 30 });
  const hover = () => {};
  wnd.on('mousemove', hover);
  await settle(app);
  assert.ok((await maskOf(app, wnd.id)) & x11.eventMask.PointerMotion, 'on() selected it');

  const kept = await wnd.deselectInput(x11.eventMask.PointerMotion);
  assert.equal(kept, x11.eventMask.PointerMotion, 'the refusal is the return value');
  assert.ok(
    (await maskOf(app, wnd.id)) & x11.eventMask.PointerMotion,
    'the listener would have stopped working'
  );
  assert.equal(
    x11.eventMask.PointerMotion & wnd.heldEventMask,
    x11.eventMask.PointerMotion,
    'and the same answer without making the request'
  );

  // the listener gone, the same call goes through
  wnd.off('mousemove', hover);
  assert.equal(x11.eventMask.PointerMotion & wnd.heldEventMask, 0);
  assert.equal(await wnd.deselectInput(x11.eventMask.PointerMotion), 0);
  assert.equal((await maskOf(app, wnd.id)) & x11.eventMask.PointerMotion, 0);
});

test('a bit several event names share survives until the last of them', async () => {
  const wnd = app.createWindow({ width: 40, height: 30 });
  const click = () => {};
  const scroll = () => {};
  // 'wheel' is a click of button 4-7 in the core protocol, so both names
  // are the same ButtonPress bit
  wnd.on('mousedown', click);
  wnd.on('wheel', scroll);
  await settle(app);

  wnd.off('mousedown', click);
  assert.equal(
    await wnd.deselectInput(x11.eventMask.ButtonPress),
    x11.eventMask.ButtonPress,
    "the other name's listener still needs it"
  );
  assert.ok((await maskOf(app, wnd.id)) & x11.eventMask.ButtonPress);

  wnd.off('wheel', scroll);
  assert.equal(await wnd.deselectInput(x11.eventMask.ButtonPress), 0);
  assert.equal((await maskOf(app, wnd.id)) & x11.eventMask.ButtonPress, 0);
});

test('a deselection that would change nothing is not a request', async () => {
  const wnd = app.createWindow({ width: 40, height: 30 });
  wnd.on('mousemove', () => {});
  await settle(app);

  const writes = countWrites(app);
  const unselected = await wnd.deselectInput(x11.eventMask.PropertyChange);
  const held = await wnd.deselectInput(x11.eventMask.PointerMotion);
  await settle(app);
  writes.restore();

  assert.equal(writes.n, 0, 'neither a bit that is off nor one that is spoken for');
  assert.equal(unselected, 0, 'a bit that was never selected is not "kept"');
  assert.equal(held, x11.eventMask.PointerMotion);
});

test("StructureNotify is held by ntk's own bookkeeping", async () => {
  const wnd = app.createWindow({ width: 40, height: 30 });
  await settle(app);

  // map/unmap/destroy tracking listens on every window without asking for a
  // selection — but it does need the events once they are being sent
  assert.equal(
    await wnd.deselectInput(x11.eventMask.StructureNotify),
    x11.eventMask.StructureNotify
  );
  assert.ok((await maskOf(app, wnd.id)) & x11.eventMask.StructureNotify);

  const mapped = new Promise((resolve) => wnd.once('map', resolve));
  wnd.map();
  await mapped;
  assert.equal(wnd._mapped, true);
});

test('Exposure is held while a backing store drives the redraw', async () => {
  const wnd = app.createWindow({ width: 40, height: 30 });
  wnd.getContext('2d'); // enables double buffering, which selects Exposure
  await settle(app);
  assert.ok((await maskOf(app, wnd.id)) & x11.eventMask.Exposure, 'nobody listens, ntk asked');

  assert.equal(
    await wnd.deselectInput(x11.eventMask.Exposure),
    x11.eventMask.Exposure,
    'the redraw cycle would have stopped'
  );
  assert.ok((await maskOf(app, wnd.id)) & x11.eventMask.Exposure);
});

test('a destroyed window lowers its tracked mask without a request', async () => {
  const wnd = app.createWindow({ width: 40, height: 30 });
  await wnd.selectInput(x11.eventMask.PropertyChange);
  wnd.destroy();
  await settle(app);

  const writes = countWrites(app);
  const kept = await wnd.deselectInput(x11.eventMask.PropertyChange);
  writes.restore();

  assert.equal(kept, 0);
  assert.equal(writes.n, 0, 'the window is gone — there is nothing to tell the server');
  assert.equal(wnd.eventMask & x11.eventMask.PropertyChange, 0);
});
