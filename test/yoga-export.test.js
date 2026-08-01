// ntk exports its layout engine so downstream layout consumers (e.g. the
// react-x11 renderer) share one WASM instance and one set of enums.
//
// The engine is not the `yoga-layout` default entry: that entry is a
// top-level await, which makes every bundle containing ntk ESM-only and so
// rules out Node's single-executable format. ntk builds the same object from
// `yoga-layout/load` instead — enums synchronously, assembly on demand — so
// these tests check both halves of that shape.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadYoga } from 'yoga-layout/load';

import { Yoga, loadLayout, layoutLoaded } from '../lib/index.js';
import YogaFromModule from '../lib/yoga.js';

test('enum constants are readable without loading anything', () => {
  // module-scope lookup tables (ntk's HtmlView, react-x11's styles.js) are
  // built at import time and must not have to await first
  assert.equal(typeof Yoga.FLEX_DIRECTION_ROW, 'number');
  assert.equal(typeof Yoga.JUSTIFY_SPACE_EVENLY, 'number');
  assert.equal(typeof Yoga.ALIGN_BASELINE, 'number');
  assert.equal(typeof Yoga.EDGE_TOP, 'number');
  assert.equal(typeof Yoga.DIRECTION_LTR, 'number');
  assert.equal(typeof Yoga.MEASURE_MODE_UNDEFINED, 'number');
  assert.equal(typeof Yoga.WRAP_NO_WRAP, 'number');
});

test('using the assembly before it is loaded says so', async () => {
  // a fresh module instance, because the rest of this file loads the engine
  const fresh = await import('../lib/yoga.js?before-load');
  assert.equal(fresh.layoutLoaded(), false);
  assert.throws(() => fresh.default.Node.create(), /layout engine is not loaded/);
});

test('loadLayout() makes it functional, and is idempotent', async () => {
  const loaded = await loadLayout();
  assert.equal(loaded, Yoga, 'resolves with the object it filled in');
  assert.equal(await loadLayout(), Yoga, 'a second call is the same instance');
  assert.equal(layoutLoaded(), true);

  const node = Yoga.Node.create();
  node.setWidth(100);
  node.calculateLayout(100, 100, Yoga.DIRECTION_LTR);
  assert.equal(node.getComputedWidth(), 100);
  node.free();
});

test('the exported engine is the one the widgets lay out with', () => {
  assert.equal(Yoga, YogaFromModule, 'one instance for ntk and its consumers');
});

test('every constant ntk generates matches the assembly', async () => {
  // ntk derives the flat SCREAMING_CASE names from yoga's typed enums; this
  // pins them against yoga's own, so a rename upstream fails here rather
  // than silently yielding `undefined` in a layout lookup table
  await loadLayout();
  const real = await loadYoga();
  const names = Object.keys(real).filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k));
  assert.ok(names.length > 50, `expected yoga's constants, found ${names.length}`);
  for (const name of names) assert.equal(Yoga[name], real[name], `constant ${name}`);
});
