// The `_NTK_GLYPHD` wire vocabulary (docs/shared-glyphs.md): the atoms and
// the property payload codecs shared by the directory (lib/glyphdirectory.js)
// and the client (lib/sharedglyphs.js). Pure functions, no X in sight —
// which is what makes the protocol unit-testable without a server.

/** selection + message vocabulary */
export const GLYPHD = {
  selection: '_NTK_GLYPHD',
  ensure: '_NTK_GLYPHD_ENSURE',
  added: '_NTK_GLYPHD_ADDED',
  done: '_NTK_GLYPHD_DONE',
  property: '_NTK_GLYPHD_RPC',
  time: '_NTK_GLYPHD_TIME',
  manager: 'MANAGER'
};

/** wire format version of the RPC properties */
export const RPC_VERSION = 1;

/** lids are compact so CompositeGlyphs can use narrow encodings; a page
 *  cannot outgrow 16-bit ids (fonts cap at 65535 glyphs; corner populations
 *  are far smaller). The directory refuses rather than overflows. */
export const MAX_LIDS = 65536;

const FLAG_INDICES = 1;

/**
 * The ensure/added request property (format 8, little-endian):
 *
 *     u8   version (1)
 *     u8   flags (bit 0: members are u32 font glyph indices, not strings)
 *     u16  token byte length T
 *     u32  member count N
 *     u32  uploaded bytes (added only; 0 in an ensure)
 *     T    token bytes
 *     N    members — u32 each, or (u16 length + bytes) each
 */
export function encodeGlyphdRequest({ token, indices, keys, bytes = 0 }) {
  const tokenBuf = Buffer.from(token, 'utf8');
  let size = 12 + tokenBuf.length;
  const keyBufs = indices ? null : keys.map((k) => Buffer.from(String(k), 'utf8'));
  size += indices ? keys.length * 4 : keyBufs.reduce((n, b) => n + 2 + b.length, 0);
  const buf = Buffer.alloc(size);
  buf.writeUInt8(RPC_VERSION, 0);
  buf.writeUInt8(indices ? FLAG_INDICES : 0, 1);
  buf.writeUInt16LE(tokenBuf.length, 2);
  buf.writeUInt32LE(keys.length, 4);
  buf.writeUInt32LE(bytes, 8);
  tokenBuf.copy(buf, 12);
  let o = 12 + tokenBuf.length;
  for (let i = 0; i < keys.length; i++) {
    if (indices) {
      buf.writeUInt32LE(keys[i] >>> 0, o);
      o += 4;
    } else {
      const kb = keyBufs[i];
      buf.writeUInt16LE(kb.length, o);
      kb.copy(buf, o + 2);
      o += 2 + kb.length;
    }
  }
  return buf;
}

/** @returns {{token, indices, keys, bytes}|null} null when malformed */
export function parseGlyphdRequest(buf) {
  try {
    if (buf.length < 12 || buf.readUInt8(0) !== RPC_VERSION) return null;
    const indices = (buf.readUInt8(1) & FLAG_INDICES) !== 0;
    const tokenLen = buf.readUInt16LE(2);
    const count = buf.readUInt32LE(4);
    const bytes = buf.readUInt32LE(8);
    let o = 12;
    if (o + tokenLen > buf.length) return null;
    const token = buf.toString('utf8', o, o + tokenLen);
    o += tokenLen;
    const keys = new Array(count);
    for (let i = 0; i < count; i++) {
      if (indices) {
        if (o + 4 > buf.length) return null;
        keys[i] = buf.readUInt32LE(o);
        o += 4;
      } else {
        if (o + 2 > buf.length) return null;
        const len = buf.readUInt16LE(o);
        if (o + 2 + len > buf.length) return null;
        keys[i] = buf.toString('utf8', o + 2, o + 2 + len);
        o += 2 + len;
      }
    }
    return { token, indices, keys, bytes };
  } catch {
    return null;
  }
}

/**
 * The ensure reply property (format 8), member entries in request order:
 *
 *     u8   version (1)
 *     u8   status (1 — a refusal sends no reply property at all)
 *     u16  0
 *     u32  serial (echo of the request's)
 *     u32  generation
 *     u32  gsid
 *     u32  member count N
 *     N    u32 each: bit 31 = present, bits 0..30 = lid
 */
export function encodeGlyphdReply({ serial, generation, gsid, entries }) {
  const buf = Buffer.alloc(20 + entries.length * 4);
  buf.writeUInt8(RPC_VERSION, 0);
  buf.writeUInt8(1, 1);
  buf.writeUInt32LE(serial >>> 0, 4);
  buf.writeUInt32LE(generation >>> 0, 8);
  buf.writeUInt32LE(gsid >>> 0, 12);
  buf.writeUInt32LE(entries.length, 16);
  entries.forEach((e, i) => {
    buf.writeUInt32LE(((e.present ? 0x80000000 : 0) | e.lid) >>> 0, 20 + i * 4);
  });
  return buf;
}

/** @returns {{serial, generation, gsid, entries: [{lid, present}]}|null} */
export function parseGlyphdReply(buf) {
  try {
    if (buf.length < 20 || buf.readUInt8(0) !== RPC_VERSION) return null;
    if (buf.readUInt8(1) !== 1) return null;
    const serial = buf.readUInt32LE(4);
    const generation = buf.readUInt32LE(8);
    const gsid = buf.readUInt32LE(12);
    const count = buf.readUInt32LE(16);
    if (buf.length < 20 + count * 4) return null;
    const entries = new Array(count);
    for (let i = 0; i < count; i++) {
      const word = buf.readUInt32LE(20 + i * 4);
      entries[i] = { lid: word & 0x7fffffff, present: (word & 0x80000000) !== 0 };
    }
    return { serial, generation, gsid, entries };
  } catch {
    return null;
  }
}
