// Which glyph path a run takes when a face is being *animated*.
//
// Between `bitmapMax` and `vectorFrom` the router watches a small ring of
// what a face has drawn recently: text that reuses its glyphs wants the
// server-side cache, and text that never draws the same thing twice wants
// the vector path, where nothing is cached and nothing leaks.
//
// A variable font broke the premise. Every point on an axis is a Font of
// its own, with its own key and its own glyph page, so an animated axis
// handed the router a fresh empty ring on every step: eight unrelated faces
// each drawn once, no churn to see. It stayed on the bitmap path and
// allocated a glyph page per step — the exact cost the ring exists to
// avoid, invisible to it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import FontManager from '../lib/text/fontmanager.js';
import { StaticFontSource } from '../lib/text/fontsource.js';
import { DEFAULT_TEXT_POLICY, routeGlyphSize } from '../lib/text/glyphs.js';

const VF = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'MonelogicsSubset[wght].ttf'
);

// squarely inside the band the ring governs
const MID = Math.round((DEFAULT_TEXT_POLICY.bitmapMax + DEFAULT_TEXT_POLICY.vectorFrom) / 2);

function fonts() {
  const source = new StaticFontSource();
  source.add(readFileSync(VF), { family: 'VF' });
  return new FontManager({ source });
}

/** routeGlyphSize only reads `_sizeRings` off the app; nothing else. */
const newApp = () => ({});

test('an animated axis at one size routes to vector', () => {
  const app = newApp();
  const manager = fonts();
  const routes = [];
  for (let wght = 400; wght < 412; wght++) {
    routes.push(routeGlyphSize(app, manager.match('VF', { weight: wght }), MID));
  }
  // the first few are allowed to be bitmap — the ring has to fill before it
  // can call it churn — but it must not stay there
  assert.ok(
    routes.slice(6).every((r) => r === 'vector'),
    `an axis sweep should settle on vector, got ${routes.join(' ')}`
  );
});

test('an animated size on one face still routes to vector', () => {
  const app = newApp();
  const font = fonts().match('VF', { weight: 400 });
  const routes = [];
  for (let i = 0; i < 12; i++) routes.push(routeGlyphSize(app, font, MID + i));
  assert.ok(
    routes.slice(6).every((r) => r === 'vector'),
    `a size sweep should settle on vector, got ${routes.join(' ')}`
  );
});

test('text that redraws the same thing stays on the cached path', () => {
  const app = newApp();
  const font = fonts().match('VF', { weight: 400 });
  const routes = [];
  for (let frame = 0; frame < 20; frame++) routes.push(routeGlyphSize(app, font, MID));
  assert.ok(
    routes.every((r) => r === 'bitmap'),
    'a static paragraph must keep its glyph cache'
  );
});

test('a handful of fixed weights is a design system, not an animation', () => {
  const app = newApp();
  const manager = fonts();
  const weights = [400, 500, 700];
  const routes = [];
  // several frames drawing the same three weights at the same size
  for (let frame = 0; frame < 8; frame++) {
    for (const weight of weights) {
      routes.push(routeGlyphSize(app, manager.match('VF', { weight }), MID));
    }
  }
  // the ring fills once, then every draw is a reuse
  assert.ok(
    routes.slice(weights.length * 2).every((r) => r === 'bitmap'),
    `three repeating weights should keep the cache, got ${routes.join(' ')}`
  );
});

test('instances of one base share a ring; unrelated faces do not', () => {
  const app = newApp();
  const manager = fonts();
  routeGlyphSize(app, manager.match('VF', { weight: 400 }), MID);
  routeGlyphSize(app, manager.match('VF', { weight: 700 }), MID);
  assert.equal(
    app._sizeRings.size,
    1,
    'two points on one axis are one face churning, not two faces'
  );
});

test('below bitmapMax the cache always wins, animated or not', () => {
  const app = newApp();
  const manager = fonts();
  const small = DEFAULT_TEXT_POLICY.bitmapMax - 20;
  const routes = [];
  for (let wght = 400; wght < 412; wght++) {
    routes.push(routeGlyphSize(app, manager.match('VF', { weight: wght }), small));
  }
  // deliberate: at small sizes a glyph page is cheap and re-rasterizing every
  // draw is not. An app that wants exact positions here asks for them.
  assert.ok(routes.every((r) => r === 'bitmap'), `got ${routes.join(' ')}`);
});
