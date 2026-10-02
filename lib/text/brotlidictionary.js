// Keeps brotli's static dictionary out of every app's startup (issue #427).
//
// fontkit's `dist/module.mjs` imports brotli's decoder at the top, for WOFF2,
// and the decoder's last line is `BrotliDictionary.init()`, at module scope.
// `dec/dictionary.js` requires `dec/dictionary-data.js` to have something to
// init from: RFC 7932's 122,784-byte dictionary written out as a 756 KB array
// literal. Compiling and running it is 8 of the 10 ms the decoder takes to
// load on an M1 Pro — the issue measured the decoder at 16 ms on an i7-7700K
// — and `import 'ntk'` paid it in every app, including the ones that never
// open a WOFF2.
//
// The decoder reads the dictionary's fields as it decompresses, and nothing
// else does; `init()` is the one thing done at load. So before fontkit loads,
// a stand-in for `dec/dictionary.js` goes into `require.cache`: its `init()`
// does nothing, and the first read of a field — the first WOFF2 decompressed
// — drops the stand-in from the cache, requires the real module and copies
// its fields over, so the decoder holds the real values from then on.
//
// Why that module and not a shallower one: before ESM evaluates anything, it
// pre-parses the CommonJS it imports for export names, which leaves loader-
// owned placeholders in `require.cache` for `decompress.js` and, through
// what reads as a re-export, `dec/decode.js` — replace one and the import
// dies with ERR_INTERNAL_ASSERTION. `dec/dictionary.js` is only reached by
// `require`, while the decoder evaluates, so it is still free when this runs.
//
// Each step stands down where it cannot apply: outside Node, in a bundle
// (which carries its own copy of brotli and never consults `require.cache`),
// where fontkit or brotli do not resolve, where something required the
// dictionary first, and for a brotli other than the 1.3 this was written
// against. A brotli release that loads the dictionary lazily itself makes
// this redundant, and the version check retires it.
//
// Where the runtime has a Brotli of its own, a WOFF2 ntk opens is not
// decompressed by this decoder at all (./woff2.js), so with the stand-in in
// place the dictionary never loads. Without it, it would still load with
// fontkit, used or not.
import { builtin, nodeRequire } from '../builtin.js';

// What the decoder reads off brotli 1.3's `dec/dictionary.js`.
const FIELDS = [
  'dictionary',
  'offsetsByLength',
  'sizeBitsByLength',
  'minDictionaryWordLength',
  'maxDictionaryWordLength',
];

/**
 * Put the stand-in for fontkit's `brotli/dec/dictionary.js` into
 * `require.cache`, unless it cannot or should not be.
 * @returns {boolean} whether it was installed
 */
export function deferBrotliDictionary() {
  try {
    const require = nodeRequire();
    if (!require) return false;
    const { createRequire, Module } = builtin('node:module');
    const fromFontkit = createRequire(require.resolve('fontkit'));
    if (!/^1\.3\./.test(fromFontkit('brotli/package.json').version)) return false;
    const file = fromFontkit.resolve('brotli/dec/dictionary.js');
    const cache = require.cache;
    if (cache[file]) return false;

    const standIn = new Module(file);
    standIn.filename = file;
    standIn.loaded = true;
    const exports = (standIn.exports = { init() {} });
    const load = () => {
      if (cache[file] === standIn) delete cache[file];
      const real = require(file);
      real.init();
      for (const key of Object.keys(real)) {
        Object.defineProperty(exports, key, {
          value: real[key],
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      return real;
    };
    for (const key of FIELDS) {
      Object.defineProperty(exports, key, {
        get: () => load()[key],
        enumerable: true,
        configurable: true,
      });
    }
    cache[file] = standIn;
    return true;
  } catch {
    // no node:module, no import.meta.url (a CommonJS bundle), or a layout
    // that does not resolve: the dictionary loads with fontkit, as before
    return false;
  }
}

deferBrotliDictionary();
