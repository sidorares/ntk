// XVideo, hermetically: how a frame is laid out for a port, which port is
// chosen and when none is, and which way a frame goes — shared memory or the
// socket — and when it does not go at all. What a real adaptor makes of the
// frame is xv-live.test.js.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { VIDEO_FOURCC, openVideoPort, packVideoFrame, videoPlanes } from '../lib/xv.js';

test('a frame copies into the port layout row by row, keeping to its own rows', () => {
  // 5x3 I420, packed, into a layout padded to 8 bytes a row as a port pads
  const W = 5;
  const H = 3;
  const y = Uint8Array.from({ length: W * H }, (_, i) => 10 + i);
  const u = Uint8Array.from({ length: 3 * 2 }, (_, i) => 100 + i);
  const v = Uint8Array.from({ length: 3 * 2 }, (_, i) => 200 + i);
  const layout = { pitches: [8, 4, 4], offsets: [0, 32, 48] };
  const out = new Uint8Array(64).fill(0xee);
  packVideoFrame('I420', W, H, [y, u, v], undefined, layout, out);
  assert.deepEqual([...out.subarray(0, 5)], [10, 11, 12, 13, 14], 'Y row 0');
  assert.deepEqual([...out.subarray(5, 8)], [0xee, 0xee, 0xee], 'the padding is not written');
  assert.deepEqual([...out.subarray(16, 21)], [20, 21, 22, 23, 24], 'Y row 2 at twice the pitch');
  assert.deepEqual([...out.subarray(32, 35)], [100, 101, 102], 'U row 0');
  assert.deepEqual([...out.subarray(36, 39)], [103, 104, 105], 'U row 1');
  assert.deepEqual([...out.subarray(48, 51)], [200, 201, 202], 'V row 0');
});

test("a decoder's stride is read past, and a plane at the port's pitch goes in one copy", () => {
  // NV12 4x2 with rows padded to 6 by the decoder; the port takes 4
  const y = Uint8Array.from([1, 2, 3, 4, 0, 0, 5, 6, 7, 8, 0, 0]);
  const uv = Uint8Array.from([9, 10, 11, 12]);
  const layout = { pitches: [4, 4], offsets: [0, 8] };
  const out = new Uint8Array(12);
  packVideoFrame('NV12', 4, 2, [y, uv], [6, 4], layout, out);
  assert.deepEqual([...out], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test('every format ntk names has its planes', () => {
  assert.deepEqual(
    videoPlanes('NV12', 3, 3).map((p) => [p.rowBytes, p.rows]),
    [
      [3, 3],
      [4, 2]
    ]
  );
  assert.deepEqual(
    videoPlanes('UYVY', 3, 2).map((p) => [p.rowBytes, p.rows]),
    [[8, 2]],
    'a 4:2:2 row is whole pixel pairs'
  );
  assert.deepEqual(
    videoPlanes('AR24', 3, 2).map((p) => [p.rowBytes, p.rows]),
    [[12, 2]]
  );
  assert.throws(() => videoPlanes('RV32', 2, 2), /not one ntk lays out/);
});

// --- a stub server -------------------------------------------------------------

/**
 * An app over a stub X whose XVideo has `adaptors`, recording the requests
 * that matter. `grabbed` is the set of ports another client holds.
 */
function stubApp({
  adaptors = [],
  grabbed = new Set(),
  formats = ['NV12', 'I420', 'AR24'],
  attributes = [{ name: 'XV_COLORSPACE', flags: 3, min: 0, max: 1 }],
  xv = true,
  shm = false,
  maxRequest = 0x40000
} = {}) {
  const sent = [];
  let nextId = 100;
  const later = (cb, ...args) => setImmediate(() => cb(...args));
  const Xv = {
    Type: { InputMask: 1, OutputMask: 2, VideoMask: 4, StillMask: 8, ImageMask: 16 },
    GrabPortStatus: { Success: 0, AlreadyGrabbed: 2 },
    AttributeFlag: { Gettable: 1, Settable: 2 },
    QueryAdaptors: (root, cb) => later(cb, null, adaptors),
    GrabPort: (port, time, cb) => {
      sent.push(['GrabPort', port]);
      later(cb, null, grabbed.has(port) ? 2 : 0);
    },
    UngrabPort: (port) => sent.push(['UngrabPort', port]),
    ListImageFormats: (port, cb) => later(cb, null, formats.map((name) => ({ id: VIDEO_FOURCC[name] }))),
    QueryPortAttributes: (port, cb) => later(cb, null, attributes),
    QueryImageAttributes: (port, id, width, height, cb) => {
      sent.push(['QueryImageAttributes', width, height]);
      const w = (width + 1) & ~1;
      const h = (height + 1) & ~1;
      later(cb, null, { width: w, height: h, dataSize: (w * h * 3) / 2, pitches: [w, w], offsets: [0, w * h] });
    },
    SetPortAttribute: (port, atom, value) => sent.push(['SetPortAttribute', value]),
    PutImage: (port, drawable, gc, id, img) => {
      if (img.data.length > maxRequest) throw new Error('too large for one request');
      sent.push(['PutImage', drawable, img.data.length]);
    },
    ShmPutImage: (port, drawable, gc, shmseg, id, img) => sent.push(['ShmPutImage', drawable, shmseg, img.sendEvent]),
    StopVideo: (port, drawable) => sent.push(['StopVideo', drawable])
  };
  const segments = [];
  const X = {
    AllocID: () => nextId++,
    CreateGC: () => sent.push(['CreateGC']),
    FreeGC: () => {},
    InternAtom: (onlyIfExists, name, cb) => later(cb, null, 77),
    stream: {}
  };
  const app = {
    X,
    display: { screen: [{ root: 1, root_visual: 0x21, default_colormap: 0x22 }], Render: {} },
    xv: async () => (xv ? Xv : null),
    composite: async () => ({ Redirect: { Manual: 1 }, RedirectWindow() {} }),
    pictFormatFor: async () => 42,
    createColormap: () => 0x99,
    shm: {
      ready: shm,
      resolve: (cb) => later(cb, shm),
      ext: {
        createSegment(size, cb) {
          const segment = new EventEmitter();
          Object.assign(segment, {
            shmseg: nextId++,
            size,
            buffer: new Uint8Array(size),
            commit() {},
            detach() {
              segment.detached = true;
            }
          });
          segments.push(segment);
          later(cb, null, segment);
        }
      }
    }
  };
  return { app, sent, segments };
}

const IMAGE_ADAPTOR = { baseId: 50, numPorts: 3, type: 16 | 1, name: 'test', formats: [{ visual: 0x21, depth: 24 }] };

test('no XVideo, no image adaptor, no adaptor at the depth, or every port held: null', async () => {
  assert.equal(await openVideoPort(stubApp({ xv: false }).app), null, 'no extension');
  assert.equal(await openVideoPort(stubApp({ adaptors: [] }).app), null, '"no adaptors present"');
  assert.equal(
    await openVideoPort(stubApp({ adaptors: [{ ...IMAGE_ADAPTOR, type: 4 | 1 }] }).app),
    null,
    'a capture adaptor takes no images'
  );
  assert.equal(await openVideoPort(stubApp({ adaptors: [IMAGE_ADAPTOR] }).app, { depth: 32 }), null, 'depth 24 only');
  assert.equal(
    await openVideoPort(stubApp({ adaptors: [IMAGE_ADAPTOR], grabbed: new Set([50, 51, 52]) }).app),
    null,
    'every port grabbed by someone else'
  );
});

test('the first port nobody holds is grabbed, and given back on close', async () => {
  const { app, sent } = stubApp({ adaptors: [IMAGE_ADAPTOR], grabbed: new Set([50]) });
  const port = await openVideoPort(app);
  assert.equal(port.id, 51);
  assert.deepEqual(port.formats, ['NV12', 'I420', 'AR24']);
  assert.deepEqual(port.colorSpaces, ['bt601', 'bt709']);
  assert.equal(app._videoPorts.has(port), true, 'the app closes it with the connection');
  port.close();
  assert.deepEqual(sent.at(-1), ['UngrabPort', 51]);
  assert.equal(app._videoPorts.has(port), false);
});

test('a port with no XV_COLORSPACE reads BT.601 only', async () => {
  const { app } = stubApp({ adaptors: [IMAGE_ADAPTOR], attributes: [] });
  const port = await openVideoPort(app);
  assert.deepEqual(port.colorSpaces, ['bt601']);
  assert.equal(port.setColorSpace('bt601'), true);
  assert.equal(port.setColorSpace('bt709'), false);
  assert.equal(port.setColorSpace('bt2020'), false);
});

const frame = (w, h) => ({
  format: 'NV12',
  width: w,
  height: h,
  planes: [new Uint8Array(w * h), new Uint8Array(w * Math.ceil(h / 2))]
});

test('a size whose layout is not known yet is declined once, and asked for', async () => {
  const { app, sent } = stubApp({ adaptors: [IMAGE_ADAPTOR] });
  const port = await openVideoPort(app);
  assert.equal(port.putImage(7, frame(64, 36)), false, 'nothing to lay it out by yet');
  assert.deepEqual(sent.at(-1), ['QueryImageAttributes', 64, 36]);
  assert.equal(port.putImage(7, frame(64, 36)), false, 'still in flight: asked once');
  assert.equal(sent.filter(([name]) => name === 'QueryImageAttributes').length, 1);
  await port.prepare('NV12', 64, 36);
  assert.equal(port.putImage(7, frame(64, 36)), true);
  assert.equal(sent.at(-1)[0], 'PutImage');
});

test('the colour space is set before the first frame, and again only when it changes', async () => {
  const { app, sent } = stubApp({ adaptors: [IMAGE_ADAPTOR] });
  const port = await openVideoPort(app);
  await port.prepare('NV12', 16, 16);
  const sets = () => sent.filter(([name]) => name === 'SetPortAttribute').map(([, v]) => v);
  port.putImage(7, { ...frame(16, 16), colorSpace: 'bt601' });
  assert.deepEqual(sets(), [0], 'whatever the last holder of the port left, it is said');
  port.putImage(7, { ...frame(16, 16), colorSpace: 'bt601' });
  port.putImage(7, { ...frame(16, 16), colorSpace: 'bt709' });
  assert.deepEqual(sets(), [0, 1]);
  assert.equal(port.putImage(7, { ...frame(16, 16), colorSpace: 'bt2020' }), false);
});

test('a frame the port does not take, or one too large for a request, is not sent', async () => {
  const { app, sent } = stubApp({ adaptors: [IMAGE_ADAPTOR], formats: ['I420'], maxRequest: 1000 });
  const port = await openVideoPort(app);
  assert.equal(port.putImage(7, frame(16, 16)), false, 'no NV12 on this port');
  await port.prepare('I420', 64, 64);
  const big = {
    format: 'I420',
    width: 64,
    height: 64,
    planes: [new Uint8Array(4096), new Uint8Array(1024), new Uint8Array(1024)]
  };
  const before = sent.length;
  assert.equal(port.putImage(7, big), false, '6144 bytes over a 1000-byte request');
  assert.equal(sent.slice(before).some(([name]) => name === 'PutImage'), false);
});

test('through shared memory once a segment is warm, recycled on its completion', async () => {
  const { app, sent, segments } = stubApp({ adaptors: [IMAGE_ADAPTOR], shm: true });
  const port = await openVideoPort(app);
  await port.prepare('NV12', 32, 32);
  const transport = () => sent.at(-1)[0];
  assert.equal(port.putImage(7, frame(32, 32)), true);
  assert.equal(transport(), 'PutImage', 'the first frame cannot wait for a segment');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(segments.length, 1, 'one warmed behind it');
  assert.equal(port.putImage(7, frame(32, 32)), true);
  assert.deepEqual(sent.at(-1), ['ShmPutImage', 7, segments[0].shmseg, true], 'asking to hear when it is read');
  // the segment is the server's until it says so: the next frame goes down
  // the socket and warms another
  assert.equal(port.putImage(7, frame(32, 32)), true);
  assert.equal(transport(), 'PutImage');
  segments[0].emit('complete');
  assert.equal(port.putImage(7, frame(32, 32)), true);
  assert.equal(sent.at(-1)[2], segments[0].shmseg, 'read, and used again');
  port.close();
  segments[0].emit('complete');
  assert.equal(segments[0].detached, true, 'a segment back after close is let go');
});

test('stop sends StopVideo for a drawable this port drew into, once', async () => {
  const { app, sent } = stubApp({ adaptors: [IMAGE_ADAPTOR] });
  const port = await openVideoPort(app);
  await port.prepare('NV12', 16, 16);
  port.stop(7);
  assert.equal(sent.some(([name]) => name === 'StopVideo'), false, 'never drawn into: nothing to stop');
  port.putImage(7, frame(16, 16));
  port.stop(7);
  port.stop(7);
  assert.deepEqual(
    sent.filter(([name]) => name === 'StopVideo'),
    [['StopVideo', 7]]
  );
});
