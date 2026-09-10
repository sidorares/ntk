// Glyph placement is translation-invariant (issue #350): the same run drawn
// whole pixels away puts every glyph exactly that many pixels away.
//
// `positionGlyphs` used to walk the pen from the run's device origin and
// round `origin + pen` as one floating-point sum. The last bits of that sum
// depend on the origin's magnitude, so a pen that should sit exactly on a
// half pixel rounded down at x 104 and up at x 152. A renderer that repaints
// everything never sees that. One that copies pixels it already drew does:
// react-x11's scroll blit is meant to be byte-identical to a repaint, and a
// glyph that rounded one way where it was drawn and the other way where the
// copy puts it comes out a pixel off.
//
// Positions first, as plain arithmetic; then pixels, through the two calls a
// consumer draws text with — TextLayout.draw and fillText — on node-x11's
// in-process X server with the fixture font. Every translation test below put
// a glyph a pixel off before the fix.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';
import { positionGlyphs } from '../lib/text/glyphs.js';

const VF = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'MonelogicsSubset[wght].ttf');

// -------------------------------------------------------------- positions

// Advances of a 1000-upem face at 13 px. 556 + 444 + 278 + 222 units come to
// 19.5 px exactly, so the fifth pen sits on a half pixel — in real
// arithmetic. None of the advances is exact in floating point, and their sum
// lands a hair either side of the half depending on what it was added to.
const u13 = (units) => (units * 13) / 1000;
const halfPixelRun = {
  glyphs: [556, 444, 278, 222, 500].map((units) => ({ ax: u13(units), dx: 0, dy: 0 }))
};

/** glyph origins of `run` drawn at (x, y), moved back by (tx, ty) */
const placed = (run, x, y, tx = 0, ty = 0) =>
  positionGlyphs([{ run, x, y }]).map((p) => [p.x - tx, p.y - ty]);

test('positionGlyphs: a pen on a half pixel rounds the same at every whole-pixel origin', () => {
  const reference = placed(halfPixelRun, 0, 20);
  for (let t = -300; t <= 600; t++) {
    assert.deepEqual(placed(halfPixelRun, t, 20, t), reference, `run drawn at x ${t}`);
  }
});

test('positionGlyphs: fractional origins moved by whole pixels move every glyph by exactly those pixels', () => {
  // Origins built the way TextLayout and fillText build them: alignment slack
  // in user space, with the translation added on top by the transform. The
  // run right-aligned in 150 px, centred in 151 (on a half pixel), and at an
  // arbitrary fraction; the baseline 45.5 px under a 4 px margin, which is a
  // hair under the half in floating point. Both axes, negative translations
  // included.
  const width = halfPixelRun.glyphs.reduce((w, g) => w + g.ax, 0);
  const baseline = 4 + [889, 944, 778, 611, 278].reduce((y, units) => y + u13(units), 0);
  for (const slack of [150 - width, (151 - width) / 2, 37.3]) {
    const reference = placed(halfPixelRun, slack, baseline);
    for (let t = -300; t <= 600; t++) {
      const across = placed(halfPixelRun, slack + t, baseline, t);
      const down = placed(halfPixelRun, slack, baseline + t, 0, t);
      assert.deepEqual(across, reference, `slack ${slack}, moved ${t} px right`);
      assert.deepEqual(down, reference, `slack ${slack}, moved ${t} px down`);
    }
  }
});

test('positionGlyphs: an origin a hair under a whole pixel walks the same pen as one exactly on it', () => {
  // A run that starts where a word ends: 556 + 722 + 722 units are 26 px in
  // real arithmetic and 25.999999999999996 in floating point. Moved along,
  // that origin stays a hair under the whole pixel at some magnitudes and
  // lands exactly on it at others. Snapping only the fraction would round the
  // hair up to 1 and walk the pen from 1 at some translations and from 0 at
  // others, and the two walks round this run's seventh pen, 45.5 px in,
  // differently.
  const word = [556, 722, 722].reduce((w, units) => w + u13(units), 0);
  const run = {
    glyphs: [667, 500, 500, 778, 611, 444, 778].map((units) => ({ ax: u13(units), dx: 0, dy: 0 }))
  };
  const reference = placed(run, word, 20);
  for (let t = -300; t <= 600; t++) {
    assert.deepEqual(placed(run, word + t, 20, t), reference, `moved ${t} px right`);
  }
});

test('positionGlyphs: the snap moves a glyph only within 1/512 px of a rounding boundary', () => {
  // Against rounding the plain floating-point sum, which is what placement did
  // before: away from the knife-edge no glyph may move. Negative origins,
  // kerning and mark offsets included.
  let seed = 7;
  const next = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const clear = (v) => Math.abs(v - Math.floor(v) - 0.5) > 1 / 512 + 1e-9;
  // `+ 0` folds the -0 that Math.round gives for (-0.5, 0): the same pixel
  const pixel = (v) => Math.round(v) + 0;
  let compared = 0;
  for (let trial = 0; trial < 2000; trial++) {
    const size = 9 + Math.floor(next() * 40);
    const glyphs = Array.from({ length: 12 }, () => ({
      ax: ((250 + Math.floor(next() * 750)) * size) / 1000,
      dx: next() < 0.3 ? -(Math.floor(next() * 80) * size) / 1000 : 0,
      dy: next() < 0.2 ? (Math.floor(next() * 400) * size) / 1000 : 0
    }));
    const x = (next() - 0.3) * 1000;
    const y = (next() - 0.3) * 1000;
    const got = positionGlyphs([{ run: { glyphs }, x, y }]);
    let pen = x;
    glyphs.forEach((g, i) => {
      const gx = pen + g.dx;
      const gy = y - g.dy;
      pen += g.ax;
      if (clear(gx)) {
        assert.equal(got[i].x + 0, pixel(gx), `trial ${trial}, glyph ${i} x`);
        compared++;
      }
      if (clear(gy)) {
        assert.equal(got[i].y + 0, pixel(gy), `trial ${trial}, glyph ${i} y`);
        compared++;
      }
    });
  }
  assert.ok(compared > 40000, `compared ${compared} coordinates, nearly all of them`);
});

// ----------------------------------------------------------------- pixels

const W = 400;

let app = null;

before(async () => {
  const server = xserver.createServer({ width: 480, height: 240 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(VF), { family: 'Fixture' });
  fontSource.alias('sans-serif', 'Fixture');
  app = await createClient({ stream: clientEnd, fontSource });
});

after(async () => {
  if (app) await app.close();
});

/** paint `draw` onto a fresh white W x `height` pixmap and read it back */
async function paint(height, draw) {
  const pixmap = app.createPixmap({ width: W, height, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, height);
  ctx.fillStyle = 'black';
  draw(ctx);
  const image = await ctx.getImageData(0, 0, W, height);
  pixmap.destroy();
  return image;
}

const inkOf = (image) => {
  let n = 0;
  for (let i = 0; i < image.data.length; i += 4) if (image.data[i] < 255) n++;
  return n;
};

/** pixels of `a` that differ from `b` read `dx` columns further right */
function shiftedDiff(a, b, dx, height) {
  let diff = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x + dx < W; x++) {
      const i = (y * W + x) * 4;
      const j = i + dx * 4;
      if (a.data[i] !== b.data[j] || a.data[i + 1] !== b.data[j + 1] || a.data[i + 2] !== b.data[j + 2]) {
        diff++;
      }
    }
  }
  return diff;
}

test('TextLayout.draw: a right-aligned paragraph drawn 48 px along is the same pixels 48 px along', async () => {
  // right alignment starts each line on a fraction, and the translate carries
  // a scroll offset, the way react-x11 draws a scrolled box
  const layout = app.fonts.layout(
    [{ text: 'gloves, and Handgloves.', family: 'sans-serif', size: 22, color: 'black' }],
    { family: 'sans-serif', size: 22 },
    { maxWidth: 210, align: 'right' }
  );
  const height = Math.ceil(layout.height) + 8;
  const at = (tx) =>
    paint(height, (ctx) => {
      ctx.translate(tx, 0);
      layout.draw(ctx, 0, 4);
    });
  const near = await at(104);
  const far = await at(152);
  assert.ok(inkOf(near) > 0, 'the paragraph drew');
  assert.equal(shiftedDiff(near, far, 48, height), 0, 'every pixel moved by exactly 48');
});

test('fillText: right-aligned text drawn 48 px along is the same pixels 48 px along', async () => {
  const at = (tx) =>
    paint(60, (ctx) => {
      ctx.translate(tx, 0);
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('Hands on gloves', 204, 40);
    });
  const near = await at(104);
  const far = await at(152);
  assert.ok(inkOf(near) > 0, 'the text drew');
  assert.equal(shiftedDiff(near, far, 48, 60), 0, 'every pixel moved by exactly 48');
});
