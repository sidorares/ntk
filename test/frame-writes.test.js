// One socket write per frame (ntk#125). Hermetic: an ntk client talks to
// node-x11's pure-JS X server over an in-process stream pair, so this measures
// what the client's output buffer hands to the transport without depending on
// a display — the mock client in frame-pacing.test.js has no output buffer to
// measure, and a shared server makes connection timing another test's problem.
//
// A frame is "draw, then a round trip": _runFrame() emits the drawing and the
// blit in one synchronous run and ends with the frame fence, a GetInputFocus.
// x11 flushes on a request that expects a reply, and `X.sync()` is that same
// round trip — so driving the batch with sync() tests the property the frame
// clock relies on, without waiting for a frame.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';

const { createServer, createStreamPair } = xserver;

const OPS = 200; // draw calls per frame

/** Draw OPS rectangles, round-trip, and report what it cost on the wire. */
async function measureFrame(options) {
  const server = createServer({ width: 320, height: 240 });
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);
  const app = await createClient({
    stream: clientEnd,
    fontSource: new StaticFontSource(),
    ...options
  });
  try {
    const pixmap = app.createPixmap({ width: 200, height: 200 });
    const ctx = pixmap.getContext('2d');
    const paint = () => {
      ctx.fillStyle = '#101020';
      ctx.fillRect(0, 0, 200, 200);
      for (let i = 0; i < OPS; i++) {
        ctx.fillStyle = `rgb(${(i * 2) % 256},${(i * 3) % 256},200)`;
        ctx.fillRect((i * 7) % 180, (i * 11) % 180, 14, 14);
      }
    };

    paint(); // warm up: gcs, pictures and any first-use round trips
    await app.X.sync();

    const before = { ...app.X.pack_stream.stats };
    paint();
    const midFrame = app.X.pack_stream.stats.writes - before.writes;
    await app.X.sync();
    const now = app.X.pack_stream.stats;
    return {
      writes: now.writes - before.writes,
      midFrame,
      requests: now.packets - before.packets,
      bytes: now.bytes - before.bytes
    };
  } finally {
    app.X.terminate();
  }
}

test('a frame of drawing goes out in one socket write', async () => {
  const frame = await measureFrame();
  assert.ok(frame.requests > OPS / 2, `${frame.requests} requests for ${OPS} draw calls`);
  assert.ok(frame.bytes > 1000, 'the frame actually drew something');
  // 1 in practice: the round trip that ends a frame flushes the batch. The
  // slack is for a machine slow enough that drawing outlives the client's
  // 5 ms age gate, which splits the batch rather than sitting on it. What
  // must not happen is a write per request.
  assert.ok(frame.writes <= 3, `${frame.writes} writes for ${frame.requests} requests`);
});

test('bufferRequests: false restores a write per request', async () => {
  const frame = await measureFrame({ bufferRequests: false });
  assert.ok(frame.writes >= frame.requests, `${frame.writes} writes, ${frame.requests} requests`);
  assert.ok(frame.midFrame >= OPS, 'every request is written as it is issued');
});
