// A face's `mark` and `mkmk` lookups are stood in for by empty ones until a
// run holds a glyph they act at (lib/text/marks.js, Font#_layout): fontkit
// decodes a feature's lookups whole at its first use, and Noto Sans' mark
// attachment was 14 ms of each face's first shaping. What has to hold is that
// the answer never changes — the same glyphs at the same places as fontkit's
// own layout — so the parser is held to hand-built tables here, and the
// shaping to a real face's.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

import * as fontkit from 'fontkit';

import Font from '../lib/text/font.js';
import { markGlyphs, marksCover } from '../lib/text/marks.js';

// --- tables built by hand ---------------------------------------------------

/** Big-endian bytes, with a way to point back at a position later. */
class Bytes {
  constructor() {
    this.out = [];
  }
  get pos() {
    return this.out.length;
  }
  u16(v) {
    this.out.push((v >> 8) & 255, v & 255);
    return this;
  }
  u32(v) {
    return this.u16(Math.floor(v / 65536)).u16(v & 65535);
  }
  tag(t) {
    for (const c of t) this.out.push(c.charCodeAt(0));
    return this;
  }
  /** Reserve a 16-bit slot; `fill(target, base)` writes target - base into it. */
  slot16() {
    const at = this.pos;
    this.u16(0);
    return { fill: (target, base) => this.set16(at, target - base) };
  }
  slot32() {
    const at = this.pos;
    this.u32(0);
    return {
      fill: (target, base) => {
        this.set16(at, Math.floor((target - base) / 65536));
        this.set16(at + 2, (target - base) & 65535);
      }
    };
  }
  set16(at, v) {
    this.out[at] = (v >> 8) & 255;
    this.out[at + 1] = v & 255;
  }
  bytes() {
    return Uint8Array.from(this.out);
  }
}

const coverage1 = (b, ids) => {
  const at = b.pos;
  b.u16(1).u16(ids.length);
  for (const id of ids) b.u16(id);
  return at;
};
const coverage2 = (b, ranges) => {
  const at = b.pos;
  b.u16(2).u16(ranges.length);
  let index = 0;
  for (const [first, last] of ranges) {
    b.u16(first).u16(last).u16(index);
    index += last - first + 1;
  }
  return at;
};

/**
 * A GPOS (or GSUB) table: `features` is [[tag, lookupIndices]], `lookups`
 * is a list of (b) => { type, subtables: [position] } writers.
 */
function layoutTable({ features, lookups, minor = 0, variations = 0 }) {
  const b = new Bytes();
  b.u16(1).u16(minor);
  const scriptList = b.slot16();
  const featureList = b.slot16();
  const lookupList = b.slot16();
  if (minor >= 1) b.u32(variations);
  scriptList.fill(b.pos, 0);
  b.u16(0); // no scripts
  const fl = b.pos;
  featureList.fill(fl, 0);
  b.u16(features.length);
  const featureSlots = features.map(([tag]) => {
    b.tag(tag);
    return b.slot16();
  });
  features.forEach(([, indices], i) => {
    featureSlots[i].fill(b.pos, fl);
    b.u16(0).u16(indices.length);
    for (const index of indices) b.u16(index);
  });
  const ll = b.pos;
  lookupList.fill(ll, 0);
  b.u16(lookups.length);
  const lookupSlots = lookups.map(() => b.slot16());
  lookups.forEach((write, i) => {
    const lookup = b.pos;
    lookupSlots[i].fill(lookup, ll);
    const { type, subtables } = write.header;
    b.u16(type).u16(0).u16(subtables);
    const subSlots = Array.from({ length: subtables }, () => b.slot16());
    write(b, (k, at) => subSlots[k].fill(at, lookup));
  });
  return b.bytes();
}

/** A lookup whose subtables are written by `writers`, each (b) => position. */
function lookup(type, ...writers) {
  const write = (b, point) => writers.forEach((w, k) => point(k, w(b)));
  write.header = { type, subtables: writers.length };
  return write;
}

/** A mark attachment subtable (types 4-6 share the head): coverage at +2. */
const markSub = (coverage) => (b) => {
  const at = b.pos;
  b.u16(1);
  const cov = b.slot16();
  b.u16(0).u16(0).u16(0).u16(0);
  cov.fill(coverage(b), at);
  return at;
};

/** A fontkit font as markGlyphs reads one: the directory and the table bytes. */
function fakeFont(tables) {
  const directory = { tables: {} };
  for (const [tag, bytes] of Object.entries(tables)) directory.tables[tag] = { length: bytes.length };
  return {
    directory,
    _getTableStream: (tag) => (tables[tag] ? { buffer: tables[tag], pos: 0 } : null)
  };
}

const covered = (marks, ids) => ids.filter((id) => marksCover(marks.bits, id));

test('the mark glyphs are the first coverage of every mark and mkmk lookup, and nothing else', () => {
  const gpos = layoutTable({
    features: [
      ['kern', [0]],
      ['mark', [1]],
      ['mkmk', [2]]
    ],
    lookups: [
      // kerning: its glyphs are not marks
      lookup(2, markSub((b) => coverage1(b, [5]))),
      // mark to base, coverage as ranges
      lookup(4, markSub((b) => coverage2(b, [[100, 102]]))),
      // mark to mark, through an extension subtable
      lookup(9, (b) => {
        const at = b.pos;
        b.u16(1).u16(6);
        const offset = b.slot32();
        offset.fill(markSub((c) => coverage1(c, [200]))(b), at);
        return at;
      })
    ]
  });
  const marks = markGlyphs(fakeFont({ GPOS: gpos }));
  assert.ok(marks, 'a face with mark lookups');
  assert.deepEqual([...marks.lookups].sort(), [1, 2]);
  assert.deepEqual(covered(marks, [5, 99, 100, 101, 102, 103, 200, 201]), [100, 101, 102, 200]);
});

test('a context under mark is entered at its first input glyph, found from the subtable', () => {
  // chained context format 3: two backtrack coverages, then the input's —
  // whose offsets count from the subtable, not from the input's count
  const chained = (b) => {
    const at = b.pos;
    b.u16(3).u16(2);
    const back = [b.slot16(), b.slot16()];
    b.u16(1);
    const input = b.slot16();
    b.u16(0).u16(0);
    back[0].fill(coverage1(b, [7]), at);
    back[1].fill(coverage1(b, [8]), at);
    input.fill(coverage1(b, [300, 301]), at);
    return at;
  };
  // context format 3: the glyph count, the lookup count, then the coverages
  const context = (b) => {
    const at = b.pos;
    b.u16(3).u16(1).u16(0);
    const first = b.slot16();
    first.fill(coverage1(b, [400]), at);
    return at;
  };
  const marks = markGlyphs(
    fakeFont({
      GPOS: layoutTable({ features: [['mark', [0, 1]]], lookups: [lookup(8, chained), lookup(7, context)] })
    })
  );
  assert.ok(marks);
  assert.deepEqual(covered(marks, [7, 8, 300, 301, 400]), [300, 301, 400]);
});

test('a face this cannot read to the end, or that fontkit shapes another way, is shaped whole', () => {
  const plain = { features: [['mark', [0]]], lookups: [lookup(4, markSub((b) => coverage1(b, [100])))] };
  assert.ok(markGlyphs(fakeFont({ GPOS: layoutTable(plain) })), 'the plain case reads');
  // nothing to stand in for
  assert.equal(markGlyphs(fakeFont({ GPOS: layoutTable({ features: [['kern', [0]]], lookups: plain.lookups }) })), null);
  assert.equal(markGlyphs(fakeFont({})), null, 'no GPOS');
  // a subtable format this does not know
  const odd = lookup(4, (b) => {
    const at = b.pos;
    b.u16(2).u16(0);
    return at;
  });
  assert.equal(markGlyphs(fakeFont({ GPOS: layoutTable({ features: [['mark', [0]]], lookups: [odd] }) })), null);
  // fontkit shapes a morx face with AAT, not GPOS
  const aat = fakeFont({ GPOS: layoutTable(plain) });
  aat.directory.tables.morx = { length: 0 };
  assert.equal(markGlyphs(aat), null);
  // cut short: never a throw
  assert.equal(markGlyphs(fakeFont({ GPOS: layoutTable(plain).slice(0, 30) })), null);
});

test('a stood-in lookup is exact wherever it is reached from, so neither variations nor GSUB tags matter', () => {
  // feature variations and a substitution named `mark` once turned this
  // off; a stand-in changes no feature, and a lookup reached through a
  // swapped feature table acts at its coverage like any other
  const plain = { features: [['mark', [0]]], lookups: [lookup(4, markSub((b) => coverage1(b, [100])))] };
  assert.ok(markGlyphs(fakeFont({ GPOS: layoutTable({ ...plain, minor: 1, variations: 64 }) })));
  const substitutes = layoutTable({ features: [['mark', [0]]], lookups: [lookup(1, markSub((b) => coverage1(b, [9])))] });
  assert.ok(markGlyphs(fakeFont({ GPOS: layoutTable(plain), GSUB: substitutes })));
});

// --- a real face ------------------------------------------------------------

/** A system face with mark lookups — DejaVu Sans on CI — or null. */
function markedFace() {
  let file;
  try {
    file = execFileSync('fc-match', ['-f', '%{file}', 'DejaVu Sans'], { encoding: 'utf8' });
  } catch {
    return null;
  }
  try {
    return markGlyphs(fontkit.openSync(file)) ? file : null;
  } catch {
    return null;
  }
}

const face = markedFace();
const needsFace = { skip: !face && 'no system face with mark lookups (DejaVu Sans)' };

/** Font over a fresh fontkit face, with the features each fontkit layout was asked with. */
function watched(file) {
  const fk = fontkit.openSync(file);
  const asked = [];
  const layout = fk.layout;
  fk.layout = function (text, features, ...rest) {
    // as handed over: fontkit adds its defaults to the object afterwards
    asked.push(structuredClone(features));
    return layout.call(this, text, features, ...rest);
  };
  return { font: new Font(fk, file), asked };
}

/** fontkit's own answer, on a face nothing else has touched. */
function reference(file, text, size) {
  const fk = fontkit.openSync(file);
  const run = fk.layout(text);
  const s = size / fk.unitsPerEm;
  return run.glyphs.map((g, i) => [g.id, run.positions[i].xAdvance * s, run.positions[i].xOffset * s, run.positions[i].yOffset * s]);
}

const answer = (shaped) => shaped.glyphs.map((g) => [g.id, g.ax, g.dx, g.dy]);

/** The mark lookups fontkit has decoded for a face, by type. */
function decodedMarks(font) {
  return font.fk.GPOS.lookupList.items.filter((l) => l && l.subTables.length > 0 && l.lookupType >= 4 && l.lookupType <= 6).length;
}

test('a run with no mark is shaped once, decodes no mark lookup, and comes out as fontkit shapes it', needsFace, () => {
  const { font, asked } = watched(face);
  assert.deepEqual(answer(font.shape('File AVAT', 40)), reference(face, 'File AVAT', 40));
  assert.deepEqual(asked, [undefined], 'once, with the features as asked');
  assert.equal(decodedMarks(font), 0);
});

test('a run holding a mark is shaped again with the real lookups, and so is every run after it', needsFace, () => {
  const { font, asked } = watched(face);
  const combining = 'e\u0301 a\u0323';
  assert.deepEqual(answer(font.shape(combining, 40)), reference(face, combining, 40));
  assert.deepEqual(asked, [undefined, undefined]);
  assert.ok(decodedMarks(font) > 0, 'the real lookups are back');
  asked.length = 0;
  assert.deepEqual(answer(font.shape('File', 40)), reference(face, 'File', 40));
  assert.deepEqual(answer(font.shape('o\u0302', 40)), reference(face, 'o\u0302', 40));
  assert.deepEqual(asked, [undefined, undefined], 'once each: nothing left to stand in for');
});

test('the features a run asks for reach fontkit as asked', needsFace, () => {
  const { font, asked } = watched(face);
  font.shape('File', 40, { features: { liga: false } });
  font.shape('File', 40, { features: ['smcp'] });
  // and a second shaping gets them as asked too, not as fontkit left them
  font.shape('e\u0301', 40, { features: { liga: false } });
  assert.deepEqual(asked, [{ liga: false }, ['smcp'], { liga: false }, { liga: false }]);
});

test('whatever a run holds, the answer is fontkit\'s', needsFace, () => {
  const corpus = [
    'File Edit View',
    'café naïve',
    'é ố',
    'Tiếng Việt',
    'Ελληνικά ΐ',
    'Русский й',
    'x́̂̃',
    'ǅ ĳ'
  ];
  for (const text of corpus) {
    // a face per text, so every one is its face's first
    const { font } = watched(face);
    assert.deepEqual(answer(font.shape(text, 40)), reference(face, text, 40), text);
  }
});
