// What shapes a run beyond its face and size: OpenType features, and letter
// spacing.
//
// Features were passed through to fontkit, and fontkit applied them — but the
// shaping memo keyed a word by face, size, weight and levels only, so a word
// shaped once plain answered every later request for it with the plain
// glyphs. `tnum` on a counter worked until the same digits had been shaped
// anywhere without it, which in an app is almost at once. The first test is
// that, in both orders, through TextLayout, which is the path that was keyed
// without them.
//
// `letterSpacing` is CSS's letter-spacing, in px: added after every glyph,
// the last on a line included, the way CoreText's kerning attribute and most
// toolkits add it. Everything a layout does with a width reads glyph
// advances, so the spacing is put there once, at shaping, and the line fill,
// the alignment, the carets and the drawing all follow from it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import FontManager from '../lib/text/fontmanager.js';
import { StaticFontSource } from '../lib/text/fontsource.js';
import { TextLayout } from '../lib/text/layout.js';

let hasFontconfig = true;
try {
  execFileSync('fc-match', ['--version'], { stdio: 'ignore' });
} catch {
  hasFontconfig = false;
}
const needsFonts = { skip: !hasFontconfig && 'fc-match not installed' };

const require = createRequire(import.meta.url);
const katexFonts = join(dirname(require.resolve('katex/package.json')), 'dist', 'fonts');
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'MonelogicsSubset[wght].ttf');

function fontsWith(bytes) {
  const source = new StaticFontSource();
  source.add(bytes, { family: 'Test' });
  source.alias('sans-serif', 'Test');
  return new FontManager({ source });
}

const glyphIds = (layout) => layout.lines[0].runs.flatMap((r) => r.run.glyphs.map((g) => g.id));

test('features take effect whatever the same text was shaped with before', () => {
  // `sups` swaps the fixture's digits for superscript glyphs
  const style = { family: 'Test', size: 16 };
  const plainFirst = fontsWith(readFileSync(FIXTURE));
  const plain = glyphIds(new TextLayout(plainFirst, [{ text: '123' }], style));
  const sups = glyphIds(new TextLayout(plainFirst, [{ text: '123', features: ['sups'] }], style));
  assert.notDeepEqual(sups, plain, 'the feature applies after a plain shape of the same word');
  assert.deepEqual(
    glyphIds(new TextLayout(plainFirst, [{ text: '123', features: { sups: true } }], style)),
    sups,
    'and the object form means the same'
  );

  const featuredFirst = fontsWith(readFileSync(FIXTURE));
  assert.deepEqual(
    glyphIds(new TextLayout(featuredFirst, [{ text: '123', features: ['sups'] }], style)),
    sups
  );
  assert.deepEqual(
    glyphIds(new TextLayout(featuredFirst, [{ text: '123' }], style)),
    plain,
    'a plain shape after a featured one is plain'
  );
  // an object that turns the feature off is a different request from one
  // that turns it on
  assert.deepEqual(
    glyphIds(new TextLayout(featuredFirst, [{ text: '123', features: { sups: true } }], style)),
    sups
  );
  assert.deepEqual(
    glyphIds(new TextLayout(featuredFirst, [{ text: '123', features: { sups: false } }], style)),
    plain
  );

  // …and now that they are keyed, the fillText path memoizes featured text
  // instead of shaping it afresh every paint
  const face = { font: featuredFirst.match('Test'), family: 'Test', size: 16, features: ['sups'] };
  assert.equal(featuredFirst._shapeCachedWhole('42', face), featuredFirst._shapeCachedWhole('42', face));
});

test('letterSpacing is added after every glyph, and a layout measures, breaks and places carets with it', () => {
  const fonts = fontsWith(readFileSync(join(katexFonts, 'KaTeX_Main-Regular.ttf')));
  const style = { family: 'Test', size: 20 };
  const plain = new TextLayout(fonts, 'abc', style);
  const spaced = new TextLayout(fonts, 'abc', { ...style, letterSpacing: 3 });
  assert.equal(spaced.width, plain.width + 9, 'three glyphs, three gaps');
  for (let i = 0; i <= 3; i++) {
    assert.equal(
      spaced.caretPosition(i).x,
      plain.caretPosition(i).x + 3 * i,
      `the caret before character ${i}`
    );
  }
  // …and the spacing is part of what shaping remembers: the plain layout
  // above, made first, did not leave its widths for the spaced one
  assert.equal(new TextLayout(fonts, 'abc', style).width, plain.width);

  // a line that fits unspaced and not spaced wraps
  const words = 'abc abc';
  const fits = new TextLayout(fonts, words, style).width + 1;
  assert.equal(new TextLayout(fonts, words, style, { maxWidth: fits }).lines.length, 1);
  assert.equal(
    new TextLayout(fonts, words, { ...style, letterSpacing: 3 }, { maxWidth: fits }).lines.length,
    2
  );
  // negative spacing tightens
  assert.equal(new TextLayout(fonts, 'abc', { ...style, letterSpacing: -1 }).width, plain.width - 3);
});

test('letterSpacing on a span spaces that span only', () => {
  const fonts = fontsWith(readFileSync(join(katexFonts, 'KaTeX_Main-Regular.ttf')));
  const style = { family: 'Test', size: 20 };
  const plain = new TextLayout(fonts, [{ text: 'ab' }, { text: 'cd' }], style);
  const spaced = new TextLayout(fonts, [{ text: 'ab' }, { text: 'cd', letterSpacing: 2 }], style);
  assert.equal(spaced.width, plain.width + 4);
});

test('letter spacing turns the optional ligatures off, unless they are asked for', needsFonts, (t) => {
  const fonts = new FontManager();
  const style = { family: 'sans-serif', size: 20 };
  const font = fonts.match('sans-serif', style);
  const glyphs = (extra) =>
    new TextLayout(fonts, [{ text: 'office', ...extra }], style).lines[0].runs.reduce(
      (n, r) => n + r.run.glyphs.length,
      0
    );
  if (glyphs({}) === 6) {
    t.skip(`${font.familyName} forms no ligature in "office"`);
    return;
  }
  assert.equal(glyphs({ letterSpacing: 1 }), 6, 'spaced: one glyph per letter');
  assert.ok(glyphs({ letterSpacing: 1, features: { liga: true } }) < 6, 'unless the style names liga');
  assert.ok(glyphs({ letterSpacing: 1, features: ['liga'] }) < 6, 'in either form');
});

test('the gap is on the right of every glyph, whichever way its run reads', () => {
  // One gap between every two neighbours on a line, as CoreText and browsers
  // set it. Opened on the reading side of an rtl run's glyphs, it came out
  // twice where the direction changed one way and not at all where it
  // changed back — WPT's css/CSS2/bidi-text/bidi-005b, #394.
  const fonts = fontsWith(readFileSync(join(katexFonts, 'KaTeX_Main-Regular.ttf')));
  const style = { family: 'Test', size: 20 };
  // `bc` under an override is an rtl run, drawn `cb`, between two ltr letters
  const text = 'a\u202Ebc\u202Cd';
  const drawn = (layout) => {
    const xs = [];
    for (const r of layout.lines[0].runs) {
      let pen = r.x;
      for (const g of r.run.glyphs) {
        if (g.ax > 0) xs.push(pen + g.dx);
        pen += g.ax;
      }
    }
    return xs;
  };
  const plain = drawn(new TextLayout(fonts, text, style));
  const spaced = drawn(new TextLayout(fonts, text, { ...style, letterSpacing: 10 }));
  assert.equal(spaced.length, 4, 'four letters');
  assert.deepEqual(
    spaced.map((x, k) => Math.round(x - plain[k])),
    [0, 10, 20, 30],
    'each a gap further along than the letter before it'
  );
});

test('a spaced line’s trailing whitespace still does not count against its width', () => {
  // The fill subtracts a token's trailing whitespace before comparing with
  // the container, and that width is worked out apart from the shaped run.
  // It has to carry the spacing too, or a line that exactly fits wraps.
  const fonts = fontsWith(readFileSync(join(katexFonts, 'KaTeX_Main-Regular.ttf')));
  const style = { family: 'Test', size: 20, letterSpacing: 5 };
  const exact = new TextLayout(fonts, 'abc abc', style).width;
  const layout = new TextLayout(fonts, 'abc abc ', style, { maxWidth: exact });
  assert.equal(layout.lines.length, 1, 'the trailing space hangs past the edge');
});

test('a combining mark takes no spacing of its own', needsFonts, (t) => {
  const fonts = new FontManager();
  const style = { family: 'sans-serif', size: 20 };
  const text = 'é';
  const run = new TextLayout(fonts, text, style).lines[0].runs[0].run;
  if (run.glyphs.length !== 2 || run.glyphs[1].ax !== 0) {
    t.skip('the matched font composes the accent into one glyph');
    return;
  }
  const plain = new TextLayout(fonts, text, style).width;
  assert.equal(new TextLayout(fonts, text, { ...style, letterSpacing: 4 }).width, plain + 4);
});

test('shaping does not write to the features object it is given', () => {
  // fontkit adds the features it plans with to the object it is handed; a
  // style's own object must come back as it went in, and a frozen one must
  // not throw
  const fonts = fontsWith(readFileSync(FIXTURE));
  const style = { family: 'Test', size: 16 };
  const features = { sups: true };
  new TextLayout(fonts, [{ text: '123', features }], style);
  assert.deepEqual(Object.keys(features), ['sups']);
  const frozen = Object.freeze({ sups: true });
  assert.doesNotThrow(() => new TextLayout(fonts, [{ text: '456', features: frozen }], style));
  const tags = Object.freeze(['sups']);
  assert.doesNotThrow(() => new TextLayout(fonts, [{ text: '789', features: tags }], style));
});
