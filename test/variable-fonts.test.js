// Variable fonts: one file, a continuous design space, and a static
// instance cut out of it per point that is actually asked for.
//
// Hermetic — the variable face is `test/fixtures`, since nothing else in the
// tree has an axis and fontkit cannot instantiate one out of a .woff2.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import Font, { normalizeVariations, variationKey } from '../lib/text/font.js';
import FontManager from '../lib/text/fontmanager.js';
import { StaticFontSource } from '../lib/text/fontsource.js';
import { opszFixture } from './helpers/opsz-fixture.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const VF = join(fixtures, 'MonelogicsSubset[wght].ttf');
const SAMPLE = 'Handgloves';

const load = () => Font.loadSync(VF);

/** width of the sample at a size, the cheapest thing an axis moves */
const widthOf = (font, size = 100) => font.shape(SAMPLE, size).width;

function manager() {
  const source = new StaticFontSource();
  source.add(readFileSync(VF), { family: 'Test VF' });
  source.alias('sans-serif', 'test vf');
  return new FontManager({ source });
}

// --- the axis ---------------------------------------------------------------

test('a variable face reports its axes, a static one reports none', () => {
  const font = load();
  assert.deepEqual(Object.keys(font.variationAxes), ['wght']);
  const { wght } = font.variationAxes;
  assert.equal(wght.min, 100);
  assert.equal(wght.max, 900);
  assert.equal(wght.default, 400);
});

test('an instance is a real font at that point in the space', () => {
  const font = load();
  const thin = font.variation({ wght: 100 });
  const black = font.variation({ wght: 900 });

  assert.ok(widthOf(thin) < widthOf(black), 'Black sets wider than Thin');
  assert.notEqual(thin.key, black.key, 'distinct coordinates, distinct keys');

  // and it is a *font*: it shapes, measures and rasterizes like any face
  const glyph = black.shape(SAMPLE, 64).glyphs[0];
  assert.ok(black.rasterize(glyph.id, 64), 'an instance rasterizes');
  assert.equal(black.unitsPerEm, font.unitsPerEm);
  assert.ok(black.metrics(100).ascent > 0);
});

test('the key is derived from the coordinates, so glyph caches never collide', () => {
  const font = load();
  const keys = new Set();
  for (const wght of [100, 250, 400.5, 620, 900]) {
    keys.add(font.variation({ wght }).key);
  }
  assert.equal(keys.size, 5, 'five coordinates, five glyph-page keys');
  for (const key of keys) assert.ok(key.startsWith(font.key), 'keyed off the base face');
});

// --- normalization ----------------------------------------------------------

test('settings are clamped, rounded, and sorted into a canonical key', () => {
  const axes = { wght: { min: 100, default: 400, max: 900 }, wdth: { min: 50, default: 100, max: 200 } };
  assert.deepEqual(normalizeVariations({ wght: 5000 }, axes), { wght: 900 });
  assert.deepEqual(normalizeVariations({ wght: -10 }, axes), { wght: 100 });
  assert.deepEqual(normalizeVariations({ wght: 459.9999999 }, axes), { wght: 460 });
  // tag order in, canonical order out — one cache entry, not two
  assert.equal(
    variationKey(normalizeVariations({ wght: 700, wdth: 75 }, axes)),
    variationKey(normalizeVariations({ wdth: 75, wght: 700 }, axes))
  );
  assert.equal(variationKey(normalizeVariations({ wght: 700, wdth: 75 }, axes)), 'wdth=75,wght=700');
});

test('a no-op setting returns the font itself rather than a copy of it', () => {
  const font = load();
  // the default coordinate *is* this font
  assert.equal(font.variation({ wght: 400 }), font);
  // an axis this font does not have is ignored, not an error
  assert.equal(font.variation({ wdth: 75 }), font);
  assert.equal(font.variation({}), font);
  assert.equal(font.variation(null), font);
});

test('instances are memoized, so the same point is the same font', () => {
  const font = load();
  assert.equal(font.variation({ wght: 620 }), font.variation({ wght: 620 }));
  // and equal-after-rounding coordinates land on that same instance
  assert.equal(font.variation({ wght: 620.001 }), font.variation({ wght: 620 }));
});

test('a static face is untouched by any of this', () => {
  const source = new StaticFontSource();
  const font = source.add(readFileSync(VF), { family: 'x' });
  const flat = new Font(font.fk); // same file, used as a plain face
  assert.equal(flat.variation({ nope: 1 }), flat);
});

// --- weight is the wght axis ------------------------------------------------

test('a numeric fontWeight drives the wght axis', () => {
  const fonts = manager();
  const light = fonts.match('Test VF', { weight: 200 });
  const bold = fonts.match('Test VF', { weight: 800 });

  assert.notEqual(light.key, bold.key);
  assert.ok(widthOf(light) < widthOf(bold), '800 sets wider than 200');
});

test('weights between the named instances work — the point of an axis', () => {
  const fonts = manager();
  const widths = [400, 460, 520].map((weight) => widthOf(fonts.match('Test VF', { weight })));
  assert.ok(widths[0] < widths[1] && widths[1] < widths[2], `monotonic, got ${widths}`);
});

test('an out-of-range weight clamps to the axis instead of failing', () => {
  const fonts = manager();
  assert.equal(
    fonts.match('Test VF', { weight: 5000 }).key,
    fonts.match('Test VF', { weight: 900 }).key
  );
});

test('an explicit wght in variations beats the weight', () => {
  const fonts = manager();
  const byWeight = fonts.match('Test VF', { weight: 900 });
  const byAxis = fonts.match('Test VF', { weight: 900, variations: { wght: 200 } });
  assert.notEqual(byWeight.key, byAxis.key);
  assert.equal(byAxis.key, fonts.match('Test VF', { weight: 200 }).key);
});

test('matches are cached per coordinate, not per weight bucket', () => {
  const fonts = manager();
  assert.equal(fonts.match('Test VF', { weight: 460 }), fonts.match('Test VF', { weight: 460 }));
  assert.notEqual(
    fonts.match('Test VF', { weight: 460 }),
    fonts.match('Test VF', { weight: 461 })
  );
});

// --- nothing is rasterized up front -----------------------------------------

test('instantiating rasterizes nothing; drawing rasterizes what it draws', () => {
  const font = load();
  const instance = font.variation({ wght: 700 });
  // an instance is a table-level object — no glyph work has happened, and
  // asking for one glyph does not produce the others
  const glyphs = instance.shape('H', 48).glyphs;
  assert.equal(glyphs.length, 1);
  assert.ok(instance.rasterize(glyphs[0].id, 48));
});

test('the instance cache is bounded, so an animated axis cannot grow forever', () => {
  const font = load();
  for (let wght = 100; wght <= 900; wght += 1) font.variation({ wght });
  assert.ok(
    font._variations.size <= 64,
    `801 coordinates should not retain 801 faces, kept ${font._variations.size}`
  );
  // and the most recent are the ones kept
  assert.ok(font._variations.has('wght=900'));
});

// --- layout and spans -------------------------------------------------------

test('a span carries its own variations through layout', () => {
  const fonts = manager();
  const style = { family: 'Test VF', size: 40, weight: 400 };
  const flat = fonts.layout([{ text: SAMPLE }], style, {});
  const heavy = fonts.layout([{ text: SAMPLE, variations: { wght: 900 } }], style, {});
  assert.ok(heavy.width > flat.width, `${heavy.width} should exceed ${flat.width}`);
});

test('the paragraph style reaches spans that do not override it', () => {
  const fonts = manager();
  const base = { family: 'Test VF', size: 40, weight: 400 };
  const flat = fonts.layout([{ text: SAMPLE }], base, {});
  const heavy = fonts.layout([{ text: SAMPLE }], { ...base, variations: { wght: 900 } }, {});
  assert.ok(heavy.width > flat.width);
});

test('two points of one axis do not share a shaped run', () => {
  const fonts = manager();
  const style = { family: 'Test VF', size: 40, weight: 400 };
  const thin = fonts.shape(SAMPLE, { ...style, variations: { wght: 100 } });
  const black = fonts.shape(SAMPLE, { ...style, variations: { wght: 900 } });
  assert.ok(black.width > thin.width, 'the shaping memo keys on the coordinate');
});

// --- optical size is the size ------------------------------------------------
//
// `opsz` is the axis a style never names and always sets: CSS has had
// `font-optical-sizing: auto` as the initial value since optical sizing was
// specified, so the coordinate follows `font-size` unless the author takes
// it over. The face here is the fixture with its axis relabelled — see
// helpers/opsz-fixture.js for why that is a real axis and not a fiction.

function opszManager() {
  const source = new StaticFontSource();
  source.add(opszFixture(), { family: 'Test OPSZ' });
  return new FontManager({ source });
}

test('the fixture relabelled for these tests really does carry an opsz axis', () => {
  const fonts = opszManager();
  const axes = fonts.match('Test OPSZ', { opticalSizing: 'none' }).variationAxes;
  assert.deepEqual(Object.keys(axes), ['opsz']);
  assert.deepEqual([axes.opsz.min, axes.opsz.default, axes.opsz.max], [17, 28, 96]);
});

test('the size text is set at drives the opsz axis', () => {
  const fonts = opszManager();
  assert.deepEqual(fonts.match('Test OPSZ', { size: 40 }).variationCoords, { opsz: 40 });
  assert.deepEqual(fonts.match('Test OPSZ', { size: 96 }).variationCoords, { opsz: 96 });
});

test('a UI size below the axis clamps to its Text end, not the file default', () => {
  const fonts = opszManager();
  const label = fonts.match('Test OPSZ', { size: 13 });
  assert.deepEqual(label.variationCoords, { opsz: 17 });
  assert.equal(label, fonts.match('Test OPSZ', { size: 17 }));
  // the bug: 13px text set in the display cut the file happens to default to
  assert.notEqual(label, fonts.match('Test OPSZ', { opticalSizing: 'none' }));
});

test('each size gets its own instance — the match cache is not keyed on the first', () => {
  const fonts = opszManager();
  const small = fonts.match('Test OPSZ', { size: 24 });
  const large = fonts.match('Test OPSZ', { size: 72 });
  assert.notEqual(small.key, large.key);
  assert.equal(small, fonts.match('Test OPSZ', { size: 24 }), 'and still cached per size');
  assert.ok(widthOf(large) > widthOf(small), 'a display cut sets wider at one size');
});

test('an explicit opsz beats the size, as font-variation-settings does in CSS', () => {
  const fonts = opszManager();
  const pinned = fonts.match('Test OPSZ', { size: 13, variations: { opsz: 72 } });
  assert.deepEqual(pinned.variationCoords, { opsz: 72 });
  assert.equal(pinned, fonts.match('Test OPSZ', { size: 72 }));
});

test("opticalSizing 'none' leaves the axis where the file put it", () => {
  const fonts = opszManager();
  const off = fonts.match('Test OPSZ', { size: 13, opticalSizing: 'none' });
  assert.equal(off.variationCoords, undefined, 'the base face, not an instance of it');
  assert.notEqual(off, fonts.match('Test OPSZ', { size: 13 }));
  // and it is the switch, not a pin: an explicit coordinate still applies
  assert.deepEqual(
    fonts.match('Test OPSZ', { size: 13, opticalSizing: 'none', variations: { opsz: 40 } })
      .variationCoords,
    { opsz: 40 }
  );
});

test('opticalSize is the size for the axis when it is not the size for the glyphs', () => {
  const fonts = opszManager();
  // a caller that pre-multiplied by a 2x device scale: 26 device pixels of
  // glyph, still a 13px label to whoever is reading it
  const scaled = fonts.match('Test OPSZ', { size: 26, opticalSize: 13 });
  assert.deepEqual(scaled.variationCoords, { opsz: 17 });
  assert.equal(scaled, fonts.match('Test OPSZ', { size: 13 }));
});

test('a face without an opsz axis is not touched by any of this', () => {
  const fonts = manager();
  const small = fonts.match('Test VF', { weight: 500, size: 13 });
  const large = fonts.match('Test VF', { weight: 500, size: 96 });
  assert.equal(small, large, 'one instance, whatever size it is drawn at');
  assert.deepEqual(small.variationCoords, { wght: 500 }, 'the weight still lands');
});

test('shaping follows the axis: the same string is not just scaled up', () => {
  const fonts = opszManager();
  const style = { family: 'Test OPSZ' };
  const small = fonts.shape(SAMPLE, { ...style, size: 13 });
  const large = fonts.shape(SAMPLE, { ...style, size: 96 });
  // both come from the memo's family path, which has to tell the two apart
  assert.ok(
    large.width / 96 > small.width / 13,
    `the display cut sets relatively wider, got ${large.width / 96} vs ${small.width / 13}`
  );
});

test('a span turns optical sizing off for itself', () => {
  const fonts = opszManager();
  const style = { family: 'Test OPSZ', size: 96 };
  const auto = fonts.layout([{ text: SAMPLE }], style, {});
  const off = fonts.layout([{ text: SAMPLE, opticalSizing: 'none' }], style, {});
  assert.ok(auto.width > off.width, `${auto.width} (opsz 96) should exceed ${off.width} (opsz 28)`);
});
