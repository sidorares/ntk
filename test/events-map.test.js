import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  coalesce,
  eventName,
  extensionEventNames,
  mask,
  maskCamelCase,
  toSnake
} from '../lib/events_map.js';

test('every camelCase handler name maps to a snake event with a mask entry', () => {
  for (const [camel, snake] of Object.entries(toSnake)) {
    assert.ok(snake in mask, `mask missing for ${snake}`);
    assert.equal(maskCamelCase[camel], mask[snake], `mask mismatch for ${camel}`);
  }
});

// names in the mask table that are not X event types. `statechange` is
// derived from the PropertyNotify for _NET_WM_STATE and `wheel` from a
// ButtonPress of button 4-7 (or an XI2 scroll valuator); both are in the
// table because a listener for one still has to select the mask it is
// derived from.
const DERIVED = new Set(['statechange', 'wheel']);

test('every maskable event name is emitted by some X event type, or derived from one', () => {
  const emitted = new Set(eventName.filter(Boolean));
  for (const name of Object.keys(mask)) {
    if (name === 'selection_clear' || DERIVED.has(name)) continue;
    assert.ok(emitted.has(name), `${name} never emitted`);
  }
  for (const name of DERIVED) {
    assert.ok(mask[name], `${name} is derived but selects no mask`);
    assert.ok(!emitted.has(name), `${name} is an X event after all — drop it from DERIVED`);
  }
});

test('coalescible events are known event names with known strategies', () => {
  const emitted = new Set(eventName.filter(Boolean));
  for (const [name, strategy] of Object.entries(coalesce)) {
    assert.ok(
      emitted.has(name) || DERIVED.has(name) || extensionEventNames.has(name),
      `${name} never emitted`
    );
    assert.ok(['last', 'union', 'accumulate'].includes(strategy), `unknown strategy ${strategy}`);
  }
  assert.equal(coalesce.mousemove, 'last');
  assert.equal(coalesce.resize, 'last');
  assert.equal(coalesce.expose, 'union');
  assert.equal(coalesce.damage, 'union');
  assert.equal(coalesce.wheel, 'accumulate');
});

test('core event codes map to browser-like names', () => {
  assert.equal(eventName[4], 'mousedown');
  assert.equal(eventName[6], 'mousemove');
  assert.equal(eventName[12], 'expose');
  assert.equal(eventName[22], 'resize');
});
