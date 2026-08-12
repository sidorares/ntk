// The public glyph-run seam (issue #254): `Font.glyphIdFor(codepoint)` and
// the hand-built run contract `ctx.drawGlyphs` accepts —
//   positioned = [{ run, x, y, textRendering? }]
//   run        = { font, size, glyphs: [{ id, ax, dx, dy }] }
// A grid renderer (a terminal, a tabular column) builds these from grid
// arithmetic instead of shaping, so the shape is frozen here: runs carrying
// ONLY the documented fields must render, place glyphs exactly where the
// pen semantics say, collapse into one CompositeGlyphs request, and honour
// the clip.
//
// Hermetic: node-x11's in-process pure-JS X server + the fixture font.
// Pixel expectations are composed client-side from the same rasterized
// bitmaps (XRender Over of solid black through a8 onto white is
// gray = 255 - coverage), the way glyph-positions.test.js does against a
// real server.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';
import Font from '../lib/text/font.js';
import { positionGlyphs } from '../lib/text/glyphs.js';

const VF = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'MonelogicsSubset[wght].ttf');

const W = 360;
const H = 80;

let app = null;
let font = null;

before(async () => {
  const server = xserver.createServer({ width: 480, height: 240 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(VF), { family: 'Fixture' });
  app = await createClient({ stream: clientEnd, fontSource });
  font = app.fonts.match('Fixture');
});

after(async () => {
  if (app) await app.close();
});

// --------------------------------------------------------------- glyphIdFor

test('glyphIdFor: the id shape() reports, without shaping', () => {
  const f = Font.loadSync(VF);
  for (const ch of 'Handgloves 0123456789.,') {
    const cp = ch.codePointAt(0);
    const id = f.glyphIdFor(cp);
    assert.equal(typeof id, 'number', `covered ${JSON.stringify(ch)} yields a number`);
    // one-char text with no context: shaping degenerates to the cmap lookup
    assert.equal(f.shape(ch, 32).glyphs[0].id, id, `matches shape() for ${JSON.stringify(ch)}`);
  }
});

test('glyphIdFor: null where the face lacks the codepoint, agreeing with hasGlyph', () => {
  const f = Font.loadSync(VF);
  // the fixture is subset to "Handgloves HANDGLOVES 0123456789 .," — z, X
  // and ! are outside it
  for (const ch of 'zX!') {
    const cp = ch.codePointAt(0);
    assert.equal(f.hasGlyph(cp), false, `${JSON.stringify(ch)} is outside the subset`);
    assert.equal(f.glyphIdFor(cp), null, `null for ${JSON.stringify(ch)}, not .notdef's 0`);
  }
  for (const cp of [0x48 /* H */, 0x7a /* z */, 0x2c /* , */, 0x2603 /* snowman */]) {
    assert.equal(f.glyphIdFor(cp) !== null, f.hasGlyph(cp), `agreement at U+${cp.toString(16)}`);
  }
});

test('glyphIdFor: a variation instance answers like its base face', () => {
  const f = Font.loadSync(VF);
  const black = f.variation({ wght: 900 });
  assert.equal(black.glyphIdFor(0x48), f.glyphIdFor(0x48));
  assert.equal(black.glyphIdFor(0x21), null);
});

// ------------------------------------------------------- the run contract

function freshCtx() {
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'black';
  return { pixmap, ctx };
}

/** client-side composition of what the positioned runs should ink */
function expectedImage(positions) {
  const img = new Float64Array(W * H);
  for (const pos of positions) {
    const bmp = pos.run.font.rasterize(pos.glyph.id, pos.run.size);
    if (!bmp) continue;
    const ox = pos.x + bmp.left;
    const oy = pos.y + bmp.top;
    for (let row = 0; row < bmp.height; row++) {
      const py = oy + row;
      if (py < 0 || py >= H) continue;
      for (let col = 0; col < bmp.width; col++) {
        const px = ox + col;
        if (px < 0 || px >= W) continue;
        const a = bmp.data[row * bmp.width + col];
        img[py * W + px] = a + (img[py * W + px] * (255 - a)) / 255;
      }
    }
  }
  return img;
}

function diffStats(actual, expected) {
  let bad = 0;
  let maxDiff = 0;
  for (let i = 0; i < W * H; i++) {
    const d = Math.abs(actual.data[i * 4] - (255 - Math.round(expected[i])));
    if (d > maxDiff) maxDiff = d;
    if (d > 0) bad++;
  }
  return { bad, maxDiff };
}

/** a terminal-style row: one glyph per cell, positions from grid arithmetic */
function gridRun(text, size, cellW) {
  const glyphs = [];
  for (const ch of text) {
    const id = font.glyphIdFor(ch.codePointAt(0));
    assert.notEqual(id, null, `fixture covers ${JSON.stringify(ch)}`);
    glyphs.push({ id, ax: cellW, dx: 0, dy: 0 });
  }
  return { font, size, glyphs };
}

test('a hand-built grid run lands every glyph on its cell, pixel-exact', async () => {
  const run = gridRun('0123456789.,', 22, 18);
  const positioned = [{ run, x: 12, y: 52 }];
  const { pixmap, ctx } = freshCtx();
  ctx.drawGlyphs(ctx.Render.PictOp.Over, ctx.createSolidPicture(0, 0, 0, 1), positioned);
  const actual = await ctx.getImageData(0, 0, W, H);
  pixmap.destroy();
  const { bad, maxDiff } = diffStats(actual, expectedImage(positionGlyphs(positioned)));
  assert.equal(bad, 0, `${bad} mismatched pixels (maxDiff ${maxDiff})`);
});

test('dx/dy offset ink from the pen without moving it, dy positive up', async () => {
  // the pen walks the grid; every other glyph is nudged right and UP —
  // exactly what a shaped mark offset does, here hand-built
  const size = 24;
  const glyphs = [];
  const ids = 'Handgloves'.split('').map((ch) => font.glyphIdFor(ch.codePointAt(0)));
  ids.forEach((id, i) => {
    assert.notEqual(id, null);
    glyphs.push({ id, ax: 20, dx: i % 2 ? 3 : 0, dy: i % 2 ? 5 : 0 });
  });
  const positioned = [{ run: { font, size, glyphs }, x: 10, y: 60 }];
  const { pixmap, ctx } = freshCtx();
  ctx.drawGlyphs(ctx.Render.PictOp.Over, ctx.createSolidPicture(0, 0, 0, 1), positioned);
  const actual = await ctx.getImageData(0, 0, W, H);
  pixmap.destroy();
  const { bad, maxDiff } = diffStats(actual, expectedImage(positionGlyphs(positioned)));
  assert.equal(bad, 0, `${bad} mismatched pixels (maxDiff ${maxDiff})`);
});

test('a shaped run stripped to the documented fields renders identically', async () => {
  const text = 'Handgloves 007';
  const size = 26;
  const draw = async (mapRun) => {
    const shaped = font.shape(text, size);
    const run = mapRun(shaped);
    const { pixmap, ctx } = freshCtx();
    ctx.drawGlyphs(ctx.Render.PictOp.Over, ctx.createSolidPicture(0, 0, 0, 1), [{ run, x: 8, y: 55 }]);
    const img = await ctx.getImageData(0, 0, W, H);
    pixmap.destroy();
    return img;
  };
  const full = await draw((shaped) => shaped);
  // only { font, size, glyphs: [{ id, ax, dx, dy }] } — no width, no
  // direction, no codePoints. This is the frozen contract.
  const minimal = await draw((shaped) => ({
    font: shaped.font,
    size: shaped.size,
    glyphs: shaped.glyphs.map(({ id, ax, dx, dy }) => ({ id, ax, dx, dy }))
  }));
  assert.deepEqual(minimal.data, full.data, 'extra fields must stay ignorable');
});

test('a warm row-span is one request, whatever the glyph count', async () => {
  const { pixmap, ctx } = freshCtx();
  const positioned = [{ run: gridRun('0123456789012345678901234567890123', 16, 10), x: 4, y: 40 }];
  // warm up: uploads the digits' bitmaps (AddGlyphs) once
  ctx.drawGlyphs(ctx.Render.PictOp.Over, ctx.createSolidPicture(0, 0, 0, 1), positioned);
  await app.X.sync();
  const before = app.X.seq_num;
  ctx.drawGlyphs(ctx.Render.PictOp.Over, ctx.createSolidPicture(0, 0, 0, 1), positioned);
  const emitted = app.X.seq_num - before;
  await app.X.sync();
  pixmap.destroy();
  assert.equal(emitted, 1, 'one CompositeGlyphs, nothing uploaded, nothing freed');
});

test('hand-built runs honour a rectangular clip', async () => {
  const run = gridRun('0000000000', 22, 20);
  const positioned = [{ run, x: 10, y: 50 }];
  const { pixmap, ctx } = freshCtx();
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, 100, H);
  ctx.clip();
  ctx.drawGlyphs(ctx.Render.PictOp.Over, ctx.createSolidPicture(0, 0, 0, 1), positioned);
  ctx.restore();
  const img = await ctx.getImageData(0, 0, W, H);
  pixmap.destroy();
  let inkInside = false;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = img.data[(y * W + x) * 4];
      if (x < 100 && v < 255) inkInside = true;
      if (x >= 100) assert.equal(v, 255, `ink escaped the clip at ${x},${y}`);
    }
  }
  assert.ok(inkInside, 'the clipped span still drew inside the clip');
});
