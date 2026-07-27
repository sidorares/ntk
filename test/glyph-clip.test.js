// Text must stay inside the 2d clip. CompositeGlyphs writes straight to the
// destination picture, so glyph drawing has to be routed through the clip
// mask by hand — without that, text spills out of clipped boxes while every
// fill and stroke stays inside (react-x11's <textarea> scrolling showed it).
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';

const { createServer, createStreamPair } = xserver;
const require = createRequire(import.meta.url);
const fontDir = join(dirname(require.resolve('katex/package.json')), 'dist', 'fonts');

let server = null;
let app = null;

before(async () => {
  server = createServer({ width: 200, height: 200 });
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);
  const source = new StaticFontSource();
  source.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), { family: 'Test Main' });
  source.alias('sans-serif', 'Test Main');
  app = await createClient({ stream: clientEnd, fontSource: source });
});

after(async () => {
  if (app) await app.close();
});

const W = 160;
const H = 80;

const readPixels = (ctx) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, W, H, (err, data) => (err ? reject(err) : resolve(data)))
  );

/** Count pixels darker than white in a band of rows. */
function inkInRows(image, y0, y1) {
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      // BGRA; anything appreciably darker than the white background is ink
      if (image.data[i] < 200 || image.data[i + 1] < 200 || image.data[i + 2] < 200) n++;
    }
  }
  return n;
}

function freshCtx() {
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H);
  return ctx;
}

const CLIP_TOP = 30;
const CLIP_BOTTOM = 60;

test('fillText stays inside the clip', async () => {
  const ctx = freshCtx();
  ctx.font = '20px sans-serif';
  ctx.fillStyle = 'black';

  // baseline chosen so the text would land well above the clip band
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, CLIP_TOP, W, CLIP_BOTTOM - CLIP_TOP);
  ctx.clip();
  ctx.fillText('Hgjy', 4, 20);
  ctx.restore();

  const image = await readPixels(ctx);
  assert.equal(
    inkInRows(image, 0, CLIP_TOP),
    0,
    'no glyph ink above the clip band',
  );
});

test('TextLayout.draw stays inside the clip, and still paints within it', async () => {
  const ctx = freshCtx();
  const layout = app.fonts.layout(
    [{ text: 'Clipping', family: 'sans-serif', size: 20, color: 'black' }],
    { family: 'sans-serif', size: 20 },
  );

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, CLIP_TOP, W, CLIP_BOTTOM - CLIP_TOP);
  ctx.clip();
  // drawn near the top: most of it falls outside the clip band
  layout.draw(ctx, 4, 4);
  // and again inside it, so the test also proves text still renders
  layout.draw(ctx, 4, CLIP_TOP + 2);
  ctx.restore();

  const image = await readPixels(ctx);
  assert.equal(inkInRows(image, 0, CLIP_TOP), 0, 'nothing above the clip');
  assert.equal(inkInRows(image, CLIP_BOTTOM, H), 0, 'nothing below the clip');
  assert.ok(
    inkInRows(image, CLIP_TOP, CLIP_BOTTOM) > 0,
    'text inside the clip still paints',
  );
});

test('without a clip, text paints where it is drawn', async () => {
  const ctx = freshCtx();
  const layout = app.fonts.layout(
    [{ text: 'Clipping', family: 'sans-serif', size: 20, color: 'black' }],
    { family: 'sans-serif', size: 20 },
  );
  layout.draw(ctx, 4, 4);
  const image = await readPixels(ctx);
  assert.ok(inkInRows(image, 0, CLIP_TOP) > 0, 'unclipped text is not suppressed');
});
