// Pixel-exact glyph position validation against a real X server.
//
// For each case the text is shaped, intended glyph positions are computed
// with positionGlyphs() (the same function the renderer uses), and an
// EXPECTED image is composed client-side from the same rasterized bitmaps.
// The text is then drawn through the full server path (AddGlyphs +
// CompositeGlyphs with compact ids, baked advances and delta corrections)
// and read back with GetImage. Every pixel must match exactly: XRender's
// Over of a solid black source through an a8 mask onto white is
// gray = 255 - coverage, the same arithmetic used here.
//
// This is the harness that caught the GLYPHINFO x-sign bug — keep cases
// diverse (bearings, kerning, subpixel drift, elt splitting, rtl, mixed
// scripts) so position regressions fail loudly.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createClient } from '../lib/index.js';
import { drawGlyphRuns, positionGlyphs } from '../lib/text/glyphs.js';
import { reorderRuns } from '../lib/text/shape.js';
import { withTimeout } from './helpers/async.js';

const W = 420;
const H = 90;

let app = null;
let skip = false;

before(async () => {
  if (!process.env.DISPLAY) {
    skip = 'no DISPLAY set';
    return;
  }
  try {
    app = await withTimeout(createClient(), 5000, 'connecting to X server', (late) => late.close());
    app.fonts.match('sans-serif');
  } catch (err) {
    skip = `cannot connect / no fonts: ${err.message}`;
    if (app) await app.close();
    app = null;
  }
});

after(async () => {
  if (app) await app.close();
});

function expectedImage(positions) {
  const img = new Float64Array(W * H);
  for (const pos of positions) {
    const bmp = pos.run.font.rasterize(pos.glyph.id, pos.run.size);
    if (!bmp) continue;
    // intent: bitmap top-left at (originX + left bearing, originY + top)
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

const readPixels = (ctx) => ctx.getImageData(0, 0, W, H);

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

async function renderCase(family, size, text) {
  const font = app.fonts.match(family);
  const shaped = app.fonts.shape(text, { font, family, size });
  const positioned = [];
  let cursor = 12;
  for (const run of reorderRuns(shaped.runs)) {
    positioned.push({ run, x: cursor, y: 60 });
    cursor += run.width;
  }
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'black';
  drawGlyphRuns(app, app.display.Render.PictOp.Over, ctx._backgroundPicture.id, ctx.picture.id, positioned);
  const actual = await readPixels(ctx);
  pixmap.destroy();
  return { actual, expected: expectedImage(positionGlyphs(positioned)) };
}

const CASES = [
  ['serif', 24, 'Hello, World!'],
  ['serif', 50, 'AVAST To Ta yj fi'],
  ['sans-serif', 16, 'The quick brown fox jumps'],
  ['sans-serif', 33, 'iiiiiii jjjjjjj'], // left bearings
  ['monospace', 17, 'mmmm||||....'],
  ['Times New Roman', 40, 'Wavy AV. To, "quotes"'], // kern corrections
  ['serif', 13, 'the rain in spain falls mainly on the plain and stays there'], // subpixel drift
  ['sans-serif', 9, 'x'.repeat(300)], // elt splitting at 254
  ['sans-serif', 20, 'العربية لغة جميلة جداً'], // rtl
  ['serif', 28, 'mix عرب and 世界 end'] // glyphset switches
];

for (const [family, size, text] of CASES) {
  test(`server render matches client composition: ${family}@${size} "${text.slice(0, 22)}"`, async (t) => {
    if (skip) return t.skip(skip);
    const { actual, expected } = await renderCase(family, size, text);
    const { bad, maxDiff } = diffStats(actual, expected);
    assert.equal(bad, 0, `${bad} mismatched pixels (maxDiff ${maxDiff})`);
  });
}

test('fillText places glyphs identically to manual run positioning', async (t) => {
  if (skip) return t.skip(skip);
  const draw = (useFillText) => {
    const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
    const ctx = pixmap.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, W, H);
    ctx.font = '28px serif';
    ctx.fillStyle = 'black';
    if (useFillText) {
      ctx.fillText('Align me AV', 12, 60);
    } else {
      const style = ctx._textStyle;
      const shaped = app.fonts.shape('Align me AV', style);
      const positioned = [];
      let cursor = 12;
      for (const run of reorderRuns(shaped.runs)) {
        positioned.push({ run, x: cursor, y: 60 });
        cursor += run.width;
      }
      drawGlyphRuns(app, app.display.Render.PictOp.Over, ctx._backgroundPicture.id, ctx.picture.id, positioned);
    }
    const p = readPixels(ctx);
    p.finally(() => pixmap.destroy());
    return p;
  };
  const [a, b] = [await draw(true), await draw(false)];
  assert.deepEqual(a.data, b.data, 'fillText output differs from manual positioning');
});
