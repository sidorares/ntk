// A line wider than 16-bit coordinates can carry still draws what is on the
// surface: a minified file in a code editor, a long label in a narrow cell.
// CompositeGlyphs places glyphs in int16, so a layout whose glyphs run past
// x = 32767 threw a RangeError out of the paint however little of it showed.
// The glyphs no surface pixel can reach are culled before the request is
// built (`visibleGlyph`), and the ones that are sent all fit.
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
const H = 60;

function freshCtx() {
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H);
  return ctx;
}

function inkColumns(image) {
  let n = 0;
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      const i = (y * W + x) * 4;
      if (image.data[i] < 200) {
        n++;
        break;
      }
    }
  }
  return n;
}

/** Count the glyphs CompositeGlyphs is asked for, over `draw`. */
function glyphsSent(draw) {
  const Render = app.display.Render;
  const inner = Render.CompositeGlyphs;
  let glyphs = 0;
  Render.CompositeGlyphs = function (...args) {
    for (const elt of args[args.length - 1]) {
      if (Array.isArray(elt)) glyphs += elt[2].length;
    }
    return inner.apply(this, args);
  };
  try {
    draw();
  } finally {
    Render.CompositeGlyphs = inner;
  }
  return glyphs;
}

// 20,000 characters at 16px: about 180,000 pixels of line
const LONG = 'abcdefghij'.repeat(2000);

test('a line past 16-bit coordinates draws the part on the surface', async () => {
  const ctx = freshCtx();
  const layout = app.fonts.layout(
    [{ text: LONG, family: 'sans-serif', size: 16, color: 'black' }],
    { family: 'sans-serif', size: 16 },
  );
  assert.ok(layout.width > 70000, `the line is ${layout.width}px`);
  // scrolled to its middle, the way an editor shows it
  const sent = glyphsSent(() => layout.draw(ctx, -layout.width / 2, 10));
  const image = await ctx.getImageData(0, 0, W, H);
  assert.ok(inkColumns(image) > W / 2, 'the part on the surface is drawn');
  assert.ok(sent < 80, `${sent} glyphs sent for a surface ${W}px wide`);
});

test('under a clip, and from fillText, the same', async () => {
  const ctx = freshCtx();
  ctx.font = '16px sans-serif';
  ctx.fillStyle = 'black';
  ctx.save();
  ctx.beginPath();
  ctx.rect(20, 0, 60, H);
  ctx.clip();
  const sent = glyphsSent(() => ctx.fillText(LONG, -50000, 30));
  ctx.restore();
  const image = await ctx.getImageData(0, 0, W, H);
  assert.ok(inkColumns(image) > 20, 'the clipped part is drawn');
  assert.ok(sent < 40, `${sent} glyphs sent for a clip 60px wide`);
});

test('a line that fits sends every glyph, as before', async () => {
  const ctx = freshCtx();
  const layout = app.fonts.layout(
    [{ text: 'abcdefghij', family: 'sans-serif', size: 16, color: 'black' }],
    { family: 'sans-serif', size: 16 },
  );
  assert.equal(glyphsSent(() => layout.draw(ctx, 4, 10)), 10);
});

// A vector glyph (above `vectorFrom`) is rasterized into a mask the size of
// its ink. One bigger than the surface — a size a zoom or a style reaches —
// asked for a mask the size of the glyph, and past 32767 pixels that is a
// pixmap X cannot make: a RangeError out of the paint. The mask is cut to
// the surface now (`clipTraps`), and that must change no pixel that shows.
// Drawn as react-x11 draws text, through a layout's span size.
function vectorDraw(w, h, x, y, size = 700) {
  const pixmap = app.createPixmap({ width: w, height: h, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, w, h);
  const layout = app.fonts.layout(
    [{ text: 'W', family: 'sans-serif', size, color: 'black' }],
    { family: 'sans-serif', size },
  );
  layout.draw(ctx, x, y);
  return ctx;
}

test('a glyph bigger than the surface paints the pixels it always painted there', async () => {
  // the glyph whole, on a surface big enough to hold it; then the window of
  // it with the most edges in it, drawn onto a surface that size
  const big = await vectorDraw(1400, 1400, 280, 300).getImageData(0, 0, 1400, 1400);
  let best = null;
  for (let wy = 300; wy + H < 1100; wy += 20) {
    for (let wx = 280; wx + W < 1100; wx += 20) {
      let ink = 0;
      for (let y = wy; y < wy + H; y += 4) {
        for (let x = wx; x < wx + W; x += 4) if (big.data[(y * 1400 + x) * 4] < 128) ink++;
      }
      const edges = Math.min(ink, (W / 4) * (H / 4) - ink);
      if (!best || edges > best.edges) best = { wx, wy, edges };
    }
  }
  const cut = await vectorDraw(W, H, 280 - best.wx, 300 - best.wy).getImageData(0, 0, W, H);
  let ink = 0;
  let worst = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const whole = big.data[((best.wy + y) * 1400 + best.wx + x) * 4];
      if (whole < 128) ink++;
      worst = Math.max(worst, Math.abs(whole - cut.data[(y * W + x) * 4]));
    }
  }
  assert.ok(ink > W * H * 0.2 && ink < W * H * 0.8, `strokes and space both: ${ink} pixels of ink`);
  // the cut is exact, bands and all: not a pixel moves
  assert.equal(worst, 0, 'every pixel as it was');
});

test('a glyph no mask could be made for still draws what is on the surface', async () => {
  // Coverage scales with the glyph, so a surface over a W 100,000px high
  // sees the colour of one point of it. A point deep inside a stroke of the
  // 700px W, and one deep in the space between two, placed under the
  // surface: all of it ink, then none of it.
  const S = 100000;
  const big = await vectorDraw(1400, 1400, 280, 300).getImageData(0, 0, 1400, 1400);
  const inked = (x, y) => big.data[(y * 1400 + x) * 4] < 128;
  const deep = (want) => {
    for (let y = 320; y < 1000; y += 7) {
      for (let x = 290; x < 1000; x += 7) {
        let all = true;
        for (let dy = -6; dy <= 6 && all; dy++) {
          for (let dx = -6; dx <= 6 && all; dx++) all = inked(x + dx, y + dy) === want;
        }
        // a point between strokes, not beside the glyph
        if (all && (want || inked(x - 60, y) || inked(x + 60, y))) return [x, y];
      }
    }
    return null;
  };
  for (const want of [true, false]) {
    const [px, py] = deep(want);
    // the point, in ems from the 700px layout's corner, at the middle
    const ctx = vectorDraw(W, H, W / 2 - ((px - 280) / 700) * S, H / 2 - ((py - 300) / 700) * S, S);
    const image = await ctx.getImageData(0, 0, W, H);
    let ink = 0;
    for (let i = 0; i < W * H * 4; i += 4) if (image.data[i] < 128) ink++;
    assert.equal(ink, want ? W * H : 0, want ? 'inside a stroke' : 'between strokes');
  }
});
