// What a text layout reads from a face, read once — and the bidi pass a
// layout makes, skipped for text nothing can reverse. A long document's
// relayout spent most of its time asking fontkit for the space glyph once a
// word, for the face's metrics once a run, and running UAX#9 over paragraphs
// with no right-to-left character in them.
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import bidiFactory from 'bidi-js';
import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';
import Font from '../lib/text/font.js';
import { embeddingLevels } from '../lib/text/shape.js';

const { createServer, createStreamPair } = xserver;
const require = createRequire(import.meta.url);
const fontDir = join(dirname(require.resolve('katex/package.json')), 'dist', 'fonts');
const MAIN = readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf'));
const bidi = bidiFactory();

let server = null;
let app = null;

before(async () => {
  server = createServer({ width: 200, height: 200 });
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);
  const source = new StaticFontSource();
  source.add(MAIN, { family: 'Test Main' });
  source.alias('sans-serif', 'Test Main');
  app = await createClient({ stream: clientEnd, fontSource: source });
});

after(async () => {
  if (app) await app.close();
});

test('metrics are the face’s, in a new object each time', () => {
  const font = Font.fromData(MAIN);
  const fk = font.fk;
  for (const size of [10, 13, 16.5, 32]) {
    const s = size / fk.unitsPerEm;
    const m = font.metrics(size);
    assert.equal(m.ascent, fk.ascent * s);
    assert.equal(m.descent, -fk.descent * s);
    assert.equal(m.lineGap, fk.lineGap * s);
    assert.equal(m.lineHeight, fk.ascent * s + -fk.descent * s + fk.lineGap * s);
    assert.equal(m.capHeight, fk.capHeight * s);
    assert.equal(m.xHeight, fk.xHeight * s);
    // a caller may keep the object or change it
    m.lineHeight = -1;
    assert.notEqual(font.metrics(size).lineHeight, -1);
  }
  assert.equal(font.scale(20), 20 / fk.unitsPerEm);
});

test('the space a line ends with is looked up once a face, not once a word', () => {
  const words = Array.from({ length: 400 }, (_, i) => `word${i % 13}`).join(' ') + ' ';
  const font = app.fonts.match('sans-serif', { size: 14 });
  const fk = font.fk;
  const expected = fk.glyphForCodePoint(0x20).advanceWidth * font.scale(14);
  assert.equal(font.spaceAdvance(14), expected);
  const inner = fk.glyphForCodePoint;
  let asked = 0;
  fk.glyphForCodePoint = function (cp) {
    if (cp === 0x20) asked++;
    return inner.call(this, cp);
  };
  try {
    for (const width of [120, 160, 200, 240]) {
      app.fonts.layout([{ text: words }], { family: 'sans-serif', size: 14 }, { maxWidth: width });
    }
  } finally {
    fk.glyphForCodePoint = inner;
  }
  // shaping asks for it too, once for each distinct word it has not shaped
  // before — thirteen words, with and without their space — and not again:
  // it was once for every word each layout ended with a space, 1,600 here
  assert.ok(asked <= 26, `the space glyph was asked for ${asked} times`);
});

test('text nothing can reverse is level 0 without the bidi pass, and the rest takes it', () => {
  const same = (text, direction) => {
    const ours = embeddingLevels(text, direction);
    const explicit = direction === 'ltr' || direction === 'rtl' ? direction : null;
    const theirs = bidi.getEmbeddingLevels(text, explicit);
    assert.deepEqual([...ours.levels], [...theirs.levels], `levels of ${JSON.stringify(text)}`);
    assert.equal(
      ours.paragraphs[0]?.level ?? 0,
      theirs.paragraphs[0]?.level ?? 0,
      `base level of ${JSON.stringify(text)}`
    );
  };
  // no right-to-left anywhere: the short cut
  for (const text of [
    '',
    'plain words, and 42 digits.',
    'two\nparagraphs and a third',
    'CJK 漢字 かな 한글 and emoji 🙂 and math ∑',
    'café with a combining mark, and a non breaking space'
  ]) {
    for (const direction of ['auto', 'ltr']) same(text, direction);
  }
  // …and everything that can reverse, or raise a level: the full pass
  for (const text of [
    'Hebrew: שלום',
    'Arabic: مرحبا',
    'Arabic digits: ١٢٣',
    'an RLM ‏ here',
    'an LRE ‪embedded‬ run',
    'an isolate ⁧inside⁩ it',
    'Phoenician: 𐤀𐤁',
    'a presentation form יִ'
  ]) {
    for (const direction of ['auto', 'ltr', 'rtl']) same(text, direction);
  }
  // an explicit rtl paragraph is never the short cut, whatever it holds
  for (const text of ['plain words', '42']) same(text, 'rtl');
});
