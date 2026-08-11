// XEmbed: the socket and the plug, driven against each other.
//
// Hermetic — node-x11's in-process pure-JS X server carries the reparenting,
// the properties and the ClientMessages, so a socket on one connection and a
// plug on another play the whole protocol out in this process with no
// external client and no display.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import x11 from 'x11';
import xserver from 'x11/lib/xserver/index.js';

import {
  XEMBED,
  XEmbedPlug,
  XEmbedSocket,
  createClient,
  decodeXEmbedInfo,
  encodeXEmbedInfo,
  StaticFontSource
} from '../lib/index.js';

const { createServer, createStreamPair } = xserver;

let server = null;
let host = null; // the embedder's connection
let guest = null; // the embedded client's connection

const connect = async () => {
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);
  return createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
};

beforeEach(async () => {
  server = createServer({ width: 400, height: 300 });
  host = await connect();
  guest = await connect();
});

afterEach(() => {
  host?.X.terminate();
  guest?.X.terminate();
  server = host = guest = null;
});

// drain the round trips a connection has in flight
const settle = (app) => new Promise((resolve) => app.X.GetInputFocus(() => setImmediate(resolve)));

const settleBoth = async () => {
  // three passes: a step on one side provokes a step on the other (a property
  // write is read back, a reparent answered with a message), and one drain
  // each only covers the first hop
  for (let i = 0; i < 3; i++) {
    await settle(guest);
    await settle(host);
  }
};

const nextEvent = (emitter, name) => new Promise((resolve) => emitter.once(name, resolve));

const queryTree = (app, wid) =>
  new Promise((resolve, reject) =>
    app.X.QueryTree(wid, (err, tree) => (err ? reject(err) : resolve(tree)))
  );

/** a host toplevel to hang sockets off, mapped so children can be viewable */
const hostToplevel = () => {
  const wnd = host.createWindow({ x: 20, y: 10, width: 200, height: 150 });
  wnd.map();
  return wnd;
};

// ---------------------------------------------------------------------
// the property and the encoding
// ---------------------------------------------------------------------

test('_XEMBED_INFO round trips, and an absent property decodes to null', () => {
  assert.deepEqual(encodeXEmbedInfo(), [XEMBED.VERSION, 0]);
  assert.deepEqual(encodeXEmbedInfo({ version: 1, mapped: true }), [1, XEMBED.MAPPED]);
  // `mapped` is the XEMBED_MAPPED bit spelled out, and wins over `flags`
  assert.deepEqual(encodeXEmbedInfo({ flags: 0xff, mapped: false }), [0, 0xfe]);

  assert.deepEqual(decodeXEmbedInfo(encodeXEmbedInfo({ version: 0, mapped: true })), {
    version: 0,
    flags: 1,
    mapped: true
  });
  assert.deepEqual(decodeXEmbedInfo([0, 0]), { version: 0, flags: 0, mapped: false });

  // a client that speaks no XEmbed sets no property: not an error, the
  // ordinary case that turns into plain reparenting
  assert.equal(decodeXEmbedInfo(null), null);
  assert.equal(decodeXEmbedInfo([]), null);
  assert.equal(decodeXEmbedInfo([0]), null, 'a one-word property is not _XEMBED_INFO');
});

test('a message carries timestamp, opcode and detail in l[0..2]', async () => {
  const parent = hostToplevel();
  const socket = new XEmbedSocket(parent, { width: 100, height: 80 });

  // a bare client window, so nothing on the guest side interprets the
  // messages before the assertions see them
  const target = guest.createWindow({ width: 100, height: 80 });
  const seen = [];
  target.on('message', (ev) => seen.push(ev));
  const xembedAtom = await target.atom('_XEMBED');
  await target.setProperty('_XEMBED_INFO', encodeXEmbedInfo({ mapped: true }), {
    type: '_XEMBED_INFO',
    format: 32
  });
  await settleBoth();

  await socket.embed(target.id);
  socket.send(XEMBED.FOCUS_IN, XEMBED.FOCUS_LAST, 0, 0, { time: 4242 });
  await settleBoth();

  assert.ok(seen.length >= 2, `expected EMBEDDED_NOTIFY and FOCUS_IN, got ${seen.length}`);
  for (const ev of seen) {
    assert.equal(ev.message_type, xembedAtom, 'message type is the _XEMBED atom');
    assert.equal(ev.format, 32);
  }

  const [embedded, focus] = seen;
  assert.equal(embedded.data[1], XEMBED.EMBEDDED_NOTIFY);
  assert.equal(embedded.data[2], 0, 'EMBEDDED_NOTIFY has no detail');
  assert.equal(embedded.data[3], socket.window.id, 'data1 is the embedder window');
  assert.equal(embedded.data[4], XEMBED.VERSION, 'data2 is the version in use');

  assert.equal(focus.data[0], 4242, 'l[0] is the timestamp');
  assert.equal(focus.data[1], XEMBED.FOCUS_IN, 'l[1] is the opcode');
  assert.equal(focus.data[2], XEMBED.FOCUS_LAST, 'l[2] is the detail');

  await socket.destroy();
});

// ---------------------------------------------------------------------
// embedding
// ---------------------------------------------------------------------

test('a socket embeds a plug: reparent, EMBEDDED_NOTIFY, and the embedder id', async () => {
  const parent = hostToplevel();
  const socket = new XEmbedSocket(parent, { width: 120, height: 90 });
  const plug = new XEmbedPlug(guest, { width: 120, height: 90 });
  await plug.ready;
  await settleBoth();

  const embedded = nextEvent(plug, 'embedded');
  const result = await socket.embed(plug.window.id);
  await settleBoth();

  assert.equal(await embedded, socket.window.id, 'the plug reports the embedder window');
  assert.equal(plug.embedder, socket.window.id);
  assert.equal(plug.xembed, true, 'EMBEDDED_NOTIFY arrived');
  assert.equal(plug.version, XEMBED.VERSION);

  assert.equal(result.xembed, true, 'the socket saw _XEMBED_INFO');
  assert.equal(result.id, plug.window.id);
  assert.equal(socket.client.id, plug.window.id);

  const tree = await queryTree(host, socket.window.id);
  assert.deepEqual(tree.children, [plug.window.id], 'the plug is a child of the socket');

  await socket.destroy();
  plug.destroy();
});

test('the plug drives its own mapped state through XEMBED_MAPPED', async () => {
  const parent = hostToplevel();
  const socket = new XEmbedSocket(parent, { width: 120, height: 90 });
  // mapped:false — the plug is not asking to be shown yet
  const plug = new XEmbedPlug(guest, { width: 120, height: 90, mapped: false });
  await plug.ready;
  await settleBoth();

  const mapped = [];
  socket.on('mappedChange', (m) => mapped.push(m));
  const shown = nextEvent(plug.window, 'map');

  await socket.embed(plug.window.id);
  await settleBoth();
  assert.deepEqual(mapped, [], 'nothing is mapped while XEMBED_MAPPED is clear');

  await plug.setMapped(true);
  await settleBoth();
  await shown;
  assert.deepEqual(mapped, [true]);

  const hidden = nextEvent(plug.window, 'unmap');
  await plug.setMapped(false);
  await settleBoth();
  await hidden;
  assert.deepEqual(mapped, [true, false], 'the socket unmaps when the bit clears');

  await socket.destroy();
  plug.destroy();
});

test('a client with no _XEMBED_INFO is mapped straight away and told nothing', async () => {
  const parent = hostToplevel();
  const socket = new XEmbedSocket(parent, { width: 120, height: 90 });

  // what `xterm -into WID` and `mpv --wid=WID` look like: an ordinary
  // unmapped toplevel, no property, no idea XEmbed exists
  const plain = guest.createWindow({ width: 120, height: 90 });
  const messages = [];
  plain.on('message', (ev) => messages.push(ev));
  const shown = nextEvent(plain, 'map');
  await settleBoth();

  const result = await socket.embed(plain.id);
  await settleBoth();
  await shown;

  assert.equal(result.xembed, false, 'plain reparenting, not XEmbed');
  assert.equal(result.version, 0);
  assert.deepEqual(messages, [], 'a client that cannot answer is not spoken to');

  const tree = await queryTree(host, socket.window.id);
  assert.deepEqual(tree.children, [plain.id]);

  await socket.destroy();
});

test('adopt() takes a window that put itself inside the socket', async () => {
  const parent = hostToplevel();
  const socket = new XEmbedSocket(parent, { x: 5, y: 7, width: 120, height: 90 });
  await settleBoth();

  // what `mpv --wid=ID` does: create the window as a child of the id it was
  // handed, rather than waiting to be reparented into it
  const waiting = socket.adopt();
  const inside = guest.createWindow({
    parent: { id: socket.window.id },
    width: 120,
    height: 90
  });
  await settleBoth();

  const result = await waiting;
  assert.equal(result.id, inside.id);
  assert.equal(result.xembed, false);
  assert.equal(socket.client.id, inside.id);
  assert.deepEqual((await queryTree(host, socket.window.id)).children, [inside.id]);

  await socket.destroy();
});

test('adopt() takes a child that is already there', async () => {
  const parent = hostToplevel();
  const socket = new XEmbedSocket(parent, { width: 120, height: 90 });
  socket.window.map();
  await settleBoth(); // the container has to exist before anyone parents to it
  const inside = guest.createWindow({
    parent: { id: socket.window.id },
    width: 10,
    height: 10
  });
  await settleBoth();

  const result = await socket.adopt();
  await settleBoth();
  assert.equal(result.id, inside.id);

  // and a socket with nothing in it says what to check rather than hanging
  const empty = new XEmbedSocket(parent, { width: 10, height: 10 });
  await assert.rejects(() => empty.adopt({ timeout: 30 }), /--wid=ID/);

  await socket.destroy();
  await empty.destroy();
});

test('a resize reaches the client as a synthetic ConfigureNotify in root coordinates', async () => {
  const parent = hostToplevel(); // at 20,10 on the root
  const socket = new XEmbedSocket(parent, { x: 5, y: 7, width: 120, height: 90 });
  // coalesceEvents:false — ntk merges resize bursts into one per paced frame,
  // and this test is about what is on the wire, not about frame pacing
  const plain = guest.createWindow({ width: 120, height: 90, coalesceEvents: false });
  await settleBoth();

  const configures = [];
  plain.on('resize', (ev) => configures.push(ev));

  await socket.embed(plain.id);
  await settleBoth();
  await socket.resize({ x: 9, y: 11, width: 60, height: 40 });
  await settleBoth();

  const last = configures.at(-1);
  assert.ok(last, 'the client heard about the resize');
  assert.equal(last.width, 60);
  assert.equal(last.height, 40);
  // ICCCM 4.1.5: a reparented client's own ConfigureNotify is relative to the
  // socket, which is not the question it asked. The synthetic one is on the
  // root: parent (20,10) + socket (9,11).
  assert.equal(last.x, 29);
  assert.equal(last.y, 21);

  await socket.destroy();
});

// ---------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------

test('a destroyed client makes the socket say gone, exactly once', async () => {
  const parent = hostToplevel();
  const socket = new XEmbedSocket(parent, { width: 120, height: 90 });
  const plain = guest.createWindow({ width: 120, height: 90 });
  await settleBoth();
  await socket.embed(plain.id);
  await settleBoth();

  let gone = 0;
  socket.on('gone', () => gone++);
  plain.destroy();
  await settleBoth();

  assert.equal(gone, 1);
  assert.equal(socket.client, null);

  // release() must not reparent a window the server has already freed — a
  // BadWindow here would be an X error with nobody to catch it
  const errors = [];
  host.options.onXError = (err) => errors.push(err);
  await socket.destroy();
  await settle(host);
  assert.deepEqual(errors, []);
});

test('release puts the client back under the root', async () => {
  const parent = hostToplevel();
  const socket = new XEmbedSocket(parent, { x: 5, y: 7, width: 120, height: 90 });
  const plain = guest.createWindow({ width: 120, height: 90 });
  await settleBoth();
  await socket.embed(plain.id);
  await settleBoth();

  const root = host.display.screen[0].root;
  assert.deepEqual((await queryTree(host, socket.window.id)).children, [plain.id]);

  await socket.release();
  await settleBoth();

  assert.equal(socket.client, null);
  const tree = await queryTree(host, plain.id);
  assert.equal(tree.parent, root, 'the client is a toplevel again');
  // put back where it was on screen: parent (20,10) + socket (5,7)
  const geometry = await new Promise((resolve, reject) =>
    guest.X.GetGeometry(plain.id, (err, g) => (err ? reject(err) : resolve(g)))
  );
  assert.equal(geometry.xPos, 25);
  assert.equal(geometry.yPos, 17);

  await socket.destroy();
});

// ---------------------------------------------------------------------
// focus
// ---------------------------------------------------------------------

test('activation and focus arrive at the plug in the order they were sent', async () => {
  const parent = hostToplevel();
  const socket = new XEmbedSocket(parent, { width: 120, height: 90 });
  const plug = new XEmbedPlug(guest, { width: 120, height: 90 });
  await plug.ready;
  await settleBoth();

  const order = [];
  for (const name of ['activate', 'deactivate', 'focusOut', 'modality']) {
    plug.on(name, () => order.push(name));
  }
  plug.on('focusIn', (detail) => order.push(`focusIn:${detail}`));

  await socket.embed(plug.window.id);
  await settleBoth();
  // before any message the client is inactive, unfocused and not modal
  assert.deepEqual(order, []);
  assert.equal(plug.active, false);
  assert.equal(plug.focused, false);

  socket.activate();
  socket.focusIn(XEMBED.FOCUS_FIRST);
  await settleBoth();
  assert.deepEqual(order, ['activate', 'focusIn:1']);
  assert.equal(plug.active, true);
  assert.equal(plug.focused, true);

  socket.focusOut();
  socket.deactivate();
  socket.modality(true);
  await settleBoth();
  assert.deepEqual(order, ['activate', 'focusIn:1', 'focusOut', 'deactivate', 'modality']);
  assert.equal(plug.focused, false);
  assert.equal(plug.active, false);
  assert.equal(plug.modal, true);

  await socket.destroy();
  plug.destroy();
});

test('the plug can ask for focus, and the socket answers with FOCUS_IN', async () => {
  const parent = hostToplevel();
  const socket = new XEmbedSocket(parent, { width: 120, height: 90 });
  const plug = new XEmbedPlug(guest, { width: 120, height: 90 });
  await plug.ready;
  await settleBoth();
  await socket.embed(plug.window.id);
  await settleBoth();

  const asked = nextEvent(socket, 'requestFocus');
  const focused = nextEvent(plug, 'focusIn');
  plug.requestFocus();
  await settleBoth();
  await asked;
  assert.equal(await focused, XEMBED.FOCUS_CURRENT);
  assert.equal(socket.focused, true);

  // and the tab chain running off the end comes back as an event
  const next = nextEvent(socket, 'focusNext');
  plug.focusNext();
  await settleBoth();
  await next;

  await socket.destroy();
  plug.destroy();
});

test('the focus proxy holds the X focus and forwards keys into the client', async () => {
  const parent = hostToplevel();
  const socket = new XEmbedSocket(parent, { width: 120, height: 90 });
  const plug = new XEmbedPlug(guest, { width: 120, height: 90, mapped: true });
  await plug.ready;
  await settleBoth();
  await socket.embed(plug.window.id);
  await settleBoth();

  const keys = [];
  plug.window.on('keydown', (ev) => keys.push(ev));

  socket.activate();
  socket.focusIn(XEMBED.FOCUS_CURRENT);
  await settleBoth();

  const proxy = socket._proxy;
  assert.ok(proxy, 'focusIn brought up a focus proxy');
  const focus = await new Promise((resolve, reject) =>
    host.X.GetInputFocus((err, res) => (err ? reject(err) : resolve(res)))
  );
  assert.equal(focus.focus, proxy.window.id, 'the real X focus is on the proxy');

  // a keystroke the way the server would deliver it: to whatever holds focus
  guest.X.SendEvent(proxy.window.id, 0, x11.eventMask.KeyPress, {
    name: 'KeyPress',
    keycode: 38,
    time: 1234,
    root: host.display.screen[0].root,
    wid: proxy.window.id,
    child: 0,
    rootx: 1,
    rooty: 2,
    x: 1,
    y: 2,
    buttons: 0,
    sameScreen: 1
  });
  await settleBoth();

  assert.equal(keys.length, 1, 'the proxy forwarded it into the client');
  assert.equal(keys[0].keycode, 38);
  assert.equal(keys[0].wid, plug.window.id, 're-addressed to the client window');

  // and once focus goes away, nothing is forwarded any more
  socket.focusOut();
  await settleBoth();
  guest.X.SendEvent(proxy.window.id, 0, x11.eventMask.KeyPress, {
    name: 'KeyPress',
    keycode: 39,
    time: 1235,
    root: host.display.screen[0].root,
    wid: proxy.window.id,
    child: 0,
    rootx: 1,
    rooty: 2,
    x: 1,
    y: 2,
    buttons: 0,
    sameScreen: 1
  });
  await settleBoth();
  assert.equal(keys.length, 1);

  await socket.destroy();
  plug.destroy();
});

test('a plug reparented back to the root ends the protocol', async () => {
  const parent = hostToplevel();
  const socket = new XEmbedSocket(parent, { width: 120, height: 90 });
  const plug = new XEmbedPlug(guest, { width: 120, height: 90 });
  await plug.ready;
  await settleBoth();
  await socket.embed(plug.window.id);
  await settleBoth();
  socket.activate();
  await settleBoth();
  assert.equal(plug.active, true);

  const released = nextEvent(plug, 'released');
  await socket.release();
  await settleBoth();
  await released;

  assert.equal(plug.embedder, 0);
  assert.equal(plug.active, false, 'state goes back to what it was before embedding');
  assert.equal(plug.xembed, false);

  await socket.destroy();
  plug.destroy();
});
