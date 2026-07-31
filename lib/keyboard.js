import { keysymToUnicode } from './text/keysym-unicode.js';

// Turning a key event into a character.
//
// X's core keyboard map is a flat list of keysyms per keycode, and XKB lays
// its groups over that list in pairs: [g1l1, g1l2, g2l1, g2l2, ...]. A layout
// switch moves the *active group*, which arrives in bits 13-14 of every key
// event's state field — the keymap itself does not change, so no
// MappingNotify is sent and nothing can be refetched in response. Reading
// those two bits is the whole of layout support for the common case.
//
// What this cannot do is level 3, the AltGr row. The core map is ambiguous
// there: four keysyms on a keycode are two groups of two levels under
// `us,ru`, and one group of four levels under `us(intl)`, and nothing in the
// core protocol distinguishes them. The request that resolves it is
// XkbGetMap, which node-x11 does not implement — its xkb module says so in
// as many words. Guessing would break multi-layout users to half-serve
// AltGr users, so this reads groups only.

const SHIFT_MASK = 1;
const LOCK_MASK = 2;

// XKB reports the effective group in bits 13-14 of the core state field
const GROUP_SHIFT = 13;
const GROUP_MASK = 3;

// Pairs, because that is all the core keyboard map can express
const LEVELS_PER_GROUP = 2;

/** The active XKB layout group, 0-3, from a key event's state field. */
export function groupForState(state) {
  return (state >> GROUP_SHIFT) & GROUP_MASK;
}

/** NoSymbol is 0, and a short keysym list simply ends. */
function present(sym) {
  return sym !== undefined && sym !== 0;
}

/**
 * The character a keysym types, or undefined for keys that type nothing —
 * arrows, function keys, modifiers.
 */
function charOf(sym) {
  const cp = present(sym) ? keysymToUnicode(sym) : undefined;
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

/**
 * Whether a key's two levels are the lower and upper case of one letter.
 *
 * This is what decides whether CapsLock applies. XKB asks the key's *type*:
 * its ALPHABETIC type folds Lock into the level, and the two-level type used
 * for the number row does not — which is why CapsLock does not turn `1` into
 * `!` on any real desktop. Unicode case mapping answers the same question
 * without the XKB map, and answers it for Cyrillic and Greek too.
 */
function isCasePair(lowerChar, upperChar) {
  if (lowerChar === undefined || upperChar === undefined) return false;
  return lowerChar !== upperChar && lowerChar.toUpperCase() === upperChar;
}

/**
 * Decode a key event against the keyboard map.
 *
 * @param {number[]} syms the keycode's keysyms, as `GetKeyboardMapping`
 *   returns them — `X.keycode2keysyms[ev.keycode]`
 * @param {number} state the event's modifier/group state (`ev.buttons`)
 * @returns {{ keysym: number, baseKeysym: number, group: number,
 *   codepoint: number|undefined }|undefined} undefined when the keycode maps
 *   to nothing at all
 */
export function decodeKey(syms, state) {
  if (!syms || syms.length === 0) return undefined;

  const group = groupForState(state);
  let base = group * LEVELS_PER_GROUP;
  // X core protocol: a group with no symbols on this key falls back to
  // group 1. Layouts differ in which keys they define, so this is normal —
  // a Cyrillic layout leaves the function row to the Latin one.
  if (!present(syms[base]) && !present(syms[base + 1])) base = 0;

  const first = syms[base];
  if (!present(first)) return undefined;
  const firstChar = charOf(first);

  let second = syms[base + 1];
  let secondChar = charOf(second);
  if (!present(second)) {
    // "if the second element is NoSymbol, the group is treated as the lower
    // and upper case of the first when the first has a case, and as the first
    // twice otherwise" — X core protocol, Keyboard and Pointer. There is no
    // uppercase *keysym* to name in that case, only an uppercase character.
    second = first;
    const upper = firstChar === undefined ? undefined : firstChar.toUpperCase();
    secondChar = upper !== undefined && upper.length === 1 ? upper : firstChar;
  }

  const shift = (state & SHIFT_MASK) !== 0;
  const lock = (state & LOCK_MASK) !== 0 && isCasePair(firstChar, secondChar);
  const upperLevel = shift !== lock;

  const keysym = upperLevel ? second : first;
  const char = upperLevel ? secondChar : firstChar;
  return {
    keysym,
    // group 1, level 1 — what a keyboard shortcut should match against, so
    // Ctrl+Z stays Ctrl+Z while the user is typing Cyrillic. GTK, Qt and
    // browsers all resolve accelerators this way.
    baseKeysym: present(syms[0]) ? syms[0] : keysym,
    group,
    codepoint: char === undefined ? undefined : char.codePointAt(0)
  };
}
