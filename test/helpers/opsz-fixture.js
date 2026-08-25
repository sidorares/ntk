// A variable face with a real `opsz` axis, for the optical-sizing tests.
//
// Nothing in the tree ships one, and a second variable file for one axis is
// not worth its kilobytes, so `test/fixtures/MonelogicsSubset[wght].ttf` is
// relabelled in memory: `fvar` is what names an axis, `gvar` only numbers
// them, so the deltas are the same deltas and every layer below the label
// sees a genuine optical-size axis.
//
// The range is San Francisco's — 17..28..96 — because the default sitting
// well above every UI size is the whole shape of the bug (issue #332): with
// no coordinate applied, a 13px menu label is set in a display cut.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VF = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'MonelogicsSubset[wght].ttf');

/** the fixture's bytes with its axis relabelled `opsz`, ranged like SF */
export function opszFixture() {
  const b = Buffer.from(readFileSync(VF));
  const numTables = b.readUInt16BE(4);
  let fvar = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16; // sfnt table record: tag, checksum, offset, length
    if (b.toString('latin1', rec, rec + 4) === 'fvar') fvar = b.readUInt32BE(rec + 8);
  }
  assert.ok(fvar > 0, 'the fixture has an fvar table');
  const axes = fvar + b.readUInt16BE(fvar + 4); // axisTag, min, default, max (16.16)
  b.write('opsz', axes, 'latin1');
  b.writeInt32BE(17 * 65536, axes + 4);
  b.writeInt32BE(28 * 65536, axes + 8);
  b.writeInt32BE(96 * 65536, axes + 12);
  b.writeUInt16BE(0, fvar + 12); // drop the named instances: they name weights
  return b;
}
