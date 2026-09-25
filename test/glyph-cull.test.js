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
