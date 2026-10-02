// brotli's static dictionary loads with the first WOFF2, not with ntk
// (lib/text/brotlidictionary.js, issue #427).
//
// In a process of its own: whether a module has loaded is a fact about the
// whole process, and a test file that imports fontkit first — as sfnt.test.js
// does — loads the dictionary before ntk can keep it back.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const index = new URL('../lib/index.js', import.meta.url).href;
const standInModule = new URL('../lib/text/brotlidictionary.js', import.meta.url).href;

const script = `
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

const require = createRequire(${JSON.stringify(index)});
const fromFontkit = createRequire(require.resolve('fontkit'));
const dictionaryData = fromFontkit.resolve('brotli/dec/dictionary-data.js');
const loaded = () => dictionaryData in require.cache;

await import(${JSON.stringify(index)});
const atImport = loaded();
const standIn = require.cache[fromFontkit.resolve('brotli/dec/dictionary.js')].exports;

// Words the encoder finds in the dictionary rather than earlier in the text.
const text = Buffer.from(
  'The government said the information was available on the internet, ' +
    'although the people of the world had something different in mind.'
);
const packed = zlib.brotliCompressSync(text, {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
});
const decompress = fromFontkit('brotli/decompress.js');
const decodes = () => {
  try {
    return Buffer.from(decompress(packed, text.length)).equals(text);
  } catch {
    return false;
  }
};
const roundTrip = decodes();
const afterDecompress = loaded();

// and the stream really did reach for the dictionary: without it, it does
// not decode
const { dictionary } = standIn;
standIn.dictionary = new Uint8Array(dictionary.length);
const withoutDictionary = decodes();
standIn.dictionary = dictionary;

const { deferBrotliDictionary } = await import(${JSON.stringify(standInModule)});
console.log(JSON.stringify({
  atImport,
  roundTrip,
  afterDecompress,
  withoutDictionary,
  dictionaryLength: dictionary.length,
  again: deferBrotliDictionary(),
}));
`;

const facts = JSON.parse(
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
);

test("importing ntk does not load brotli's static dictionary", () => {
  assert.equal(
    facts.atImport,
    false,
    'dec/dictionary-data.js loaded with ntk. If brotli moved past 1.3, check ' +
      'whether it now loads the dictionary lazily itself, and if it does, ' +
      'retire lib/text/brotlidictionary.js'
  );
});

test('the first decompress loads it, and decodes with it', () => {
  assert.equal(facts.roundTrip, true, 'decodes what node:zlib encoded');
  assert.equal(facts.afterDecompress, true, 'loaded by the decompress');
  assert.equal(facts.dictionaryLength, 122784, "RFC 7932's dictionary, whole");
  assert.equal(facts.withoutDictionary, false, 'the sample needs the dictionary');
});

test('the stand-in stays out once the dictionary module is in the cache', () => {
  assert.equal(facts.again, false);
});
