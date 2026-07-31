import assert from 'node:assert/strict';
import { test } from 'node:test';

import { keysymToUnicode } from '../lib/text/keysym-unicode.js';

const U = (ch) => ch.codePointAt(0);

test('Latin-1 keysyms map to themselves', () => {
  assert.equal(keysymToUnicode(0x20), U(' '));
  assert.equal(keysymToUnicode(0x41), U('A'));
  assert.equal(keysymToUnicode(0x61), U('a'));
  assert.equal(keysymToUnicode(0x7e), U('~'));
  assert.equal(keysymToUnicode(0xa0), 0x00a0); // nobreakspace
  assert.equal(keysymToUnicode(0xe9), U('é'));
  assert.equal(keysymToUnicode(0xff), U('ÿ'));
});

test('the gaps around the Latin-1 ranges type nothing', () => {
  for (const sym of [0x00, 0x1f, 0x7f, 0x80, 0x9f]) {
    assert.equal(keysymToUnicode(sym), undefined, `0x${sym.toString(16)}`);
  }
});

// the whole point of the range rule: modern non-Latin layouts emit these, and
// the old keysym package returned undefined for every one of them
test('direct-Unicode keysyms decode by masking', () => {
  assert.equal(keysymToUnicode(0x1000439), U('й')); // Cyrillic short i
  assert.equal(keysymToUnicode(0x1000531), U('Ա')); // Armenian AYB
  assert.equal(keysymToUnicode(0x10010d0), U('ა')); // Georgian AN
  assert.equal(keysymToUnicode(0x1001ea0), U('Ạ')); // Vietnamese A below dot
  assert.equal(keysymToUnicode(0x100067e), U('پ')); // Arabic peh
  assert.equal(keysymToUnicode(0x0110ffff), 0x10ffff); // top of the reserved range
});

test('direct-Unicode keysyms outside the codepoint space are rejected', () => {
  assert.equal(keysymToUnicode(0x0110ffff + 1), undefined);
  assert.equal(keysymToUnicode(0x01ffffff), undefined);
  // masking to a C0 control would be junk: those keys have legacy keysyms
  assert.equal(keysymToUnicode(0x01000000), undefined);
  assert.equal(keysymToUnicode(0x0100001f), undefined);
});

test('legacy script blocks come from the table', () => {
  assert.equal(keysymToUnicode(0x06c1), U('а')); // Cyrillic_a
  assert.equal(keysymToUnicode(0x07c1), U('Α')); // Greek_ALPHA
  assert.equal(keysymToUnicode(0x01a1), U('Ą')); // Aogonek
  assert.equal(keysymToUnicode(0x04a7), U('ァ')); // kana_a
  assert.equal(keysymToUnicode(0x0da1), U('ก')); // Thai_kokai
  assert.equal(keysymToUnicode(0x20ac), U('€')); // EuroSign
  assert.equal(keysymToUnicode(0x08a2), 0x250c); // topleftradical, a deprecated mapping
});

// modern keysymdef.h moved these scripts to the direct-Unicode form and dropped
// the old numbers outright, but servers and older keymaps still emit them — a
// table generated from the current header alone would silently lose them
test('keysyms current headers no longer define still resolve', () => {
  assert.equal(keysymToUnicode(0x14b2), U('Ա')); // Armenian_AYB
  assert.equal(keysymToUnicode(0x15d0), U('ა')); // Georgian_an
  assert.equal(keysymToUnicode(0x1ea0), U('Ạ')); // Abelowdot
  assert.equal(keysymToUnicode(0x05b0), U('٠')); // Arabic_0
  assert.equal(keysymToUnicode(0x0590), U('۰')); // Farsi_0
  assert.equal(keysymToUnicode(0x0680), U('Ғ')); // Cyrillic_GHE_bar
  assert.equal(keysymToUnicode(0x12a1), U('Ḃ')); // Babovedot
  assert.equal(keysymToUnicode(0x20a9), U('₩')); // WonSign
});

test('the keysyms in 0xff00-0xffff that really do type a character', () => {
  assert.equal(keysymToUnicode(0xff08), 0x08); // BackSpace
  assert.equal(keysymToUnicode(0xff09), 0x09); // Tab
  assert.equal(keysymToUnicode(0xff0a), 0x0a); // Linefeed
  assert.equal(keysymToUnicode(0xff0b), 0x0b); // Clear
  assert.equal(keysymToUnicode(0xff0d), 0x0d); // Return
  assert.equal(keysymToUnicode(0xff1b), 0x1b); // Escape
  assert.equal(keysymToUnicode(0xffff), 0x7f); // Delete
  assert.equal(keysymToUnicode(0xff80), U(' ')); // KP_Space
  assert.equal(keysymToUnicode(0xff89), 0x09); // KP_Tab
  assert.equal(keysymToUnicode(0xff8d), 0x0d); // KP_Enter
  assert.equal(keysymToUnicode(0xffaa), U('*')); // KP_Multiply
  assert.equal(keysymToUnicode(0xffae), U('.')); // KP_Decimal
  assert.equal(keysymToUnicode(0xffb0), U('0')); // KP_0
  assert.equal(keysymToUnicode(0xffb9), U('9')); // KP_9
  assert.equal(keysymToUnicode(0xffbd), U('=')); // KP_Equal
});

// the naive "low 7 bits of an 0xffxx keysym" rule the old table used invented
// characters for these; keysymdef.h gives them no Unicode annotation, which is
// authoritative
test('keys that type nothing report nothing', () => {
  const silent = {
    0xff13: 'Pause',
    0xff14: 'Scroll_Lock',
    0xff15: 'Sys_Req',
    0xff51: 'Left',
    0xff52: 'Up',
    0xff55: 'Prior',
    0xffbe: 'F1',
    0xffc9: 'F12',
    0xffe1: 'Shift_L',
    0xffe3: 'Control_L',
    0xffe9: 'Alt_L',
    0xff7e: 'Mode_switch',
    0xfe03: 'ISO_Level3_Shift',
    0xff20: 'Multi_key',
  };
  for (const [sym, name] of Object.entries(silent)) {
    assert.equal(keysymToUnicode(Number(sym)), undefined, name);
  }
});

// ntk has no compose support: emitting the bare combining mark appends it to
// whatever was typed *before* the dead key, which renders as the wrong word.
// Xlib, GTK and Qt all produce nothing here and compose on the next keystroke.
test('dead keys type nothing rather than a bare combining mark', () => {
  for (let sym = 0xfe50; sym <= 0xfe62; sym++) {
    assert.equal(keysymToUnicode(sym), undefined, `0x${sym.toString(16)}`);
  }
});

test('unmapped keysyms and junk input are undefined, never a bad codepoint', () => {
  for (const sym of [0x0100, 0xffffff, undefined, null, NaN, -1, 1.5]) {
    assert.equal(keysymToUnicode(sym), undefined, String(sym));
  }
});

test('every table entry is a codepoint String.fromCodePoint accepts', () => {
  // guards against a generator change emitting an out-of-range or fractional
  // value, which would throw on the keypress path instead of typing nothing
  for (let sym = 0; sym <= 0x20ff; sym++) {
    const cp = keysymToUnicode(sym);
    if (cp === undefined) continue;
    assert.ok(Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff, `0x${sym.toString(16)} -> ${cp}`);
    assert.doesNotThrow(() => String.fromCodePoint(cp));
  }
});

test('the module touches no filesystem or node builtin', async () => {
  // the reason this table exists at all: it has to load in a bundle, a SEA and
  // a browser, none of which can read data files next to the module. A single
  // `import` of node:fs here would put that back.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('../lib/text/keysym-unicode.js', import.meta.url)), 'utf8');
  // the generated file holds no string literals, so stripping comments this
  // bluntly is safe and leaves only code
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const forbidden of [/\bimport\b/, /\brequire\s*\(/, /\b__dirname\b/, /\b__filename\b/, /\bprocess\b/]) {
    assert.doesNotMatch(code, forbidden);
  }
});
