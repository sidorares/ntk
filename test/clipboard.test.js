// Clipboard/selection transfer, fully hermetic: several clients connect to
// node-x11's in-process X server (which routes SetSelectionOwner /
// ConvertSelection / SendEvent since x11 3.1.0) and pass text between each
// other exactly like separate processes would on a real display. Raw
// node-x11 clients play the "foreign application" roles: a STRING-only
// legacy owner, an INCR owner, a TARGETS requestor.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import x11 from 'x11';
import xserver from 'x11/lib/xserver/index.js';

import { createClient } from '../lib/index.js';

const { createServer, createStreamPair } = xserver;

let server = null;
let writer = null; // ntk app that copies
let reader = null; // ntk app that pastes
let raw = null; // plain node-x11 display for foreign-app roles

const connect = () => {
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);
  return createClient({ stream: clientEnd });
};

before(async () => {
  server = createServer({ width: 320, height: 240 });
  writer = await connect();
  reader = await connect();
  raw = (await connect()).display;
});

after(async () => {
  if (writer) await writer.close();
  if (reader) await reader.close();
  if (raw) await new Promise((resolve) => raw.client.close(resolve));
});

const atom = (X, name) =>
  new Promise((resolve, reject) =>
    X.InternAtom(false, name, (err, a) => (err ? reject(err) : resolve(a)))
  );

const getProperty = (X, wid, prop, del = 1) =>
  new Promise((resolve, reject) =>
    X.GetProperty(del, wid, prop, 0, 0, 0x1fffffff, (err, res) => (err ? reject(err) : resolve(res)))
  );

// the raw 32-byte SelectionNotify for SendEvent (same shape lib/clipboard.js builds)
const selectionNotify = (time, requestor, selection, target, property) => {
  const b = Buffer.alloc(32);
  b[0] = 31;
  b.writeUInt32LE(time >>> 0, 4);
  b.writeUInt32LE(requestor >>> 0, 8);
  b.writeUInt32LE(selection >>> 0, 12);
  b.writeUInt32LE(target >>> 0, 16);
  b.writeUInt32LE(property >>> 0, 20);
  return b;
};

const rawWindow = (display) => {
  const X = display.client;
  const wid = X.AllocID();
  X.CreateWindow(wid, display.screen[0].root, 0, 0, 1, 1, 0, 0, 0, 0, {});
  return wid;
};

test('round-trip between two clients, including non-ASCII UTF-8', async () => {
  const text = 'Hello, κόσμε! 🎉 — ntk';
  await writer.clipboard.write(text);
  assert.equal(await reader.clipboard.read(), text);
});

test('round-trip on the same connection (self paste)', async () => {
  await writer.clipboard.write('self');
  assert.equal(await writer.clipboard.read(), 'self');
});

test('empty string round-trips as empty, not an error', async () => {
  await writer.clipboard.write('');
  assert.equal(await reader.clipboard.read(), '');
});

test('PRIMARY is independent of CLIPBOARD', async () => {
  await writer.clipboard.write('for ctrl-v');
  await writer.clipboard.write('for middle click', { selection: 'PRIMARY' });
  assert.equal(await reader.clipboard.read({ selection: 'PRIMARY' }), 'for middle click');
  assert.equal(await reader.clipboard.read(), 'for ctrl-v');
});

test('read with no owner rejects with a descriptive error', async () => {
  await assert.rejects(
    reader.clipboard.read({ selection: 'NTK_TEST_UNOWNED' }),
    /no owner/
  );
});

test('ownership handover: last writer wins, loser forgets its text', async () => {
  await writer.clipboard.write('older');
  await reader.clipboard.write('newer');
  assert.equal(await writer.clipboard.read(), 'newer');
  // the server told the previous owner via SelectionClear; give the
  // notification a beat to land on the writer's connection
  const clipboardAtom = await atom(writer.X, 'CLIPBOARD');
  for (let i = 0; i < 50 && writer.clipboard._owned.has(clipboardAtom); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(writer.clipboard._owned.has(clipboardAtom), false);
});

test('TARGETS lists [TARGETS, UTF8_STRING, STRING]; unknown targets are refused', async () => {
  await writer.clipboard.write('anything');
  const X = raw.client;
  const wid = rawWindow(raw);
  const [CLIPBOARD, TARGETS, UTF8_STRING, PROP, PNG] = await Promise.all(
    ['CLIPBOARD', 'TARGETS', 'UTF8_STRING', 'NTK_TEST_PROP', 'image/png'].map((n) => atom(X, n))
  );

  const convert = (target) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no SelectionNotify')), 2000);
      const onEvent = (ev) => {
        if (ev.type !== 31 || ev.requestor !== wid) return;
        clearTimeout(timer);
        X.removeListener('event', onEvent);
        resolve(ev);
      };
      X.on('event', onEvent);
      X.ConvertSelection(wid, CLIPBOARD, target, PROP, 0);
    });

  const targetsReply = await convert(TARGETS);
  assert.equal(targetsReply.property, PROP, 'TARGETS conversion succeeds');
  const prop = await getProperty(X, wid, PROP);
  assert.equal(prop.type, X.atoms.ATOM);
  const offered = [0, 4, 8].map((o) => prop.data.readUInt32LE(o));
  assert.deepEqual(offered, [TARGETS, UTF8_STRING, X.atoms.STRING]);

  const refused = await convert(PNG);
  assert.equal(refused.property, 0, 'unsupported target refused with property None');
});

test('falls back to STRING when the owner refuses UTF8_STRING', async () => {
  const X = raw.client;
  const wid = rawWindow(raw);
  const [SELECTION, UTF8_STRING] = await Promise.all(
    ['NTK_TEST_LEGACY', 'UTF8_STRING'].map((n) => atom(X, n))
  );

  // legacy owner: STRING only, latin-1 payload
  const onRequest = (ev) => {
    if (ev.type !== 30 || ev.owner !== wid) return;
    let property = ev.property;
    if (ev.target === X.atoms.STRING) {
      X.ChangeProperty(0, ev.requestor, property, X.atoms.STRING, 8, Buffer.from('caf\xe9', 'latin1'));
    } else {
      property = 0;
    }
    X.SendEvent(ev.requestor, 0, 0, selectionNotify(ev.time, ev.requestor, ev.selection, ev.target, property));
  };
  X.on('event', onRequest);
  X.SetSelectionOwner(wid, SELECTION, 0);
  try {
    assert.notEqual(UTF8_STRING, 0, 'UTF8_STRING atom interned');
    assert.equal(await reader.clipboard.read({ selection: 'NTK_TEST_LEGACY' }), 'café');
  } finally {
    X.removeListener('event', onRequest);
  }
});

test('INCR transfer reassembles chunks split mid-codepoint', async () => {
  const X = raw.client;
  const wid = rawWindow(raw);
  const [SELECTION, UTF8_STRING, INCR] = await Promise.all(
    ['NTK_TEST_INCR', 'UTF8_STRING', 'INCR'].map((n) => atom(X, n))
  );

  const text = `${'x'.repeat(1000)}κόσμος🎉${'y'.repeat(1000)}`;
  const payload = Buffer.from(text, 'utf8');
  // deliberately split inside multibyte sequences: decode must only happen
  // after reassembly
  const chunks = [payload.subarray(0, 1001), payload.subarray(1001, 1010), payload.subarray(1010)];

  const onEvent = (ev) => {
    if (ev.type === 30 && ev.owner === wid) {
      if (ev.target !== UTF8_STRING) {
        X.SendEvent(ev.requestor, 0, 0, selectionNotify(ev.time, ev.requestor, ev.selection, ev.target, 0));
        return;
      }
      // announce INCR: property holds a lower-bound byte count; watch the
      // requestor's property deletions to pace the chunks
      X.ChangeWindowAttributes(ev.requestor, { eventMask: x11.eventMask.PropertyChange }, () => {});
      const size = Buffer.alloc(4);
      size.writeUInt32LE(payload.length, 0);
      X.ChangeProperty(0, ev.requestor, ev.property, INCR, 32, size);
      X.SendEvent(ev.requestor, 0, 0, selectionNotify(ev.time, ev.requestor, ev.selection, ev.target, ev.property));
      onEvent.pending = [...chunks, Buffer.alloc(0)];
      onEvent.transfer = { requestor: ev.requestor, property: ev.property };
    } else if (ev.type === 28 && onEvent.transfer && ev.wid === onEvent.transfer.requestor && ev.state === 1) {
      // requestor consumed (deleted) the previous value: send the next
      // chunk; the zero-length one ends the transfer
      if (ev.atom !== onEvent.transfer.property || !onEvent.pending.length) return;
      X.ChangeProperty(0, onEvent.transfer.requestor, onEvent.transfer.property, UTF8_STRING, 8, onEvent.pending.shift());
    }
  };
  X.on('event', onEvent);
  X.SetSelectionOwner(wid, SELECTION, 0);
  try {
    assert.equal(await reader.clipboard.read({ selection: 'NTK_TEST_INCR' }), text);
  } finally {
    X.removeListener('event', onEvent);
  }
});

// --- selection watching, without XFixes ------------------------------------
//
// The in-process server has no XFixes, which makes it the right place to pin
// what happens on a server that lacks it: a readable error, not a crash and
// not silence. The working path needs a real server — see
// test/selection-watch.test.js.

test('watch() explains itself on a server without XFixes', async () => {
  await assert.rejects(
    () => reader.clipboard.watch('CLIPBOARD', () => {}),
    /no XFixes extension/
  );
});

test('watch() rejects a missing handler before touching the server', async () => {
  await assert.rejects(() => reader.clipboard.watch('CLIPBOARD'), /needs a handler/);
});
