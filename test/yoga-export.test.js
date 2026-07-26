// ntk re-exports its yoga-layout instance so downstream layout consumers
// (e.g. the react-x11 renderer) share one WASM module and one set of enums.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import YogaDirect from 'yoga-layout';

import { Yoga } from '../lib/index.js';

test('Yoga is re-exported and functional', () => {
  assert.ok(Yoga, 'Yoga export present');
  const node = Yoga.Node.create();
  node.setWidth(100);
  node.calculateLayout(100, 100, Yoga.DIRECTION_LTR);
  assert.equal(node.getComputedWidth(), 100);
  node.free();
});

test('Yoga is the same instance htmlview uses', () => {
  // htmlview.js does `import Yoga from 'yoga-layout'` — module resolution
  // guarantees identity as long as both import the same specifier from the
  // same package instance
  assert.equal(Yoga, YogaDirect, 'single shared yoga-layout module');
});
