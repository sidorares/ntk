// The glyphs a face can set closer or further from the glyph beside them,
// read from its tables' bytes the way ./marks.js reads its marks: a pair of
// letters that neither can be is set together as it is set apart, and the
// layout need not shape the two to find that out (`TextLayout._kernBefore`).
//
// A pair's left glyph can be moved by a pair adjustment it enters, by a
// cursive attachment, by a context it is the first input of, or by the
// pairs of a legacy `kern` table; its right glyph only by a context it is
// the first input of, with the left glyph behind it. Every GPOS lookup is
// read, whatever feature names it — a superset of what fontkit applies,
// which only widens what counts.
//
// Null — ask the shaper — for a face shaped through AAT's morx, a `kern`
// table in a format this does not read, or tables it cannot read to the end.

import { addCoverage, firstCoverage, table } from './marks.js';

/**
 * @param {object} fk a fontkit font
 * @returns {{ left: Uint8Array, right: Uint8Array }|null} a bit per glyph id,
 *   set for every glyph that can be moved against the glyph after it
 *   (`left`) or before it (`right`); null where this cannot tell
 */
export function pairGlyphs(fk) {
  try {
    if (fk.directory?.tables?.morx) return null;
    const left = new Uint8Array(8192);
    const right = new Uint8Array(8192);
    const gpos = table(fk, 'GPOS');
    if (gpos) {
      const lookupList = gpos.offset(8, 0);
      for (let index = 0, n = gpos.u16(lookupList); index < n; index++) {
        if (!coverPairs(gpos, lookupList, index, left, right)) return null;
      }
    }
    const kern = table(fk, 'kern');
    if (kern && !kernLefts(kern, left)) return null;
    return { left, right };
  } catch {
    return null;
  }
}

/** Whether `bits` (from `pairGlyphs`) has glyph `id`. */
export function pairsCover(bits, id) {
  return (bits[id >> 3] & (1 << (id & 7))) !== 0;
}

/** Adds what a lookup can move against a neighbour; false for one it cannot read. */
function coverPairs(t, lookupList, index, left, right) {
  const lookup = t.offset(lookupList + 2 + index * 2, lookupList);
  const type = t.u16(lookup);
  for (let i = 0, n = t.u16(lookup + 4); i < n; i++) {
    let sub = t.offset(lookup + 6 + i * 2, lookup);
    let subType = type;
    if (subType === 9) {
      if (t.u16(sub) !== 1) return false;
      subType = t.u16(sub + 2);
      sub += t.u32(sub + 4);
    }
    // a single adjustment moves a glyph whatever is beside it, and a mark
    // attaches with no advance of its own
    if (subType !== 2 && subType !== 3 && subType !== 7 && subType !== 8) continue;
    const coverage = firstCoverage(t, subType, sub);
    if (coverage < 0) return false;
    addCoverage(t, coverage, left);
    if (subType === 7 || subType === 8) addCoverage(t, coverage, right);
  }
  return true;
}

/** Adds the left glyphs of a Microsoft `kern` table's pairs; false for a
 *  table or subtable format this does not read. */
function kernLefts(t, left) {
  if (t.u16(0) !== 0) return false;
  let at = 4;
  for (let i = 0, n = t.u16(2); i < n; i++) {
    const length = t.u16(at + 2);
    const format = t.u16(at + 4) >> 8;
    if (format !== 0) return false;
    for (let j = 0, pairs = t.u16(at + 6); j < pairs; j++) {
      const id = t.u16(at + 14 + j * 6);
      left[id >> 3] |= 1 << (id & 7);
    }
    at += length;
  }
  return true;
}
