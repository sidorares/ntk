// `textRendering`: a run's own answer to which glyph path it takes.
//
// The thresholds in `textPolicy` are a guess from size, and a good one for
// UI text. They cannot know that a word is a headline whose weight is under
// a slider — and on the bitmap path that word's advances round to whole
// pixels, so a fraction of drift accumulates silently until one glyph
// crosses a boundary and jumps a pixel by itself while its neighbours stand
// still. This is how an app says which it wants.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import FontManager from '../lib/text/fontmanager.js';
import { StaticFontSource } from '../lib/text/fontsource.js';
import {
  DEFAULT_TEXT_POLICY,
  routeForRendering,
  routeGlyphSize
} from '../lib/text/glyphs.js';

const VF = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'MonelogicsSubset[wght].ttf'
);

const SMALL = DEFAULT_TEXT_POLICY.bitmapMax - 20; // the thresholds say bitmap
const HUGE = DEFAULT_TEXT_POLICY.vectorFrom + 100; // the thresholds say vector

function font() {
  const source = new StaticFontSource();
  source.add(readFileSync(VF), { family: 'VF' });
  return new FontManager({ source }).match('VF', { weight: 400 });
}

const newApp = () => ({});

test('the values map to the two paths, and auto defers', () => {
  assert.equal(routeForRendering('geometricPrecision'), 'vector');
  assert.equal(routeForRendering('optimizeSpeed'), 'bitmap');
  assert.equal(routeForRendering('auto'), null);
  assert.equal(routeForRendering(undefined), null);
  // no hinting to turn on, so it promises nothing
  assert.equal(routeForRendering('optimizeLegibility'), null);
  assert.equal(routeForRendering('nonsense'), null);
});

test('geometricPrecision wins where the thresholds say bitmap', () => {
  const f = font();
  assert.equal(routeGlyphSize(newApp(), f, SMALL), 'bitmap', 'the default');
  assert.equal(
    routeGlyphSize(newApp(), f, SMALL, undefined, 'geometricPrecision'),
    'vector'
  );
});

test('optimizeSpeed wins where the thresholds say vector', () => {
  const f = font();
  assert.equal(routeGlyphSize(newApp(), f, HUGE), 'vector', 'the default');
  assert.equal(
    routeGlyphSize(newApp(), f, HUGE, undefined, 'optimizeSpeed'),
    'bitmap'
  );
});

test('auto leaves every threshold exactly as it was', () => {
  const f = font();
  for (const size of [SMALL, HUGE]) {
    assert.equal(
      routeGlyphSize(newApp(), f, size, undefined, 'auto'),
      routeGlyphSize(newApp(), f, size)
    );
  }
});

test('a policy default applies app-wide, and a run still overrides it', () => {
  const f = font();
  const app = { textPolicy: { textRendering: 'geometricPrecision' } };
  assert.equal(routeGlyphSize(app, f, SMALL), 'vector', 'the app asked');
  assert.equal(
    routeGlyphSize(app, f, SMALL, undefined, 'optimizeSpeed'),
    'bitmap',
    'the run asked louder'
  );
});

test('it overrides the churn heuristic too, in both directions', () => {
  const f = font();
  const mid = Math.round(
    (DEFAULT_TEXT_POLICY.bitmapMax + DEFAULT_TEXT_POLICY.vectorFrom) / 2
  );
  // an app that has decided its large text is static keeps the cache even
  // while the ring is calling it churn
  const app = newApp();
  const routes = [];
  for (let i = 0; i < 12; i++) {
    routes.push(routeGlyphSize(app, f, mid + i, undefined, 'optimizeSpeed'));
  }
  assert.ok(routes.every((r) => r === 'bitmap'), `got ${routes.join(' ')}`);
});
