// One socket write per frame (ntk#125). Needs a real server: what is measured
// is what x11's output buffer hands to the socket, which the mock client in
// frame-pacing.test.js has no equivalent of. Skipped when no server is
// reachable.
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

/**
 * Paint `frames` frames of OPS rectangles and report what each cost on the
 * wire. Painting happens inside the requestAnimationFrame callback, so a
 * frame's drawing, its blit and its fence are one synchronous run — the
 * shape every ntk frame has.
 */
async function measureFrames(options, frames = 4) {
  const app = await createClient(options);
  const wnd = app.createWindow({ width: 200, height: 200, frameInterval: 0 });
  wnd.map();
  const ctx = wnd.getContext('2d');
  const paint = () => {
    ctx.fillStyle = '#101020';
    ctx.fillRect(0, 0, 200, 200);
    for (let i = 0; i < OPS; i++) {
      ctx.fillStyle = `rgb(${(i * 2) % 256},${(i * 3) % 256},200)`;
      ctx.fillRect((i * 7) % 180, (i * 11) % 180, 14, 14);
    }
  };

  const measured = [];
  await withTimeout(
    new Promise((resolve) => {
      const step = () => {
        wnd.requestAnimationFrame(() => {
          const before = { ...app.X.pack_stream.stats };
          paint();
          // after the frame's synchronous run: blit and fence included
          queueMicrotask(() => {
            const now = app.X.pack_stream.stats;
            measured.push({
              writes: now.writes - before.writes,
              requests: now.packets - before.packets,
              bytes: now.bytes - before.bytes
            });
            if (measured.length < frames) step();
            else resolve();
          });
        });
      };
      step();
    }),
    10000,
    `${frames} frames`
  );
  await app.close();
  return measured.slice(1); // the first frame also creates gcs/pictures/glyphs
}

test('a frame of drawing goes out in one socket write', async (t) => {
  if (skip) return t.skip(skip);
  for (const frame of await measureFrames()) {
    assert.ok(frame.requests > OPS / 2, `${frame.requests} requests for ${OPS} draw calls`);
    assert.ok(frame.bytes > 1000, 'the frame actually drew something');
    // 1 in practice — the frame fence flushes the batch at the frame
    // boundary. The slack is for a machine slow enough that painting outlives
    // the client's 5 ms age gate, which splits the batch rather than sitting
    // on it; what must not happen is a write per request.
    assert.ok(frame.writes <= 3, `${frame.writes} writes for ${frame.requests} requests`);
  }
});

test('bufferRequests: false restores a write per request', async (t) => {
  if (skip) return t.skip(skip);
  for (const frame of await measureFrames({ bufferRequests: false })) {
    assert.ok(frame.writes >= frame.requests, `${frame.writes} writes, ${frame.requests} requests`);
  }
});
