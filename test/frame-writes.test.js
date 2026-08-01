// One socket write per frame (ntk#125). Needs a real server: what is measured
// is what x11's output buffer hands to the socket, which the mock client in
// frame-pacing.test.js has no equivalent of. Skipped when no server is
// reachable.
//
// A frame is "draw, then a round trip": _runFrame() emits the drawing and the
// blit in one synchronous run and ends with the frame fence, a GetInputFocus
// whose reply x11 does not make the caller wait for the buffer. `X.sync()` is
// that same round trip, so this drives the batch directly rather than through
// the frame clock — the property under test is the same one, and the test
// cannot hang waiting for a frame that a busy shared display never delivers.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { createClient } from '../lib/index.js';

const withTimeout = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${what}`)), ms).unref())
  ]);

const OPS = 200; // draw calls per frame

let skip = false;

before(async () => {
  if (!process.env.DISPLAY) {
    skip = 'no DISPLAY set';
    return;
  }
  try {
    const probe = await withTimeout(createClient(), 5000, 'connecting to X server');
    await probe.close();
  } catch (err) {
    skip = `cannot connect to X server: ${err.message}`;
  }
});

/** Draw OPS rectangles, round-trip, and report what it cost on the wire. */
async function measureFrame(options) {
  const app = await withTimeout(createClient(options), 5000, 'connecting to X server');
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
    await withTimeout(app.X.sync(), 5000, 'warm-up round trip');

    const before = { ...app.X.pack_stream.stats };
    paint();
    const midFrame = app.X.pack_stream.stats.writes - before.writes;
    await withTimeout(app.X.sync(), 5000, 'measured round trip');
    const now = app.X.pack_stream.stats;
    return {
      writes: now.writes - before.writes,
      midFrame,
      requests: now.packets - before.packets,
      bytes: now.bytes - before.bytes
    };
  } finally {
    await app.close();
  }
}

test('a frame of drawing goes out in one socket write', async (t) => {
  if (skip) return t.skip(skip);
  const frame = await measureFrame();
  assert.ok(frame.requests > OPS / 2, `${frame.requests} requests for ${OPS} draw calls`);
  assert.ok(frame.bytes > 1000, 'the frame actually drew something');
  // 1 in practice: the round trip that ends a frame flushes the batch. The
  // slack is for a machine slow enough that drawing outlives the client's
  // 5 ms age gate, which splits the batch rather than sitting on it. What
  // must not happen is a write per request.
  assert.ok(frame.writes <= 3, `${frame.writes} writes for ${frame.requests} requests`);
});

test('bufferRequests: false restores a write per request', async (t) => {
  if (skip) return t.skip(skip);
  const frame = await measureFrame({ bufferRequests: false });
  assert.ok(frame.writes >= frame.requests, `${frame.writes} writes, ${frame.requests} requests`);
  assert.ok(frame.midFrame >= OPS, 'every request is written as it is issued');
});
