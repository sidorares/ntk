// A mark attachment subtable may leave an anchor out — a NULL for a glyph
// and mark class, "this subtable attaches no such mark to it" — and fontkit
// read the NULL's coordinates and threw from inside a layout (see
// lib/text/anchors.js). What has to hold is HarfBuzz's answer: the subtable
// did not apply, and the lookup's next subtable gets its turn. The faces
// are the system's DejaVu, as in text-marks.test.js, and the NULLs are the
// face's own or put into a copy of one of its lookups.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

import * as fontkit from 'fontkit';

import Font from '../lib/text/font.js';

/** A system face by name, or null where fontconfig answers another. */
function systemFace(name, postscript) {
  try {
    const file = execFileSync('fc-match', ['-f', '%{file}', name], { encoding: 'utf8' });
    return fontkit.openSync(file).postscriptName === postscript ? file : null;
  } catch {
    return null;
  }
}

const mono = systemFace('DejaVu Sans Mono', 'DejaVuSansMono');
const sans = systemFace('DejaVu Sans', 'DejaVuSans');
const needsMono = { skip: !mono && 'no DejaVu Sans Mono' };
const needsSans = { skip: !sans && 'no DejaVu Sans' };

const answer = (run) => run.glyphs.map((g, i) => [g.id, run.positions[i].xAdvance, run.positions[i].xOffset, run.positions[i].yOffset]);
const gposOf = (fk) => fk._layoutEngine.engine.GPOSProcessor;

test('a mark whose anchor its base leaves out is left where no attachment puts it, where fontkit threw', needsMono, () => {
  // DejaVu Sans Mono's mark-to-base lookup holds NULLs for its precomposed
  // capitals: À with a combining grave above reaches one
  const text = 'À̀';
  assert.throws(() => fontkit.openSync(mono).layout(text), /xCoordinate/, 'fontkit alone');
  const font = Font.loadSync(mono);
  assert.deepEqual(answer(font._layout(text, {})), answer(fontkit.openSync(mono).layout(text, { mark: false, mkmk: false })));
  // and a Lithuanian Į̃, which another lookup attaches, shapes too
  assert.doesNotThrow(() => font.shape('Į̃ ų̃ ė̃', 16));
});

test('a face is watched for a NULL until its text reaches one, and only then pays for taking it', needsMono, () => {
  const font = Font.loadSync(mono);
  font.shape('File Edit é', 16);
  assert.equal(Object.hasOwn(gposOf(font.fk), 'applyLookup'), false, 'no NULL reached: fontkit shapes it unwrapped');
  font.shape('À̀', 16);
  assert.equal(Object.hasOwn(gposOf(font.fk), 'applyLookup'), true, 'from the first NULL on');
  // and what the face shapes after is fontkit's answer
  assert.deepEqual(answer(font._layout('é x̃', {})), answer(fontkit.openSync(mono).layout('é x̃')));
});

/**
 * A fresh DejaVu Sans whose mark-to-base lookup for U+0301 on e has the
 * subtable that attaches it handed to `edit`, which returns the subtables
 * to put in its place.
 */
function editedSans(edit) {
  const fk = fontkit.openSync(sans);
  const e = fk.glyphForCodePoint(0x65).id;
  const acute = fk.glyphForCodePoint(0x301).id;
  const index = (coverage, glyph) => {
    if (coverage.version === 1) return coverage.glyphs.indexOf(glyph);
    for (const r of coverage.rangeRecords) if (glyph >= r.start && glyph <= r.end) return r.startCoverageIndex + glyph - r.start;
    return -1;
  };
  const list = fk.GPOS.lookupList;
  for (let i = 0; i < list.length; i++) {
    const lookup = list.get(i);
    const at = lookup.subTables.findIndex((sub) => {
      const table = lookup.lookupType === 9 ? sub.extension : sub;
      const type = lookup.lookupType === 9 ? sub.lookupType : lookup.lookupType;
      return type === 4 && index(table.markCoverage, acute) >= 0 && index(table.baseCoverage, e) >= 0;
    });
    if (at < 0) continue;
    const sub = lookup.subTables[at];
    const table = lookup.lookupType === 9 ? sub.extension : sub;
    const base = index(table.baseCoverage, e);
    const cls = table.markArray[index(table.markCoverage, acute)].class;
    assert.ok(table.baseArray[base][cls], 'the real subtable has the anchor');
    const nulled = {
      ...table,
      baseArray: table.baseArray.map((row, b) => (b === base ? row.map((anchor, c) => (c === cls ? null : anchor)) : row))
    };
    const wrap = (t) => (lookup.lookupType === 9 ? { ...sub, extension: t } : t);
    const subTables = [...lookup.subTables.slice(0, at), ...edit(wrap(nulled), sub), ...lookup.subTables.slice(at + 1)];
    list.items[i] = { ...lookup, subTableCount: subTables.length, subTables };
    return fk;
  }
  throw new Error('DejaVu Sans attaches no U+0301 to e');
}

test("a subtable that reaches a NULL did not apply, so the lookup's next one gets its turn", needsSans, () => {
  const text = 'é';
  const reference = answer(fontkit.openSync(sans).layout(text));
  // the NULL ahead of the real subtable: the real one still attaches the
  // mark, where an early return that counted as applied left it unattached
  const font = new Font(editedSans((nulled, real) => [nulled, real]), sans);
  assert.deepEqual(answer(font._layout(text, {})), reference);
  // the NULL alone: the same as no such subtable at all
  const alone = new Font(editedSans((nulled) => [nulled]), sans);
  assert.deepEqual(answer(alone._layout(text, {})), answer(editedSans(() => []).layout(text)));
  assert.notDeepEqual(answer(alone._layout(text, {})), reference, 'the mark is not attached');
});
