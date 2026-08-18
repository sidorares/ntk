// Glyph drawing must honour the context transform, like every other drawing
// call (issue #280). `ctx.drawGlyphs` composited runs at the coordinates it
// was handed while applying the clip, so a `TextLayout` drawn into a
// translated context — every react-x11 <canvas> that is not at the window's
// origin — landed at the untransformed spot and was then cut away, and the
// two text APIs disagreed: `fillText` moved with the transform, `draw` did
// not.
//
// Hermetic: node-x11's in-process pure-JS X server + the fixture font.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';

const VF = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'MonelogicsSubset[wght].ttf');

const W = 240;
const H = 90;

let app = null;
let font = null;

before(async () => {
  const server = xserver.createServer({ width: 480, height: 240 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(VF), { family: 'Fixture' });
  fontSource.alias('sans-serif', 'Fixture');
  app = await createClient({ stream: clientEnd, fontSource });
  font = app.fonts.match('Fixture');
});

after(async () => {
  if (app) await app.close();
});

function freshCtx() {
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'black';
  return { pixmap, ctx };
}

/** paint with `draw`, read the pixels back, and drop the pixmap */
async function paint(draw) {
  const { pixmap, ctx } = freshCtx();
  draw(ctx);
  const image = await ctx.getImageData(0, 0, W, H);
  pixmap.destroy();
  return image;
}

const isInk = (image, x, y) => image.data[(y * W + x) * 4] < 200;

/** ink pixels inside a box, counted from the red channel (black on white) */
function inkInBox(image, x0, y0, x1, y1) {
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) if (isInk(image, x, y)) n++;
  }
  return n;
}

const samePixels = (a, b) => {
  let diff = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (Math.abs(a.data[i] - b.data[i]) > 0) diff++;
  }
  return diff;
};

const runOf = (text, size) => ({
  font,
  size,
  glyphs: Array.from(text, (ch) => ({
    id: font.glyphIdFor(ch.codePointAt(0)) ?? 0,
    ax: 18,
    dx: 0,
    dy: 0
  }))
});

const layoutOf = (text = 'Handgloves') =>
  app.fonts.layout([{ text, family: 'sans-serif', size: 20, color: 'black' }], {
    family: 'sans-serif',
    size: 20
  });

// ------------------------------------------------------------- drawGlyphs

test('drawGlyphs: a translated context moves the run, pixel for pixel', async () => {
  const run = runOf('0123456', 22);
  const black = (ctx) => ctx.createSolidPicture(0, 0, 0, 1);

  const translated = await paint((ctx) => {
    ctx.translate(90, 20);
    ctx.drawGlyphs(ctx.Render.PictOp.Over, black(ctx), [{ run, x: 12, y: 30 }]);
  });
  const byHand = await paint((ctx) => {
    ctx.drawGlyphs(ctx.Render.PictOp.Over, black(ctx), [{ run, x: 102, y: 50 }]);
  });

  assert.ok(inkInBox(byHand, 0, 0, W, H) > 0, 'the reference actually drew');
  assert.equal(samePixels(translated, byHand), 0, 'translate moved the glyphs exactly');
});

test('drawGlyphs: the run origin goes through the whole matrix', async () => {
  const run = runOf('012', 22);
  const black = (ctx) => ctx.createSolidPicture(0, 0, 0, 1);

  // a scale moves the origin the way it moves fillText's anchor; the glyphs
  // themselves keep their size, which is what fillText documents too
  const scaled = await paint((ctx) => {
    ctx.scale(2, 3);
    ctx.drawGlyphs(ctx.Render.PictOp.Over, black(ctx), [{ run, x: 20, y: 15 }]);
  });
  const byHand = await paint((ctx) => {
    ctx.drawGlyphs(ctx.Render.PictOp.Over, black(ctx), [{ run, x: 40, y: 45 }]);
  });
  assert.ok(inkInBox(byHand, 0, 0, W, H) > 0, 'the reference actually drew');
  assert.equal(samePixels(scaled, byHand), 0, 'the origin took the matrix');
});

test('drawGlyphs: save/restore puts the transform back', async () => {
  const run = runOf('0123456', 22);
  const black = (ctx) => ctx.createSolidPicture(0, 0, 0, 1);
  const draw = (ctx, x, y) =>
    ctx.drawGlyphs(ctx.Render.PictOp.Over, black(ctx), [{ run, x, y }]);

  const nested = await paint((ctx) => {
    ctx.save();
    ctx.translate(40, 10);
    ctx.translate(20, 20);
    draw(ctx, 10, 20);
    ctx.restore();
    draw(ctx, 10, 80);
  });
  const byHand = await paint((ctx) => {
    draw(ctx, 70, 50);
    draw(ctx, 10, 80);
  });
  assert.equal(samePixels(nested, byHand), 0, 'nested translates compose, restore undoes them');
});

// -------------------------------------------------------- TextLayout.draw

test('TextLayout.draw: the layout origin is in user space', async () => {
  const translated = await paint((ctx) => {
    ctx.translate(80, 24);
    layoutOf().draw(ctx, 6, 4);
  });
  const byHand = await paint((ctx) => {
    layoutOf().draw(ctx, 86, 28);
  });
  assert.ok(inkInBox(byHand, 0, 0, W, H) > 0, 'the reference actually drew');
  assert.equal(samePixels(translated, byHand), 0, 'the paragraph moved with the transform');
});

test('TextLayout.draw and fillText agree under a transform', async () => {
  // the same string at the same coordinates must land in the same place
  // whichever call draws it — the disagreement in #280
  const text = 'Handgloves';
  const viaLayout = await paint((ctx) => {
    ctx.translate(70, 12);
    const layout = layoutOf(text);
    layout.draw(ctx, 8, 20);
  });
  const viaFillText = await paint((ctx) => {
    ctx.translate(70, 12);
    ctx.font = '20px sans-serif';
    ctx.fillStyle = 'black';
    const layout = layoutOf(text);
    // fillText anchors on the baseline; the layout's top-left is 20 above it
    ctx.fillText(text, 8, 20 + layout.lines[0].baseline);
  });
  assert.ok(inkInBox(viaFillText, 0, 0, W, H) > 0, 'fillText actually drew');
  assert.equal(samePixels(viaLayout, viaFillText), 0, 'both text APIs land together');
});

test('TextLayout.draw: a translated, clipped box keeps its paragraph', async () => {
  // the shape of the react-x11 report: the element translates to its own
  // origin and clips to its own box. Before the fix the glyphs were composited
  // at the untranslated coordinates and the clip then destroyed all but a
  // sliver of them.
  const BOX = { x: 120, y: 10, w: 110, h: 70 };
  const image = await paint((ctx) => {
    ctx.save();
    ctx.translate(BOX.x, BOX.y);
    ctx.beginPath();
    ctx.rect(0, 0, BOX.w, BOX.h);
    ctx.clip();
    layoutOf('Handgloves').draw(ctx, 4, 4);
    ctx.restore();
  });

  const inside = inkInBox(image, BOX.x, BOX.y, BOX.x + BOX.w, BOX.y + BOX.h);
  const outside = inkInBox(image, 0, 0, W, H) - inside;
  assert.equal(outside, 0, 'nothing painted outside the clipped box');

  // and the paragraph survives whole: the same ink as an unclipped draw at
  // the box's origin, not the sliver a clipped-away paragraph leaves
  const unclipped = await paint((ctx) => {
    layoutOf('Handgloves').draw(ctx, BOX.x + 4, BOX.y + 4);
  });
  assert.equal(
    inside,
    inkInBox(unclipped, BOX.x, BOX.y, BOX.x + BOX.w, BOX.y + BOX.h),
    'every glyph that fits the box is drawn'
  );
  assert.ok(inside > 0, 'and there is something to see');
});
