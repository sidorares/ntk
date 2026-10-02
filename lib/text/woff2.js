// A WOFF2's font data, decompressed by the runtime's own Brotli.
//
// A WOFF2 keeps every table in one Brotli stream. The fontkit build ntk
// carries (lib/vendor/fontkit.js) is the fork's browser build, and it
// decompresses that with brotli.js, a decoder written in JavaScript. Node,
// Bun and Deno each carry a native one in `node:zlib` — every Node ntk runs
// on, and Bun since 1.1.8 — which gives the same bytes about six times as
// fast: the twenty KaTeX faces and the variable fixture decompress in 3.9 ms
// instead of 21.4 on an M1 Pro. It also never reaches brotli.js's static
// dictionary, which ./brotlidictionary.js keeps out of startup so that only a
// WOFF2 pays for it. On these runtimes, none does.
//
// The fork takes a decompressor from outside, `setBrotliDecompressor`
// (windowkit/fontkit#6), and checks what comes back against the size the
// table directory gives, as Google's reference decoder does. So this is one
// function, handed over once: zlib's Brotli where the runtime has one, looked
// for at the first WOFF2 rather than at import, and the build's own brotli.js
// where it has none, in a browser.
//
// What fontkit does not do is say so when a file is damaged. It decompresses
// at a WOFF2's first table read, and swallows a table's errors: the table
// reads as undefined. So a damaged WOFF2 opened as a font with no tables,
// and failed at the first glyph drawn, with brotli.js's own message. `opened`
// decompresses it as it is opened, calling fontkit's `_decompress` as
// ./sfnt.js does, and a damaged file is an error naming it, at the call that
// named it. Font sources skip a face that throws there (./fontsource.js),
// and a match moves on to the next candidate (./fontmanager.js).
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
      // no builtins to reach: brotli.js it is
    }
  }
  return zlib;
}

/**
 * Test seam: what decompresses a WOFF2 — a `node:zlib`-shaped module, `null`
 * for the build's brotli.js, or `undefined` to look for the runtime's again.
 */
export function setNativeBrotli(module) {
  zlib = module;
}

/**
 * Hand `fontkit` the runtime's Brotli for WOFF2, keeping the decompressor it
 * had for where there is none.
 *
 * @param {object} fontkit the build ntk carries
 */
export function useNativeBrotli(fontkit) {
  const own = fontkit.setBrotliDecompressor(decompress);

  function decompress(buffer, size) {
    const z = nativeBrotli();
    if (!z) return own(buffer, size);
    let bytes;
    try {
      bytes = z.brotliDecompressSync(buffer, { maxOutputLength: Math.max(size, 1) });
    } catch (err) {
      if (err?.code !== 'ERR_BUFFER_TOO_LARGE') throw err;
      throw new RangeError(`it holds more than the ${size} bytes its table directory gives`, {
        cause: err,
      });
    }
    // A plain Uint8Array, as brotli.js returns, not zlib's Buffer: a Buffer's
    // slice() is a view, and what is read out of this expects a copy —
    // ./sfnt.js rewrites `head` in the copy it slices.
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
  }
}

/**
 * `fk`, with its font data decompressed now if it is a WOFF2, so that a
 * damaged file is an error naming it rather than a font with no tables.
 *
 * @param {object} fk a fontkit font
 * @param {string} [where] the file it was read from
 * @returns {object} `fk`
 */
export function opened(fk, where) {
  if (fk?.type !== 'WOFF2' || typeof fk._decompress !== 'function') return fk;
  try {
    fk._decompress();
  } catch (err) {
    throw new Error(
      `${where ? `${where}: ` : ''}${err.message} — the file is damaged or cut short; ` +
        'browsers reject it too.',
      { cause: err }
    );
  }
  return fk;
}
