// A WOFF2's font data, decompressed by the runtime's own Brotli.
//
// A WOFF2 keeps every table in one Brotli stream, and fontkit (2.0.4)
// decompresses it with brotli.js, a decoder written in JavaScript. Node, Bun
// and Deno each carry a native one in `node:zlib` — every Node ntk runs on,
// and Bun since 1.1.8 — which gives the same bytes about six times as fast:
// the twenty KaTeX faces and the variable fixture decompress in 3.9 ms
// instead of 21.4 on an M1 Pro. It also never reaches brotli.js's static
// dictionary, which ./brotlidictionary.js keeps out of startup so that only a
// WOFF2 pays for it. On these runtimes, none does.
//
// fontkit reaches its decoder through a module-scoped import, so the decoder
// cannot be swapped for one font, but the method that calls it can. A WOFF2
// face ntk opens gets an `_decompress` of its own that does what fontkit's
// does — lay the tables end to end, read the stream, decode it — with
// `zlib.brotliDecompressSync`. Where there is no native Brotli, in a browser
// or a runtime that predates it, it hands over to fontkit's.
//
// One difference, on purpose: font data that does not decompress to exactly
// the size the table directory gives is an error. brotli.js hands back what
// it got, short; Google's reference decoder, the one browsers run, rejects
// it, and so does this. It also has to look, because Deno's zlib answers a
// corrupt stream with no bytes rather than an error.
import { builtin } from '../builtin.js';

// `node:zlib`, or null where it has no Brotli; undefined until first asked
let zlib;

function nativeBrotli() {
  if (zlib === undefined) {
    zlib = null;
    try {
      const z = builtin('node:zlib');
      if (typeof z?.brotliDecompressSync === 'function') zlib = z;
    } catch {
      // no builtins to reach: fontkit's decoder it is
    }
  }
  return zlib;
}

/**
 * Test seam: what decompresses a WOFF2 — a `node:zlib`-shaped module, `null`
 * for fontkit's own decoder, or `undefined` to look for the runtime's again.
 */
export function setNativeBrotli(module) {
  zlib = module;
}

/**
 * A WOFF2's compressed font data, decompressed natively.
 *
 * @param {Uint8Array} compressed the Brotli stream
 * @param {number} size the bytes the table directory says it holds
 * @param {string} [where] the file, for the error
 * @returns {Uint8Array} exactly `size` bytes
 * @throws {Error} where there is no native Brotli, and where the data does
 *   not decompress to `size` bytes
 */
export function decompressWoff2(compressed, size, where) {
  const z = nativeBrotli();
  if (!z) throw new Error('ntk: no native Brotli in this runtime');
  let bytes;
  let why;
  let cause;
  try {
    bytes = z.brotliDecompressSync(compressed, { maxOutputLength: Math.max(size, 1) });
  } catch (err) {
    cause = err;
    why =
      err?.code === 'ERR_BUFFER_TOO_LARGE'
        ? `it holds more than the ${size} bytes its table directory gives`
        : `Brotli says: ${err?.message}`;
  }
  if (bytes && bytes.length !== size) {
    why = `it holds ${bytes.length} of the ${size} bytes its table directory gives`;
  }
  // A plain Uint8Array, as brotli.js returns, not zlib's Buffer: a Buffer's
  // slice() is a view, and what is read out of this expects a copy —
  // ./sfnt.js rewrites `head` in the copy it slices.
  if (why === undefined) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
  throw new Error(
    `${where ? `WOFF2 ${where}` : 'a WOFF2'}: its font data does not decompress — ${why}. ` +
      'The file is damaged or cut short; browsers reject it too.',
    { cause }
  );
}

/**
 * Have `fk` decompress natively, if it is a fontkit WOFF2 that has not been
 * decompressed yet. Anything else is left alone.
 *
 * @param {object} fk a fontkit font
 * @param {string} [where] the file, for the error a damaged one throws
 * @returns {object} `fk`
 */
export function decompressNatively(fk, where) {
  if (fk?.type !== 'WOFF2' || fk._decompressed || Object.hasOwn(fk, '_decompress')) return fk;
  const fontkits = fk._decompress;
  if (typeof fontkits !== 'function' || fk._dataPos == null || !fk.directory?.tables) return fk;
  fk._decompress = function () {
    if (this._decompressed) return;
    if (!nativeBrotli()) return fontkits.call(this);
    const { directory } = this;
    let size = 0;
    for (const tag in directory.tables) {
      const entry = directory.tables[tag];
      entry.offset = size;
      size += entry.transformLength != null ? entry.transformLength : entry.length;
    }
    this.stream.pos = this._dataPos;
    const compressed = this.stream.readBuffer(directory.totalCompressedSize);
    this.stream = new this.stream.constructor(decompressWoff2(compressed, size, where));
    this._decompressed = true;
  };
  return fk;
}
