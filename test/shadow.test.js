// Canvas shadows (issue #272): the four properties, and the coverage
// surface + separable gaussian behind them.
//
// The kernel maths is asserted on its own (no X at all), and everything else
// runs against node-x11's in-process pure-JS X server, which implements the
// convolution filter — so the blur is checked as *pixels*, including the one
// number that decides whether a shadow looks like a browser's: shadowBlur is
// a diameter, and the gaussian it names has sigma = blur / 2.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource, Surface } from '../lib/index.js';
import {
  DEFAULT_SHADOW_POLICY,
  gaussianKernel1d,
  shadowReach,
  shadowSigma
} from '../lib/shadow.js';

const require = createRequire(import.meta.url);
const fontDir = join(dirname(require.resolve('katex/package.json')), 'dist', 'fonts');

const W = 120;
const H = 80;

let app = null;

before(async () => {
  const server = xserver.createServer({ width: 200, height: 200 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), { family: 'Test Main' });
  fontSource.alias('sans-serif', 'Test Main');
  app = await createClient({ stream: clientEnd, fontSource });
});

after(async () => {
  await app?.close();
});

/** a transparent depth-32 target and its context */
function target(w = W, h = H) {
  const pixmap = app.createPixmap({ width: w, height: h, depth: 32 });
  const ctx = pixmap.getContext('2d');
  const R = app.display.Render;
  R.FillRectangles(R.PictOp.Src, ctx.picture.id, [0, 0, 0, 0], [0, 0, w, h]);
  return ctx;
}

const readAll = async (ctx, w = W, h = H) => {
  const img = await ctx.getImageData(0, 0, w, h);
  return (x, y) => [...img.data.slice((y * w + x) * 4, (y * w + x) * 4 + 4)];
};

// ------------------------------------------------------------------
// the mapping, on its own

describe('the blur a shadowBlur asks for', () => {
  test('shadowBlur is a diameter: sigma is half of it', () => {
    assert.equal(shadowSigma(8), 4);
    assert.equal(shadowSigma(0), 0);
    assert.equal(shadowSigma(1), 0.5);
  });

  test('sigma is capped, so a kernel cannot grow without bound', () => {
    const max = DEFAULT_SHADOW_POLICY.maxSigma;
    assert.equal(shadowSigma(max * 4), max);
    assert.equal(shadowReach(shadowSigma(max * 4)), Math.ceil(max * 3));
  });

  test('the kernel is normalized, symmetric and 3 sigma wide', () => {
    const kernel = gaussianKernel1d(4);
    assert.equal(kernel.length, 2 * 12 + 1, '3 sigma each side');
    const sum = kernel.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-12, `sums to 1, got ${sum}`);
    for (let i = 0; i < kernel.length; i++) {
      assert.equal(kernel[i], kernel[kernel.length - 1 - i], 'symmetric');
    }
  });

  test('the kernel really has the standard deviation it claims', () => {
    // The truncated kernel's own second moment: what the server convolves
    // with, not the ideal gaussian it was sampled from.
    const sigma = 5;
    const kernel = gaussianKernel1d(sigma);
    const reach = (kernel.length - 1) / 2;
    let variance = 0;
    for (let i = 0; i < kernel.length; i++) variance += kernel[i] * (i - reach) ** 2;
    // 1% under the ideal: what truncating at 3 sigma and renormalizing costs
    assert.ok(
      Math.abs(Math.sqrt(variance) - sigma) < 0.1,
      `sigma ${Math.sqrt(variance)} should be ~${sigma}`
    );
  });
});

// ------------------------------------------------------------------
// the properties

describe('shadow properties', () => {
  test('default to no shadow at all', () => {
    const ctx = target();
    assert.equal(ctx.shadowBlur, 0);
    assert.equal(ctx.shadowOffsetX, 0);
    assert.equal(ctx.shadowOffsetY, 0);
    assert.equal(ctx.shadowColor, 'rgba(0, 0, 0, 0)');
    ctx.destroy();
  });

  test('invalid values are ignored, not thrown or coerced', () => {
    const ctx = target();
    ctx.shadowBlur = 4;
    ctx.shadowColor = '#f00';
    ctx.shadowOffsetX = 3;
    ctx.shadowBlur = -1;
    ctx.shadowBlur = NaN;
    ctx.shadowColor = 'not-a-colour';
    ctx.shadowOffsetX = Infinity;
    assert.equal(ctx.shadowBlur, 4);
    assert.equal(ctx.shadowColor, '#f00');
    assert.equal(ctx.shadowOffsetX, 3);
    ctx.destroy();
  });

  test('save/restore carries them', () => {
    const ctx = target();
    ctx.shadowColor = '#00f';
    ctx.shadowBlur = 2;
    ctx.save();
    ctx.shadowColor = '#0f0';
    ctx.shadowBlur = 9;
    ctx.shadowOffsetY = 4;
    ctx.restore();
    assert.equal(ctx.shadowColor, '#00f');
    assert.equal(ctx.shadowBlur, 2);
    assert.equal(ctx.shadowOffsetY, 0);
    ctx.destroy();
  });
});

// ------------------------------------------------------------------
// pixels

describe('drawing a shadow', () => {
  test('a transparent shadowColor changes nothing', async () => {
    const ctx = target();
    ctx.shadowBlur = 8;
    ctx.shadowOffsetX = 10;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(20, 20, 20, 20);
    const at = await readAll(ctx);
    assert.deepEqual(at(30, 30), [255, 0, 0, 255], 'the rect itself');
    assert.deepEqual(at(45, 45), [0, 0, 0, 0], 'where the shadow would be');
    ctx.destroy();
  });

  test('an unblurred shadow is the shape, offset and recoloured', async () => {
    const ctx = target();
    ctx.shadowColor = '#0000ff';
    ctx.shadowOffsetX = 12;
    ctx.shadowOffsetY = 8;
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(20, 20, 20, 20);
    const at = await readAll(ctx);
    assert.deepEqual(at(30, 30), [255, 0, 0, 255], 'the shape is drawn over its shadow');
    assert.deepEqual(at(50, 45), [0, 0, 255, 255], 'the shadow is offset by (12, 8)');
    assert.deepEqual(at(38, 25), [255, 0, 0, 255], 'the overlap belongs to the shape');
    assert.deepEqual(at(19, 19), [0, 0, 0, 0], 'nothing before the shape');
    assert.deepEqual(at(53, 49), [0, 0, 0, 0], 'nothing past the shadow');
    ctx.destroy();
  });

  test('the blur has the profile of a gaussian with sigma = blur / 2', async () => {
    // A half-plane's blurred edge is the gaussian's cumulative distribution,
    // so the coverage at the edge is 0.5 and at n sigma either side is
    // Phi(-n). That is the whole browser-compatibility claim, in pixels.
    const blur = 8;
    const sigma = blur / 2;
    const ctx = target();
    ctx.shadowColor = '#000000';
    ctx.shadowBlur = blur;
    ctx.fillStyle = 'rgba(0, 0, 0, 0)'; // shape invisible: only the shadow shows
    // starts off the left edge, so the only edge in view is the one at x=40
    ctx.fillRect(-30, 0, 70, H);
    const at = await readAll(ctx);
    const alphaAt = (x) => at(x, H / 2)[3] / 255;
    // the edge is between pixel 39 and 40; sample pixel centres either side
    const expected = [
      [40 - 2 * sigma, 0.977],
      [40 - sigma, 0.841],
      [40, 0.5],
      [40 + sigma, 0.159],
      [40 + 2 * sigma, 0.023]
    ];
    for (const [x, want] of expected) {
      const got = alphaAt(Math.round(x));
      assert.ok(
        Math.abs(got - want) < 0.06,
        `coverage at x=${x} is ${got.toFixed(3)}, expected ~${want}`
      );
    }
    assert.ok(alphaAt(5) > 0.99, 'the interior stays fully covered');
    assert.ok(alphaAt(40 + Math.ceil(3 * sigma) + 2) < 0.01, 'and it ends');
    ctx.destroy();
  });

  test('a blurred shadow spreads on every side, not just into the offset', async () => {
    const ctx = target();
    ctx.shadowColor = '#000000';
    ctx.shadowBlur = 6;
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillRect(40, 30, 20, 20);
    const at = await readAll(ctx);
    for (const [x, y, what] of [
      [50, 26, 'above'],
      [50, 53, 'below'],
      [36, 40, 'left'],
      [63, 40, 'right']
    ]) {
      assert.ok(at(x, y)[3] > 10, `${what} of the rect has shadow, got ${at(x, y)[3]}`);
    }
    ctx.destroy();
  });

  test('globalAlpha scales the shadow, and the clip clips it', async () => {
    const ctx = target();
    ctx.shadowColor = '#000000';
    ctx.shadowOffsetX = 15;
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(20, 20, 20, 20);
    let at = await readAll(ctx);
    assert.ok(
      Math.abs(at(50, 30)[3] - 128) <= 1,
      `the shadow is composited at globalAlpha, got ${at(50, 30)[3]}`
    );
    ctx.destroy();

    const clipped = target();
    clipped.shadowColor = '#000000';
    clipped.shadowOffsetX = 15;
    clipped.beginPath();
    clipped.rect(0, 0, 45, H);
    clipped.clip();
    clipped.fillStyle = '#ff0000';
    clipped.fillRect(20, 20, 20, 20);
    at = await readAll(clipped);
    assert.equal(at(44, 30)[3], 255, 'inside the clip');
    assert.deepEqual(at(46, 30), [0, 0, 0, 0], 'the shadow stops at the clip');
    clipped.destroy();
  });

  test('a stroke casts one too, and it follows the line width', async () => {
    const ctx = target();
    ctx.shadowColor = '#000000';
    ctx.shadowOffsetY = 20;
    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(20, 20);
    ctx.lineTo(90, 20);
    ctx.stroke();
    const at = await readAll(ctx);
    assert.ok(at(50, 20)[0] > 200, 'the line');
    assert.ok(at(50, 40)[3] > 200, 'its shadow, 20px below');
    assert.ok(at(50, 42)[3] > 200, 'as thick as the line');
    assert.equal(at(50, 46)[3], 0, 'and no thicker');
    ctx.destroy();
  });

  test('an image casts the shadow of its own alpha', async () => {
    // a surface with a transparent right half: the shadow must have one too
    const tile = new Surface(app, { width: 20, height: 20 });
    tile.render((c) => {
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, 10, 20);
    });
    const ctx = target();
    ctx.shadowColor = '#000000';
    ctx.shadowOffsetX = 30;
    ctx.drawImage(tile, 20, 20);
    const at = await readAll(ctx);
    assert.equal(at(55, 30)[3], 255, 'the shadow of the drawn half');
    assert.equal(at(65, 30)[3], 0, 'nothing where the image was transparent');
    tile.destroy();
    ctx.destroy();
  });

  test('a shadow with no offset and no blur still shows under a translucent shape', async () => {
    const ctx = target();
    ctx.shadowColor = '#0000ff';
    ctx.fillStyle = 'rgba(255, 0, 0, 0.5)';
    ctx.fillRect(20, 20, 20, 20);
    const at = await readAll(ctx);
    const [r, g, b, a] = at(30, 30);
    assert.equal(a, 255, 'shape over shadow is opaque');
    assert.ok(r > 100 && b > 100 && g < 20, `red over blue, got ${[r, g, b]}`);
    ctx.destroy();
  });
});

// ------------------------------------------------------------------
// text, and the cache it earns

describe('text shadows', () => {
  test('the glyphs cast one, offset from the text', async () => {
    const ctx = target();
    ctx.font = '30px sans-serif';
    ctx.shadowColor = '#0000ff';
    ctx.shadowOffsetX = 4;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = '#ff0000';
    ctx.fillText('II', 20, 50);
    const img = await ctx.getImageData(0, 0, W, H);
    let red = 0;
    let blue = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i] > 128 && img.data[i + 2] < 128) red++;
      if (img.data[i + 2] > 128 && img.data[i] < 128) blue++;
    }
    assert.ok(red > 20, `the glyphs are drawn (${red} red pixels)`);
    assert.ok(blue > 20, `and shadowed (${blue} blue pixels)`);
    ctx.destroy();
  });

  test('the same text, font and blur is built once and kept', async () => {
    app._shadowSurfaces?.clear(); // other tests in this file drew text too
    const ctx = target();
    ctx.font = '20px sans-serif';
    ctx.shadowColor = '#000000';
    ctx.shadowBlur = 4;
    ctx.fillText('cached', 10, 30);
    const built = app._shadowSurfaces.size;
    const [surface] = [...app._shadowSurfaces.values()];
    assert.equal(built, 1, 'one coverage surface');

    ctx.fillText('cached', 40, 60); // same string, different place
    assert.equal(app._shadowSurfaces.size, 1, 'the second draw reuses it');
    assert.equal([...app._shadowSurfaces.values()][0], surface, 'the same one');

    ctx.shadowBlur = 9; // a different blur is a different shadow
    ctx.fillText('cached', 10, 30);
    assert.equal(app._shadowSurfaces.size, 2);
    ctx.destroy();
    app._shadowSurfaces.clear();
  });

  test('the cache stays inside its budget', async () => {
    const ctx = target();
    ctx.font = '20px sans-serif';
    ctx.shadowColor = '#000000';
    app._shadowSurfaces?.clear();
    app.shadowPolicy = { cacheBytes: 4096 };
    for (const word of ['one', 'two', 'three', 'four', 'five']) {
      ctx.fillText(word, 10, 30);
    }
    let bytes = 0;
    for (const surface of app._shadowSurfaces.values()) bytes += surface.bytes;
    assert.ok(bytes <= 4096, `${bytes} bytes retained, budget 4096`);
    assert.ok(app._shadowSurfaces.size >= 1, 'the last one drawn is still there');
    delete app.shadowPolicy;
    app._shadowSurfaces.clear();
    ctx.destroy();
  });
});

// ------------------------------------------------------------------
// text that went through a layout, which is a different drawing path
// (issue #283): TextLayout.draw composites through drawGlyphs, which used
// to be the one text call that ignored the shadow state

describe('shadows on laid-out text', () => {
  /** how many pixels are mostly-blue (the shadow) / mostly-red (the text) */
  const tally = (img) => {
    let red = 0;
    let blue = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i] > 128 && img.data[i + 2] < 128) red++;
      if (img.data[i + 2] > 128 && img.data[i] < 128) blue++;
    }
    return { red, blue };
  };

  const shadowedText = (ctx) => {
    ctx.font = '20px sans-serif';
    ctx.shadowColor = '#0000ff';
    ctx.shadowOffsetX = 4;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = '#ff0000';
  };

  test('the same string shadows the same drawn either way', async () => {
    const direct = target();
    shadowedText(direct);
    direct.fillText('Hi there', 10, 40);
    const one = tally(await direct.getImageData(0, 0, W, H));

    const laid = target();
    shadowedText(laid);
    const layout = laid.layoutText('Hi there');
    // layout.draw takes the box's top-left; fillText takes the baseline
    layout.draw(laid, 10, 40 - layout.lines[0].baseline);
    const two = tally(await laid.getImageData(0, 0, W, H));

    assert.ok(one.blue > 20, `fillText is shadowed (${one.blue} blue pixels)`);
    assert.ok(two.blue > 20, `and so is the layout (${two.blue} blue pixels)`);
    assert.ok(two.red > 20, 'the glyphs themselves are still drawn');
    assert.ok(
      Math.abs(one.blue - two.blue) <= one.blue * 0.15,
      `the two shadows are the same size (${one.blue} vs ${two.blue})`
    );
    direct.destroy();
    laid.destroy();
  });

  test('every line of a wrapped paragraph casts one', async () => {
    const ctx = target();
    shadowedText(ctx);
    ctx.font = '16px sans-serif';
    const layout = ctx.layoutText('one two three four', { maxWidth: 60 });
    assert.ok(layout.lines.length > 1, `the text wrapped (${layout.lines.length} lines)`);
    layout.draw(ctx, 8, 8);
    const img = await ctx.getImageData(0, 0, W, H);
    const blueIn = (y0, y1) => {
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          if (img.data[i + 2] > 128 && img.data[i] < 128) n++;
        }
      }
      return n;
    };
    const mid = Math.round(8 + layout.height / 2);
    assert.ok(blueIn(0, mid) > 10, 'the first line is shadowed');
    assert.ok(blueIn(mid, H) > 10, 'and so is the last');
    ctx.destroy();
  });

  test('the transform carries the shadow with the text', async () => {
    const ctx = target();
    shadowedText(ctx);
    ctx.font = '16px sans-serif';
    ctx.translate(40, 30);
    ctx.layoutText('Hi').draw(ctx, 0, 0);
    const img = await ctx.getImageData(0, 0, W, H);
    let blue = 0;
    let minX = W;
    let minY = H;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (img.data[i + 2] > 128 && img.data[i] < 128) {
          blue++;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
        }
      }
    }
    assert.ok(blue > 10, `the layout is shadowed (${blue} blue pixels)`);
    // the shadow of a translated drawing is translated too, not left at the
    // untransformed origin (the bug #280 fixed for the glyphs themselves)
    assert.ok(minX >= 38, `shadow starts at x=${minX}, past the translation`);
    assert.ok(minY >= 28, `shadow starts at y=${minY}, past the translation`);
    ctx.destroy();
  });

  test('one coverage surface for the whole paragraph, kept across draws', async () => {
    app._shadowSurfaces?.clear();
    const ctx = target();
    ctx.font = '16px sans-serif';
    ctx.shadowColor = '#000000';
    ctx.shadowBlur = 4;
    const text = 'one two three four';
    const layout = ctx.layoutText(text, { maxWidth: 60 });
    assert.ok(layout.lines.length > 1);
    layout.draw(ctx, 8, 8);
    assert.equal(app._shadowSurfaces.size, 1, 'one surface, not one per line');
    const [surface] = [...app._shadowSurfaces.values()];

    layout.draw(ctx, 30, 20); // the same paragraph elsewhere
    assert.equal(app._shadowSurfaces.size, 1, 'the second draw reuses it');
    assert.equal([...app._shadowSurfaces.values()][0], surface, 'the same one');

    // the same text at another width is another shadow: same runs, but the
    // lines they sit on are not the same lines
    ctx.layoutText(text, { maxWidth: 110 }).draw(ctx, 8, 8);
    assert.equal(app._shadowSurfaces.size, 2);
    app._shadowSurfaces.clear();
    ctx.destroy();
  });

  test('no shadow colour, no shadow work', async () => {
    app._shadowSurfaces?.clear();
    const ctx = target();
    ctx.font = '16px sans-serif';
    ctx.layoutText('one two three', {}).draw(ctx, 8, 20);
    assert.equal(app._shadowSurfaces?.size ?? 0, 0);
    ctx.destroy();
  });
});
