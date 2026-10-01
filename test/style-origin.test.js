// A gradient or a pattern painted small far from the surface's origin lands
// where the matrix puts it.
//
// Both are defined in user space, and their picture transform is the
// inverse of the CTM. Every fill used to sample them at device coordinates,
// which put the CTM's translation, times its downscale, into that inverse:
// a box drawn at a thirty-second of its size at x 2,200 asked for 70,400,
// past the 32,767 that XRender's 16.16 fixed point carries. The request
// encoder threw, and after #486 the fill was skipped. Now each style is
// sampled from where its own origin lands, and the translation is small
// wherever on the surface the paint is.
//
// Every paint path that composites a style is drawn here twice, near the
// origin and far from it, and has to come out the same pixel for pixel.
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, Image, StaticFontSource, Surface } from '../lib/index.js';

const require = createRequire(import.meta.url);
const fontDir = join(dirname(require.resolve('katex/package.json')), 'dist', 'fonts');

let app = null;
const W = 2400;
const H = 48;
const NEAR = 100;
const FAR = 2200;
const SPAN = 150;

before(async () => {
  const server = xserver.createServer({ width: 320, height: 240 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), { family: 'Test Main' });
  fontSource.alias('sans-serif', 'Test Main');
  app = await createClient({ stream: clientEnd, fontSource });
});

after(async () => {
  if (app) await app.close();
});

function freshCtx() {
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H);
  return { pixmap, ctx };
}

/** An unhandled X error is reported through console.error, not thrown. */
async function xErrorsDuring(fn) {
  const errors = [];
  const report = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.error = report;
  }
  return errors.filter((e) => /X error/.test(e));
}

/**
 * Every path a style is composited through, at a thirty-second of its size
 * with user space's origin at device (x, 4): a path fill, a stroke on the
 * triangle path and on the mask path, text on the bitmap and the vector
 * glyph path, and all of it again under a rectangle clip and a path clip.
 */
function scene(ctx, x, style) {
  ctx.save();
  ctx.translate(x, 4);
  ctx.scale(1 / 32, 1 / 32);
  ctx.fillStyle = style;
  ctx.strokeStyle = style;
  ctx.fillRect(0, 0, 320, 1280);
  ctx.beginPath();
  ctx.moveTo(480, 64);
  ctx.lineTo(960, 1216);
  ctx.lineWidth = 96;
  ctx.stroke(); // triangles, straight to the destination
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(1120, 64);
  ctx.lineTo(1120, 1216);
  ctx.stroke(); // round caps: through the mask
  ctx.font = '20px sans-serif';
  ctx.fillText('Hg', 1280, 1024);
  ctx.font = '19.5px sans-serif';
  ctx.fillText('Hg', 1920, 1024); // a fractional size: the vector path
  ctx.save();
  ctx.beginPath();
  ctx.rect(2560, 0, 640, 1024);
  ctx.clip();
  ctx.fillRect(2560, 0, 1280, 1280);
  ctx.font = '20px sans-serif';
  ctx.fillText('Hg', 2560, 1216);
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.arc(3840, 640, 512, 0, 2 * Math.PI);
  ctx.clip();
  ctx.fillRect(3328, 0, 1024, 1280);
  ctx.font = '20px sans-serif';
  ctx.fillText('Hg', 3456, 1216);
  ctx.restore();
  ctx.restore();
}

/** The SPAN x H pixels from device x `x0`, as RGB triples. */
async function strip(ctx, x0) {
  const img = await ctx.getImageData(x0, 0, SPAN, H);
  const out = [];
  for (let i = 0; i < img.data.length; i += 4) out.push(img.data[i], img.data[i + 1], img.data[i + 2]);
  return out;
}

async function assertSameNearAndFar(style, what) {
  const { pixmap, ctx } = freshCtx();
  const errors = await xErrorsDuring(async () => {
    scene(ctx, NEAR, style);
    scene(ctx, FAR, style);
    await ctx.getImageData(0, 0, 1, 1);
  });
  assert.deepEqual(errors, [], `${what}: no X errors`);
  const near = await strip(ctx, NEAR - 10);
  const far = await strip(ctx, FAR - 10);
  const inked = near.filter((v) => v !== 255).length;
  assert.ok(inked > 3000, `${what}: the scene near the origin is painted (${inked} channels)`);
  let differ = 0;
  let first = -1;
  for (let i = 0; i < near.length; i++) {
    if (near[i] !== far[i]) {
      differ++;
      if (first < 0) first = i;
    }
  }
  const at = first < 0 ? '' : ` — first at ${((first / 3) | 0) % SPAN},${((first / 3 / SPAN) | 0)}`;
  assert.equal(differ, 0, `${what}: far from the origin it is painted the same${at}`);
  pixmap.destroy();
}

test('a linear gradient is painted the same far from the origin, through every path', async () => {
  const { ctx } = freshCtx();
  const g = ctx.createLinearGradient(0, 0, 4800, 1280);
  g.addColorStop(0, 'red');
  g.addColorStop(0.5, 'lime');
  g.addColorStop(1, 'blue');
  await assertSameNearAndFar(g, 'linear');
});

test('a radial gradient is painted the same far from the origin, through every path', async () => {
  const { ctx } = freshCtx();
  const g = ctx.createRadialGradient(2400, 640, 64, 2400, 640, 2400);
  g.addColorStop(0, 'black');
  g.addColorStop(1, 'yellow');
  await assertSameNearAndFar(g, 'radial');
});

/** One colour per quadrant: 160 pixels is five across at a thirty-second */
function quadrantTile(w = 160, h = 160) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = x < w / 2 ? 255 : 0;
      data[i + 1] = y < h / 2 ? 0 : 160;
      data[i + 2] = x < w / 2 ? 0 : 255;
      data[i + 3] = 255;
    }
  }
  return new Image({ width: w, height: h, data });
}

for (const repetition of ['repeat', 'no-repeat', 'reflect', 'pad']) {
  test(`a '${repetition}' pattern is painted the same far from the origin, through every path`, async () => {
    const { ctx } = freshCtx();
    // one tile is the scene's corner; a big one, stretched only so far that
    // the inverse still scales by 16, is the whole scene
    const single = repetition === 'no-repeat';
    const tile = single ? quadrantTile(2400, 640) : quadrantTile();
    const pattern = ctx.createPattern(tile, repetition);
    if (single) pattern.setTransform([2, 0, 0, 2, 0, 0]);
    await assertSameNearAndFar(pattern, repetition);
    tile.destroy();
  });
}

test('a gradient far from the origin lands where the matrix puts it', async () => {
  const { pixmap, ctx } = freshCtx();
  // a ramp across 2000 units of user space, drawn at a fortieth at x 2,200:
  // 50 device pixels, black to white
  const g = ctx.createLinearGradient(0, 0, 2000, 0);
  g.addColorStop(0, 'black');
  g.addColorStop(1, 'white');
  ctx.save();
  ctx.translate(2200, 10);
  ctx.scale(1 / 40, 1 / 40);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2000, 800);
  ctx.restore();
  const img = await ctx.getImageData(2190, 20, 70, 1);
  const at = (x) => img.data[(x - 2190) * 4];
  const near = (x, want, what) =>
    assert.ok(Math.abs(at(x) - want) <= 3, `${what}: expected ~${want}, got ${at(x)}`);
  // pixel x samples user (x + 0.5 - 2200) * 40 of the 2000
  near(2201, 8, 'its start');
  near(2225, 130, 'its middle');
  near(2249, 252, 'its end');
  assert.equal(at(2195), 255, 'left of it');
  assert.equal(at(2255), 255, 'right of it');
  pixmap.destroy();
});

test('a grid scrolled 100,000 pixels is the grid, not nothing', async () => {
  // The tile's origin is far off the surface, and so are the texels every
  // pixel on it samples; a repeating tile is the same a whole number of
  // tiles along, which is what brings them back in reach.
  const tile = new Surface(app, { width: 4, height: 4 });
  tile.render((c) => {
    c.fillStyle = 'red';
    c.fillRect(0, 0, 2, 2);
    c.fillStyle = 'blue';
    c.fillRect(2, 2, 2, 2);
  });
  const { pixmap, ctx } = freshCtx();
  const pattern = ctx.createPattern(tile, 'repeat');
  ctx.fillStyle = pattern;
  const errors = await xErrorsDuring(async () => {
    pattern.setTransform([1, 0, 0, 1, 0, -100000]);
    ctx.fillRect(0, 0, 16, 16);
    // two pixels further: the grid moves two pixels
    pattern.setTransform([1, 0, 0, 1, 0, -100002]);
    ctx.fillRect(20, 0, 16, 16);
    await ctx.getImageData(0, 0, 1, 1);
  });
  assert.deepEqual(errors, []);
  const img = await ctx.getImageData(0, 0, 40, 16);
  const px = (x, y) => [...img.data.slice((y * 40 + x) * 4, (y * 40 + x) * 4 + 3)];
  assert.deepEqual(px(0, 0), [255, 0, 0], 'the tile starts on the grid');
  assert.deepEqual(px(2, 2), [0, 0, 255]);
  assert.deepEqual(px(2, 0), [255, 255, 255]);
  assert.deepEqual(px(20, 0), [255, 255, 255], 'moved two pixels up');
  assert.deepEqual(px(20, 2), [255, 0, 0]);
  assert.deepEqual(px(22, 0), [0, 0, 255]);
  tile.destroy();
  pixmap.destroy();
});
