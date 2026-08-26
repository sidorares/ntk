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

import {
  blurCoverage,
  blurScale,
  createClient,
  StaticFontSource,
  Surface
} from '../lib/index.js';
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

// ------------------------------------------------------------------
// how strong a blurred shadow gets (issue #287)

describe('how strong a blurred shadow gets', () => {
  // Issue #287 read a shadow as missing on this very server because nothing
  // on the canvas came within a tolerance of `shadowColor` itself. Nothing
  // was missing: a blurred shadow only *reaches* its colour where the shape
  // casting it is wide compared with the blur, and a glyph stem never is.
  // The numbers below are the ones that decided it, and they are the same on
  // Xorg (test/smoke-canvas.test.js pins the rect case there too).

  /** the shadow's own alpha, straight from getImageData, over the surface */
  const shadowAlpha = async (ctx, w, h) => {
    const img = await ctx.getImageData(0, 0, w, h);
    let peak = 0;
    let painted = 0;
    for (let i = 3; i < img.data.length; i += 4) {
      if (img.data[i] > 0) painted++;
      if (img.data[i] > peak) peak = img.data[i];
    }
    return { peak, painted };
  };

  test('a shape much wider than the blur reaches the shadow colour', async () => {
    const w = 180;
    const h = 140;
    const ctx = target(w, h);
    ctx.shadowColor = '#ff0000';
    ctx.shadowBlur = 30; // sigma 15, so a 60x40 rect is 4 sigma by 2.7
    ctx.fillStyle = 'rgba(0, 0, 0, 0)'; // only the shadow paints
    ctx.fillRect(60, 50, 60, 40);
    const { peak } = await shadowAlpha(ctx, w, h);
    // convolving that rect with the same kernel gives 0.784 of full alpha —
    // the interior is not opaque either, because 60x40 is not wide enough
    // for one, and the gaussian says exactly how much it keeps
    assert.ok(Math.abs(peak - 200) <= 4, `the middle of the shadow is ${peak}, expected ~200`);
    ctx.destroy();
  });

  test('the shadow of 48px glyphs peaks at about a third of it', async () => {
    const w = 200;
    const h = 120;
    const ctx = target(w, h);
    ctx.font = '48px sans-serif';
    ctx.shadowColor = '#ff0000';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetX = 5;
    ctx.shadowOffsetY = 5;
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillText('AAA', 10, 70);
    const { peak, painted } = await shadowAlpha(ctx, w, h);
    assert.ok(painted > 2000, `the shadow is there (${painted} painted pixels)`);
    // a 48px stem is about 5px wide against sigma 7: erf(5 / (2*sqrt(2)*7))
    // is 0.28, and two neighbouring stems add to a little over a third
    assert.ok(peak > 60 && peak < 140, `peak alpha ${peak}, expected ~94`);
    // which is why a test that looks for `shadowColor` itself finds nothing
    assert.ok(peak < 165, 'nothing on the canvas is within 90 of the colour');
    ctx.destroy();
  });
});

// ------------------------------------------------------------------
// the same blur, run on less of it (issue #338)

describe('a wide blur runs at reduced scale', () => {
  /** the alpha a coverage surface would paint, straight out of the server */
  const coverageAlpha = async (surface) => {
    const ctx = target(surface.width, surface.height);
    ctx.fillStyle = '#000000';
    ctx.drawImage(surface, 0, 0);
    const img = await ctx.getImageData(0, 0, surface.width, surface.height);
    ctx.destroy();
    const alpha = new Uint8Array(surface.width * surface.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = img.data[i * 4 + 3];
    return alpha;
  };

  /** a rect's coverage, padded by the blur's reach as the blur requires */
  const shapeFor = (sigma, w = 60, h = 40) => {
    const pad = shadowReach(sigma);
    const surface = new Surface(app, {
      width: w + 2 * pad,
      height: h + 2 * pad,
      format: 'a8'
    });
    surface.render((c) => {
      c.fillStyle = '#ffffff';
      c.fillRect(pad, pad, w, h);
    });
    return surface;
  };

  /** what went to the server: the kernels hung on pictures, and the
   * transforms, which are the whole visible signature of the shrink */
  const record = (fn) => {
    const R = app.display.Render;
    const filters = [];
    const transforms = [];
    const setFilter = R.SetPictureFilter;
    const setTransform = R.SetPictureTransform;
    R.SetPictureFilter = function (id, name, params) {
      filters.push({ name, params });
      return setFilter.apply(this, arguments);
    };
    R.SetPictureTransform = function (id, matrix) {
      transforms.push(matrix[0]);
      return setTransform.apply(this, arguments);
    };
    try {
      return { value: fn(), filters, transforms };
    } finally {
      R.SetPictureFilter = setFilter;
      R.SetPictureTransform = setTransform;
    }
  };

  const taps = (filters) => {
    const convolution = filters.filter((f) => f.name === 'convolution');
    assert.equal(convolution.length, 2, 'two separable passes, whatever the scale');
    // params are [width, height, ...kernel]: one pass is k x 1, the other 1 x k
    return Math.max(convolution[0].params[0], convolution[0].params[1]);
  };

  test('the scale is a power of two, bounded by a sigma floor and a cap', () => {
    // Nothing below 2 * scaleSigma moves: the two resampling composites
    // would cost more than the kernel they save.
    for (const sigma of [0.5, 2, 4, 6, 7.9]) assert.equal(blurScale(sigma), 1, `sigma ${sigma}`);
    for (const sigma of [8, 10, 12, 15.9]) assert.equal(blurScale(sigma), 2, `sigma ${sigma}`);
    for (const sigma of [16, 21, 32]) assert.equal(blurScale(sigma), 4, `sigma ${sigma}`);
    // the reduced sigma is what the floor is about, so it never goes under it
    for (const sigma of [8, 12, 21, 32]) {
      assert.ok(sigma / blurScale(sigma) >= DEFAULT_SHADOW_POLICY.scaleSigma);
    }
    // and the cap holds whatever the floor would allow
    assert.equal(blurScale(64, { ...DEFAULT_SHADOW_POLICY, maxScale: 8 }), 8);
    assert.equal(blurScale(64, { ...DEFAULT_SHADOW_POLICY, maxScale: 1 }), 1);
    assert.equal(blurScale(12, { ...DEFAULT_SHADOW_POLICY, scaleSigma: 12 }), 1);
    assert.equal(blurScale(12, { ...DEFAULT_SHADOW_POLICY, scaleSigma: 1 }), 4);
    assert.equal(blurScale(0), 1, 'no blur, nothing to scale');
  });

  test('a wide blur shrinks the coverage, blurs small, and resolves back', () => {
    const sigma = 21;
    const shape = shapeFor(sigma);
    const { width, height } = shape;
    const { value: blurred, filters, transforms } = record(() => blurCoverage(shape, sigma));
    // 4x: two halvings on the way down, one 1/4 on the way back up
    assert.deepEqual(transforms, [2, 2, 0.25]);
    assert.equal(
      filters.filter((f) => f.name === 'bilinear').length,
      3,
      'every resampling composite is bilinear'
    );
    // the kernel is the reduced one — 2 * ceil(3 * 21/4) + 1, not 127
    assert.equal(taps(filters), 2 * shadowReach(sigma / 4) + 1);
    assert.equal(taps(filters), 33);
    // and none of that is visible in what comes back
    assert.equal(blurred.width, width);
    assert.equal(blurred.height, height);
    assert.equal(blurred.format, 'a8');
    blurred.destroy();
  });

  test('and it is the same blur: three levels of alpha, at most', async () => {
    // The claim the whole thing rests on. A gaussian carries no detail finer
    // than about sigma/2 px, so resolving it at full resolution is work the
    // result cannot hold — but "cannot hold" has to mean pixels, not theory.
    // Three levels is the bound on a real server (test/smoke-canvas.test.js
    // asserts the same thing against Xorg); this one, whose bilinear is
    // exact arithmetic rather than fixed point, comes in at two.
    for (const sigma of [10, 15, 21, 32]) {
      const scale = blurScale(sigma);
      assert.ok(scale > 1, `sigma ${sigma} is scaled at all`);
      const exact = await coverageAlpha(blurCoverage(shapeFor(sigma), sigma, { scale: 1 }));
      const scaled = await coverageAlpha(blurCoverage(shapeFor(sigma), sigma));
      assert.equal(exact.length, scaled.length);
      let worst = 0;
      for (let i = 0; i < exact.length; i++) {
        worst = Math.max(worst, Math.abs(exact[i] - scaled[i]));
      }
      assert.ok(worst <= 3, `sigma ${sigma} at ${scale}x differs by ${worst} of 255`);
    }
  });

  test('the exact kernel is one option away, and one policy away', () => {
    const sigma = 21;
    const exact = record(() => blurCoverage(shapeFor(sigma), sigma, { scale: 1 }));
    assert.deepEqual(exact.transforms, [], 'nothing is resampled');
    assert.equal(taps(exact.filters), 2 * shadowReach(sigma) + 1, 'every tap of it');
    exact.value.destroy();

    app.shadowPolicy = { maxScale: 1 };
    try {
      const policy = record(() => blurCoverage(shapeFor(sigma), sigma));
      assert.deepEqual(policy.transforms, []);
      assert.equal(taps(policy.filters), 2 * shadowReach(sigma) + 1);
      policy.value.destroy();
    } finally {
      delete app.shadowPolicy;
    }
  });

  test('what comes back is a plain mask, exactly as it was before', async () => {
    // The output of a *scaled* bake must be as ordinary as the output of an
    // exact one: no filter, no transform left on it, or every composite of
    // the cached shadow afterwards would pay to resample it again.
    const sigma = 21;
    const blurred = blurCoverage(shapeFor(sigma), sigma);
    const drawn = record(() => {
      const ctx = target(blurred.width, blurred.height);
      ctx.fillStyle = '#000000';
      ctx.drawImage(blurred, 0, 0);
      ctx.destroy();
    });
    assert.deepEqual(drawn.filters, [], 'compositing it sets no filter');
    assert.deepEqual(drawn.transforms, [], 'and no transform');
    blurred.destroy();
  });

  test('a sliver is not shrunk into a smear', () => {
    // Nothing a shadow builds is this thin — a blur wide enough to be scaled
    // pads by 24px a side — but the primitive takes any a8 surface.
    const sliver = new Surface(app, { width: 400, height: 9, format: 'a8' });
    const { value, transforms } = record(() => blurCoverage(sliver, 21));
    assert.deepEqual(transforms, [], '9 rows have nothing to give up');
    assert.equal(value.width, 400);
    assert.equal(value.height, 9);
    value.destroy();
  });

  test('a scale that is not one is refused, and an odd one is snapped down', () => {
    const coverage = new Surface(app, { width: 64, height: 64, format: 'a8' });
    for (const bad of [0, -2, NaN, Infinity, 0.5]) {
      assert.throws(() => blurCoverage(coverage, 8, { scale: bad }), /scale/, `scale ${bad}`);
    }
    assert.equal(coverage._destroyed, undefined, 'a refused call destroys nothing');
    coverage.destroy();
    // 3 is not a power of two, and a bilinear tap of a 3x shrink would skip
    // pixels rather than average them: it shrinks by 2 instead
    const { value, transforms } = record(() => blurCoverage(shapeFor(21), 21, { scale: 3 }));
    assert.deepEqual(transforms, [2, 0.5]);
    value.destroy();
  });

  test('the 2d context gets it without asking', async () => {
    // The shadow properties call blurCoverage, so the reduced kernel is what
    // the server sees for a wide `shadowBlur` — and the shadow still lands.
    const ctx = target(160, 140);
    const { filters } = record(() => {
      ctx.shadowColor = '#ff0000';
      ctx.shadowBlur = 42; // sigma 21
      ctx.fillStyle = 'rgba(0, 0, 0, 0)';
      ctx.fillRect(50, 50, 60, 40);
    });
    assert.equal(taps(filters), 2 * shadowReach(21 / 4) + 1);
    const at = await readAll(ctx, 160, 140);
    assert.ok(at(80, 70)[3] > 100, `the shadow is there (alpha ${at(80, 70)[3]})`);
    ctx.destroy();
  });

  test('blurScale reaches a consumer too', async () => {
    const ntk = await import('ntk');
    assert.equal(ntk.blurScale, blurScale);
    assert.equal(ntk.DEFAULT_SHADOW_POLICY.scaleSigma, 4);
    assert.equal(ntk.DEFAULT_SHADOW_POLICY.maxScale, 4);
  });
});

// ------------------------------------------------------------------
// the blur as a primitive someone else can call (issue #335)

describe('blurCoverage on the public surface', () => {
  test('the bake and its maths reach a consumer', async () => {
    // The whole of the issue: the exports map names '.' and './xembed', so a
    // consumer cannot reach into lib/ — anything they are meant to call has
    // to leave through the entry point. Self-reference resolves the package
    // by name here, through the very map an installed copy would use.
    await assert.rejects(import('ntk/lib/shadow.js'), {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'
    });
    const ntk = await import('ntk');
    assert.equal(ntk.blurCoverage, blurCoverage);
    assert.equal(ntk.shadowSigma, shadowSigma);
    assert.equal(ntk.shadowReach, shadowReach);
    assert.equal(ntk.gaussianKernel1d, gaussianKernel1d);
    assert.deepEqual(ntk.DEFAULT_SHADOW_POLICY, DEFAULT_SHADOW_POLICY);
  });

  test('the blur lands in the pixels, and the result carries no filter', async () => {
    // Bake against filter is the point of exporting this: a picture's filter
    // is re-run by the server on every composite, so a cached blurred picture
    // pays its kernel per frame. What is asserted is both halves — the
    // coverage that comes back is blurred, and drawing it sets no filter.
    const sigma = 4;
    const pad = shadowReach(sigma);
    const shape = new Surface(app, {
      width: 60 + 2 * pad,
      height: 40 + 2 * pad,
      format: 'a8'
    });
    shape.render((c) => {
      c.fillStyle = '#ffffff';
      c.fillRect(pad, pad, 60, 40);
    });

    const blurred = blurCoverage(shape, sigma);
    assert.notEqual(blurred, shape, 'a new surface, not the same one filtered');
    assert.equal(blurred.format, 'a8');
    assert.equal(blurred.width, shape.width);
    assert.equal(blurred.height, shape.height);
    assert.equal(shape._destroyed, true, 'the sharp copy is not left behind');

    const R = app.display.Render;
    const original = R.SetPictureFilter;
    let filters = 0;
    R.SetPictureFilter = function (...args) {
      filters += 1;
      return original.apply(this, args);
    };
    const ctx = target();
    try {
      ctx.fillStyle = '#000000';
      ctx.drawImage(blurred, 0, 0);
    } finally {
      R.SetPictureFilter = original;
    }
    assert.equal(filters, 0, 'compositing the bake is a plain masked composite');

    const at = await readAll(ctx);
    const alphaAt = (x) => at(x, pad + 20)[3] / 255;
    // the left edge of the rect is at x = pad, so the profile there is the
    // gaussian's CDF — the same claim the shadow properties make, made by
    // the primitive on its own
    for (const [x, want] of [
      [pad - sigma, 0.159],
      [pad, 0.5],
      [pad + sigma, 0.841]
    ]) {
      const got = alphaAt(Math.round(x));
      assert.ok(
        Math.abs(got - want) < 0.06,
        `coverage at x=${x} is ${got.toFixed(3)}, expected ~${want}`
      );
    }
    assert.ok(alphaAt(pad + 30) > 0.99, 'the interior of the rect stays covered');
    // the padding is 3 sigma, so the coverage has all but died by its edge
    assert.ok(alphaAt(0) < 0.01, `the blur ends inside the padding, got ${alphaAt(0)}`);

    blurred.destroy();
    ctx.destroy();
  });

  test('a sigma that is not one, or a surface that is not coverage, is refused', () => {
    const coverage = new Surface(app, { width: 8, height: 8, format: 'a8' });
    for (const bad of [0, -1, NaN, Infinity, undefined]) {
      assert.throws(() => blurCoverage(coverage, bad), /sigma/, `sigma ${bad}`);
    }
    // the message names the call that turns a canvas blur into a sigma,
    // because halving it is exactly what a caller coming from CSS forgets
    assert.throws(() => blurCoverage(coverage, 0), /shadowSigma/);
    assert.equal(coverage._destroyed, undefined, 'a refused call destroys nothing');

    const colour = new Surface(app, { width: 8, height: 8 });
    assert.throws(() => blurCoverage(colour, 2), /a8/);
    coverage.destroy();
    colour.destroy();
  });

  test('the docs section the picture API points at exists', () => {
    // `setBlurFilter` sends whoever reads it to docs/surface.md#baking-a-blur
    // for the version that does not re-convolve; nothing else checks that
    // anchor, and the heading is what makes it one
    const docs = readFileSync(new URL('../docs/surface.md', import.meta.url), 'utf8');
    assert.match(docs, /^## Baking a blur$/m);
  });
});
