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

import { cssColorStraight } from '../lib/color.js';
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

test('a colour that throws leaves the style as it was', async () => {
  // The throw is the documented answer to a string that is not a colour;
  // the setter had kept the string before throwing, and `fillRects`, which
  // reads the string again, threw from a later paint with nothing wrong in it.
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'rgb(10, 20, 30)';
  ctx.strokeStyle = 'rgb(40, 50, 60)';
  assert.throws(() => {
    ctx.fillStyle = 'nonsense';
  }, /Not a color/);
  assert.throws(() => {
    ctx.strokeStyle = '';
  }, /Not a color/);
  assert.equal(ctx.fillStyle, 'rgb(10, 20, 30)');
  assert.equal(ctx.strokeStyle, 'rgb(40, 50, 60)');
  ctx.fillRects([[0, 0, W, H]]);
  const img = await ctx.getImageData(0, 0, 1, 1);
  assert.deepEqual([...img.data.slice(0, 3)], [10, 20, 30]);
});

test('a colour parsed again is the same colour, and each caller gets its own', () => {
  // Parsed once per spelling (lib/color.js): what has to hold is that the
  // cache changes nothing a caller can see.
  const first = cssColorStraight('rgba(255, 128, 0, 0.5)');
  first[0] = 99; // a caller scaling what it was handed
  const again = cssColorStraight('rgba(255, 128, 0, 0.5)');
  assert.deepEqual(again, [1, 128 / 255, 0, 0.5]);
  assert.notEqual(again, cssColorStraight('rgba(255, 128, 0, 0.5)'));
  // and what is not a colour stays not a colour, asked twice
  assert.equal(cssColorStraight('not-a-colour'), null);
  assert.equal(cssColorStraight('not-a-colour'), null);
  assert.equal(cssColorStraight('#1234567'), null);
  assert.equal(cssColorStraight(42), null);
});

test('more spellings than the cache holds all still parse', () => {
  const red = (i) => i % 256;
  const green = (i) => (i >> 8) % 256;
  const spellings = Array.from({ length: 2000 }, (_, i) => `rgb(${red(i)}, ${green(i)}, 7)`);
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < spellings.length; i++) {
      const want = [red(i) / 255, green(i) / 255, 7 / 255, 1];
      assert.deepEqual(cssColorStraight(spellings[i]), want);
    }
  }
});

const parsesTo = (value, want) => {
  const got = cssColorStraight(value);
  assert.ok(got, `${value} is a colour`);
  assert.ok(
    got.every((v, i) => Math.abs(v - want[i]) < 1e-9),
    `${value}: got [${got}], want [${want}]`
  );
};

test("CSS Color 4's rgb() and hsl(): spaces, a slash before the alpha, none", () => {
  parsesTo('rgb(255 128 0)', [1, 128 / 255, 0, 1]);
  parsesTo('rgb(255 128 0 / 50%)', [1, 128 / 255, 0, 0.5]);
  parsesTo('rgba(0 0 0/.25)', [0, 0, 0, 0.25]);
  parsesTo('rgb(100% 50% 0%)', [1, 0.5, 0, 1]);
  // `none` is a component left out, which is zero
  parsesTo('rgb(none 255 none / none)', [0, 1, 0, 0]);
  parsesTo('hsl(120 100% 50%)', [0, 1, 0, 1]);
  parsesTo('hsl(240deg 100% 50% / 0.5)', [0, 0, 1, 0.5]);
  // …and saturation and lightness as bare numbers, which mean percentages
  parsesTo('hsl(0 100 50)', [1, 0, 0, 1]);
});

test('an rgb() percentage is a percentage, and nothing is out of range', () => {
  // parse-color read 100% as a byte of 100: 39% red
  parsesTo('rgb(100%, 0%, 0%)', [1, 0, 0, 1]);
  parsesTo('rgba(0, 0, 0, 50%)', [0, 0, 0, 0.5]);
  // clamped as CSS clamps; a component past 1 reached XRender as it was
  parsesTo('rgb(300, -5, 0)', [1, 0, 0, 1]);
  parsesTo('rgba(0, 0, 0, 2)', [0, 0, 0, 1]);
  parsesTo('rgb(0 0 0 / -1)', [0, 0, 0, 0]);
});

test('a hue takes any angle unit, and goes round', () => {
  for (const hue of ['120', '120deg', '133.333grad', `${(2 * Math.PI) / 3}rad`, '0.3333turn', '-240', '480']) {
    const [r, g, b] = cssColorStraight(`hsl(${hue} 100% 50%)`);
    assert.deepEqual([r, g, b], [0, 1, 0], hue);
  }
});

test("colour names and functions are case-insensitive, as CSS's are", () => {
  parsesTo('TOMATO', [1, 99 / 255, 71 / 255, 1]);
  parsesTo('RebeccaPurple', [0.4, 0.2, 0.6, 1]);
  parsesTo('RGB(255, 0, 0)', [1, 0, 0, 1]);
  parsesTo('HSLA(120, 100%, 50%, .5)', [0, 1, 0, 0.5]);
});

test('what CSS does not read is still not a colour', () => {
  for (const value of [
    'rgb(255 0 0 0.5)', // an alpha needs its slash
    'rgb(255 0)',
    'rgb(255 0 0 / 0.5 / 1)',
    'rgb(255, 0, 0',
    'rgb(NaN 0 0)',
    'hsl(120px 100% 50%)',
    'currentcolor'
  ]) {
    assert.equal(cssColorStraight(value), null, value);
  }
});

test('the modern syntax paints what it says', async () => {
  near(
    await over('#000', (ctx) => {
      ctx.fillStyle = 'rgb(255 0 0 / 50%)';
    }),
    [128, 0, 0],
    'half red over black'
  );
  near(
    await over('#000', (ctx) => {
      ctx.fillStyle = 'hsl(240 100% 50%)';
    }),
    [0, 0, 255],
    'hsl blue'
  );
});

test('a colour string paints with one picture, however often it is set', () => {
  // by its spelling (App#styleSolid), over the solid the numbers name
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'rgba(10, 20, 30, 0.5)';
  const first = ctx._backgroundPicture;
  ctx.fillStyle = '#000';
  ctx.fillStyle = 'rgba(10, 20, 30, 0.5)';
  assert.equal(ctx._backgroundPicture, first);
  // another spelling of the same colour is the same solid
  ctx.strokeStyle = 'rgba(10,20,30,0.5)';
  assert.equal(ctx._strokePicture, first);
  // and a string that is not a colour throws every time it is set
  for (let i = 0; i < 2; i++) {
    assert.throws(() => {
      ctx.fillStyle = 'not-a-colour';
    }, /Not a color/);
  }
});

test('the pictures a colour string names go with the connection', async () => {
  // freed on close with every other solid, so neither index may outlive them
  const server = xserver.createServer({ width: 100, height: 100 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const other = await createClient({
    stream: clientEnd,
    fontSource: new StaticFontSource()
  });
  const pixmap = other.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'rgb(1, 2, 3)';
  assert.ok(other._solidByName.has('rgb(1, 2, 3)'));
  // and one let go of in the job that closes, which would be freed when
  // the job has run, is freed with them
  other._styleSolidLimit = 0;
  const gone = ctx._backgroundPicture;
  ctx.fillStyle = 'rgb(4, 5, 6)';
  assert.ok(other._evictedSolids.includes(gone));
  await other.close();
  assert.equal(other._solidByName.size, 0);
  assert.equal(other._solidPictures.size, 0);
  assert.equal(other._styleSolids.size, 0);
  assert.equal(other._evictedSolids.length, 0);
  assert.equal(gone._owned, false, 'freed, not only forgotten');
});
