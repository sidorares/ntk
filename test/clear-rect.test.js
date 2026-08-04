// clearRect resets to "nothing", and what nothing is depends on the target.
// A depth-32 drawable has an alpha channel, so it clears to transparent
// black and a compositor shows what is behind it; a depth-24 one has no
// alpha to write, so it keeps clearing to the opaque white it always did.
//
// The transformed/clipped path matters as much as the fast one: it goes
// through a coverage mask, where the naive "composite transparent black over
// it" is a no-op and leaves the pixels untouched.
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';

let app = null;
const W = 64;
const H = 64;

before(async () => {
  const server = xserver.createServer({ width: 200, height: 200 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  app = await createClient({
    stream: clientEnd,
    fontSource: new StaticFontSource(),
  });
});

after(async () => {
  if (app) await app.close();
});

/** a context on a drawable of the given depth, painted opaque red first, so
 *  a clear that does nothing is visible as red rather than as a pass */
function ctxOfDepth(depth) {
  const pixmap = app.createPixmap({ width: W, height: H, depth });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'red';
  ctx.fillRect(0, 0, W, H);
  return ctx;
}

const pixels = async (ctx) => {
  const img = await ctx.getImageData(0, 0, W, H);
  return (x, y) => [...img.data.slice((y * W + x) * 4, (y * W + x) * 4 + 4)];
};

test('depth 32 clears to transparent black', async () => {
  const ctx = ctxOfDepth(32);
  ctx.clearRect(0, 0, W, H);

  const at = await pixels(ctx);
  assert.deepEqual(at(10, 10), [0, 0, 0, 0], 'nothing left, not even alpha');
  assert.deepEqual(at(W - 1, H - 1), [0, 0, 0, 0]);
});

test('depth 24 still clears to opaque white', async () => {
  const ctx = ctxOfDepth(24);
  ctx.clearRect(0, 0, W, H);

  const at = await pixels(ctx);
  const [r, g, b] = at(10, 10);
  assert.ok(
    r > 240 && g > 240 && b > 240,
    `an opaque target has no transparency to clear to, got ${at(10, 10)}`,
  );
});

test('a clear bounded to part of the surface leaves the rest alone', async () => {
  const ctx = ctxOfDepth(32);
  ctx.clearRect(0, 0, 32, 32);

  const at = await pixels(ctx);
  assert.deepEqual(at(10, 10), [0, 0, 0, 0], 'inside the rect');
  assert.deepEqual(at(40, 40).slice(3), [255], 'outside it is untouched');
});

test('a clipped clear erases only inside the clip, and really erases', async () => {
  const ctx = ctxOfDepth(32);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, 32, H);
  ctx.clip();
  // the whole surface, narrowed by the clip — this is the masked path, where
  // compositing transparent black with Over would silently do nothing
  ctx.clearRect(0, 0, W, H);
  ctx.restore();

  const at = await pixels(ctx);
  assert.deepEqual(at(10, 10), [0, 0, 0, 0], 'inside the clip is gone');
  assert.deepEqual(at(50, 10).slice(3), [255], 'outside the clip survives');
});

test('a translated clear follows the transform', async () => {
  const ctx = ctxOfDepth(32);
  ctx.save();
  ctx.translate(32, 0);
  ctx.clearRect(0, 0, 32, 32);
  ctx.restore();

  const at = await pixels(ctx);
  assert.deepEqual(at(40, 10), [0, 0, 0, 0], 'cleared where it was moved to');
  assert.deepEqual(at(10, 10).slice(3), [255], 'not where it was asked from');
});
