// A face's cap height and x-height, where its OS/2 table states them and
// where it cannot: a table older than version 2 has neither field, and a
// face with no OS/2 table at all — Apple's Courier.ttc — has no table.
// Both are measured from the face's own `H` and `x` then (CSS Values 4,
// 6.1.1), as browsers measure them, rather than coming out as nothing: an
// `ex` in Courier was half an em in react-x11-components' <Html>, and five
// of them set a line 4.5px taller than Chrome does.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import Font from '../lib/text/font.js';

const require = createRequire(import.meta.url);
const fontDir = join(dirname(require.resolve('katex/package.json')), 'dist', 'fonts');
const bytes = readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf'));

/** The sfnt's table records: tag, and where the record is. */
function records(buf) {
  const out = [];
  for (let i = 0; i < buf.readUInt16BE(4); i++) {
    const at = 12 + 16 * i;
    out.push({ tag: buf.toString('latin1', at, at + 4), at, offset: buf.readUInt32BE(at + 8) });
  }
  return out;
}

/** The font with one table left out of its directory. */
function without(buf, tag) {
  const out = Buffer.from(buf);
  const list = records(out);
  const drop = list.findIndex((r) => r.tag === tag);
  assert.ok(drop >= 0, `the font has ${tag}`);
  // the records after it move up one, and the count goes down
  out.copy(out, 12 + 16 * drop, 12 + 16 * (drop + 1), 12 + 16 * list.length);
  out.writeUInt16BE(list.length - 1, 4);
  return out;
}

/** The font with its OS/2 table's version set. */
function os2Version(buf, version) {
  const out = Buffer.from(buf);
  const os2 = records(out).find((r) => r.tag === 'OS/2');
  out.writeUInt16BE(version, os2.offset);
  return out;
}

test('a stated x-height and cap height are the ones used', () => {
  const font = Font.fromData(bytes);
  const os2 = font.fk['OS/2'];
  assert.ok(os2.version >= 2 && os2.xHeight > 0, 'KaTeX states both');
  const m = font.metrics(1000);
  const upem = font.fk.unitsPerEm;
  assert.equal(m.xHeight, (os2.xHeight / upem) * 1000);
  assert.equal(m.capHeight, (os2.capHeight / upem) * 1000);
});

for (const [name, buf] of [
  ['an OS/2 table older than version 2', os2Version(bytes, 1)],
  ['no OS/2 table at all', without(bytes, 'OS/2')],
]) {
  test(`with ${name}, the x-height and cap height are its x's and H's`, () => {
    const font = Font.fromData(buf);
    const upem = font.fk.unitsPerEm;
    const top = (cp) => (font.fk.glyphForCodePoint(cp).bbox.maxY / upem) * 1000;
    const m = font.metrics(1000);
    assert.ok(top(0x78) > 0 && top(0x48) > top(0x78), 'glyphs to measure');
    assert.equal(m.xHeight, top(0x78));
    assert.equal(m.capHeight, top(0x48));
  });
}
