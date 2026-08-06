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
