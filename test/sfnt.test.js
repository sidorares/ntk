// The sfnt inside a WOFF or a WOFF2 (lib/text/sfnt.js): what a variable
// face in either container is handed to fontkit as.
//
// Hermetic — the variable fixture in its three containers, which has
// composite glyphs, and KaTeX's Main, which has hinted and empty ones and
// which katex ships as .ttf, .woff and .woff2.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import * as fontkit from 'fontkit';

import Font from '../lib/text/font.js';
import { sfntOf, untransformGlyf } from '../lib/text/sfnt.js';

const require = createRequire(import.meta.url);
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const katex = join(dirname(require.resolve('katex/package.json')), 'dist', 'fonts');
const FACES = [
  ['the variable fixture', (ext) => join(fixtures, `MonelogicsSubset[wght].${ext}`)],
  ['KaTeX Main', (ext) => join(katex, `KaTeX_Main-Regular.${ext}`)]
];

/** fontkit's font for bytes, as `Font` makes one */
const parse = (bytes) => fontkit.create(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));

/** a parsed sfnt's tables, tag to bytes */
function tablesOf(fk) {
  const tables = {};
  for (const [tag, entry] of Object.entries(fk.directory.tables)) {
    tables[tag] = fk.stream.buffer.subarray(entry.offset, entry.offset + entry.length);
  }
  return tables;
}

/**
 * A `head` table with what a tool rewrites on every save left out — the
 * file's checksum adjustment and its two dates — and what a WOFF2 changes:
 * the bit of `flags` an encoder sets to say the font has been through one,
 * and the form of `loca`. The containers here were each saved from a .ttf.
 */
function steadyHead(bytes) {
  const head = Buffer.from(bytes);
  head.fill(0, 8, 12);
  head[16] &= ~0x08;
  head.fill(0, 20, 36);
  head.fill(0, 50, 52);
  return head;
}

/** every glyph as it reads: its outline, its advance, and the box in its header */
function glyphsOf(fk) {
  return Array.from({ length: fk.numGlyphs }, (_, id) => {
    const glyph = fk.getGlyph(id);
    const drawn = glyph.path.commands.length > 0;
    const { minX, minY, maxX, maxY } = drawn ? glyph._getCBox(true) : {};
    return `${id} ${glyph.advanceWidth} ${glyph.path.toSVG()} ${drawn ? [minX, minY, maxX, maxY] : ''}`;
  });
}

for (const [name, file] of FACES) {
  test(`${name}: a WOFF's sfnt is the font it was made from, table for table`, () => {
    const original = tablesOf(fontkit.openSync(file('ttf')));
    const rebuilt = parse(sfntOf(fontkit.openSync(file('woff'))));
    assert.equal(rebuilt.type, 'TTF');
    const tables = tablesOf(rebuilt);
    assert.deepEqual(Object.keys(tables).sort(), Object.keys(original).sort());
    for (const tag of Object.keys(original)) {
      const same =
        tag === 'head'
          ? steadyHead(tables.head).equals(steadyHead(original.head))
          : Buffer.from(tables[tag]).equals(Buffer.from(original[tag]));
      assert.ok(same, `table ${tag}`);
    }
    assert.equal(rebuilt.head.indexToLocFormat, fontkit.openSync(file('ttf')).head.indexToLocFormat);
  });

  test(`${name}: a WOFF2's sfnt has the font's tables, and its glyphs written again`, () => {
    const ttf = fontkit.openSync(file('ttf'));
    const original = tablesOf(ttf);
    const rebuilt = parse(sfntOf(fontkit.openSync(file('woff2'))));
    assert.equal(rebuilt.type, 'TTF');
    const tables = tablesOf(rebuilt);
    assert.deepEqual(Object.keys(tables).sort(), Object.keys(original).sort());
    for (const tag of Object.keys(original)) {
      // the glyphs are the same points in other bytes, `loca` follows them,
      // and `head` says which form `loca` has
      if (tag === 'glyf' || tag === 'loca' || tag === 'head') continue;
      assert.ok(Buffer.from(tables[tag]).equals(Buffer.from(original[tag])), `table ${tag}`);
    }
    assert.ok(steadyHead(tables.head).equals(steadyHead(original.head)), 'table head');
    assert.equal(rebuilt.head.indexToLocFormat, 1, 'a long loca');
    assert.equal(rebuilt.numGlyphs, ttf.numGlyphs);
    assert.deepEqual(glyphsOf(rebuilt), glyphsOf(ttf));
  });
}

test('the two faces have the glyphs this is for: composite, hinted and empty ones', () => {
  // or the tests above prove less than they read as
  const count = (fk) => {
    const found = { composite: 0, hinted: 0, empty: 0 };
    for (let id = 0; id < fk.numGlyphs; id += 1) {
      const glyph = fk.getGlyph(id)._decode();
      if (!glyph) found.empty += 1;
      else if (glyph.numberOfContours < 0) found.composite += 1;
      else if (glyph.instructions.length) found.hinted += 1;
    }
    return found;
  };
  const fixture = count(fontkit.openSync(FACES[0][1]('ttf')));
  const main = count(fontkit.openSync(FACES[1][1]('ttf')));
  assert.ok(fixture.composite > 0, `composite glyphs in the fixture: ${fixture.composite}`);
  assert.ok(main.hinted > 0, `hinted glyphs in KaTeX Main: ${main.hinted}`);
  assert.ok(main.empty > 0, `empty glyphs in KaTeX Main: ${main.empty}`);
});

test('there is no sfnt to make of a font that is not in a container', () => {
  assert.equal(sfntOf(fontkit.openSync(FACES[0][1]('ttf'))), null);
  assert.equal(sfntOf(null), null);
});

test('a glyf table that ends short is refused, not read past', () => {
  assert.throws(() => untransformGlyf(new Uint8Array(12)), RangeError);
  // a header that promises streams the table does not have
  const table = new Uint8Array(36);
  new DataView(table.buffer).setUint16(4, 3); // three glyphs
  new DataView(table.buffer).setUint32(8, 600); // and 600 bytes of contour counts
  assert.throws(() => untransformGlyf(table), RangeError);
});

test('a static face stays in its container; a variable one is read as its sfnt', () => {
  // nothing is asked of a static face that a container does not answer, and
  // taking one apart costs its whole size in memory
  assert.equal(Font.loadSync(FACES[1][1]('woff2')).fk.type, 'WOFF2');
  assert.equal(Font.loadSync(FACES[1][1]('woff')).fk.type, 'WOFF');
  assert.equal(Font.loadSync(FACES[0][1]('woff2')).fk.type, 'TTF');
  assert.equal(Font.fromData(readFileSync(FACES[0][1]('woff'))).fk.type, 'TTF');
});
