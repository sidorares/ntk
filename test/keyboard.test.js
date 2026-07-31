// Which character a key event types. Pure unit tests against the keyboard
// map — no X server, because the whole bug is that the answer depends on
// state bits ntk was not reading, not on anything the server does.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeKey, groupForState } from '../lib/keyboard.js';

const SHIFT = 1;
const LOCK = 2;
const group = (n) => n << 13;

// keysyms, as GetKeyboardMapping reports them
const a = 0x0061;
const A = 0x0041;
const one = 0x0031;
const exclam = 0x0021;
const cyrillicEf = 0x06c6; // Cyrillic_ef, the 'a' key under the ru layout
const cyrillicEF = 0x06e6; // Cyrillic_EF
const F1 = 0xffbe;
const NoSymbol = 0;

const ch = (result) =>
  result && result.codepoint !== undefined ? String.fromCodePoint(result.codepoint) : undefined;

test('group bits are the top of the state field, not a modifier', () => {
  assert.equal(groupForState(0), 0);
  assert.equal(groupForState(group(1)), 1);
  assert.equal(groupForState(group(3) | SHIFT | LOCK), 3);
  // the modifier bits below them must not leak in
  assert.equal(groupForState(0x1fff), 0);
});

test('group 1 types unshifted and shifted as before', () => {
  assert.equal(ch(decodeKey([a, A], 0)), 'a');
  assert.equal(ch(decodeKey([a, A], SHIFT)), 'A');
});

test('the active group selects the second pair of keysyms', () => {
  // this is the bug: with us,ru loaded the keymap holds all four symbols and
  // a layout switch moves only the group bits, so ntk typed Latin forever
  const syms = [a, A, cyrillicEf, cyrillicEF];
  assert.equal(ch(decodeKey(syms, group(1))), 'ф');
  assert.equal(ch(decodeKey(syms, group(1) | SHIFT)), 'Ф');
  assert.equal(ch(decodeKey(syms, 0)), 'a', 'and group 1 is unaffected');
});

test('a group with nothing on this key falls back to group 1', () => {
  // layouts differ in which keys they define — a Cyrillic layout leaves the
  // function row to the Latin one, and X core protocol says so explicitly
  assert.equal(decodeKey([F1, NoSymbol, NoSymbol, NoSymbol], group(1)).keysym, F1);
  assert.equal(decodeKey([F1], group(1)).keysym, F1, 'a short list is the same case');
});

test('CapsLock applies to letters', () => {
  assert.equal(ch(decodeKey([a, A], LOCK)), 'A');
  // XKB folds Lock into the level for alphabetic keys, so caps + shift is
  // lowercase again — what every real desktop does
  assert.equal(ch(decodeKey([a, A], LOCK | SHIFT)), 'a');
});

test('CapsLock does not apply to the number row', () => {
  // the old shift-xor-lock rule turned 1 into ! with CapsLock on, because it
  // never asked whether the key had a case at all
  assert.equal(ch(decodeKey([one, exclam], LOCK)), '1');
  assert.equal(ch(decodeKey([one, exclam], SHIFT)), '!');
  assert.equal(ch(decodeKey([one, exclam], LOCK | SHIFT)), '!');
});

test('CapsLock applies to Cyrillic too, not just Latin', () => {
  assert.equal(ch(decodeKey([a, A, cyrillicEf, cyrillicEF], group(1) | LOCK)), 'Ф');
});

test('a missing second level is the upper case of the first', () => {
  assert.equal(ch(decodeKey([a], 0)), 'a');
  assert.equal(ch(decodeKey([a], SHIFT)), 'A');
  assert.equal(ch(decodeKey([a], LOCK)), 'A');
  // and a key with no case repeats rather than inventing one
  assert.equal(ch(decodeKey([one], SHIFT)), '1');
});

test('keys that type nothing report no codepoint', () => {
  const key = decodeKey([F1, NoSymbol], 0);
  assert.equal(key.keysym, F1);
  assert.equal(key.codepoint, undefined, 'F1 is a keysym, not a character');
});

test('an unmapped keycode decodes to nothing at all', () => {
  assert.equal(decodeKey(undefined, 0), undefined);
  assert.equal(decodeKey([], 0), undefined);
  assert.equal(decodeKey([NoSymbol, NoSymbol], 0), undefined);
});

test('baseKeysym stays on group 1 so shortcuts survive a layout switch', () => {
  // Ctrl+Z has to keep being Ctrl+Z while the user types Cyrillic. GTK, Qt
  // and browsers all resolve accelerators against the group-1 keysym.
  const z = 0x007a;
  const Z = 0x005a;
  const cyrillicYa = 0x06d1;
  const syms = [z, Z, cyrillicYa, cyrillicYa];

  const typed = decodeKey(syms, group(1));
  assert.equal(typed.keysym, cyrillicYa, 'types Cyrillic');
  assert.equal(typed.baseKeysym, z, 'but the shortcut is still z');
  assert.equal(typed.group, 1);
});

test('direct-Unicode keysyms decode to their codepoint', () => {
  // 0x01000000 | codepoint — how layouts spell characters keysymdef.h has no
  // name for, and the shape a non-Latin layout most often emits
  const snowman = 0x01002603;
  assert.equal(ch(decodeKey([snowman], 0)), '☃');
});
