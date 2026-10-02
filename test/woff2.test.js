// A WOFF2 decompressed by the runtime's own Brotli (lib/text/woff2.js).
//
// Hermetic: KaTeX's twenty WOFF2 faces and the variable fixture, each
// compared with what fontkit's own decoder makes of it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { test } from 'node:test';

import Font from '../lib/text/font.js';
import * as fontkit from 'fontkit';
import { decompressNatively, decompressWoff2, setNativeBrotli } from '../lib/text/woff2.js';

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

/** the font data fontkit holds once `fk` is decompressed, and where each table starts in it */
function decompressed(fk) {
  fk._decompress();
  const offsets = Object.entries(fk.directory.tables).map(([tag, entry]) => [tag, entry.offset]);
  return { bytes: Buffer.from(fk.stream.buffer), offsets };
}

/** `node:zlib`, counting its Brotli calls */
function counting() {
  const z = { calls: 0 };
  z.brotliDecompressSync = (...args) => {
    z.calls += 1;
    return zlib.brotliDecompressSync(...args);
  };
  return z;
}

test("a WOFF2 decompresses natively to the bytes fontkit's own decoder gives", () => {
  const z = counting();
  setNativeBrotli(z);
  try {
    for (const file of FILES) {
      const fk = decompressNatively(fontkit.openSync(file), file);
      const native = decompressed(fk);
      const own = decompressed(fontkit.openSync(file));
      assert.ok(native.bytes.equals(own.bytes), file);
      assert.deepEqual(native.offsets, own.offsets, file);
      // and in the type fontkit's decoder hands back: a Buffer's slice() is
      // a view, and ./sfnt.js rewrites `head` in the copy it slices
      assert.equal(Object.getPrototypeOf(fk.stream.buffer), Uint8Array.prototype, file);
    }
    assert.equal(z.calls, FILES.length, 'each by the native decoder');
  } finally {
    setNativeBrotli(undefined);
  }
});

test('every way ntk opens a WOFF2 decompresses it natively', () => {
  const opened = [
    Font.loadSync(MAIN),
    Font.fromData(readFileSync(MAIN)),
    new Font(fontkit.openSync(MAIN)),
  ];
  for (const font of opened) {
    assert.ok(Object.hasOwn(font.fk, '_decompress'), font.key);
    assert.ok(font.hasGlyph(0x41), 'and reads like any face');
  }
});

test('a variable WOFF2 decompressed natively draws its instances as before', () => {
  // read out of its container as the sfnt inside (./sfnt.js), then cut
  const drawn = (native) => {
    setNativeBrotli(native);
    try {
      const base = Font.loadSync(fixture);
      assert.equal(base.fk.type, 'TTF', 'handed to fontkit as an sfnt');
      const bold = base.variation({ wght: 700 });
      return bold.shape('Handgloves', 32).glyphs.map(({ id }) => bold.rasterize(id, 32));
    } finally {
      setNativeBrotli(undefined);
    }
  };
  const z = counting();
  const native = drawn(z);
  assert.equal(z.calls, 1, 'decompressed natively on the way');
  const own = drawn(null);
  assert.equal(native.length, 10);
  native.forEach((glyph, i) => {
    assert.ok(glyph, `glyph ${i} drawn`);
    assert.deepEqual(glyph, own[i], `glyph ${i} as fontkit's decoder draws it`);
  });
});

test("with no native Brotli, fontkit's decoder does the work", () => {
  setNativeBrotli(null);
  try {
    const font = Font.loadSync(MAIN);
    assert.ok(decompressed(font.fk).bytes.equals(decompressed(fontkit.openSync(MAIN)).bytes));
  } finally {
    setNativeBrotli(undefined);
  }
});

test('font data that does not decompress names the file and the reason', () => {
  const bytes = Buffer.from(readFileSync(MAIN));
  const at = fontkit.create(bytes)._dataPos + 2000;
  for (let i = 0; i < 8; i += 1) bytes[at + i] ^= 0xa5;
  const font = Font.fromData(bytes, { key: 'broken.woff2' });
  assert.throws(() => font.fk._decompress(), (err) => {
    assert.match(err.message, /^WOFF2 broken\.woff2: its font data does not decompress — Brotli says: /);
    assert.match(err.message, /The file is damaged or cut short; browsers reject it too\.$/);
    assert.ok(err.cause, "zlib's own error rides along");
    return true;
  });
});

test('nor does font data of another size than the table directory gives', () => {
  const data = Buffer.alloc(1000, 'woff2 ');
  const packed = zlib.brotliCompressSync(data);
  assert.ok(Buffer.from(decompressWoff2(packed, 1000)).equals(data));
  assert.throws(() => decompressWoff2(packed, 999, 'long.woff2'), {
    message: /^WOFF2 long\.woff2: .* it holds more than the 999 bytes its table directory gives\./,
  });
  assert.throws(() => decompressWoff2(packed, 1001), {
    message: /^a WOFF2: .* it holds 1000 of the 1001 bytes its table directory gives\./,
  });
  // Deno's zlib answers a corrupt stream with nothing rather than an error
  setNativeBrotli({ brotliDecompressSync: () => Buffer.alloc(0) });
  try {
    assert.throws(() => decompressWoff2(packed, 1000), { message: /it holds 0 of the 1000 bytes/ });
  } finally {
    setNativeBrotli(undefined);
  }
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
const dictionary = createRequire(require.resolve('fontkit')).resolve('brotli/dec/dictionary-data.js');
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
