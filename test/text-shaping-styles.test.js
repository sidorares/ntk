// The spans of a layout share what they are shaped with when nothing shaping
// reads differs between them (`shapingStyleOf` in lib/text/layout.js). A
// highlighted source file is a span a token — half a million for twenty
// thousand lines — over a handful of styles, and matching a font and keying
// the shaping memo once a span was most of what laying it out cost.
//
// What is asserted is the other half: that sharing never shapes a span with
// somebody else's style. Every span of a mixed layout comes out exactly as
// it does laid out on its own.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import FontManager from '../lib/text/fontmanager.js';
import { StaticFontSource } from '../lib/text/fontsource.js';
import { TextLayout } from '../lib/text/layout.js';

const require = createRequire(import.meta.url);
const katexFonts = join(dirname(require.resolve('katex/package.json')), 'dist', 'fonts');
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'MonelogicsSubset[wght].ttf');

function fonts() {
  const source = new StaticFontSource();
  source.add(readFileSync(FIXTURE), { family: 'Var' });
  source.add(readFileSync(join(katexFonts, 'KaTeX_Main-Regular.ttf')), { family: 'Main' });
  source.add(readFileSync(join(katexFonts, 'KaTeX_Main-Bold.ttf')), {
    family: 'Main',
    weight: 700
  });
  source.add(readFileSync(join(katexFonts, 'KaTeX_Main-Italic.ttf')), {
    family: 'Main',
    style: 'italic'
  });
  source.add(readFileSync(join(katexFonts, 'KaTeX_SansSerif-Regular.ttf')), { family: 'Sans' });
  source.alias('sans-serif', 'Main');
  return new FontManager({ source });
}

const STYLE = { family: 'Main', size: 16 };

/** The runs of the span marked `marker`, as what they draw: text, face,
 *  size and every glyph's place. */
function shapeOf(layout, marker) {
  return layout.lines.flatMap((line) =>
    line.runs
      .filter((r) => r.span.marker === marker)
      .map((r) => ({
        text: r.run.text,
        face: r.run.font.key,
        size: r.run.size,
        glyphs: r.run.glyphs.map((g) => [g.id, g.ax, g.dx, g.dy])
      }))
  );
}

// A span last in its paragraph loses the space it ends on, so every layout
// here ends with one more: each span is then shaped as it is mid-paragraph.
const END = { text: 'x' };

test('every span of a mixed layout is shaped as it is on its own', () => {
  const spans = [
    { text: 'ab 12 ' },
    { text: 'ab 12 ', color: 'red' },
    { text: 'ab 12 ', weight: 700 },
    { text: '123 ', family: 'Var', features: ['sups'] },
    { text: '123 ', family: 'Var' },
    { text: 'ab 12 ', letterSpacing: 3 },
    { text: 'ab 12 ', size: 24 },
    { text: 'ab 12 ', family: 'Sans' },
    { text: 'ab 12 ', style: 'italic' },
    { text: '123 ', family: 'Var', variations: { wght: 300 } },
    { text: 'ab 12 ', language: 'tr' },
    { text: 'ab 12 ', color: 'blue' }
  ].map((span, marker) => ({ ...span, marker }));
  // one manager for the mixed layout, so the shaping memo is shared as it is
  // in an app: a span shaped with another's style would find its words
  const mixed = new TextLayout(fonts(), [...spans, END], STYLE);
  for (const span of spans) {
    const alone = new TextLayout(fonts(), [span, END], STYLE);
    const expected = shapeOf(alone, span.marker);
    assert.ok(expected.length, `span ${span.marker} was drawn`);
    assert.deepEqual(shapeOf(mixed, span.marker), expected, `span ${span.marker}`);
  }
  // and the styles are not all one thing drawn twelve times
  const glyphs = (marker) => shapeOf(mixed, marker).flatMap((r) => r.glyphs);
  assert.notDeepEqual(glyphs(3), glyphs(4), 'the feature reached its span');
  assert.notDeepEqual(glyphs(5), glyphs(0), 'so did the spacing');
  assert.notDeepEqual(glyphs(2), glyphs(0), 'and the weight');
});

test('spans that differ only in what shaping never reads look their font up once', () => {
  const manager = fonts();
  const match = manager.match;
  let lookups = 0;
  manager.match = function (...args) {
    lookups++;
    return match.apply(this, args);
  };
  const spans = [];
  for (let i = 0; i < 1000; i++) {
    spans.push({ text: `w${i % 7} `, color: i % 2 ? 'red' : 'blue', marker: i });
  }
  const layout = new TextLayout(manager, spans, STYLE);
  assert.equal(lookups, 1, `${lookups} font lookups for 1000 spans of one style`);
  // each span is still its own, with its own fields
  const run = layout.lines.flatMap((line) => line.runs).find((r) => r.span.marker === 3);
  assert.equal(run.span.color, 'red');
  assert.equal(run.span.text, 'w3 ');
});

test('more styles than are shared still shape each span as its own', () => {
  const spans = [];
  for (let i = 0; i < 40; i++) spans.push({ text: 'ab ', size: 10 + i });
  const layout = new TextLayout(fonts(), spans, STYLE);
  for (const line of layout.lines) {
    for (const r of line.runs) assert.equal(r.run.size, r.span.size);
  }
  assert.equal(
    layout.lines.reduce((n, line) => n + line.runs.length, 0),
    spans.length,
    'a run a span'
  );
});

test('a span that names its face is shaped with that face', () => {
  const manager = fonts();
  const other = manager.match('Sans', {});
  const layout = new TextLayout(
    manager,
    [{ text: 'ab ' }, { text: 'ab ', font: other }, { text: 'ab ' }],
    STYLE
  );
  const faces = layout.lines.flatMap((line) => line.runs.map((r) => r.run.font.key));
  assert.equal(faces[1], other.key);
  assert.notEqual(faces[0], other.key);
  assert.equal(faces[2], faces[0]);
});
