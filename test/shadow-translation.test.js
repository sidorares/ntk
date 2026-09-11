// Text shadows are translation-invariant, as the glyphs casting them are
// (issue #350): the same text drawn whole pixels away puts its shadow
// exactly that many pixels away.
//
// A text shadow is cached coverage composited at an anchor. fillText's
// anchors at its run's origin; drawGlyphs', and so every TextLayout's, at
// its first run's, with the other runs placed inside the coverage at
// whole-pixel offsets from that one. Both used to round floating-point sums,
// `origin + shadowOffset` and `origin - first`, and like the glyph pens #350
// fixed, their last bits depend on the origin's magnitude. An anchor that
// should sit exactly on a half pixel went down at x 104 and up at x 152,
// moving the whole shadow a pixel; an offset between two runs on a half
// pixel moved one word's shadow and changed the cache key, so a scrolled
// paragraph built its coverage again. react-x11's scroll blit copies pixels
// it already drew, and a repaint has to match them byte for byte.
//
// Pixels first, through the two calls a consumer draws text with — fillText
// and TextLayout.draw — on node-x11's in-process X server with the fixture
// font; every one of those put a shadow a pixel off before the fix. Then the
// arithmetic both anchors round with now, `roundFrom` and `snapOrigin`, which
// they share with positionGlyphs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';
import { roundFrom, snapOrigin } from '../lib/text/glyphs.js';

const VF = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'MonelogicsSubset[wght].ttf');

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

/** paint `draw` onto a fresh white W x `height` pixmap under a blue shadow
 * offset by `offsetX`, and read it back */
async function paint(height, offsetX, draw) {
  const pixmap = app.createPixmap({ width: W, height, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, height);
  ctx.fillStyle = 'black';
  ctx.shadowColor = 'rgba(0, 0, 160, 0.6)';
  ctx.shadowBlur = 2;
  ctx.shadowOffsetX = offsetX;
  ctx.shadowOffsetY = 2;
  draw(ctx);
  const image = await ctx.getImageData(0, 0, W, height);
  pixmap.destroy();
  return image;
}

/** pixels the shadow tints: the text is grey on white, the shadow blue */
const tinted = (image) => {
  let n = 0;
  for (let i = 0; i < image.data.length; i += 4) if (image.data[i + 2] - image.data[i] > 16) n++;
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

/** `text` laid out at `size` px in the fixture face */
const layoutOf = (text, size, options) =>
  app.fonts.layout(
    [{ text, family: 'sans-serif', size, color: 'black' }],
    { family: 'sans-serif', size },
    options
  );

test('fillText: a shadow drawn 48 px along is the same pixels 48 px along', async () => {
  // Each anchor is on a half pixel in real arithmetic and a hair off it in
  // floating point. 'ends Dale' is 4580 units wide, 114.5 px at 25px and
  // 114.50000000000001 as its advances sum, so right-aligned at x 112 it
  // starts a hair under 101.5 — a hair that survives at x 104 and is rounded
  // away at x 152. Centred 'Genoa Sand Glass 76' is 158 px at 16px, a hair
  // over too, and its anchor lands on a half with the 1.5 px offset added.
  for (const c of [
    { text: 'ends Dale', size: 25, align: 'right', x: 112, offsetX: 0 },
    { text: 'ends Dale', size: 25, align: 'right', x: 112, offsetX: 3 },
    { text: 'Genoa Sand Glass 76', size: 16, align: 'center', x: 80, offsetX: 1.5 }
  ]) {
    const at = (tx) =>
      paint(70, c.offsetX, (ctx) => {
        ctx.translate(tx, 0);
        ctx.font = `${c.size}px sans-serif`;
        ctx.textAlign = c.align;
        ctx.fillText(c.text, c.x, 45);
      });
    const near = await at(104);
    const far = await at(152);
    const what = `'${c.text}' ${c.align}-aligned, shadowOffsetX ${c.offsetX}`;
    assert.ok(tinted(near) > 50, `${what}: the shadow drew`);
    assert.equal(shiftedDiff(near, far, 48, 70), 0, `${what}: every pixel moved by exactly 48`);
  }
});

test("TextLayout.draw: a right-aligned paragraph's shadow drawn 48 px along is the same pixels 48 px along", async () => {
  // 'Hands on gloves' wraps in 100 px at 20px, and its first line is 87.5 px
  // wide, so right alignment starts it on 12.5 — 12.499999999999986 in
  // floating point. The paragraph's shadow anchors there, and the translate
  // carries a scroll offset, the way react-x11 draws a scrolled box.
  const layout = layoutOf('Hands on gloves', 20, { maxWidth: 100, align: 'right' });
  const height = Math.ceil(layout.height) + 12;
  for (const offsetX of [0, 3]) {
    const at = (tx) =>
      paint(height, offsetX, (ctx) => {
        ctx.translate(tx, 0);
        layout.draw(ctx, 0, 4);
      });
    const near = await at(104);
    const far = await at(152);
    assert.ok(tinted(near) > 50, `shadowOffsetX ${offsetX}: the shadow drew`);
    assert.equal(
      shiftedDiff(near, far, 48, height),
      0,
      `shadowOffsetX ${offsetX}: every pixel moved by exactly 48`
    );
  }
});

test('TextLayout.draw: the words of a centred line keep their shadows, and their cache entry, 48 px along', async () => {
  // A line is a run per word, and the paragraph's coverage places each run
  // at a whole-pixel offset from the first. 'gold ends ' is 4725 units,
  // 94.5 px at 20px, so 'Sven' starts a half pixel along in real arithmetic;
  // taken as the difference of two device origins, that offset came to
  // 94.49999999999999 at x 104 and 94.5 at x 152. Sven's shadow moved a
  // pixel, and the second draw missed the cache and built its coverage again.
  const layout = layoutOf('gold ends Sven 76.', 20, { maxWidth: 200, align: 'center' });
  assert.equal(layout.lines.length, 1, 'one line');
  assert.equal(layout.lines[0].runs.length, 4, 'four runs, one per word');
  const height = Math.ceil(layout.height) + 12;
  app._shadowSurfaces?.clear(); // other tests in this file drew text too
  for (const offsetX of [0, 1.5, 3]) {
    const at = (tx) =>
      paint(height, offsetX, (ctx) => {
        ctx.translate(tx, 0);
        layout.draw(ctx, 0, 4);
      });
    const near = await at(104);
    const far = await at(152);
    assert.ok(tinted(near) > 50, `shadowOffsetX ${offsetX}: the shadow drew`);
    assert.equal(
      shiftedDiff(near, far, 48, height),
      0,
      `shadowOffsetX ${offsetX}: every pixel moved by exactly 48`
    );
  }
  // the offset is not part of the key: one coverage, whatever it is composited at
  assert.equal(app._shadowSurfaces.size, 1, 'one coverage surface for every draw');
  app._shadowSurfaces.clear();
});

// ------------------------------------------------------------- arithmetic

// Advances of a 1000-upem face at 23 px. 836 + 395 + 786 + 483 units come to
// 57.5 px in real arithmetic and to 57.50000000000001 as they sum in floating
// point: the hair over a half that 'ends Dale' has at 25px.
const u23 = (units) => (units * 23) / 1000;
const hairOver = [836, 395, 786, 483].reduce((w, units) => w + u23(units), 0);

// whole-pixel translations, negative ones included
const TRANSLATIONS = Array.from({ length: 901 }, (_, i) => i - 300);

/** how many different values `f` takes over the translations */
const landings = (f) => new Set(TRANSLATIONS.map(f)).size;

test('roundFrom: an anchor on a half pixel lands the same at every whole-pixel origin', () => {
  // The run right-aligned in 150 px and moved t px, its origin built the way
  // the text builds one: the box's edge moved first, the width taken off
  // after. Rounded as one sum, it lands two ways over the range; roundFrom
  // lands it one way at every offset, those that are not exact in binary
  // too. It does not know which axis it rounds, and the shadows use it for
  // both.
  assert.equal(hairOver, 57.50000000000001);
  const origin = (t) => 150 + t - hairOver;
  for (const offset of [0, 3]) {
    assert.equal(
      landings((t) => Math.round(origin(t) + offset) - t),
      2,
      `offset ${offset}: plain rounding does land two ways`
    );
  }
  for (const offset of [0, 3, 1.5, -1.5, 0.25, 0.7, 0.1 * 15]) {
    const reference = roundFrom(origin(0), offset);
    for (const t of TRANSLATIONS) {
      assert.equal(roundFrom(origin(t), offset) - t, reference, `offset ${offset}, moved ${t} px`);
    }
  }
});

test('snapOrigin: the offset between two runs rounds the same wherever they are drawn', () => {
  // A line starting on a fraction, and a run `hairOver` px along it, both
  // moved t px: the difference of the two device origins rounds two ways over
  // the range, the difference of the snapped ones one way.
  const lineX = 12.95;
  const first = (t) => lineX + t;
  const run = (t) => lineX + hairOver + t;
  assert.equal(landings((t) => Math.round(run(t) - first(t))), 2, 'plain rounding does land two ways');
  assert.equal(landings((t) => Math.round(snapOrigin(run(t)) - snapOrigin(first(t)))), 1);
});

test('roundFrom and snapOrigin round as plain rounding does, away from the knife-edge', () => {
  // Against what the shadows did before: nothing may move but what lies
  // within the snap of a rounding boundary, 1/512 px for an anchor and 1/256
  // for a difference of two snapped origins.
  let seed = 7;
  const next = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const clear = (v, margin) => Math.abs(v - Math.floor(v) - 0.5) > margin + 1e-9;
  // `+ 0` folds the -0 that Math.round gives for (-0.5, 0): the same pixel
  const pixel = (v) => Math.round(v) + 0;
  let compared = 0;
  for (let trial = 0; trial < 20000; trial++) {
    const origin = (next() - 0.3) * 1000;
    const offset = (next() - 0.5) * 20;
    const other = origin + (next() - 0.5) * 400;
    if (clear(origin + offset, 1 / 512)) {
      assert.equal(roundFrom(origin, offset) + 0, pixel(origin + offset), `trial ${trial}, anchor`);
      compared++;
    }
    if (clear(other - origin, 1 / 256)) {
      assert.equal(
        Math.round(snapOrigin(other) - snapOrigin(origin)) + 0,
        pixel(other - origin),
        `trial ${trial}, offset`
      );
      compared++;
    }
  }
  assert.ok(compared > 39000, `compared ${compared} roundings, nearly all of them`);
});
