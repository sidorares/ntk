// A paragraph's layout up to the line fill, kept by the font manager and
// shared by its layouts at other widths (text/paragraphs.js). What that
// promises is checked against a font manager that keeps nothing: every
// layout of every paragraph, at every width and with every option, has to
// come out the same — its lines, their runs and spans, where each caret
// goes and what a point hits.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import FontManager from '../lib/text/fontmanager.js';
import { StaticFontSource } from '../lib/text/fontsource.js';
import { TextLayout } from '../lib/text/layout.js';
import { PARAGRAPH_MIN_CHARS, ParagraphCache } from '../lib/text/paragraphs.js';

const require = createRequire(import.meta.url);
const katexFonts = join(dirname(require.resolve('katex/package.json')), 'dist', 'fonts');
const fontBytes = (file) => readFileSync(join(katexFonts, file));

function manager() {
  const source = new StaticFontSource();
  for (const file of ['KaTeX_Main-Regular.ttf', 'KaTeX_Main-Bold.ttf', 'KaTeX_Main-Italic.ttf']) {
    source.add(fontBytes(file), { family: 'Test' });
  }
  source.alias('sans-serif', 'Test');
  return new FontManager({ source });
}

/** A font manager whose layouts all start from nothing. */
function keepsNothing() {
  const fonts = manager();
  fonts._paragraphs = null;
  return fonts;
}

const PARAGRAPHS = {
  plain: 'A paragraph of plain words, long enough to wrap at every width below and then some.',
  spans: [
    { text: 'Spans in ' },
    { text: 'bold', weight: 700 },
    { text: ' and ', color: '#c00' },
    { text: 'italic', style: 'italic' },
    { text: ', spaced', letterSpacing: 2 },
    { text: ' and bigger', size: 22 },
    { text: ' and a link', href: 'https://example.test', color: '#06c' }
  ],
  breaks: 'First line\nsecond line after a hard break\n\nand a paragraph after a blank one',
  unbroken: 'https://example.test/a/very/long/path/with/no/break/opportunity/anywhere/in/it',
  rtl: 'שלום עולם, זו פסקה שנשברת לכמה שורות',
  mixed: 'Mixed text: שלום עולם in the middle of an English sentence, 123 numbers too.',
  spaces: '   leading and trailing whitespace   ',
  empty: [],
  blank: ''
};

const OPTIONS = [];
for (const maxWidth of [undefined, 400, 160, 60, 7]) {
  for (const align of [undefined, 'center', 'right', 'end']) OPTIONS.push({ maxWidth, align });
}
OPTIONS.push({ maxWidth: 160, lineHeight: 1.5 });
OPTIONS.push({ maxWidth: 160, maxLines: 2 });
OPTIONS.push({ maxWidth: 160, maxLines: 2, overflow: 'ellipsis' });
OPTIONS.push({ maxWidth: 160, direction: 'rtl' });
OPTIONS.push({ maxWidth: 160, direction: 'auto' });

const BASE = { family: 'sans-serif', size: 15, color: '#111' };
// what makes a paragraph long enough to keep (`PARAGRAPH_MIN_CHARS`)
const LONG = ', and then enough words after them to make a paragraph worth keeping';

/** Everything a layout says, with a face named rather than compared by object. */
function summary(layout, text) {
  const spanOf = (span) => {
    const out = {};
    for (const [name, value] of Object.entries(span)) {
      out[name] = name === 'font' ? value?.postscriptName : value;
    }
    return out;
  };
  const cps = [...text].length;
  const carets = [];
  for (let i = 0; i <= cps; i++) carets.push(layout.caretPosition(i));
  const hits = [];
  for (let y = 2; y < layout.height; y += 7) {
    for (let x = -5; x < layout.width + 10; x += 11) hits.push(layout.indexAt(x, y));
  }
  return {
    width: layout.width,
    height: layout.height,
    truncated: layout.truncated,
    baseLevel: layout.baseLevel,
    lines: layout.lines.map((line) => ({
      x: line.x,
      y: line.y,
      width: line.width,
      height: line.height,
      baseline: line.baseline,
      ascent: line.ascent,
      descent: line.descent,
      start: line.start,
      end: line.end,
      runs: line.runs.map((r) => ({
        x: r.x,
        width: r.width,
        start: r.start,
        end: r.end,
        ellipsis: r.ellipsis === true,
        level: r.run.level,
        direction: r.run.direction,
        glyphs: r.run.glyphs.map((g) => [g.id, g.ax, g.dx, g.dy, [...g.codePoints]]),
        span: spanOf(r.span)
      }))
    })),
    carets,
    hits
  };
}

const textOf = (content) => (typeof content === 'string' ? content : content.map((s) => s.text).join(''));
// a caller's spans as a re-render hands them over: equal, and new objects
const fresh = (content) => (typeof content === 'string' ? `${content}` : content.map((s) => ({ ...s })));

test('a layout from a kept paragraph is the layout a fresh one makes', () => {
  const keeping = manager();
  const plain = keepsNothing();
  for (const [name, content] of Object.entries(PARAGRAPHS)) {
    for (const options of OPTIONS) {
      // every width after the first lays out from the paragraph kept then
      const kept = keeping.layout(fresh(content), { ...BASE }, options);
      const alone = plain.layout(fresh(content), { ...BASE }, options);
      assert.deepEqual(
        summary(kept, textOf(content)),
        summary(alone, textOf(content)),
        `${name} ${JSON.stringify(options)}`
      );
    }
  }
});

test('the width-independent work is done once a paragraph, and every time for short text', () => {
  const fonts = manager();
  const prepare = TextLayout.prototype._prepare;
  let prepared = 0;
  TextLayout.prototype._prepare = function (...args) {
    prepared++;
    return prepare.apply(this, args);
  };
  try {
    for (const maxWidth of [600, 480, 360, 240, 120]) {
      for (const content of Object.values(PARAGRAPHS)) fonts.layout(fresh(content), { ...BASE }, { maxWidth });
    }
  } finally {
    TextLayout.prototype._prepare = prepare;
  }
  const long = Object.values(PARAGRAPHS).filter((c) => textOf(c).length >= PARAGRAPH_MIN_CHARS).length;
  const short = Object.keys(PARAGRAPHS).length - long;
  assert.ok(long >= 4 && short >= 4, 'both kinds are asked for');
  assert.equal(prepared, long + short * 5, 'a long paragraph once, a short one at every width');
});

test('a span that differs anywhere is another paragraph, and its runs say so', () => {
  const fonts = manager();
  const link = (fields) => [{ text: 'Read ' }, { text: 'the docs', ...fields }, { text: ' first' + LONG }];
  const target = (layout) => layout.lines.flatMap((l) => l.runs).find((r) => r.span.text === 'the docs').span;
  fonts.layout(link({ href: 'a' }), BASE, { maxWidth: 300 });
  const variants = [
    [{ href: 'b' }, (span) => span.href === 'b'],
    [{ href: 'a', color: '#f00' }, (span) => span.href === 'a' && span.color === '#f00'],
    [{ href: 'a', visited: true }, (span) => span.visited === true],
    [{ href: 'a', visited: undefined }, (span) => 'visited' in span],
    [{ href: 'a', features: { liga: false } }, (span) => span.features?.liga === false]
  ];
  for (const [fields, holds] of variants) {
    const span = target(fonts.layout(link(fields), BASE, { maxWidth: 300 }));
    assert.ok(holds(span), JSON.stringify(fields));
  }
  // the base style counts too
  const red = fonts.layout(link({ href: 'a' }), { ...BASE, color: '#f00' }, { maxWidth: 300 });
  assert.equal(red.lines[0].runs[0].span.color, '#f00');
});

test('what a caller does to its spans afterwards changes nothing it laid out', () => {
  // A kept paragraph is found by copies of the spans it was made from. Were
  // it found by the caller's own objects, a span changed after the call would
  // be the one the next lookup compared against — and a bold paragraph would
  // answer for the regular one the caller now asks about.
  const fonts = manager();
  const spans = [{ text: 'Before ' }, { text: 'the change', weight: 700 }, { text: LONG }];
  const bold = fonts.layout(spans, BASE, { maxWidth: 300 });
  spans[1].weight = 400;
  const regular = fonts.layout([{ text: 'Before ' }, { text: 'the change', weight: 400 }, { text: LONG }], BASE, {
    maxWidth: 300
  });
  // a span is a run per word it holds, so the set of weights is what compares
  const weights = (layout) => [...new Set(layout.lines.flatMap((l) => l.runs.map((r) => r.span.weight)))];
  assert.deepEqual(weights(regular), [undefined, 400]);
  assert.ok(regular.width < bold.width, 'laid out regular, not as the bold one kept before');
  // and the same list, its text changed in place: its key is the one the
  // list was first laid out under, which can lose the paragraph but not
  // find another's
  spans[1].text = 'another thing';
  const again = fonts.layout(spans, BASE, { maxWidth: 300 });
  assert.equal(again.lines.flatMap((l) => l.runs.map((r) => r.run.text)).join(''), 'Before another thing' + LONG);
});

test('loading a face drops the kept paragraphs, whose spans hold the faces matched before', () => {
  const fonts = manager();
  const text = 'Some text' + LONG;
  fonts.layout(text, BASE, { maxWidth: 200 });
  // booleans, not the paragraph: a failed comparison would print its
  // tokens, and through them every face they were shaped with
  assert.ok(fonts._paragraphs.find(text, undefined, text, BASE) !== undefined, 'kept');
  fonts.load(fontBytes('KaTeX_Main-Bold.ttf'), { family: 'Late' });
  assert.ok(fonts._paragraphs.find(text, undefined, text, BASE) === undefined, 'dropped by the load');
});

test('two generations of characters are kept, and what neither used is dropped', () => {
  const cache = new ParagraphCache(30);
  const style = {};
  const keep = (text) => cache.keep(text, undefined, text, style, { text });
  const kept = (text) => cache.find(text, undefined, text, style) !== undefined;
  keep('first paragraph');
  keep('second one here');
  // 32 characters with their separators: the second began a new generation
  assert.ok(kept('first paragraph'), 'the generation before is still asked');
  keep('a third, longer paragraph');
  keep('and a fourth');
  assert.ok(!kept('second one here'), 'two generations on, it is gone');
  assert.ok(kept('and a fourth'));
});
