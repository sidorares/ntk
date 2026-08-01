// Translucent colours have to reach XRender *premultiplied* — each of r, g
// and b scaled by alpha. Straight alpha composites at full brightness, and
// over a white background it clamps to the same result, which is how this
// stayed invisible: red at half alpha looked right on white and was twice as
// bright as it should be on anything dark.
//
// So every case here paints over black. Hermetic: node-x11's in-process
// pure-JS X server, no $DISPLAY needed.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';

let app = null;
const W = 20;
const H = 20;

before(async () => {
  const server = xserver.createServer({ width: 100, height: 100 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  app = await createClient({
    stream: clientEnd,
    fontSource: new StaticFontSource()
  });
});

after(async () => {
  if (app) await app.close();
});

const centre = async (ctx) => {
  const d = await ctx.getImageData(0, 0, W, H);
  const i = (10 * W + 10) * 4;
  return [d.data[i], d.data[i + 1], d.data[i + 2]];
};

// fill `under`, then apply a style and fill again over the top
async function over(under, apply) {
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = under;
  ctx.fillRect(0, 0, W, H);
  apply(ctx);
  ctx.fillRect(0, 0, W, H);
  return centre(ctx);
}

const near = (got, want, what, tol = 3) =>
  assert.ok(
    got.every((v, i) => Math.abs(v - want[i]) <= tol),
    `${what}: got rgb(${got}), want ~rgb(${want})`
  );

test('a translucent colour string composites at the right brightness', async () => {
  // the reference: globalAlpha goes through an a8 mask and was always right
  near(
    await over('black', (c) => {
      c.globalAlpha = 0.5;
      c.fillStyle = 'red';
    }),
    [128, 0, 0],
    'globalAlpha 0.5 + red'
  );
  // ...and colour-string alpha must agree with it
  near(
    await over('black', (c) => {
      c.fillStyle = 'rgba(255, 0, 0, 0.5)';
    }),
    [128, 0, 0],
    'rgba(255, 0, 0, 0.5)'
  );
  near(
    await over('black', (c) => {
      c.fillStyle = 'hsla(0, 100%, 50%, 0.5)';
    }),
    [128, 0, 0],
    'hsla(0, 100%, 50%, 0.5)'
  );
});

test('hex alpha renders as its alpha, not fully opaque', async () => {
  near(
    await over('black', (c) => {
      c.fillStyle = '#ff000080';
    }),
    [128, 0, 0],
    '#ff000080'
  );
  near(
    await over('black', (c) => {
      c.fillStyle = '#f008';
    }),
    [136, 0, 0],
    '#f008'
  );
  // the case that shipped broken downstream: black at 13% over white was
  // drawing a solid black pill, because parse-color handed back alpha 34
  near(
    await over('white', (c) => {
      c.fillStyle = '#00000022';
    }),
    [221, 221, 221],
    '#00000022 over white'
  );
});

test('transparent and fully opaque are both no-ops in their own way', async () => {
  near(
    await over('white', (c) => {
      c.fillStyle = 'transparent';
    }),
    [255, 255, 255],
    'transparent leaves the background alone'
  );
  near(
    await over('white', (c) => {
      c.fillStyle = 'red';
    }),
    [255, 0, 0],
    'an opaque colour still covers completely'
  );
});

test('an array style is taken as already premultiplied', async () => {
  near(
    await over('black', (c) => {
      c.fillStyle = [0.5, 0, 0, 0.5];
    }),
    [128, 0, 0],
    'premultiplied array passes through untouched'
  );
});

test('gradient stops are premultiplied too', async () => {
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, W, H);
  // a gradient from half-alpha red to half-alpha red is a flat half-alpha
  // red, so it must match the solid-colour case exactly
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, 'rgba(255, 0, 0, 0.5)');
  g.addColorStop(1, 'rgba(255, 0, 0, 0.5)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  near(await centre(ctx), [128, 0, 0], 'flat half-alpha red gradient');
});

test('an unparseable colour throws instead of writing garbage', () => {
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext('2d');
  // '#00000022' used to reach XRender as alpha 34; a bogus string used to
  // throw a TypeError from inside parse-color's result
  assert.throws(() => {
    ctx.fillStyle = 'not-a-colour';
  }, /Not a color/);
  assert.throws(() => {
    ctx.fillStyle = '#1234567';
  }, /Not a color/);
});
