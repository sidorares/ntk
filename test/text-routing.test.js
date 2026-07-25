// Bitmap/vector routing policy and glyph-page LRU — pure unit tests
// (no X server: fake app object, fake fonts with stable keys).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_TEXT_POLICY, routeGlyphSize, trimGlyphPages } from '../lib/text/glyphs.js';

const fakeFont = (key) => ({ key });
const fakeApp = (policy) => ({ textPolicy: policy });

test('small sizes always use bitmaps', () => {
  const app = fakeApp();
  const font = fakeFont('a');
  for (const size of [8, 16, 64, 128, 12.5, 96.25]) {
    assert.equal(routeGlyphSize(app, font, size), 'bitmap', `size ${size}`);
  }
});

test('sizes above vectorFrom use the vector path', () => {
  const app = fakeApp();
  assert.equal(routeGlyphSize(app, fakeFont('a'), 257), 'vector');
  assert.equal(routeGlyphSize(app, fakeFont('a'), 512), 'vector');
});

test('vectorFrom: Infinity opts out of the vector path for static sizes', () => {
  const app = fakeApp({ vectorFrom: Infinity });
  assert.equal(routeGlyphSize(app, fakeFont('a'), 512), 'bitmap');
});

test('middle band: fractional sizes go vector, stable integers stay bitmap', () => {
  const app = fakeApp();
  const font = fakeFont('a');
  assert.equal(routeGlyphSize(app, font, 200.5), 'vector');
  assert.equal(routeGlyphSize(app, font, 200), 'bitmap');
  assert.equal(routeGlyphSize(app, font, 200), 'bitmap');
});

test('middle band: size churn (animation) flips to vector, reuse flips back', () => {
  const app = fakeApp();
  const font = fakeFont('a');
  const routes = [];
  for (let s = 130; s < 142; s++) routes.push(routeGlyphSize(app, font, s));
  assert.equal(routes[0], 'bitmap', 'first sizes give bitmaps a chance');
  assert.equal(routes[routes.length - 1], 'vector', 'sustained churn routes to vector');
  // animation settled: the repeated size is in the recent ring -> bitmap again
  assert.equal(routeGlyphSize(app, font, 141), 'bitmap');
});

test('ring buffers are per font face', () => {
  const app = fakeApp();
  const a = fakeFont('a');
  for (let s = 130; s < 140; s++) routeGlyphSize(app, a, s);
  assert.equal(routeGlyphSize(app, a, 141), 'vector');
  assert.equal(routeGlyphSize(app, fakeFont('b'), 141), 'bitmap', 'other face unaffected');
});

test('trimGlyphPages evicts least-recently-used pages down to the budget', () => {
  const destroyed = [];
  const page = (name, bytes) => ({ bytes, destroy: () => destroyed.push(name) });
  const app = {
    textPolicy: { cacheBytes: 250 },
    _glyphPages: new Map([
      ['old', page('old', 100)],
      ['mid', page('mid', 100)],
      ['new', page('new', 100)]
    ])
  };
  trimGlyphPages(app);
  assert.deepEqual(destroyed, ['old'], 'oldest evicted first, stops at budget');
  assert.deepEqual([...app._glyphPages.keys()], ['mid', 'new']);
});

test('trimGlyphPages never evicts pages referenced by the current draw', () => {
  const destroyed = [];
  const mk = (name, bytes) => ({ bytes, destroy: () => destroyed.push(name) });
  const inUsePage = mk('inuse', 300);
  const app = {
    textPolicy: { cacheBytes: 100 },
    _glyphPages: new Map([
      ['inuse', inUsePage],
      ['other', mk('other', 50)]
    ])
  };
  trimGlyphPages(app, undefined, new Set([inUsePage]));
  assert.deepEqual(destroyed, ['other']);
  assert.ok(app._glyphPages.has('inuse'));
});

test('default policy matches issue #45 thresholds', () => {
  assert.equal(DEFAULT_TEXT_POLICY.bitmapMax, 128);
  assert.equal(DEFAULT_TEXT_POLICY.vectorFrom, 256);
  assert.ok(DEFAULT_TEXT_POLICY.cacheBytes >= 4 << 20);
});
