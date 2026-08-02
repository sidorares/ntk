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

const rawWindow = (display, eventMask = 0) => {
  const X = display.client;
  const wid = X.AllocID();
  X.CreateWindow(wid, display.screen[0].root, 0, 0, 1, 1, 0, 0, 0, 0, { eventMask });
  return wid;
};

// ConvertSelection from a raw client and wait for the owner's answer
const rawConvert = (X, wid, selection, target, property) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      X.removeListener('event', onEvent);
      reject(new Error('no SelectionNotify'));
    }, 2000);
    const onEvent = (ev) => {
      if (ev.type !== 31 || ev.requestor !== wid || ev.target !== target) return;
      clearTimeout(timer);
      X.removeListener('event', onEvent);
      resolve(ev);
    };
    X.on('event', onEvent);
    X.ConvertSelection(wid, selection, target, property, 0);
  });

// the requestor half of ICCCM 2.7.2: collect chunks until a zero-length one.
// Call before deleting the INCR property — that delete starts the transfer.
const rawIncrRead = (X, wid, prop) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    const finish = (err, data) => {
      clearTimeout(timer);
      X.removeListener('event', onEvent);
      return err ? reject(err) : resolve(data);
    };
    const timer = setTimeout(() => finish(new Error('INCR transfer stalled')), 4000);
    const onEvent = (ev) => {
      if (ev.type !== 28 || ev.wid !== wid || ev.atom !== prop || ev.state !== 0) return;
      // delete=1 is the "next chunk please" handshake
      X.GetProperty(1, wid, prop, 0, 0, 0x1fffffff, (err, res) => {
        if (err) return finish(err);
        if (res.data.length === 0) return finish(null, Buffer.concat(chunks));
        chunks.push(res.data);
      });
    };
    X.on('event', onEvent);
  });

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

test('TARGETS lists the required three plus the text targets; unknown ones are refused', async () => {
  await writer.clipboard.write('anything');
  const X = raw.client;
  const wid = rawWindow(raw);
  const [CLIPBOARD, TARGETS, TIMESTAMP, MULTIPLE, UTF8_STRING, PROP, PNG] = await Promise.all(
    [
      'CLIPBOARD',
      'TARGETS',
      'TIMESTAMP',
      'MULTIPLE',
      'UTF8_STRING',
      'NTK_TEST_PROP',
      'image/png'
    ].map((n) => atom(X, n))
  );
  const convert = (target) => rawConvert(X, wid, CLIPBOARD, target, PROP);

  const targetsReply = await convert(TARGETS);
  assert.equal(targetsReply.property, PROP, 'TARGETS conversion succeeds');
  const prop = await getProperty(X, wid, PROP);
  assert.equal(prop.type, X.atoms.ATOM);
  const offered = [];
  for (let o = 0; o < prop.data.length; o += 4) offered.push(prop.data.readUInt32LE(o));
  assert.deepEqual(offered, [TARGETS, TIMESTAMP, MULTIPLE, UTF8_STRING, X.atoms.STRING]);

  const refused = await convert(PNG);
  assert.equal(refused.property, 0, 'unsupported target refused with property None');
});

test('TIMESTAMP answers the ownership time, which is never CurrentTime', async () => {
  const X = raw.client;
  const wid = rawWindow(raw);
  const [CLIPBOARD, TIMESTAMP, PROP] = await Promise.all(
    ['CLIPBOARD', 'TIMESTAMP', 'NTK_TEST_PROP'].map((n) => atom(X, n))
  );

  await writer.clipboard.write('stamped');
  const owned = writer.clipboard._owned.get(await atom(writer.X, 'CLIPBOARD'));
  // ICCCM 2.1 forbids acquiring with CurrentTime; with no event timestamp
  // to hand, ntk asks the server for one
  assert.notEqual(owned.time, 0, 'ownership acquired with a real timestamp');

  const reply = await rawConvert(X, wid, CLIPBOARD, TIMESTAMP, PROP);
  assert.equal(reply.property, PROP, 'TIMESTAMP conversion succeeds');
  const prop = await getProperty(X, wid, PROP);
  assert.equal(prop.type, X.atoms.INTEGER);
  assert.equal(prop.data.readUInt32LE(0), owned.time);

  // an explicit event timestamp (what a toolkit routing key events has) wins
  await writer.clipboard.write('stamped by the caller', {
    selection: 'NTK_TEST_STAMP',
    time: 4242
  });
  const stamped = await rawConvert(
    X,
    wid,
    await atom(X, 'NTK_TEST_STAMP'),
    TIMESTAMP,
    PROP
  );
  assert.equal(stamped.property, PROP);
  assert.equal((await getProperty(X, wid, PROP)).data.readUInt32LE(0), 4242);
});

test('MULTIPLE converts every pair it can and marks the rest None', async () => {
  await writer.clipboard.write('multi');
  const X = raw.client;
  const wid = rawWindow(raw);
  const [CLIPBOARD, MULTIPLE, UTF8_STRING, ATOM_PAIR, LIST, P1, P2, PNG] = await Promise.all(
    [
      'CLIPBOARD',
      'MULTIPLE',
      'UTF8_STRING',
      'ATOM_PAIR',
      'NTK_TEST_LIST',
      'NTK_TEST_P1',
      'NTK_TEST_P2',
      'image/png'
    ].map((n) => atom(X, n))
  );

  // (UTF8_STRING -> P1) can be converted, (image/png -> P2) cannot
  X.ChangeProperty(0, wid, LIST, ATOM_PAIR, 32, [UTF8_STRING, P1, PNG, P2]);
  const reply = await rawConvert(X, wid, CLIPBOARD, MULTIPLE, LIST);
  assert.equal(reply.property, LIST, 'MULTIPLE itself is not refused');

  const list = await getProperty(X, wid, LIST);
  assert.equal(list.data.readUInt32LE(4), P1, 'converted pair keeps its property');
  assert.equal(list.data.readUInt32LE(12), 0, 'unconvertible pair comes back as None');

  assert.equal((await getProperty(X, wid, P1)).data.toString('utf8'), 'multi');
  assert.equal((await getProperty(X, wid, P2)).type, 0, 'nothing written for the refused pair');
});

test('a payload over the transfer limit is served with INCR', async () => {
  const clipboard = writer.clipboard;
  const X = raw.client;
  const wid = rawWindow(raw, x11.eventMask.PropertyChange);
  const [CLIPBOARD, UTF8_STRING, INCR, PROP] = await Promise.all(
    ['CLIPBOARD', 'UTF8_STRING', 'INCR', 'NTK_TEST_INCR_PROP'].map((n) => atom(X, n))
  );

  const text = `${'a'.repeat(5000)}κόσμος🎉${'b'.repeat(5000)}`;
  const payload = Buffer.from(text, 'utf8');
  clipboard._transferLimit = 64; // instead of copying a quarter of a megabyte
  try {
    await clipboard.write(text);
    const reply = await rawConvert(X, wid, CLIPBOARD, UTF8_STRING, PROP);
    assert.equal(reply.property, PROP);

    const collecting = rawIncrRead(X, wid, PROP);
    const first = await getProperty(X, wid, PROP); // delete=1 starts the transfer
    assert.equal(first.type, INCR, 'answered with INCR, not the data itself');
    assert.equal(first.data.readUInt32LE(0), payload.length, 'INCR carries the byte count');
    assert.deepEqual(await collecting, payload);
    // the owner closes the transfer when the empty property it ended with
    // is deleted, one notification behind the requestor
    for (let i = 0; i < 50 && clipboard._transfers.size; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(clipboard._transfers.size, 0, 'transfer released');
    // and gives back the event mask it selected to pace the chunks
    const attrs = await new Promise((resolve, reject) =>
      writer.X.GetWindowAttributes(wid, (err, a) => (err ? reject(err) : resolve(a)))
    );
    assert.equal(attrs.myEventMasks, 0, 'requestor window left as it was found');
  } finally {
    clipboard._transferLimit = null;
  }
});

test('an INCR write round-trips through ntk read(), twice on one helper window', async () => {
  const clipboard = writer.clipboard;
  const text = `${'x'.repeat(4000)}κόσμε${'y'.repeat(4000)}`;
  clipboard._transferLimit = 100;
  try {
    await clipboard.write(text);
    assert.equal(await reader.clipboard.read(), text, 'INCR write -> INCR read across clients');
    // the second paste only works if the first restored PropertyChange on
    // the requestor's window (here: another ntk client's helper window)
    assert.equal(await reader.clipboard.read(), text, 'and again');
    // owner and requestor on one connection: the requestor window is ntk's
    // own, whose event mask the transfer must not clear
    assert.equal(await clipboard.read(), text, 'self paste over INCR');
    assert.equal(await clipboard.read(), text, 'and again');
  } finally {
    clipboard._transferLimit = null;
  }
});

test('a copy larger than one X request pastes (the real, uncapped threshold)', async () => {
  // the bug this guards: one ChangeProperty cannot carry more than 65535
  // four-byte units, and the request never reached the server at all — the
  // paste came back empty with no error on either side
  const text = `${'z'.repeat(300000)}κόσμε`;
  await writer.clipboard.write(text);
  assert.ok(
    Buffer.byteLength(text) > writer.clipboard._limit(),
    'payload is over the single-request limit'
  );
  assert.equal(await reader.clipboard.read(), text);
});

test('MULTIPLE carries INCR pairs, and the requestor window is released once', async () => {
  const clipboard = writer.clipboard;
  const X = raw.client;
  const wid = rawWindow(raw, x11.eventMask.PropertyChange);
  const [CLIPBOARD, MULTIPLE, ATOM_PAIR, INCR, HTML, PNG, LIST, P1, P2] = await Promise.all(
    [
      'CLIPBOARD',
      'MULTIPLE',
      'ATOM_PAIR',
      'INCR',
      'text/html',
      'image/png',
      'NTK_TEST_MLIST',
      'NTK_TEST_MP1',
      'NTK_TEST_MP2'
    ].map((n) => atom(X, n))
  );

  const html = `<p>${'h'.repeat(3000)}</p>`;
  const png = Buffer.alloc(3000, 0xa7);
  clipboard._transferLimit = 64;
  try {
    await clipboard.write({ 'text/html': html, 'image/png': png });
    X.ChangeProperty(0, wid, LIST, ATOM_PAIR, 32, [HTML, P1, PNG, P2]);
    const reply = await rawConvert(X, wid, CLIPBOARD, MULTIPLE, LIST);
    assert.equal(reply.property, LIST);

    const list = await getProperty(X, wid, LIST);
    assert.deepEqual(
      [list.data.readUInt32LE(4), list.data.readUInt32LE(12)],
      [P1, P2],
      'both pairs accepted'
    );

    const collecting = [rawIncrRead(X, wid, P1), rawIncrRead(X, wid, P2)];
    const [firstHtml, firstPng] = await Promise.all([
      getProperty(X, wid, P1),
      getProperty(X, wid, P2)
    ]);
    assert.equal(firstHtml.type, INCR);
    assert.equal(firstPng.type, INCR);
    const [gotHtml, gotPng] = await Promise.all(collecting);
    assert.equal(gotHtml.toString('utf8'), html);
    assert.deepEqual(gotPng, png);

    for (let i = 0; i < 50 && clipboard._transfers.size; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(clipboard._transfers.size, 0, 'both transfers released');
    assert.equal(clipboard._watched.size, 0, 'and the window watched for them only once');
  } finally {
    clipboard._transferLimit = null;
  }
});

test('two INCR conversions at once share one watch on the requestor', async () => {
  const clipboard = writer.clipboard;
  const X = raw.client;
  const wid = rawWindow(raw, x11.eventMask.PropertyChange);
  const [CLIPBOARD, HTML, PNG, P1, P2] = await Promise.all(
    ['CLIPBOARD', 'text/html', 'image/png', 'NTK_TEST_CP1', 'NTK_TEST_CP2'].map((n) => atom(X, n))
  );

  // lopsided on purpose: the short one is done long before the long one,
  // and must not take the window's event mask with it when it goes
  const html = `<p>${'c'.repeat(200)}</p>`;
  const png = Buffer.alloc(12000, 0x5c);
  clipboard._transferLimit = 64;
  try {
    await clipboard.write({ 'text/html': html, 'image/png': png });
    // ICCCM allows concurrent conversions as long as they use different
    // properties; both answers are INCR, so both want PropertyChange here
    const replies = await Promise.all([
      rawConvert(X, wid, CLIPBOARD, HTML, P1),
      rawConvert(X, wid, CLIPBOARD, PNG, P2)
    ]);
    assert.deepEqual(
      replies.map((r) => r.property),
      [P1, P2]
    );

    const collecting = [rawIncrRead(X, wid, P1), rawIncrRead(X, wid, P2)];
    await Promise.all([getProperty(X, wid, P1), getProperty(X, wid, P2)]);
    const [gotHtml, gotPng] = await Promise.all(collecting);
    assert.equal(gotHtml.toString('utf8'), html);
    assert.deepEqual(gotPng, png);

    for (let i = 0; i < 50 && clipboard._watched.size; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // one transfer finishing must not stop pacing the other, and the last
    // one out gives the window back
    assert.equal(clipboard._watched.size, 0, 'watch released exactly once');
  } finally {
    clipboard._transferLimit = null;
  }
});

test('write() offers arbitrary targets, including binary ones', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f]);
  await writer.clipboard.write({
    'text/plain;charset=utf-8': 'hello',
    'text/html': '<b>hello</b>',
    'image/png': png
  });

  const X = raw.client;
  const wid = rawWindow(raw);
  const [CLIPBOARD, TARGETS, TIMESTAMP, MULTIPLE, PLAIN, HTML, PNG, PROP, UTF8_STRING] =
    await Promise.all(
      [
        'CLIPBOARD',
        'TARGETS',
        'TIMESTAMP',
        'MULTIPLE',
        'text/plain;charset=utf-8',
        'text/html',
        'image/png',
        'NTK_TEST_PROP',
        'UTF8_STRING'
      ].map((n) => atom(X, n))
    );

  const targetsReply = await rawConvert(X, wid, CLIPBOARD, TARGETS, PROP);
  assert.equal(targetsReply.property, PROP);
  const list = await getProperty(X, wid, PROP);
  const offered = [];
  for (let o = 0; o < list.data.length; o += 4) offered.push(list.data.readUInt32LE(o));
  assert.deepEqual(
    offered,
    [TARGETS, TIMESTAMP, MULTIPLE, PLAIN, HTML, PNG],
    'the required three, then what the caller offered, in order'
  );

  assert.equal((await rawConvert(X, wid, CLIPBOARD, HTML, PROP)).property, PROP);
  assert.equal((await getProperty(X, wid, PROP)).data.toString('utf8'), '<b>hello</b>');

  const pngReply = await rawConvert(X, wid, CLIPBOARD, PNG, PROP);
  assert.equal(pngReply.property, PROP);
  const pngProp = await getProperty(X, wid, PROP);
  assert.equal(pngProp.type, PNG, 'served with the target as its type');
  assert.deepEqual(pngProp.data, png, 'bytes survive untouched');

  // offering formats explicitly means exactly those formats
  assert.equal(
    (await rawConvert(X, wid, CLIPBOARD, UTF8_STRING, PROP)).property,
    0,
    'UTF8_STRING was not offered, so it is refused'
  );
});

test('write() rejects payloads it cannot name a target for', async () => {
  await assert.rejects(writer.clipboard.write(Buffer.from('png')), /needs a target name/);
  await assert.rejects(writer.clipboard.write({}), /at least one target/);
  await assert.rejects(writer.clipboard.write({ TARGETS: 'no' }), /answered by ntk/);
  await assert.rejects(writer.clipboard.write({ 'text/html': 42 }), /string or binary/);
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
// --- reading what multi-format write publishes -----------------------------
//
// write() has offered arbitrary targets since this change; these are the
// other half, so an ntk app can get back what an ntk app put there.

test('targets() lists what the owner offers', async () => {
  await writer.clipboard.write({
    'text/plain;charset=utf-8': 'hi',
    'text/html': '<b>hi</b>',
    'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47])
  });
  const offered = await reader.clipboard.targets();
  for (const name of ['text/plain;charset=utf-8', 'text/html', 'image/png']) {
    assert.ok(offered.includes(name), `${name} offered, got ${offered.join(', ')}`);
  }
  // the three ntk answers for itself are advertised too, per ICCCM 2.6.2
  for (const name of ['TARGETS', 'TIMESTAMP', 'MULTIPLE']) {
    assert.ok(offered.includes(name), `${name} advertised`);
  }
});

test('targets() is empty when nothing owns the selection', async () => {
  const offered = await reader.clipboard.targets({ selection: 'NTK_UNOWNED_SELECTION' });
  assert.deepEqual(offered, []);
});

test('read({ target }) returns that target as bytes', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await writer.clipboard.write({ 'image/png': png, 'text/html': '<b>hi</b>' });

  const back = await reader.clipboard.read({ target: 'image/png' });
  assert.ok(Buffer.isBuffer(back), 'binary targets come back as bytes');
  assert.deepEqual(back, png);

  const html = await reader.clipboard.read({ target: 'text/html' });
  assert.equal(html.toString('utf8'), '<b>hi</b>');
});

test('read({ target }) survives an INCR-sized payload', async () => {
  const big = Buffer.alloc(300000);
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
  await writer.clipboard.write({ 'application/octet-stream': big });
  const back = await reader.clipboard.read({ target: 'application/octet-stream' });
  assert.equal(back.length, big.length);
  assert.ok(back.equals(big), 'every byte survives the chunking');
});

test('read({ target }) says which target the owner could not convert', async () => {
  await writer.clipboard.write('just text');
  await assert.rejects(
    () => reader.clipboard.read({ target: 'image/png' }),
    /cannot convert to image\/png/
  );
});

// --- conversion timestamps (ICCCM 2.4) -------------------------------------
//
// A requestor should convert with the timestamp of the event that asked for
// the data, not CurrentTime. The owner sees it on its SelectionRequest, so a
// raw client playing owner can assert what went over the wire. Note the
// server substitutes its own clock for a zero time, which is what makes the
// default distinguishable from an explicit one.

// A raw selection owner that records the timestamp of every request it gets.
// `serve(ev)` returns { type, data } to answer with, or null to refuse.
const recordingOwner = (X, wid, serve) => {
  const requests = [];
  const onRequest = (ev) => {
    if (ev.type !== 30 || ev.owner !== wid) return;
    requests.push({ target: ev.target, time: ev.time });
    const payload = serve(ev);
    let property = ev.property;
    if (payload) {
      X.ChangeProperty(0, ev.requestor, property, payload.type, 8, payload.data);
    } else {
      property = 0;
    }
    X.SendEvent(
      ev.requestor,
      0,
      0,
      selectionNotify(ev.time, ev.requestor, ev.selection, ev.target, property)
    );
  };
  X.on('event', onRequest);
  return { requests, stop: () => X.removeListener('event', onRequest) };
};

const PASTE_TIME = 0x3ade68b1; // a timestamp no server clock will coincide with

test('read({ time }) converts with that timestamp, and without one with CurrentTime', async () => {
  const X = raw.client;
  const wid = rawWindow(raw);
  const [SELECTION, UTF8_STRING] = await Promise.all(
    ['NTK_TEST_CONVERT_TIME', 'UTF8_STRING'].map((n) => atom(X, n))
  );
  const owner = recordingOwner(X, wid, (ev) =>
    ev.target === UTF8_STRING ? { type: UTF8_STRING, data: Buffer.from('stamped', 'utf8') } : null
  );
  X.SetSelectionOwner(wid, SELECTION, 0);
  try {
    assert.equal(
      await reader.clipboard.read({ selection: 'NTK_TEST_CONVERT_TIME', time: PASTE_TIME }),
      'stamped'
    );
    assert.equal(owner.requests.length, 1);
    assert.equal(owner.requests[0].time, PASTE_TIME, 'the paste timestamp reaches the owner');

    // no time: still CurrentTime, which the server replaces with its own
    // clock — so the owner sees a real stamp, just not the caller's
    await reader.clipboard.read({ selection: 'NTK_TEST_CONVERT_TIME' });
    assert.equal(owner.requests.length, 2);
    assert.notEqual(owner.requests[1].time, PASTE_TIME, 'the option is what carries it');
  } finally {
    owner.stop();
  }
});

test('the STRING retry is the same paste, so it reuses its timestamp', async () => {
  const X = raw.client;
  const wid = rawWindow(raw);
  const [SELECTION, UTF8_STRING] = await Promise.all(
    ['NTK_TEST_RETRY_TIME', 'UTF8_STRING'].map((n) => atom(X, n))
  );
  // a legacy owner: refuses UTF8_STRING, so read() falls back to STRING
  const owner = recordingOwner(X, wid, (ev) =>
    ev.target === X.atoms.STRING
      ? { type: X.atoms.STRING, data: Buffer.from('caf\xe9', 'latin1') }
      : null
  );
  X.SetSelectionOwner(wid, SELECTION, 0);
  try {
    assert.equal(
      await reader.clipboard.read({ selection: 'NTK_TEST_RETRY_TIME', time: PASTE_TIME }),
      'café'
    );
    assert.deepEqual(
      owner.requests.map((r) => r.target),
      [UTF8_STRING, X.atoms.STRING],
      'refused UTF8_STRING, then retried as STRING'
    );
    assert.deepEqual(
      owner.requests.map((r) => r.time),
      [PASTE_TIME, PASTE_TIME],
      'both halves of one paste carry its timestamp'
    );
  } finally {
    owner.stop();
  }
});

test('targets({ time }) and read({ target, time }) carry it too', async () => {
  const X = raw.client;
  const wid = rawWindow(raw);
  const [SELECTION, TARGETS, PNG] = await Promise.all(
    ['NTK_TEST_TARGETS_TIME', 'TARGETS', 'image/png'].map((n) => atom(X, n))
  );
  const owner = recordingOwner(X, wid, (ev) => {
    if (ev.target === TARGETS) {
      const list = Buffer.alloc(4);
      list.writeUInt32LE(PNG, 0);
      // format 32 for an ATOM list; ChangeProperty's format follows the type
      X.ChangeProperty(0, ev.requestor, ev.property, X.atoms.ATOM, 32, list);
      X.SendEvent(
        ev.requestor,
        0,
        0,
        selectionNotify(ev.time, ev.requestor, ev.selection, ev.target, ev.property)
      );
      return undefined; // already answered
    }
    return ev.target === PNG ? { type: PNG, data: Buffer.from([0x89, 0x50]) } : null;
  });
  X.SetSelectionOwner(wid, SELECTION, 0);
  try {
    const offered = await reader.clipboard.targets({
      selection: 'NTK_TEST_TARGETS_TIME',
      time: PASTE_TIME
    });
    assert.deepEqual(offered, ['image/png']);
    await reader.clipboard.read({
      selection: 'NTK_TEST_TARGETS_TIME',
      target: 'image/png',
      time: PASTE_TIME
    });
    assert.deepEqual(
      owner.requests.map((r) => r.time),
      [PASTE_TIME, PASTE_TIME]
    );
  } finally {
    owner.stop();
  }
});

// --- giving a selection back (ICCCM 2.3.1) ---------------------------------

test('clear() releases the selection, and a paste then finds no owner', async () => {
  await writer.clipboard.write('temporary');
  assert.equal(await reader.clipboard.read(), 'temporary');

  await writer.clipboard.clear();
  await assert.rejects(() => reader.clipboard.read(), /no owner/);
  const sel = await atom(writer.X, 'CLIPBOARD');
  assert.equal(writer.clipboard._owned.has(sel), false, 'and it stops answering for it');
});

test('clear() gives up one selection, not every selection', async () => {
  await writer.clipboard.write('for ctrl-v');
  await writer.clipboard.write('for middle click', { selection: 'PRIMARY' });

  await writer.clipboard.clear();

  await assert.rejects(() => reader.clipboard.read(), /no owner/);
  assert.equal(await reader.clipboard.read({ selection: 'PRIMARY' }), 'for middle click');
});

test('clear() releases with the timestamp the selection was acquired with', async () => {
  const clipboard = writer.clipboard;
  await clipboard.write('stamped');
  const sel = await atom(writer.X, 'CLIPBOARD');
  const acquired = clipboard._owned.get(sel).time;
  assert.notEqual(acquired, 0);

  const calls = [];
  const real = clipboard.X.SetSelectionOwner.bind(clipboard.X);
  clipboard.X.SetSelectionOwner = (owner, selection, time) => {
    calls.push({ owner, selection, time });
    return real(owner, selection, time);
  };
  try {
    await clipboard.clear();
  } finally {
    clipboard.X.SetSelectionOwner = real;
  }
  // ICCCM 2.3.1: owner None, and the acquisition timestamp — not a fresh
  // one, and not CurrentTime, either of which a real server may reject
  assert.deepEqual(calls, [{ owner: 0, selection: sel, time: acquired }]);
});

test('clear() on a selection we do not own sends nothing', async () => {
  const X = raw.client;
  const wid = rawWindow(raw);
  const SELECTION = await atom(X, 'NTK_TEST_FOREIGN');
  X.SetSelectionOwner(wid, SELECTION, 0);
  // something else is owned, so this exercises the per-selection check
  // rather than the "never wrote anything" shortcut
  await writer.clipboard.write('unrelated');

  await writer.clipboard.clear('NTK_TEST_FOREIGN');

  const owner = await new Promise((resolve, reject) =>
    writer.X.GetSelectionOwner(SELECTION, (err, id) => (err ? reject(err) : resolve(id)))
  );
  assert.equal(owner, wid, 'the real owner keeps the selection');
});

test('clear() on a clipboard that never wrote anything touches the server at all', async () => {
  const fresh = await connect();
  try {
    await fresh.clipboard.clear();
    assert.equal(fresh.clipboard._window, null, 'no helper window created for a no-op');
  } finally {
    await fresh.close();
  }
});

test('a transfer already in flight survives the release', async () => {
  const clipboard = writer.clipboard;
  const X = raw.client;
  const wid = rawWindow(raw, x11.eventMask.PropertyChange);
  const [CLIPBOARD, UTF8_STRING, INCR, PROP] = await Promise.all(
    ['CLIPBOARD', 'UTF8_STRING', 'INCR', 'NTK_TEST_CLEAR_INCR'].map((n) => atom(X, n))
  );
  const text = `${'a'.repeat(4000)}κόσμε${'b'.repeat(4000)}`;
  const payload = Buffer.from(text, 'utf8');
  clipboard._transferLimit = 64;
  try {
    await clipboard.write(text);
    const reply = await rawConvert(X, wid, CLIPBOARD, UTF8_STRING, PROP);
    assert.equal(reply.property, PROP);

    const collecting = rawIncrRead(X, wid, PROP);
    const first = await getProperty(X, wid, PROP); // delete=1 starts the chunks
    assert.equal(first.type, INCR);
    // give the selection up mid-transfer: ICCCM 2.7.2 says the transfer
    // still has to finish, and it does because it holds its own copy
    await clipboard.clear();
    assert.equal(clipboard._owned.has(CLIPBOARD), false, 'ownership is gone immediately');
    assert.deepEqual(await collecting, payload, 'every byte still arrives');
  } finally {
    clipboard._transferLimit = null;
  }
});
