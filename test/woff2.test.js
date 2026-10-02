// A WOFF2 decompressed by the runtime's own Brotli (lib/text/woff2.js).
//
// Hermetic: KaTeX's twenty WOFF2 faces and the variable fixture, each
// compared with what the build's own brotli.js makes of it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { test } from 'node:test';

import Font from '../lib/text/font.js';
import { createFontSource } from '../lib/text/fontsource.js';
import { sfntOf } from '../lib/text/sfnt.js';
import * as fontkit from '../lib/vendor/fontkit.js';
import { setNativeBrotli } from '../lib/text/woff2.js';

const require = createRequire(import.meta.url);
const katex = join(dirname(require.resolve('katex/package.json')), 'dist', 'fonts');
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'MonelogicsSubset[wght].woff2');
const FILES = [
  ...readdirSync(katex)
    .filter((name) => name.endsWith('.woff2'))
    .map((name) => join(katex, name)),
  fixture,
];
const MAIN = join(katex, 'KaTeX_Main-Regular.woff2');

/** `node:zlib`, counting its Brotli calls */
function counting() {
  const z = { calls: 0 };
  z.brotliDecompressSync = (...args) => {
    z.calls += 1;
    return zlib.brotliDecompressSync(...args);
  };
  return z;
}

/** what `fn` returns with `brotli` decompressing a WOFF2 (see setNativeBrotli) */
function using(brotli, fn) {
  setNativeBrotli(brotli);
  try {
    return fn();
  } finally {
    setNativeBrotli(undefined);
  }
}

/** `bytes` with eight bytes of its Brotli stream flipped */
function damaged(bytes) {
  const copy = Buffer.from(bytes);
  const at = fontkit.create(copy)._dataPos + 2000;
  for (let i = 0; i < 8; i += 1) copy[at + i] ^= 0xa5;
  return copy;
}

/** what `fn` returns, given the path of a file holding `bytes` */
function inFile(bytes, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ntk-woff2-'));
  try {
    const path = join(dir, 'broken.woff2');
    writeFileSync(path, bytes);
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a WOFF2 decompresses natively to the font brotli.js makes of it', () => {
  const z = counting();
  for (const file of FILES) {
    const bytes = readFileSync(file);
    // the sfnt inside, which is every table decompressed (./sfnt.js)
    const native = using(z, () => sfntOf(fontkit.create(bytes)));
    const own = using(null, () => sfntOf(fontkit.create(bytes)));
    assert.ok(native && Buffer.from(native).equals(Buffer.from(own)), file);
  }
  assert.equal(z.calls, FILES.length, 'each by the native decoder');
});

test('every way ntk opens a WOFF2 decompresses it natively', () => {
  const z = counting();
  using(z, () => {
    const opened = [
      Font.loadSync(MAIN),
      Font.fromData(readFileSync(MAIN)),
      new Font(fontkit.create(readFileSync(MAIN))),
    ];
    for (const font of opened) assert.ok(font.hasGlyph(0x41), font.key);
  });
  assert.equal(z.calls, 3);
});

test('a variable WOFF2 decompressed natively draws its instances as brotli.js does', () => {
  // read out of its container as the sfnt inside (./sfnt.js), then cut
  const drawn = () => {
    const base = Font.loadSync(fixture);
    assert.equal(base.fk.type, 'TTF', 'handed to fontkit as an sfnt');
    const bold = base.variation({ wght: 700 });
    return bold.shape('Handgloves', 32).glyphs.map(({ id }) => bold.rasterize(id, 32));
  };
  const z = counting();
  const native = using(z, drawn);
  assert.equal(z.calls, 1, 'decompressed natively on the way');
  const own = using(null, drawn);
  assert.equal(native.length, 10);
  native.forEach((glyph, i) => {
    assert.ok(glyph, `glyph ${i} drawn`);
    assert.deepEqual(glyph, own[i], `glyph ${i} as brotli.js draws it`);
  });
});

test('a damaged WOFF2 is an error naming it, at the call that opened it', () => {
  const bytes = damaged(readFileSync(MAIN));
  for (const brotli of [undefined, null]) {
    const how = brotli === null ? 'with brotli.js' : 'natively';
    inFile(bytes, (path) => {
      assert.throws(
        () => using(brotli, () => Font.loadSync(path)),
        (err) => {
          assert.ok(err.message.startsWith(`${path}: Error decoding compressed data in WOFF2: `), err.message);
          assert.match(err.message, / — the file is damaged or cut short; browsers reject it too\.$/);
          assert.ok(err.cause, "fontkit's error rides along");
          return true;
        },
        how
      );
    });
    // from data there is no file to name
    assert.throws(() => using(brotli, () => Font.fromData(bytes)), {
      message: /^Error decoding compressed data in WOFF2: .* — the file is damaged/,
    }, how);
  }
});

test('so a font source skips one, rather than holding a font with no tables', () => {
  inFile(damaged(readFileSync(MAIN)), (path) => {
    const source = createFontSource([path, MAIN]);
    assert.equal(source.skipped.length, 1);
    assert.equal(source.skipped[0].file, path);
    assert.match(source.skipped[0].error.message, /damaged or cut short/);
    const [face] = source.matchSorted({ family: 'KaTeX_Main' });
    assert.equal(face.font.familyName, 'KaTeX_Main', 'and the good face is there');
  });
});

test('font data of another size than the table directory gives is refused', () => {
  const bytes = readFileSync(MAIN);
  // short, and none at all: Deno's zlib answers a corrupt stream so
  for (const length of [-1, null]) {
    const z = {
      brotliDecompressSync: (data, opts) => Buffer.alloc(length === null ? 0 : opts.maxOutputLength + length),
    };
    assert.throws(() => using(z, () => Font.fromData(bytes)), {
      message: /^Error decoding compressed data in WOFF2: \d+ bytes, where the table directory gives \d+ — /,
    });
  }
  // long: zlib stops at the directory's size and says so
  const capped = {
    brotliDecompressSync: (data, opts) =>
      zlib.brotliDecompressSync(data, { ...opts, maxOutputLength: opts.maxOutputLength - 1 }),
  };
  assert.throws(() => using(capped, () => Font.fromData(bytes)), {
    message: /^Error decoding compressed data in WOFF2: it holds more than the \d+ bytes its table directory gives — /,
  });
});

test("drawing from a WOFF2 never loads brotli.js's dictionary", () => {
  // in a process of its own, as test/brotli-dictionary.test.js explains
  const index = new URL('../lib/index.js', import.meta.url).href;
  const fontModule = new URL('../lib/text/font.js', import.meta.url).href;
  const script = `
import { createRequire } from 'node:module';
await import(${JSON.stringify(index)});
const { default: Font } = await import(${JSON.stringify(fontModule)});
const require = createRequire(${JSON.stringify(index)});
// brotli is ntk's own dependency, which the vendored fontkit imports
const dictionary = require.resolve('brotli/dec/dictionary-data.js');
for (const file of ${JSON.stringify([MAIN, fixture])}) {
  let font = Font.loadSync(file);
  if (Object.keys(font.variationAxes).length) font = font.variation({ wght: 700 });
  const [glyph] = font.shape('H', 32).glyphs;
  if (!font.rasterize(glyph.id, 32)) throw new Error('nothing drawn from ' + file);
}
console.log(dictionary in require.cache);
`;
  const loaded = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  assert.equal(loaded.trim(), 'false');
});
