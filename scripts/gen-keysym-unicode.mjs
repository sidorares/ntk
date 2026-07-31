// Regenerates lib/text/keysym-unicode.js — the keysym -> Unicode table used to
// put a `codepoint` on keydown events.
//
//   node scripts/gen-keysym-unicode.mjs [path/to/keysymdef.h]
//
// Two sources, because neither is complete on its own:
//
//   1. X11's keysymdef.h, whose comments annotate each keysym with the Unicode
//      character it produces. Three annotation forms, all of which count for
//      the keysym -> Unicode direction:
//        /* U+0104 ... */    one-to-one
//        /*<U+0020 ...>*/    a more specific spelling of another keysym (keypad)
//        /*(U+2329 ...)*/    deprecated: not one-to-one or semantically unclear
//   2. scripts/keysym-legacy-values.mjs, the numeric keysyms that current
//      headers dropped when whole scripts moved to the direct-Unicode form.
//
// The header always wins: a keysym it defines *without* a Unicode annotation is
// an authoritative "this key produces no character" (dead keys, Pause,
// Scroll_Lock), so those never fall through to the legacy table.
//
// Latin-1 (0x20-0x7e, 0xa0-0xff) and direct-Unicode (0x01000000 | codepoint)
// keysyms are covered by range rules in the generated module and deliberately
// left out of the table — the header's 191 Latin-1 and 717 direct-Unicode
// annotations were verified to agree with those rules exactly.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEGACY_ONLY } from './keysym-legacy-values.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(repoRoot, 'lib', 'text', 'keysym-unicode.js');

const CANDIDATE_HEADERS = [
  '/usr/include/X11/keysymdef.h',
  '/opt/X11/include/X11/keysymdef.h',
  '/opt/homebrew/include/X11/keysymdef.h',
  '/usr/local/include/X11/keysymdef.h',
];

function findHeader() {
  const explicit = process.argv[2];
  if (explicit) return explicit;
  const found = CANDIDATE_HEADERS.find((p) => fs.existsSync(p));
  if (found) return found;
  throw new Error(
    `no keysymdef.h found (looked in ${CANDIDATE_HEADERS.join(', ')}); ` +
      'pass a path explicitly — it ships with xorgproto / XQuartz'
  );
}

const headerPath = findHeader();
const src = fs.readFileSync(headerPath, 'utf8');

// every keysym value the header defines, annotated or not
const defined = new Set();
for (const m of src.matchAll(/^#define\s+XK_(\w+)\s+0x([0-9a-fA-F]+)/gm)) {
  defined.add(parseInt(m[2], 16));
}

// the annotated subset, with the Unicode name so "Unassigned code point" can be
// recognised and skipped
const annotated = new Map();
const ANNOTATION =
  /^#define\s+XK_(\w+)\s+0x([0-9a-fA-F]+)\s*\/\*\s*([<(]?)U\+([0-9A-Fa-f]{4,6})\s+([^*]*?)\s*[)>]?\*\//gm;
for (const m of src.matchAll(ANNOTATION)) {
  const sym = parseInt(m[2], 16);
  // first definition wins: later ones are alternate spellings of the same
  // keysym (Greek_LAMBDA / Greek_LAMDA), never a different character
  if (!annotated.has(sym)) {
    annotated.set(sym, { name: m[1], cp: parseInt(m[4], 16), unicodeName: m[5] });
  }
}

const coveredByRangeRule = (sym) =>
  sym <= 0xff || (sym >= 0x01000000 && sym <= 0x0110ffff);

// sanity: the range rules must reproduce the header exactly for the keysyms
// they claim, otherwise dropping those entries would lose information
for (const [sym, { cp, name }] of annotated) {
  if (sym <= 0xff && cp !== sym) {
    throw new Error(`Latin-1 rule broken: XK_${name} 0x${sym.toString(16)} -> U+${cp.toString(16)}`);
  }
  if (sym >= 0x01000000 && cp !== (sym & 0x00ffffff)) {
    throw new Error(`direct-Unicode rule broken: XK_${name} 0x${sym.toString(16)}`);
  }
}

const table = new Map(); // sym -> { cp, name, source }
let skippedUnassigned = 0;

for (const [sym, { cp, name, unicodeName }] of annotated) {
  if (coveredByRangeRule(sym)) continue;
  if (/Unassigned/i.test(unicodeName)) {
    // e.g. XK_Thai_maihanakat_maitho 0x0dde /*(U+0E3E Unassigned code point)*/
    skippedUnassigned++;
    continue;
  }
  table.set(sym, { cp, name, source: 'header' });
}

let legacyKept = 0;
let legacyOverruled = 0;
for (const [sym, cp, name] of LEGACY_ONLY) {
  if (defined.has(sym)) {
    // the header knows this keysym; its verdict (character or no character)
    // is the current one
    legacyOverruled++;
    continue;
  }
  table.set(sym, { cp, name, source: 'legacy' });
  legacyKept++;
}

const entries = [...table.entries()].sort((a, b) => a[0] - b[0]);
const hex = (n, w) => `0x${n.toString(16).padStart(w, '0')}`;

const body = entries
  .map(([sym, { cp, name }]) => `  ${hex(sym, 4)}: ${hex(cp, 4)}, // ${name}`)
  .join('\n');

const out = `// GENERATED FILE — do not edit by hand.
// Regenerate with: node scripts/gen-keysym-unicode.mjs [path/to/keysymdef.h]
//
// Maps an X keysym to the Unicode codepoint it types. This is the table Xlib
// keeps in keysym2ucs.c; ntk carries its own copy so that nothing on the
// keypress path touches the filesystem — the table has to survive bundling
// (esbuild), single-executable builds and the browser, where a package that
// reads JSON tables with fs.readFileSync at import time cannot.
//
// ${entries.length} entries, generated from ${path.basename(headerPath)}.

const LEGACY = {
${body}
};

/**
 * The Unicode codepoint an X keysym types, or \`undefined\` when it types
 * nothing (arrows, function keys, modifiers, dead keys).
 *
 * Three rules, in the order Xlib's keysym2ucs.c applies them:
 *
 * 1. **Direct-Unicode keysyms.** X reserves \`0x01000100\`-\`0x0110ffff\` for
 *    \`0x01000000 | codepoint\`, which is how every script added since the
 *    1990s is encoded and what modern non-Latin layouts emit. Like Xlib, the
 *    whole \`0x01xxxxxx\` plane is accepted and masked, bounded at the largest
 *    real codepoint; results below U+0020 are rejected, since keysyms for
 *    control characters have their own legacy values.
 * 2. **Latin-1 keysyms map to themselves** over \`0x20\`-\`0x7e\` and
 *    \`0xa0\`-\`0xff\`.
 * 3. **Everything else** comes from the generated table: the legacy script
 *    blocks (Cyrillic, Greek, Arabic, Thai, …) plus the handful of keysyms in
 *    \`0xff00\`-\`0xffff\` that really do produce a character — Return, Tab,
 *    BackSpace, Escape, Delete and the keypad.
 *
 * @param {number} sym X keysym
 * @returns {number|undefined} Unicode codepoint, or undefined
 */
export function keysymToUnicode(sym) {
  if (sym >= 0x01000000 && sym <= 0x0110ffff) {
    const cp = sym & 0x00ffffff;
    return cp >= 0x20 ? cp : undefined;
  }
  if ((sym >= 0x20 && sym <= 0x7e) || (sym >= 0xa0 && sym <= 0xff)) return sym;
  return LEGACY[sym];
}
`;

fs.writeFileSync(OUT, out);

const bySource = (s) => entries.filter(([, e]) => e.source === s).length;
console.log(`header:        ${headerPath}`);
console.log(`  defined keysyms      ${defined.size}`);
console.log(`  with a U+ annotation ${annotated.size}`);
console.log(`  skipped (unassigned) ${skippedUnassigned}`);
console.log(`legacy values: ${LEGACY_ONLY.length} offered, ${legacyKept} kept, ${legacyOverruled} overruled by the header`);
console.log(`wrote ${path.relative(repoRoot, OUT)}: ${entries.length} entries ` + `(${bySource('header')} header, ${bySource('legacy')} legacy)`);
