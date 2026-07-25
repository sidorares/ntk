import assert from 'node:assert/strict';
import { test } from 'node:test';

import { eventName, mask, maskCamelCase, toSnake } from '../lib/events_map.js';

test('every camelCase handler name maps to a snake event with a mask entry', () => {
  for (const [camel, snake] of Object.entries(toSnake)) {
    assert.ok(snake in mask, `mask missing for ${snake}`);
    assert.equal(maskCamelCase[camel], mask[snake], `mask mismatch for ${camel}`);
  }
});

test('every maskable event name is emitted by some X event type', () => {
  const emitted = new Set(eventName.filter(Boolean));
  for (const name of Object.keys(mask)) {
    if (name === 'selection_clear') continue;
    assert.ok(emitted.has(name), `${name} never emitted`);
  }
});

test('core event codes map to browser-like names', () => {
  assert.equal(eventName[4], 'mousedown');
  assert.equal(eventName[6], 'mousemove');
  assert.equal(eventName[12], 'expose');
  assert.equal(eventName[22], 'resize');
});
