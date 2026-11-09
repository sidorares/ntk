// Canvas's blend modes, `multiply` to `luminosity`, are RENDER 0.11's blend
// operators. The context takes the names only where the server has them, so
// a caller that reads one back knows it will be drawn — CSS mix-blend-mode is
// drawn that way — and everything that draws composites with them: fills,
// strokes, text, images and a surface drawn whole.
//
// What a server draws for an opaque colour over an opaque one is the blend
// function of the two, which `OPAQUE` holds as Xvfb (pixman) drew it. pixman
// runs color-dodge, color-burn, soft-light and the four HSL modes in single
// floats, and node-x11's in-process server in doubles, so those can be a
// level apart: every comparison here allows one.
//
// Hermetic: node-x11's in-process pure-JS X server + the fixture font.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource, Surface } from '../lib/index.js';

const VF = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'MonelogicsSubset[wght].ttf');

const W = 60;
const H = 40;
const BACKDROP = '#cc6633';
const COLOUR = '#3366cc';

// COLOUR over BACKDROP, both opaque, as pixman composites each mode
const OPAQUE = {
  multiply: [0x29, 0x29, 0x29],
  screen: [0xd6, 0xa3, 0xd6],
  overlay: [0xad, 0x52, 0x52],
  darken: [0x33, 0x66, 0x33],
  lighten: [0xcc, 0x66, 0xcc],
  'color-dodge': [0xff, 0xaa, 0xff],
  'color-burn': [0x00, 0x00, 0x00],
  'hard-light': [0x52, 0x52, 0xad],
  'soft-light': [0xb4, 0x5a, 0x59],
  difference: [0x99, 0x00, 0x99],
  exclusion: [0xad, 0x7a, 0xad],
  hue: [0x50, 0x83, 0xe9],
  saturation: [0xcc, 0x66, 0x33],
  color: [0x50, 0x83, 0xe9],
  luminosity: [0xaf, 0x49, 0x16]
};
const BLENDS = Object.keys(OPAQUE);
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

let server = null;
let app = null;
const errors = [];

before(async () => {
  server = xserver.createServer({ width: 320, height: 240 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(VF), { family: 'Fixture' });
  app = await createClient({
    stream: clientEnd,
    fontSource,
    onXError: (err) => errors.push(err)
  });
});

after(async () => {
  assert.deepEqual(errors, [], 'no request the server refused');
  if (app) await app.close();
});

/** `draw` on a canvas of `backdrop`, read back as straight RGBA */
async function paint(draw, { backdrop = BACKDROP, depth = 24 } = {}) {
  const pixmap = app.createPixmap({ width: W, height: H, depth });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = backdrop;
  ctx.fillRect(0, 0, W, H);
  draw(ctx);
  const image = await ctx.getImageData(0, 0, W, H);
  ctx.destroy();
  pixmap.destroy();
  return image.data;
}

const at = (data, x, y) => [...data.slice((y * W + x) * 4, (y * W + x) * 4 + 3)];

function near(got, want, label, slack = 1) {
  const off = got.some((v, i) => Math.abs(v - want[i]) > slack);
  assert.ok(!off, `${label}: ${JSON.stringify(got)}, not within ${slack} of ${JSON.stringify(want)}`);
}

/** with the server's RENDER version reading as `version` for the while */
function withRenderVersion(version, fn) {
  const R = app.display.Render;
  const was = R.version;
  R.version = version;
  try {
    return fn();
  } finally {
    R.version = was;
  }
}

describe('the names', () => {
  test('every blend mode is taken where the server has RENDER 0.11', () => {
    const pixmap = app.createPixmap({ width: 4, height: 4, depth: 24 });
    const ctx = pixmap.getContext('2d');
    for (const mode of BLENDS) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalCompositeOperation = mode;
      assert.equal(ctx.globalCompositeOperation, mode);
    }
    ctx.destroy();
    pixmap.destroy();
  });

  test('below 0.11 none of them is, and the op stays what it was', () => {
    const pixmap = app.createPixmap({ width: 4, height: 4, depth: 24 });
    const ctx = pixmap.getContext('2d');
    withRenderVersion([0, 10], () => {
      ctx.globalCompositeOperation = 'xor';
      for (const mode of BLENDS) {
        ctx.globalCompositeOperation = mode;
        assert.equal(ctx.globalCompositeOperation, 'xor', mode);
      }
      // and the Porter-Duff ones still are
      ctx.globalCompositeOperation = 'lighter';
      assert.equal(ctx.globalCompositeOperation, 'lighter');
    });
    ctx.destroy();
    pixmap.destroy();
  });

  test('a name canvas does not have is ignored, an inherited one too', () => {
    const pixmap = app.createPixmap({ width: 4, height: 4, depth: 24 });
    const ctx = pixmap.getContext('2d');
    ctx.globalCompositeOperation = 'multiply';
    for (const name of ['normal', 'Multiply', 'toString', 'constructor', '', null]) {
      ctx.globalCompositeOperation = name;
      assert.equal(ctx.globalCompositeOperation, 'multiply', String(name));
    }
    ctx.destroy();
    pixmap.destroy();
  });

  test('save() and restore() keep a blend mode as they keep any op', () => {
    const pixmap = app.createPixmap({ width: 4, height: 4, depth: 24 });
    const ctx = pixmap.getContext('2d');
    ctx.globalCompositeOperation = 'screen';
    ctx.save();
    ctx.globalCompositeOperation = 'difference';
    ctx.restore();
    assert.equal(ctx.globalCompositeOperation, 'screen');
    ctx.destroy();
    pixmap.destroy();
  });
});

describe('the pixels', () => {
  for (const mode of BLENDS) {
    test(`${mode}: an opaque colour over an opaque one`, async () => {
      const data = await paint((ctx) => {
        ctx.globalCompositeOperation = mode;
        ctx.fillStyle = COLOUR;
        ctx.fillRect(10, 10, 20, 20);
      });
      near(at(data, 20, 20), OPAQUE[mode], mode);
      assert.deepEqual(at(data, 5, 5), rgb(BACKDROP), `${mode}: outside the fill`);
    });
  }

  test('a gray pill multiplied over a word leaves the word black, and screen leaves it white', async () => {
    // vercel.com's "New" badges: an absolutely positioned pill painted after
    // the word it marks, multiply in the light theme and screen in the dark
    const light = await paint(
      (ctx) => {
        ctx.fillStyle = '#000';
        ctx.fillRect(10, 15, 20, 10); // the word
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = '#eaeaea';
        ctx.fillRect(5, 10, 40, 20); // the pill
      },
      { backdrop: '#fff' }
    );
    assert.deepEqual(at(light, 20, 20), [0, 0, 0], 'the word under the pill');
    assert.deepEqual(at(light, 7, 20), [0xea, 0xea, 0xea], 'the pill beside it');
    assert.deepEqual(at(light, 50, 20), [0xff, 0xff, 0xff], 'the page');

    const dark = await paint(
      (ctx) => {
        ctx.fillStyle = '#fff';
        ctx.fillRect(10, 15, 20, 10);
        ctx.globalCompositeOperation = 'screen';
        ctx.fillStyle = '#333';
        ctx.fillRect(5, 10, 40, 20);
      },
      { backdrop: '#000' }
    );
    assert.deepEqual(at(dark, 20, 20), [0xff, 0xff, 0xff], 'the word under the pill');
    assert.deepEqual(at(dark, 7, 20), [0x33, 0x33, 0x33], 'the pill beside it');
    assert.deepEqual(at(dark, 50, 20), [0, 0, 0], 'the page');
  });

  // Each way a drawing reaches the surface, `mode` on the context, and a
  // point it covers whole. What lands there is the blend of COLOUR and the
  // backdrop, or under `alpha` that far towards it from the backdrop.
  const ROUTES = {
    fillRect: (ctx) => {
      ctx.fillStyle = COLOUR;
      ctx.fillRect(10, 8, 40, 24);
    },
    'fillRect off the pixel grid': (ctx) => {
      ctx.fillStyle = COLOUR;
      ctx.fillRect(10.4, 8.6, 40, 24);
    },
    fillRects: (ctx) => {
      ctx.fillStyle = COLOUR;
      ctx.fillRects([
        [10, 8, 15, 24],
        [25, 8, 25, 24]
      ]);
    },
    fill: (ctx) => {
      ctx.fillStyle = COLOUR;
      ctx.beginPath();
      ctx.arc(30, 20, 16, 0, Math.PI * 2);
      ctx.fill();
    },
    stroke: (ctx) => {
      ctx.strokeStyle = COLOUR;
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.moveTo(4, 20);
      ctx.lineTo(56, 20);
      ctx.stroke();
    },
    'a surface drawn whole': (ctx) => {
      const group = new Surface(app, { width: 40, height: 24 });
      group.render((g) => {
        g.fillStyle = COLOUR;
        g.fillRect(0, 0, 40, 24);
      });
      ctx.drawImage(group, 10, 8);
      group.destroy();
    },
    'a surface drawn scaled': (ctx) => {
      const group = new Surface(app, { width: 20, height: 12 });
      group.render((g) => {
        g.fillStyle = COLOUR;
        g.fillRect(0, 0, 20, 12);
      });
      ctx.drawImage(group, 10, 8, 40, 24);
      group.destroy();
    },
    'a surface drawn turned': (ctx) => {
      const group = new Surface(app, { width: 40, height: 24 });
      group.render((g) => {
        g.fillStyle = COLOUR;
        g.fillRect(0, 0, 40, 24);
      });
      ctx.translate(30, 20);
      ctx.rotate(0.3);
      ctx.drawImage(group, -20, -12);
      group.destroy();
    }
  };
  const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

  for (const [route, draw] of Object.entries(ROUTES)) {
    for (const mode of ['multiply', 'screen', 'hue']) {
      test(`${route}, ${mode}`, async () => {
        const plain = await paint((ctx) => {
          ctx.globalCompositeOperation = mode;
          draw(ctx);
        });
        near(at(plain, 30, 20), OPAQUE[mode], `${route}, ${mode}`);
        assert.deepEqual(at(plain, 1, 1), rgb(BACKDROP), `${route}, ${mode}: away from the drawing`);

        const faded = await paint((ctx) => {
          ctx.globalCompositeOperation = mode;
          ctx.globalAlpha = 0.5;
          draw(ctx);
        });
        near(at(faded, 30, 20), lerp(rgb(BACKDROP), OPAQUE[mode], 0.5), `${route}, ${mode}, at half alpha`, 2);

        // under a path clip, folded into the drawing's mask: inside it the
        // blend, outside it the backdrop, as after the op
        const clipped = await paint((ctx) => {
          ctx.beginPath();
          ctx.rect(26, 0, 30, H);
          ctx.arc(26, 20, 6, 0, Math.PI * 2);
          ctx.clip();
          ctx.globalCompositeOperation = mode;
          draw(ctx);
        });
        near(at(clipped, 30, 20), OPAQUE[mode], `${route}, ${mode}, inside a path clip`);
        assert.deepEqual(at(clipped, 14, 20), rgb(BACKDROP), `${route}, ${mode}: outside the clip`);
      });
    }
  }

  test('text takes a blend mode', async () => {
    const data = await paint((ctx) => {
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = '#000';
      ctx.font = '30px Fixture';
      ctx.fillText('HH', 4, 32);
    });
    const ink = [];
    for (let x = 0; x < W; x++) ink.push(at(data, x, 20));
    // black multiplied over anything is black, and the rest is the backdrop
    assert.ok(ink.some((p) => p.every((v) => v === 0)), 'some of the letters is black');
    assert.ok(
      ink.every((p) => p.every((v, i) => v <= rgb(BACKDROP)[i])),
      'nothing multiplied comes out lighter than the backdrop'
    );
  });

  test('a path of scattered pieces is masked as its pieces, as for source-over', () => {
    // a blend mode leaves the destination as it was where the mask is zero,
    // so the gaps between the pieces need no mask (maskcluster.js)
    const stats = {};
    for (const mode of ['source-over', ...BLENDS]) {
      const pixmap = app.createPixmap({ width: 300, height: 200, depth: 24 });
      const ctx = pixmap.getContext('2d');
      ctx.globalCompositeOperation = mode;
      ctx.fillStyle = COLOUR;
      ctx.beginPath();
      ctx.arc(10, 10, 6, 0, Math.PI * 2);
      ctx.closePath();
      ctx.moveTo(291, 185);
      ctx.arc(285, 185, 6, 0, Math.PI * 2);
      ctx.closePath();
      ctx.fill();
      stats[mode] = { ...ctx.maskStats };
      ctx.destroy();
      pixmap.destroy();
    }
    assert.equal(stats['source-over'].split, 1, 'source-over splits the mask');
    for (const mode of BLENDS) assert.deepEqual(stats[mode], stats['source-over'], mode);
  });

  test('onto a surface with alpha, a blend over transparency is the colour', async () => {
    // over a transparent backdrop every blend mode is the source itself
    const surface = new Surface(app, { width: 8, height: 8 });
    const ctx = surface.getContext('2d');
    for (const [i, mode] of ['multiply', 'difference', 'luminosity'].entries()) {
      ctx.globalCompositeOperation = mode;
      ctx.fillStyle = COLOUR;
      ctx.fillRect(i * 2, 0, 2, 8);
    }
    const data = await ctx.getImageData(0, 0, 8, 8);
    for (let x = 0; x < 6; x++) {
      assert.deepEqual([...data.data.slice(x * 4, x * 4 + 4)], [...rgb(COLOUR), 255], `column ${x}`);
    }
    ctx.destroy();
    surface.destroy();
  });
});
