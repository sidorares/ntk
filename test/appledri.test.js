// The Apple-DRI protocol binding, hermetically: request bytes, reply
// decoding, the SurfaceNotify event parser and the two extension errors,
// against a stub of node-x11's client surface (pack_stream / replies /
// eventParsers / errorParsers). No display, no macOS, no addon — the wire
// encoding is the same everywhere, which is what makes this checkable on CI.
// The live half is test/gl-appledri-live.test.js.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { NotifyKind, requireAppleDRI } from '../lib/appledri.js';

const OPCODE = 130;
const FIRST_EVENT = 90;
const FIRST_ERROR = 140;

function fakeDisplay({ present = 1 } = {}) {
  const X = {
    seq_num: 0,
    replies: {},
    eventParsers: {},
    errorParsers: {},
    requests: [],
    queries: 0,
    pack_stream: {
      put(b) {
        X.requests.push(Buffer.from(b));
      },
      submit() {}
    },
    QueryExtension(name, cb) {
      X.queries++;
      assert.equal(name, 'Apple-DRI');
      queueMicrotask(() =>
        cb(null, {
          present,
          majorOpcode: OPCODE,
          firstEvent: FIRST_EVENT,
          firstError: FIRST_ERROR
        })
      );
    }
  };
  return { client: X };
}

/** run the decode half registered for the last request */
const decodeLast = (X, buf) => X.replies[X.seq_num][0](buf);

describe('requireAppleDRI', () => {
  test('a server without the extension answers null, once, cached', async () => {
    const display = fakeDisplay({ present: 0 });
    assert.equal(await requireAppleDRI(display), null);
    assert.equal(await requireAppleDRI(display), null);
    assert.equal(display.client.queries, 1);
  });

  test('QueryVersion: 1-word request, version triple out of the reply', async () => {
    const display = fakeDisplay();
    const ext = await requireAppleDRI(display);
    const X = display.client;

    ext.QueryVersion(() => {});
    const req = X.requests.at(-1);
    assert.deepEqual([...req], [OPCODE, 0, 1, 0]);
    assert.equal(X.seq_num, 1, 'one request issued, sequence tracked');

    const reply = Buffer.alloc(24);
    reply.writeUInt16LE(1, 0);
    reply.writeUInt16LE(0, 2);
    reply.writeUInt32LE(23, 4);
    assert.deepEqual(decodeLast(X, reply), { major: 1, minor: 0, patch: 23 });
  });

  test('QueryDirectRenderingCapable: screen in, boolean out', async () => {
    const display = fakeDisplay();
    const ext = await requireAppleDRI(display);
    const X = display.client;

    ext.QueryDirectRenderingCapable(0, () => {});
    const req = X.requests.at(-1);
    assert.equal(req.length, 8);
    assert.equal(req.readUInt8(0), OPCODE);
    assert.equal(req.readUInt8(1), 1); // minor opcode
    assert.equal(req.readUInt16LE(2), 2); // length in words
    assert.equal(req.readUInt32LE(4), 0); // screen

    assert.equal(decodeLast(X, Buffer.from([1])), true);
    assert.equal(decodeLast(X, Buffer.from([0])), false);
  });

  test('CreateSurface: screen/drawable/clientId in, key pair and uid out', async () => {
    const display = fakeDisplay();
    const ext = await requireAppleDRI(display);
    const X = display.client;

    ext.CreateSurface(0, 0x0200004a, 0x1234, () => {});
    const req = X.requests.at(-1);
    assert.equal(req.length, 16);
    assert.equal(req.readUInt8(1), 2); // minor opcode
    assert.equal(req.readUInt16LE(2), 4); // length in words
    assert.equal(req.readUInt32LE(4), 0); // screen
    assert.equal(req.readUInt32LE(8), 0x0200004a); // drawable
    assert.equal(req.readUInt32LE(12), 0x1234); // client_id

    const reply = Buffer.alloc(24);
    reply.writeUInt32LE(0xdeadbeef, 0);
    reply.writeUInt32LE(0x00c0ffee, 4);
    reply.writeUInt32LE(7, 8);
    assert.deepEqual(decodeLast(X, reply), { key: [0xdeadbeef, 0x00c0ffee], uid: 7 });
  });

  test('DestroySurface: void request, no reply handler registered', async () => {
    const display = fakeDisplay();
    const ext = await requireAppleDRI(display);
    const X = display.client;

    ext.DestroySurface(0, 0x0200004a);
    const req = X.requests.at(-1);
    assert.equal(req.length, 12);
    assert.equal(req.readUInt8(1), 3); // minor opcode
    assert.equal(req.readUInt16LE(2), 3); // length in words
    assert.equal(req.readUInt32LE(4), 0); // screen
    assert.equal(req.readUInt32LE(8), 0x0200004a); // drawable
    assert.equal(X.replies[X.seq_num], undefined, 'nothing awaits a reply');
  });

  test('SurfaceNotify: classic event at firstEvent + 3, kind in the code byte, uid in arg', async () => {
    const display = fakeDisplay();
    const ext = await requireAppleDRI(display);
    const X = display.client;

    assert.equal(ext.events.AppleDRISurfaceNotify, 3);
    assert.deepEqual(ext.NotifyKind, { Changed: 0, Destroyed: 1 });
    assert.equal(ext.NotifyKind, NotifyKind);

    const parse = X.eventParsers[FIRST_EVENT + 3];
    assert.equal(typeof parse, 'function');
    const raw = Buffer.alloc(24);
    raw.writeUInt32LE(7, 4); // the surface uid — NOT a window id
    const ev = parse(FIRST_EVENT + 3, 42, 123456, NotifyKind.Destroyed, raw);
    assert.deepEqual(ev, {
      type: FIRST_EVENT + 3,
      seq: 42,
      name: 'AppleDRISurfaceNotify',
      kind: NotifyKind.Destroyed,
      time: 123456,
      arg: 7
    });
  });

  test('the two protocol errors decode to messages that say what to do', async () => {
    const display = fakeDisplay();
    const ext = await requireAppleDRI(display);
    const X = display.client;

    assert.deepEqual(ext.errors, { ClientNotLocal: 0, OperationNotSupported: 1 });
    const local = { message: 'unknown' };
    X.errorParsers[FIRST_ERROR + 0](local);
    assert.match(local.message, /not local.*same machine/s);
    const unsupported = { message: 'unknown' };
    X.errorParsers[FIRST_ERROR + 1](unsupported);
    assert.match(unsupported.message, /not supported/);
  });
});
