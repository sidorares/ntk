// The glyphs a face's mark positioning can move, read from the GPOS table's
// own bytes, so that its lookups need not be decoded until a run holds one.
//
// fontkit decodes a lookup whole the first time a run asks for its feature,
// and `mark` is the one that costs: Noto Sans' mark-to-base subtable holds an
// anchor for every base glyph in every mark class, and decoding it took 14 ms
// of each face's first shaping (21 ms in all), inside the first frame of
// every app whose sans-serif is Noto. A line of Latin UI text has no glyph
// any of those lookups acts on.
//
// So each `mark` and `mkmk` lookup is stood in for, in fontkit's cache of the
// face's lookups, by an empty one (`standInMarks`): a run applies the stand-in
// and decodes nothing, and fontkit is handed the caller's features as they
// are. A run that turns out to hold a glyph one of the real lookups acts at
// puts them back and is shaped again (`Font#_layout`).
//
// That is exact rather than a guess about scripts. Every GPOS lookup acts
// only at a glyph in its first coverage — the mark coverage of a mark
// attachment, the first glyph's of a pair, the first input's of a context —
// wherever it is reached from: its feature, another feature that names it,
// the feature table a variation swaps in, a context that nests it. A run
// holding no glyph from the coverage of any stood-in lookup is one the real
// lookups would have left as it is.
//
// An earlier cut left the two features out through fontkit's own feature
// overrides instead. That was exact too, and cost every shaping a pass over
// the overrides that deletes the tags from the plan: 1-3 us a word, 6% of a
// frame scrolling a long document into text it had not shaped.
//
// Null — shape as fontkit shapes — for a face that has nothing to stand in
// for, that fontkit shapes through AAT's morx rather than GPOS, or whose
// tables this cannot read to the end.

const TAGS = new Set(['mark', 'mkmk']);

/**
 * @param {object} fk a fontkit font
 * @returns {{ bits: Uint8Array, lookups: Set<number> }|null} the `mark` and
 *   `mkmk` lookups, and a bit per glyph id, set for every glyph one of them
 *   can act at; null where none can be stood in for
 */
export function markGlyphs(fk) {
  try {
    if (fk.directory?.tables?.morx) return null;
    const gpos = table(fk, 'GPOS');
    if (!gpos) return null;
    const lookups = markLookups(gpos);
    if (lookups.size === 0) return null;
    const bits = new Uint8Array(8192);
    const lookupList = gpos.offset(8, 0);
    for (const index of lookups) {
      if (!coverLookup(gpos, lookupList, index, bits)) return null;
    }
    return { bits, lookups };
  } catch {
    return null;
  }
}

/**
 * Stand an empty lookup in for each `mark` and `mkmk` lookup of a face, in
 * fontkit's cache of its GPOS lookups (restructure's lazy array, which
 * decodes an index the first time it is asked and keeps it in `items`).
 * Applied, a stand-in has no subtables and moves nothing.
 *
 * @param {object} fk a fontkit font, before its first layout
 * @returns {{ bits: Uint8Array, restore: () => void }|null} `restore` puts the
 *   real lookups back, to be decoded by the next run that asks; null where
 *   there is nothing to stand in for, where fontkit's cache is not the shape
 *   this knows, or where a lookup was decoded already
 */
export function standInMarks(fk) {
  const marks = markGlyphs(fk);
  if (marks === null) return null;
  let list;
  try {
    list = fk.GPOS?.lookupList;
  } catch {
    return null;
  }
  if (!list || typeof list.get !== 'function' || !Array.isArray(list.items)) return null;
  for (const index of marks.lookups) if (list.items[index] != null) return null;
  const standIn = { lookupType: 0, flags: {}, subTableCount: 0, subTables: [] };
  for (const index of marks.lookups) list.items[index] = standIn;
  return {
    bits: marks.bits,
    restore() {
      for (const index of marks.lookups) {
        if (list.items[index] === standIn) list.items[index] = null;
      }
    }
  };
}

/** Whether `bits` (from `markGlyphs`) has glyph `id`. */
export function marksCover(bits, id) {
  return (bits[id >> 3] & (1 << (id & 7))) !== 0;
}

/**
 * A table's bytes, read big-endian at positions from its start. `offset(pos,
 * base)` reads the 16-bit offset stored at `pos` and answers where it
 * points, `base` being what the format measures it from.
 */
function table(fk, tag) {
  const entry = fk.directory?.tables?.[tag];
  if (!entry) return null;
  const stream = fk._getTableStream(tag);
  if (!stream) return null;
  const buf = stream.buffer;
  const start = stream.pos;
  const end = Math.min(start + entry.length, buf.length);
  const u16 = (pos) => {
    const p = start + pos;
    if (pos < 0 || p + 2 > end) throw new RangeError(`${tag} read past its end`);
    return (buf[p] << 8) | buf[p + 1];
  };
  const u32 = (pos) => u16(pos) * 65536 + u16(pos + 2);
  const offset = (pos, base) => base + u16(pos);
  return { u16, u32, offset };
}

/**
 * The lookup indices of every `mark` and `mkmk` feature record, in any
 * script: a superset of what fontkit applies, which only widens what
 * counts as a mark.
 */
function markLookups(t) {
  const list = t.offset(6, 0);
  const lookups = new Set();
  for (let i = 0, n = t.u16(list); i < n; i++) {
    const rec = list + 2 + i * 6;
    const tag = String.fromCharCode(t.u16(rec) >> 8, t.u16(rec) & 255, t.u16(rec + 2) >> 8, t.u16(rec + 2) & 255);
    if (!TAGS.has(tag)) continue;
    const feature = t.offset(rec + 4, list);
    for (let j = 0, m = t.u16(feature + 2); j < m; j++) lookups.add(t.u16(feature + 4 + j * 2));
  }
  return lookups;
}

/** Adds the first coverage of each of a lookup's subtables; false for one it cannot read. */
function coverLookup(t, lookupList, index, bits) {
  if (index >= t.u16(lookupList)) return false;
  const lookup = t.offset(lookupList + 2 + index * 2, lookupList);
  const type = t.u16(lookup);
  for (let i = 0, n = t.u16(lookup + 4); i < n; i++) {
    let sub = t.offset(lookup + 6 + i * 2, lookup);
    let subType = type;
    if (subType === 9) {
      // an extension: the real subtable, at a 32-bit offset from here
      if (t.u16(sub) !== 1) return false;
      subType = t.u16(sub + 2);
      sub += t.u32(sub + 4);
    }
    const coverage = firstCoverage(t, subType, sub);
    if (coverage < 0) return false;
    addCoverage(t, coverage, bits);
  }
  return true;
}

/**
 * Where the coverage a subtable is entered from starts, or -1 for a
 * subtable this does not know.
 */
function firstCoverage(t, type, sub) {
  const format = t.u16(sub);
  switch (type) {
    case 1: // single adjustment
    case 2: // pair adjustment: the pair's first glyph
      return format === 1 || format === 2 ? t.offset(sub + 2, sub) : -1;
    case 3: // cursive attachment
    case 4: // mark to base: the mark
    case 5: // mark to ligature: the mark
    case 6: // mark to mark: the mark that attaches
      return format === 1 ? t.offset(sub + 2, sub) : -1;
    case 7: // context
      if (format === 1 || format === 2) return t.offset(sub + 2, sub);
      // the first input glyph's, after the glyph and lookup counts
      return format === 3 && t.u16(sub + 2) > 0 ? t.offset(sub + 6, sub) : -1;
    case 8: {
      // chained context
      if (format === 1 || format === 2) return t.offset(sub + 2, sub);
      if (format !== 3) return -1;
      // past the backtrack coverages to the input's count, then its first
      const input = sub + 4 + t.u16(sub + 2) * 2;
      return t.u16(input) > 0 ? t.offset(input + 2, sub) : -1;
    }
    default:
      return -1;
  }
}

function addCoverage(t, coverage, bits) {
  const format = t.u16(coverage);
  const count = t.u16(coverage + 2);
  if (format === 1) {
    for (let i = 0; i < count; i++) set(bits, t.u16(coverage + 4 + i * 2));
  } else if (format === 2) {
    for (let i = 0; i < count; i++) {
      const rec = coverage + 4 + i * 6;
      const last = t.u16(rec + 2);
      for (let id = t.u16(rec); id <= last; id++) set(bits, id);
    }
  } else {
    throw new RangeError(`coverage format ${format}`);
  }
}

function set(bits, id) {
  bits[id >> 3] |= 1 << (id & 7);
}
