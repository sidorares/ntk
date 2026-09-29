// `ctx.font`, the CSS font shorthand (lib/text/fontshorthand.js).
//
// canvas-fontstyle read it before, with a regular expression that allowed no
// space after a weight: `'2000px sans-serif'` was weight 200 at size 0, so
// every size from 1000px up that begins with a weight set no text. It also
// wanted the weight before the style, took no line height, and kept every
// string it was ever handed.
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';
import { parseFont, parseFontCached } from '../lib/text/fontshorthand.js';

const require = createRequire(import.meta.url);
const fontDir = join(dirname(require.resolve('katex/package.json')), 'dist', 'fonts');

const brief = (value) => {
  const f = parseFont(value);
  return f && { weight: f.weight, style: f.style, size: f.size, families: f.families };
};

test('a size is a size, however many digits it has', () => {
  for (const size of [10, 100, 999, 1000, 2000, 3000, 9000, 10000, 100000]) {
    assert.deepEqual(brief(`${size}px sans-serif`), {
      weight: 'normal',
      style: 'normal',
      size,
      families: ['sans-serif']
    });
  }
});

test('the keywords before the size come in any order, each once', () => {
  const want = { weight: 'bold', style: 'italic', size: 12, families: ['serif'] };
  assert.deepEqual(brief('bold italic 12px serif'), want);
  assert.deepEqual(brief('italic bold 12px serif'), want);
  assert.deepEqual(brief('italic small-caps bold condensed 12px serif'), want);
  assert.deepEqual(brief('ITALIC BOLD 12PX serif'), want);
  // `normal` stands for whichever is left unset
  assert.deepEqual(brief('italic normal bold 12px serif'), want);
  assert.deepEqual(brief('normal normal normal normal 12px serif').size, 12);
  assert.equal(brief('normal normal normal normal normal 12px serif'), undefined);
  assert.equal(brief('bold bold 12px serif'), undefined);
  // a weight is any number from 1 to 1000, and `oblique` may carry its angle
  assert.equal(brief('450 12px serif').weight, '450');
  assert.equal(brief('oblique 10deg 12px serif').style, 'oblique 10deg');
});

test('a line height is taken and left, as canvas leaves it', () => {
  assert.equal(brief('12px/30px Georgia, serif').size, 12);
  assert.equal(brief('italic 300 16px/1.5 serif').weight, '300');
  assert.equal(brief('16px / normal serif').size, 16);
  assert.equal(brief('16px/ serif'), undefined);
});

test('sizes in every unit, and the keywords, in pixels', () => {
  const size = (value) => brief(value).size;
  assert.equal(size('12pt serif'), 16);
  assert.equal(size('1in serif'), 96);
  assert.equal(size('1pc serif'), 16);
  assert.ok(Math.abs(size('2.54cm serif') - 96) < 1e-9);
  assert.equal(size('1e2px serif'), 100);
  // relative to the font a context starts with, 20px
  assert.equal(size('2em serif'), 40);
  assert.equal(size('150% serif'), 30);
  assert.equal(size('medium serif'), 16);
  assert.equal(size('0px serif'), 0);
  assert.equal(brief('-5px serif'), undefined);
});

test('the families: quoted or not, several words or one, all of them', () => {
  assert.deepEqual(brief('16px "Some Font", serif').families, ['Some Font', 'serif']);
  assert.deepEqual(brief("16px 'Some Font',serif").families, ['Some Font', 'serif']);
  // an unquoted name is the identifiers it is made of
  assert.deepEqual(brief('16px Times  New Roman, serif').families, ['Times New Roman', 'serif']);
  assert.equal(parseFont('16px Times New Roman').family, 'Times New Roman');
  for (const bad of ['16px', '16px 12px', '16px "unclosed', '16px ,serif', '16 serif', 'bold', '']) {
    assert.equal(brief(bad), undefined, JSON.stringify(bad));
  }
});

test('the cache does not keep every spelling it was ever handed', () => {
  // an animated size is a new string every frame
  for (let i = 0; i < 5000; i++) {
    assert.equal(parseFontCached(`${10 + i / 100}px sans-serif`).size, 10 + i / 100);
  }
  // and what is not a font is remembered as not one
  assert.equal(parseFontCached('nonsense'), undefined);
  assert.equal(parseFontCached('nonsense'), undefined);
});

// --- on a context --------------------------------------------------------

let app = null;

before(async () => {
  const server = xserver.createServer({ width: 200, height: 200 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const source = new StaticFontSource();
  source.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), { family: 'Test Main' });
  source.alias('sans-serif', 'Test Main');
  app = await createClient({ stream: clientEnd, fontSource: source });
});

after(async () => {
  if (app) await app.close();
});

function context() {
  return app.createPixmap({ width: 40, height: 40, depth: 24 }).getContext('2d');
}

test('ctx.font takes a size of two thousand pixels', () => {
  const ctx = context();
  ctx.font = '20px sans-serif';
  const small = ctx.measureText('W').width;
  ctx.font = '2000px sans-serif';
  assert.equal(ctx.font, '2000px sans-serif');
  assert.ok(Math.abs(ctx.measureText('W').width - small * 100) < 1, 'a hundred times the 20px W');
});

test('ctx.font keeps the font it had for one it cannot read', () => {
  const ctx = context();
  ctx.font = 'italic 300 16px/1.5 sans-serif';
  assert.equal(ctx.font, 'italic 300 16px/1.5 sans-serif');
  const width = ctx.measureText('W').width;
  ctx.font = '16px 12px';
  assert.equal(ctx.font, 'italic 300 16px/1.5 sans-serif');
  assert.equal(ctx.measureText('W').width, width);
});

test('a style that is not a string, or a line height that is not a number, sets text anyway', () => {
  const plain = app.fonts.layout([{ text: 'Hello', family: 'sans-serif', size: 20 }], {
    family: 'sans-serif',
    size: 20
  });
  // a style of 7 threw from the face matching; a line height of '24px'
  // made every line NaN pixels tall
  const odd = app.fonts.layout([{ text: 'Hello', family: 'sans-serif', size: 20, style: 7 }], {
    family: 'sans-serif',
    size: 20,
    style: 7
  });
  assert.equal(odd.width, plain.width);
  const tall = app.fonts.layout([{ text: 'Hello', family: 'sans-serif', size: 20 }], { family: 'sans-serif', size: 20 }, {
    lineHeight: '24px'
  });
  assert.equal(tall.height, plain.height, "the font's own line height");
  const numeric = app.fonts.layout([{ text: 'Hello', family: 'sans-serif', size: 20 }], { family: 'sans-serif', size: 20 }, {
    lineHeight: '2'
  });
  assert.ok(numeric.height > plain.height * 1.5, 'a numeric string is still a multiplier');
});
