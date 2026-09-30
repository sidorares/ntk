// A WOFF or a WOFF2, as the sfnt it was made from.
//
// fontkit reads a font out of either container, a table at a time, and that
// is all most faces are asked for. A variable face is asked for more: an
// instance, cut at a point of its design space, and fontkit (2.0.4) cuts
// one by reading the file again as a plain sfnt — a WOFF's directory is
// another, and a WOFF2 is Brotli-compressed — so the instance came back
// with no tables, and the first text set at a weight off the file's default
// threw. A variable web font is nearly always a WOFF2: a page set in one
// drew nothing.
//
// So a variable face that arrives in a container is handed to fontkit as
// the sfnt inside it (`Font`, text/font.js), and everything after that is
// the path an uncompressed font takes. Built here rather than fixed there,
// because there is nowhere to put a fixed fontkit: upstream releases
// rarely, and a fork has to be named by URL or by git, neither of which npm
// 12 installs for a dependency of a dependency (`allow-remote` and
// `allow-git` are `none` unless an application says otherwise).
//
// A WOFF is the sfnt's tables, each deflated on its own, and fontkit
// inflates them. A WOFF2 is the tables in one Brotli stream, which fontkit
// decompresses, with `glyf` and `loca` *transformed*: the glyphs' contour
// counts, point counts, flags, coordinates, composites, boxes and
// instructions are each a stream of their own, and `loca` is left out. The
// work here is writing those back as the two tables (WOFF2, 5.1 to 5.3).

/** Reads big-endian numbers off a byte array, from a position it keeps. */
class Reader {
  constructor(bytes, pos = 0, end = bytes.length) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = pos;
    this.end = end;
  }

  need(n) {
    if (this.pos + n > this.end) throw new RangeError('a stream of the WOFF2 glyf table ends short');
  }

  u8() {
    this.need(1);
    return this.bytes[this.pos++];
  }

  u16() {
    this.need(2);
    const value = this.view.getUint16(this.pos);
    this.pos += 2;
    return value;
  }

  i16() {
    this.need(2);
    const value = this.view.getInt16(this.pos);
    this.pos += 2;
    return value;
  }

  u32() {
    this.need(4);
    const value = this.view.getUint32(this.pos);
    this.pos += 4;
    return value;
  }

  take(n) {
    this.need(n);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** WOFF2's 255UInt16: a number up to 65535 in one to three bytes. */
  u255() {
    const code = this.u8();
    if (code === 253) return this.u16();
    if (code === 255) return this.u8() + 253;
    if (code === 254) return this.u8() + 506;
    return code;
  }
}

const signed = (flag, value) => (flag & 1 ? value : -value);

// glyf: a simple glyph's flags, and a composite's
const ON_CURVE = 0x01;
const OVERLAP_SIMPLE = 0x40;
const ARGS_ARE_WORDS = 0x0001;
const HAS_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const HAS_XY_SCALE = 0x0040;
const HAS_TWO_BY_TWO = 0x0080;
const HAS_INSTRUCTIONS = 0x0100;

/**
 * The `glyf` and `loca` tables a WOFF2's transformed `glyf` stands for.
 *
 * A glyph comes out as the points it had, not the bytes: a coordinate is
 * written as a 16-bit step from the one before, where the font it was made
 * from had short forms and repeats. What reads the table reads the same
 * outline, and nothing here is written to a file.
 *
 * @param {Uint8Array} table the transformed table
 * @returns {{ glyf: Uint8Array, loca: Uint8Array }}
 */
export function untransformGlyf(table) {
  const head = new Reader(table);
  head.u16(); // reserved
  const options = head.u16();
  const numGlyphs = head.u16();
  head.u16(); // the loca format the font had: a long one is written
  const sizes = [];
  for (let i = 0; i < 7; i += 1) sizes.push(head.u32());
  let at = head.pos;
  const stream = (size) => {
    const reader = new Reader(table, at, at + size);
    at += size;
    if (at > table.length) throw new RangeError('the WOFF2 glyf table is shorter than its streams');
    return reader;
  };
  const contours = stream(sizes[0]);
  const pointCounts = stream(sizes[1]);
  const flags = stream(sizes[2]);
  const glyphs = stream(sizes[3]);
  const composites = stream(sizes[4]);
  const boxes = stream(sizes[5]);
  const instructions = stream(sizes[6]);
  // a bit a glyph, set where its box is stored; the boxes follow the bits
  const stored = boxes.take(((numGlyphs + 31) >> 5) << 2);
  const overlaps = options & 1 ? new Reader(table, at).take((numGlyphs + 7) >> 3) : null;
  const bit = (bits, i) => (bits[i >> 3] & (0x80 >> (i & 7))) !== 0;

  const records = [];
  let total = 0;
  for (let id = 0; id < numGlyphs; id += 1) {
    const count = contours.i16();
    let record = null;
    if (count > 0) {
      record = simpleGlyph(count, {
        pointCounts,
        flags,
        glyphs,
        instructions,
        box: bit(stored, id) ? boxes : null,
        overlap: overlaps !== null && bit(overlaps, id)
      });
    } else if (count < 0) {
      // a composite's box cannot be had from its points: it has to be stored
      if (!bit(stored, id)) throw new RangeError('a composite glyph of the WOFF2 has no box');
      record = compositeGlyph(count, { composites, glyphs, instructions, box: boxes });
    }
    records.push(record);
    if (record) total += (record.length + 3) & ~3;
  }

  const glyf = new Uint8Array(total);
  const loca = new Uint8Array((numGlyphs + 1) * 4);
  const offsets = new DataView(loca.buffer);
  let offset = 0;
  for (let id = 0; id < numGlyphs; id += 1) {
    offsets.setUint32(id * 4, offset);
    const record = records[id];
    if (!record) continue;
    glyf.set(record, offset);
    offset += (record.length + 3) & ~3;
  }
  offsets.setUint32(numGlyphs * 4, offset);
  return { glyf, loca };
}

function simpleGlyph(count, { pointCounts, flags, glyphs, instructions, box, overlap }) {
  const ends = [];
  let points = 0;
  for (let i = 0; i < count; i += 1) {
    points += pointCounts.u255();
    ends.push(points - 1);
  }
  const on = new Uint8Array(points);
  const xs = new Int32Array(points);
  const ys = new Int32Array(points);
  let x = 0;
  let y = 0;
  let xMin = 0x7fff;
  let yMin = 0x7fff;
  let xMax = -0x8000;
  let yMax = -0x8000;
  for (let i = 0; i < points; i += 1) {
    // a point is a flag and one to four bytes: which, and how they divide
    // between the two steps, is the flag's (WOFF2, 5.2)
    let flag = flags.u8();
    on[i] = flag >> 7 ? 0 : 1;
    flag &= 0x7f;
    let dx = 0;
    let dy = 0;
    if (flag < 10) {
      dy = signed(flag, ((flag & 14) << 7) + glyphs.u8());
    } else if (flag < 20) {
      dx = signed(flag, (((flag - 10) & 14) << 7) + glyphs.u8());
    } else if (flag < 84) {
      const b0 = flag - 20;
      const b1 = glyphs.u8();
      dx = signed(flag, 1 + (b0 & 0x30) + (b1 >> 4));
      dy = signed(flag >> 1, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f));
    } else if (flag < 120) {
      const b0 = flag - 84;
      dx = signed(flag, 1 + (Math.floor(b0 / 12) << 8) + glyphs.u8());
      dy = signed(flag >> 1, 1 + (((b0 % 12) >> 2) << 8) + glyphs.u8());
    } else if (flag < 124) {
      const b1 = glyphs.u8();
      const b2 = glyphs.u8();
      dx = signed(flag, (b1 << 4) + (b2 >> 4));
      dy = signed(flag >> 1, ((b2 & 0x0f) << 8) + glyphs.u8());
    } else {
      dx = signed(flag, glyphs.u16());
      dy = signed(flag >> 1, glyphs.u16());
    }
    xs[i] = dx;
    ys[i] = dy;
    x += dx;
    y += dy;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  const program = instructions.take(glyphs.u255());
  if (box) {
    xMin = box.i16();
    yMin = box.i16();
    xMax = box.i16();
    yMax = box.i16();
  }

  const out = new Uint8Array(10 + count * 2 + 2 + program.length + points * 5);
  const view = new DataView(out.buffer);
  view.setInt16(0, count);
  view.setInt16(2, xMin);
  view.setInt16(4, yMin);
  view.setInt16(6, xMax);
  view.setInt16(8, yMax);
  let pos = 10;
  for (const end of ends) {
    view.setUint16(pos, end);
    pos += 2;
  }
  view.setUint16(pos, program.length);
  pos += 2;
  out.set(program, pos);
  pos += program.length;
  for (let i = 0; i < points; i += 1) out[pos + i] = on[i] ? ON_CURVE : 0;
  if (overlap && points) out[pos] |= OVERLAP_SIMPLE;
  pos += points;
  for (let i = 0; i < points; i += 1) view.setInt16(pos + i * 2, xs[i]);
  pos += points * 2;
  for (let i = 0; i < points; i += 1) view.setInt16(pos + i * 2, ys[i]);
  return out;
}

function compositeGlyph(count, { composites, glyphs, instructions, box }) {
  // the components are in the stream as they are in a glyf table
  const from = composites.pos;
  let flags;
  let programmed = false;
  do {
    flags = composites.u16();
    let size = 2 + (flags & ARGS_ARE_WORDS ? 4 : 2);
    if (flags & HAS_SCALE) size += 2;
    else if (flags & HAS_XY_SCALE) size += 4;
    else if (flags & HAS_TWO_BY_TWO) size += 8;
    composites.take(size);
    if (flags & HAS_INSTRUCTIONS) programmed = true;
  } while (flags & MORE_COMPONENTS);
  const components = composites.bytes.subarray(from, composites.pos);
  const program = programmed ? instructions.take(glyphs.u255()) : null;

  const out = new Uint8Array(10 + components.length + (program ? 2 + program.length : 0));
  const view = new DataView(out.buffer);
  view.setInt16(0, count);
  for (let i = 0; i < 4; i += 1) view.setInt16(2 + i * 2, box.i16());
  out.set(components, 10);
  if (program) {
    view.setUint16(10 + components.length, program.length);
    out.set(program, 12 + components.length);
  }
  return out;
}

/** Where a `head` table says which of `loca`'s two formats the font uses. */
const LOCA_FORMAT = 50;

/** A table's checksum: its bytes as 32-bit numbers, the last one padded. */
function checksum(data) {
  let sum = 0;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const whole = data.length & ~3;
  for (let i = 0; i < whole; i += 4) sum = (sum + view.getUint32(i)) >>> 0;
  let last = 0;
  for (let i = whole; i < data.length; i += 1) last |= data[i] << (24 - (i - whole) * 8);
  return (sum + (last >>> 0)) >>> 0;
}

/** An sfnt of `tables`, each `{ tag, data }`, under a version `flavor`. */
function assemble(flavor, tables) {
  tables.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const count = tables.length;
  let size = 12 + count * 16;
  for (const table of tables) size += (table.data.length + 3) & ~3;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  const power = Math.floor(Math.log2(count));
  view.setUint32(0, flavor);
  view.setUint16(4, count);
  view.setUint16(6, 16 << power);
  view.setUint16(8, power);
  view.setUint16(10, count * 16 - (16 << power));
  let offset = 12 + count * 16;
  tables.forEach(({ tag, data }, i) => {
    const entry = 12 + i * 16;
    for (let c = 0; c < 4; c += 1) out[entry + c] = tag.charCodeAt(c);
    view.setUint32(entry + 4, checksum(data));
    view.setUint32(entry + 8, offset);
    view.setUint32(entry + 12, data.length);
    out.set(data, offset);
    offset += (data.length + 3) & ~3;
  });
  return out;
}

/** `ttcf`: a collection, which neither container is read as here. */
const COLLECTION = 0x74746366;

/**
 * The sfnt inside a font fontkit read out of a WOFF or a WOFF2, or null
 * where there is none to be had: a font that is not in a container, a
 * collection, or a WOFF2 whose `hmtx` is transformed, which fontkit does
 * not read either.
 *
 * Reads fontkit's own state — its directory, and the tables as it inflated
 * or decompressed them — so the bytes are decompressed once, by the code
 * that already does it.
 *
 * @param {object} fk a fontkit font
 * @returns {Uint8Array|null}
 */
export function sfntOf(fk) {
  const entries = fk?.directory?.tables;
  if (!entries || fk.directory.flavor === COLLECTION) return null;
  const tables = [];

  if (fk.type === 'WOFF') {
    for (const tag of Object.keys(entries)) {
      const entry = entries[tag];
      const stream = fk._getTableStream(tag);
      // a table deflated in the file is a stream of its own, and one that
      // was stored is the file's, at the table
      const data =
        stream === fk.stream
          ? fk.stream.buffer.subarray(entry.offset, entry.offset + entry.length)
          : stream.buffer;
      tables.push({ tag, data });
    }
    return assemble(fk.directory.flavor, tables);
  }

  if (fk.type !== 'WOFF2') return null;
  fk._decompress();
  const bytes = fk.stream.buffer;
  const stored = (entry) =>
    bytes.subarray(entry.offset, entry.offset + (entry.transformLength ?? entry.length));
  for (const tag of Object.keys(entries)) {
    const entry = entries[tag];
    if (tag === 'loca' && entries.glyf?.transformed) continue;
    if (tag === 'glyf' && entry.transformed) {
      const { glyf, loca } = untransformGlyf(stored(entry));
      tables.push({ tag: 'glyf', data: glyf }, { tag: 'loca', data: loca });
    } else if (entry.transformed) {
      return null;
    } else if (tag === 'head' && entries.glyf?.transformed) {
      // `loca` is written long, whatever it was
      const head = stored(entry).slice();
      new DataView(head.buffer).setInt16(LOCA_FORMAT, 1);
      tables.push({ tag, data: head });
    } else {
      tables.push({ tag, data: stored(entry) });
    }
  }
  return assemble(fk.directory.flavor, tables);
}
