import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';

import { charsetHas } from '../lib/fontconfig.js';
import Font from '../lib/text/font.js';
import FontManager from '../lib/text/fontmanager.js';
import { StaticFontSource } from '../lib/text/fontsource.js';
import { encodeGlyphItems } from '../lib/text/glyphs.js';
import { TextLayout } from '../lib/text/layout.js';
import { reorderRuns, shapeText } from '../lib/text/shape.js';

let hasFontconfig = true;
try {
  execFileSync('fc-match', ['--version'], { stdio: 'ignore' });
} catch {
  hasFontconfig = false;
}
const needsFonts = { skip: !hasFontconfig && 'fc-match not installed' };

// A FontManager that needs no fontconfig, on the .ttf files katex ships —
// the same trick test/fontsource.test.js uses. Elision is mostly arithmetic
// over shaped widths, so it can be tested without asking what fonts the host
// happens to have; only the bidi cases below need real script coverage.
const require = createRequire(import.meta.url);
const katexFonts = join(dirname(require.resolve('katex/package.json')), 'dist', 'fonts');
const fontBytes = (file) => readFileSync(join(katexFonts, file));

function fixedFonts(files = ['KaTeX_Main-Regular.ttf']) {
  const source = new StaticFontSource();
  for (const file of files) source.add(fontBytes(file), { family: 'Test' });
  source.alias('sans-serif', 'Test');
  return new FontManager({ source });
}

// ---------- pure: CompositeGlyphs elt encoder ----------

test('encoder: unkerned run costs one elt', () => {
  const items = [];
  for (let i = 0; i < 10; i++) items.push({ gs: 7, lid: i, adv: 12, x: 5 + i * 12, y: 40 });
  const enc = encodeGlyphItems(items, 8);
  assert.equal(enc.gsid, 7);
  assert.equal(enc.elts.length, 1);
  assert.deepEqual(enc.elts[0].slice(0, 2), [5, 40]);
  assert.equal(enc.elts[0][2].length, 10);
});

test('encoder: kerning deviation opens exactly one new elt', () => {
  const items = [];
  let x = 0;
  for (let i = 0; i < 6; i++) {
    if (i === 3) x -= 2; // kern pair
    items.push({ gs: 1, lid: i, adv: 10, x, y: 0 });
    x += 10;
  }
  const enc = encodeGlyphItems(items, 8);
  assert.equal(enc.elts.length, 2);
  assert.deepEqual(enc.elts[1].slice(0, 2), [-2, 0]);
});

test('encoder: glyphset switch entries appear between runs', () => {
  const items = [
    { gs: 1, lid: 0, adv: 10, x: 0, y: 0 },
    { gs: 1, lid: 1, adv: 10, x: 10, y: 0 },
    { gs: 2, lid: 0, adv: 10, x: 20, y: 0 }
  ];
  const enc = encodeGlyphItems(items, 8);
  assert.equal(enc.gsid, 1);
  assert.equal(enc.elts.length, 3); // [glyphs], switch, [glyphs]
  assert.equal(enc.elts[1], 2);
  // pen carries across the switch: second elt needs no correction
  assert.deepEqual(enc.elts[2].slice(0, 2), [0, 0]);
});

test('encoder: elts split at 254 glyphs', () => {
  const items = [];
  for (let i = 0; i < 300; i++) items.push({ gs: 1, lid: i % 200, adv: 5, x: i * 5, y: 0 });
  const enc = encodeGlyphItems(items, 8);
  assert.equal(enc.elts.length, 2);
  assert.equal(enc.elts[0][2].length, 254);
  assert.equal(enc.elts[1][2].length, 46);
});

test('encoder: empty input', () => {
  assert.equal(encodeGlyphItems([], 8), null);
});

// ---------- pure: bidi run reordering (UAX#9 L2) ----------

test('reorderRuns reverses rtl sequences', () => {
  const runs = [{ level: 0, id: 'a' }, { level: 1, id: 'b' }, { level: 1, id: 'c' }, { level: 0, id: 'd' }];
  assert.deepEqual(
    reorderRuns(runs).map((r) => r.id),
    ['a', 'c', 'b', 'd']
  );
});

test('reorderRuns handles nested levels', () => {
  // "he SAYS 123 ok" style: ltr inside rtl inside ltr
  const runs = [{ level: 1, id: 'A' }, { level: 2, id: 'n' }, { level: 1, id: 'B' }];
  assert.deepEqual(
    reorderRuns(runs).map((r) => r.id),
    ['B', 'n', 'A']
  );
});

// ---------- pure: fontconfig charset parsing ----------

test('charsetHas parses fontconfig range format', () => {
  const c = { charset: '20-7e a0-ff 131 1e00-1eff', _ranges: null };
  assert.equal(charsetHas(c, 0x41), true);
  assert.equal(charsetHas(c, 0x131), true);
  assert.equal(charsetHas(c, 0x130), false);
  assert.equal(charsetHas(c, 0x1e45), true);
  assert.equal(charsetHas(c, 0x2603), false);
});

// ---------- shaping with real fonts ----------

test('shapeText produces positioned glyphs and applies kerning', needsFonts, () => {
  const fonts = new FontManager();
  const font = fonts.match('serif');
  const size = 32;
  const shaped = shapeText(fonts, 'Hello', { font, size });
  assert.equal(shaped.runs.length, 1);
  assert.equal(shaped.runs[0].glyphs.length, 5);
  assert.ok(shaped.width > size, `width ${shaped.width}`);
  // sum of advances equals run width
  const sum = shaped.runs[0].glyphs.reduce((w, g) => w + g.ax, 0);
  assert.ok(Math.abs(sum - shaped.width) < 1e-6);
});

test('shapeText splits mixed-direction text into level runs', needsFonts, () => {
  const fonts = new FontManager();
  const shaped = shapeText(fonts, 'abc عرب xyz', { family: 'sans-serif', size: 16 });
  assert.ok(shaped.runs.length >= 3, `got ${shaped.runs.length} runs`);
  const levels = shaped.runs.map((r) => r.level & 1);
  assert.ok(levels.includes(1), 'has an rtl run');
  assert.ok(levels.includes(0), 'has ltr runs');
  // logical order preserved in .runs
  assert.equal(shaped.runs[0].text.trim(), 'abc');
});

test('font fallback picks a covering font for unsupported scripts', needsFonts, (t) => {
  const fonts = new FontManager();
  const base = fonts.match('Times New Roman');
  if (base.hasGlyph(0x4e16)) return t.skip('base font covers CJK');
  const fallback = fonts.fallbackFor(0x4e16, 'Times New Roman', {});
  if (!fallback) return t.skip('no CJK font installed');
  assert.ok(fallback.hasGlyph(0x4e16));
  const shaped = shapeText(fonts, 'a 世 b', { font: base, family: 'Times New Roman', size: 16 });
  const fontsUsed = new Set(shaped.runs.map((r) => r.font.key));
  assert.ok(fontsUsed.size >= 2, 'fallback font used for CJK char');
});

// ---------- layout ----------

test('TextLayout wraps to maxWidth and never overflows', needsFonts, () => {
  const fonts = new FontManager();
  const layout = new TextLayout(
    fonts,
    'one two three four five six seven eight nine ten eleven twelve',
    { family: 'sans-serif', size: 16 },
    { maxWidth: 160 }
  );
  assert.ok(layout.lines.length > 1);
  for (const line of layout.lines) {
    assert.ok(line.width <= 160 + 0.5, `line ${line.width} overflows`);
  }
  assert.ok(layout.height >= layout.lines.length * 10);
});

test('TextLayout honors explicit newlines', needsFonts, () => {
  const fonts = new FontManager();
  const layout = new TextLayout(fonts, 'a\nb\n\nc', { family: 'sans-serif', size: 16 }, {});
  assert.equal(layout.lines.length, 4);
  assert.equal(layout.lines[2].runs.length, 0); // blank paragraph
});

test('TextLayout copes with an empty span list', needsFonts, () => {
  const fonts = new FontManager();
  // A document view hands over an empty span list for a blank block, which
  // happens while one is being typed — every line still needs a style to
  // take its metrics from, and this used to throw on the first one
  // ("undefined is not an object (evaluating 'baseSpan.font')")
  const layout = new TextLayout(fonts, [], { family: 'sans-serif', size: 16 }, {});
  assert.equal(layout.lines.length, 1);
  assert.equal(layout.lines[0].runs.length, 0);
  assert.ok(layout.height > 0, 'the empty line still has the base line height');
});

test('TextLayout strips trailing whitespace at line ends', needsFonts, () => {
  const fonts = new FontManager();
  const wrapped = new TextLayout(
    fonts,
    'aaaa bbbb',
    { family: 'sans-serif', size: 16 },
    { maxWidth: 45 }
  );
  assert.equal(wrapped.lines.length, 2);
  const single = new TextLayout(fonts, 'aaaa', { family: 'sans-serif', size: 16 }, {});
  // first line width equals the bare word width (no trailing space)
  assert.ok(Math.abs(wrapped.lines[0].width - single.lines[0].width) < 0.01);
});

test('a no-break space a line ends on keeps its room; spaces and tabs hang', () => {
  // CSS hangs the spaces and tabs left at a line's end. U+00A0 is not one of
  // them — `&nbsp;` at the end of a cell or a span is there to take room —
  // and it was stripped with them, #395.
  const fonts = fixedFonts();
  const style = { family: 'Test', size: 20 };
  const width = (text) => new TextLayout(fonts, text, style).lines[0].width;
  const nbsp = width('x\u00a0x') - 2 * width('x');
  assert.ok(nbsp > 0, 'the face has a no-break space');
  assert.ok(Math.abs(width('x\u00a0') - (width('x') + nbsp)) < 0.01, 'measured where it ends a line');
  assert.equal(width('x '), width('x'), 'where a space hangs');
  assert.equal(width('x\t'), width('x'), 'and a tab');
});

test('TextLayout force-breaks tokens wider than the container', needsFonts, () => {
  const fonts = new FontManager();
  const layout = new TextLayout(
    fonts,
    'Pneumonoultramicroscopicsilicovolcanoconiosis',
    { family: 'sans-serif', size: 20 },
    { maxWidth: 90 }
  );
  assert.ok(layout.lines.length > 1);
  for (const line of layout.lines) {
    assert.ok(line.width <= 90.5, `line ${line.width}`);
  }
});

test("overflowWrap: 'normal' keeps a word wider than the line whole", needsFonts, () => {
  // CSS's overflow-wrap: normal — a long URL runs past its box instead of
  // being cut inside itself — on a line of its own, with the words around
  // it wrapping as they would
  const fonts = new FontManager();
  const word = 'Pneumonoultramicroscopicsilicovolcanoconiosis';
  const style = { family: 'sans-serif', size: 20 };
  const alone = new TextLayout(fonts, word, style, {
    maxWidth: 90,
    overflowWrap: 'normal'
  });
  assert.equal(alone.lines.length, 1, 'one line');
  assert.ok(alone.lines[0].width > 90, `past the line's end: ${alone.lines[0].width}`);
  const around = new TextLayout(fonts, `a ${word} b`, style, {
    maxWidth: 90,
    overflowWrap: 'normal'
  });
  assert.equal(around.lines.length, 3, 'a line before it and one after');
  const [before, middle, after] = around.lines;
  assert.deepEqual(
    [around._text.slice(before.start, before.end).trim(), around._text.slice(middle.start, middle.end).trim(), around._text.slice(after.start, after.end).trim()],
    ['a', word, 'b']
  );
  // and the default still cuts it
  const cut = new TextLayout(fonts, word, style, { maxWidth: 90 });
  assert.ok(cut.lines.length > 1);
  // as does 'normal', where the word is a phrase in a script written
  // without spaces: the breaker found no words in it to break between
  const thai = new TextLayout(fonts, 'ภาษาไทยเขียนติดกันโดยไม่เว้นวรรคระหว่างคำ', style, {
    maxWidth: 90,
    overflowWrap: 'normal'
  });
  assert.ok(thai.lines.length > 1, 'Thai falls back to cutting');
  assert.ok(thai.lines.every((line) => line.width <= 90 + 0.5));
});

test('spans that share nowrap have no break inside them or between them', needsFonts, () => {
  // CSS's white-space: nowrap on an element: a hyphenated word in one does
  // not break at its hyphens, and the break between two such elements, or
  // after one, is the paragraph's
  const fonts = new FontManager();
  const style = { family: 'sans-serif', size: 16 };
  const texts = (layout) => layout.lines.map((l) => layout._text.slice(l.start, l.end).trim());
  const word = 'state-of-the-art';
  const room = new TextLayout(fonts, word, style, {}).width + 2;
  const spans = (nowrap) => [{ text: 'a ' }, { text: word, nowrap }, { text: ' design' }];
  const free = texts(new TextLayout(fonts, spans(undefined), style, { maxWidth: room }));
  assert.ok(
    free.some((line) => line.endsWith('-')),
    `a hyphen ends a line without it: ${JSON.stringify(free)}`
  );
  const held = texts(new TextLayout(fonts, spans(true), style, { maxWidth: room }));
  assert.ok(held.includes(word), `the word whole: ${JSON.stringify(held)}`);
  // two groups may break between them, at the space the first ends on
  const a = {};
  const b = {};
  const two = (x, y) => [
    { text: 'alpha-beta ', nowrap: x },
    { text: 'gamma-delta', nowrap: y }
  ];
  const width = new TextLayout(fonts, 'gamma-delta', style, {}).width + 2;
  const apart = texts(new TextLayout(fonts, two(a, b), style, { maxWidth: width }));
  assert.deepEqual(apart, ['alpha-beta', 'gamma-delta']);
  // one group is one run of text, whatever the room
  const one = texts(
    new TextLayout(fonts, two(a, a), style, { maxWidth: width, overflowWrap: 'normal' })
  );
  assert.deepEqual(one, ['alpha-beta gamma-delta']);
});

test('wrap: false with an ellipsis cuts a line at the width, inside a word', needsFonts, () => {
  // CSS's text-overflow on text that does not wrap: the ellipsis goes where
  // the box ends, and the line is cut there, inside a word if that is where
  // it is. maxLines: 1 wrapped the text first and put the ellipsis after
  // the last word that fitted, a word short of the box's end.
  const fonts = new FontManager();
  const style = { family: 'sans-serif', size: 16 };
  const text = 'Leslie Alexander, Co-Founder and Chief Executive Officer';
  const maxWidth = 200;
  const clamp = new TextLayout(fonts, text, style, { maxWidth, maxLines: 1, overflow: 'ellipsis' });
  const cut = new TextLayout(fonts, text, style, { maxWidth, wrap: false, overflow: 'ellipsis' });
  assert.equal(cut.lines.length, 1);
  assert.ok(cut.truncated);
  assert.ok(cut.lines[0].width <= maxWidth + 0.5, `within the width: ${cut.lines[0].width}`);
  assert.ok(
    cut.lines[0].width > clamp.lines[0].width,
    `fuller than a clamp: ${cut.lines[0].width} against ${clamp.lines[0].width}`
  );
  // each line to a forced break is cut on its own, and one that fits is not
  const two = new TextLayout(fonts, `short\n${text}`, style, { maxWidth, wrap: false, overflow: 'ellipsis' });
  assert.equal(two.lines.length, 2);
  assert.ok(two.lines[1].width <= maxWidth + 0.5);
  assert.equal(two._text.slice(two.lines[0].start, two.lines[0].end).trim(), 'short');
  // with no ellipsis a line that does not wrap runs past the width whole
  const long = new TextLayout(fonts, text, style, { maxWidth, wrap: false });
  assert.equal(long.lines.length, 1);
  assert.ok(long.lines[0].width > maxWidth);
  assert.equal(long.truncated, false);
});

test('a line too long for its container starts at its start edge', needsFonts, () => {
  // CSS Text 3, 7.1: whatever the alignment, a line that does not fit runs
  // past its end edge, not its start — right-aligned, it was pushed out of
  // the container's left side, where nothing would scroll to it
  const fonts = new FontManager();
  const word = 'Pneumonoultramicroscopicsilicovolcanoconiosis';
  const style = { family: 'sans-serif', size: 20 };
  for (const align of ['right', 'center', 'end']) {
    const layout = new TextLayout(fonts, `${word} a`, style, {
      maxWidth: 90,
      overflowWrap: 'normal',
      align
    });
    assert.equal(layout.lines[0].x, 0, `${align}: the long line at the left edge`);
    assert.ok(layout.lines[1].x > 0, `${align}: the short one still aligned`);
  }
  // and in a right-to-left paragraph the start is the right edge
  const rtl = new TextLayout(fonts, word, style, {
    maxWidth: 90,
    overflowWrap: 'normal',
    align: 'left',
    direction: 'rtl'
  });
  assert.equal(rtl.lines[0].x, 90 - rtl.lines[0].width);
});

// ---------- leading ----------

test('leading is split evenly above and below the glyphs', () => {
  const fonts = fixedFonts();
  const style = { family: 'sans-serif', size: 16 };
  for (const lineHeight of [1, 1.25, 1.5, 2, 0.8, 0.5]) {
    const layout = new TextLayout(fonts, 'Hg\nHg', style, { lineHeight });
    for (const line of layout.lines) {
      const above = line.baseline - line.ascent - line.y;
      const below = line.y + line.height - (line.baseline + line.descent);
      assert.ok(
        Math.abs(above - below) < 1e-9,
        `lineHeight ${lineHeight}: ${above} above vs ${below} below`
      );
      // a multiplier too small for the glyphs overflows evenly, as in CSS
      if (lineHeight >= 1) assert.ok(above >= 0);
      else assert.ok(above < 0);
    }
  }
});

test('leading applies at lineHeight 1, because a line gap is leading too', () => {
  // the bug was visible at the default setting, not just above it: a face
  // whose natural line height exceeds ascent+descent has slack to split
  const fonts = fixedFonts();
  const style = { family: 'sans-serif', size: 16 };
  const m = fonts.match('sans-serif').metrics(16);
  assert.ok(m.lineGap > 0, 'precondition: this face has a line gap');
  const line = new TextLayout(fonts, 'Hg', style, {}).lines[0];
  assert.ok(line.baseline - line.ascent > 0, 'glyphs are not pinned to the box top');
  assert.ok(Math.abs(line.baseline - line.ascent - m.lineGap / 2) < 1e-9);
});

test('the line box still tiles the layout height exactly', () => {
  const fonts = fixedFonts();
  const style = { family: 'sans-serif', size: 16 };
  for (const lineHeight of [1, 1.4]) {
    const layout = new TextLayout(fonts, 'one\ntwo\nthree', style, { lineHeight });
    assert.equal(layout.lines.length, 3);
    let y = 0;
    for (const line of layout.lines) {
      assert.equal(line.y, y, 'line boxes are contiguous, with no gap or overlap');
      y += line.height;
    }
    assert.equal(layout.height, y);
  }
});

test('a single line sits centred in a box measured from layout.height', () => {
  // the reported symptom: text rides high in any box sized from the layout
  const fonts = fixedFonts();
  const layout = new TextLayout(fonts, 'Hg', { family: 'sans-serif', size: 16 }, { lineHeight: 1.5 });
  const line = layout.lines[0];
  const above = line.baseline - line.ascent;
  const below = layout.height - (line.baseline + line.descent);
  assert.ok(Math.abs(above - below) < 1e-9, `${above} above vs ${below} below`);
  assert.ok(above > 1, 'precondition: there is real leading to distribute');
});

test('the caret box is the glyph band, centred in the line box', () => {
  const fonts = fixedFonts();
  const layout = new TextLayout(fonts, 'Hg', { family: 'sans-serif', size: 16 }, { lineHeight: 2 });
  const line = layout.lines[0];
  const caret = layout.caretPosition(0);
  assert.equal(caret.y, line.baseline - line.ascent);
  assert.equal(caret.height, line.ascent + line.descent);
  assert.ok(caret.y > line.y, 'the caret starts below the line box top');
  assert.ok(caret.y + caret.height < line.y + line.height, 'and ends above its bottom');
});

test('hit testing still uses the whole line box', () => {
  // clicking in the leading belongs to that line, not to a gap between lines
  const fonts = fixedFonts();
  const layout = new TextLayout(fonts, 'one\ntwo', { family: 'sans-serif', size: 16 }, { lineHeight: 2 });
  const second = layout.lines[1];
  assert.equal(layout.caretPosition(layout.indexAt(0, second.y + 0.5)).line, 1);
  assert.equal(layout.caretPosition(layout.indexAt(0, second.y + second.height - 0.5)).line, 1);
});

// ---------- maxLines / ellipsis ----------

const LONG = 'one two three four five six seven eight nine ten eleven twelve';
const ELIDE = { maxWidth: 160, maxLines: 2, overflow: 'ellipsis' };
const marker = (line) => line.runs.find((r) => r.ellipsis);

// What a line actually shows, taken from its logical range rather than from
// the runs: a run's `text` is the whole shaped segment even after trailing
// whitespace is stripped from its glyphs, and rtl runs hold glyphs in visual
// order, so reading either back would misreport what was drawn.
const visible = (layout, i) => layout._text.slice(layout.lines[i].start, layout.lines[i]._contentEnd);

test('maxLines caps the lines, and the height with them', () => {
  const fonts = fixedFonts();
  const full = new TextLayout(fonts, LONG, { family: 'sans-serif', size: 16 }, { maxWidth: 160 });
  assert.ok(full.lines.length > 2, 'precondition: this wraps to more than two lines');
  assert.equal(full.truncated, false);

  const capped = new TextLayout(fonts, LONG, { family: 'sans-serif', size: 16 }, { maxWidth: 160, maxLines: 2 });
  assert.equal(capped.lines.length, 2);
  assert.equal(capped.truncated, true);
  assert.ok(capped.height < full.height, 'dropped lines take their height with them');
  // 'clip' is the default: the cap alone, no marker
  assert.equal(marker(capped.lines[1]), undefined);
  assert.deepEqual(
    [visible(capped, 0), visible(capped, 1)],
    [visible(full, 0), visible(full, 1)],
    'the kept lines are untouched'
  );
});

test('maxLines that content does not reach changes nothing', () => {
  const fonts = fixedFonts();
  const style = { family: 'sans-serif', size: 16 };
  const plain = new TextLayout(fonts, LONG, style, { maxWidth: 160 });
  const roomy = new TextLayout(fonts, LONG, style, { maxWidth: 160, maxLines: 99, overflow: 'ellipsis' });
  assert.equal(roomy.truncated, false);
  assert.equal(roomy.lines.length, plain.lines.length);
  assert.equal(roomy.height, plain.height);
  assert.deepEqual(
    roomy.lines.map((_, i) => visible(roomy, i)),
    plain.lines.map((_, i) => visible(plain, i))
  );
  assert.equal(roomy.lines.some(marker), false, 'nothing was cut, so nothing is marked');
});

test('overflow: ellipsis marks the last line and still fits maxWidth', () => {
  const fonts = fixedFonts();
  const layout = new TextLayout(fonts, LONG, { family: 'sans-serif', size: 16 }, ELIDE);
  assert.equal(layout.truncated, true);
  assert.equal(layout.lines.length, 2);
  const last = layout.lines[1];
  assert.equal(marker(last).run.text, '…');
  for (const line of layout.lines) {
    assert.ok(line.width <= 160 + 0.5, `line ${line.width} overflows the container`);
  }
  // the marker is the visually last run of an ltr line, and content precedes it
  assert.equal(marker(last), last.runs[last.runs.length - 1]);
  assert.ok(visible(layout, 1).length > 0);
  // and it really did cost content: the same two lines without eliding are longer
  const clipped = new TextLayout(fonts, LONG, { family: 'sans-serif', size: 16 }, { maxWidth: 160, maxLines: 2 });
  assert.ok(visible(layout, 1).length < visible(clipped, 1).length);
});

test('single-line elision is just maxLines: 1', () => {
  const fonts = fixedFonts();
  const layout = new TextLayout(fonts, LONG, { family: 'sans-serif', size: 16 }, { maxWidth: 160, maxLines: 1, overflow: 'ellipsis' });
  assert.equal(layout.lines.length, 1);
  assert.ok(layout.lines[0].width <= 160.5);
  assert.equal(marker(layout.lines[0]).run.text, '…');
});

test('whitespace at the cut is dropped, not left in front of the ellipsis', () => {
  const fonts = fixedFonts();
  const layout = new TextLayout(fonts, LONG, { family: 'sans-serif', size: 16 }, ELIDE);
  const last = layout.lines[1];
  assert.doesNotMatch(visible(layout, 1), /\s$/);
  // trailing whitespace on an elided line has no wrap to precede, so it is
  // gone rather than extending the caret past the line edge
  assert.equal(last._trailing, null);
});

test('the ellipsis is shaped in the style of the span it cuts into', () => {
  const fonts = fixedFonts();
  const spans = [{ text: 'BIGTAILWORDS', size: 32 }, { text: ' and a tail' }];
  const layout = new TextLayout(fonts, spans, { family: 'sans-serif', size: 16 }, { maxWidth: 150, maxLines: 1, overflow: 'ellipsis' });
  const m = marker(layout.lines[0]);
  assert.equal(m.span.size, 32, 'the line was cut inside the 32px span');
  // and a line that never reaches that span gets the base style instead
  const small = new TextLayout(
    fonts,
    [{ text: 'aaaaaaaaaaaaaaaaaaaa ' }, { text: 'B', size: 32 }],
    { family: 'sans-serif', size: 16 },
    { maxWidth: 100, maxLines: 1, overflow: 'ellipsis' }
  );
  assert.equal(marker(small.lines[0]).span.size, 16);
});

test('a font without U+2026 elides with three periods instead of a .notdef box', () => {
  // Fraktur has no horizontal ellipsis, and nothing else is in this source
  const fonts = fixedFonts(['KaTeX_Fraktur-Regular.ttf']);
  assert.equal(fonts.match('sans-serif').hasGlyph(0x2026), false, 'precondition');
  assert.equal(fonts.fallbackFor(0x2026, 'sans-serif'), null, 'precondition: no fallback either');
  const layout = new TextLayout(fonts, LONG, { family: 'sans-serif', size: 16 }, { maxWidth: 160, maxLines: 1, overflow: 'ellipsis' });
  const m = marker(layout.lines[0]);
  assert.equal(m.run.text, '...');
  assert.ok(
    m.run.glyphs.every((g) => g.id !== 0),
    'the stand-in has to be drawable, which is the whole point of using it'
  );
});

test('a cut never lands inside a grapheme cluster', () => {
  const fonts = fixedFonts();
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const prefixes = (text) => {
    const out = [''];
    for (const { segment } of segmenter.segment(text)) out.push(out[out.length - 1] + segment);
    return out;
  };
  for (const text of [
    'aaaaéaaaa',
    'aa\u{1F468}‍\u{1F469}‍\u{1F466}aa',
    'नमस्ते नमस्ते',
    // a mark on the first letter is the first cluster, and a CR and the LF
    // after it are one: the ways ASCII text joins into a cluster
    'e\u0301aaaaaa',
    'aa\r\naa',
    // Latin letters and the punctuation typeset around them, which are cut
    // without a segmenter — and a mark after a dash, which is not
    'naïve—“café”…ÆØÅ',
    '—\u0301aaaaaa',
    'aa\u200d\u200caa'
  ]) {
    const valid = prefixes(text);
    for (let maxWidth = 8; maxWidth <= 120; maxWidth += 4) {
      const layout = new TextLayout(fonts, text, { family: 'sans-serif', size: 16 }, { maxWidth, maxLines: 1, overflow: 'ellipsis' });
      const kept = visible(layout, 0);
      assert.ok(
        valid.includes(kept),
        `cut ${JSON.stringify(kept)} of ${JSON.stringify(text)} at ${maxWidth} is not a grapheme boundary`
      );
    }
  }
});

test('Latin text and its punctuation are cut without a segmenter', (t) => {
  // UAX#29 joins nothing below U+0300, nor in the general punctuation block
  // but its two joiners, so cutting such text asks no segmenter — which is
  // a microsecond a word, and 10 ms for the first one made
  const fonts = fixedFonts();
  const segment = t.mock.method(Intl.Segmenter.prototype, 'segment');
  for (const text of ['naïve—“café”…', 'Æsir – ‘quoted’ ÿ']) {
    for (let maxWidth = 8; maxWidth <= 120; maxWidth += 4) {
      new TextLayout(fonts, text, { family: 'sans-serif', size: 16 }, { maxWidth, maxLines: 1, overflow: 'ellipsis' });
      new TextLayout(fonts, text, { family: 'sans-serif', size: 16 }, { maxWidth, overflowWrap: 'anywhere' });
    }
  }
  assert.equal(segment.mock.callCount(), 0);
  // …and a mark after a dash still goes to it
  new TextLayout(fonts, '—\u0301aaaaaa', { family: 'sans-serif', size: 16 }, { maxWidth: 8, maxLines: 1, overflow: 'ellipsis' });
  assert.ok(segment.mock.callCount() > 0);
});

test('the ellipsis stands for the text after it, for caret purposes', () => {
  const fonts = fixedFonts();
  const layout = new TextLayout(fonts, LONG, { family: 'sans-serif', size: 16 }, { maxWidth: 160, maxLines: 1, overflow: 'ellipsis' });
  const line = layout.lines[0];
  const m = marker(line);
  const cut = layout._cpOf(line._contentEnd);
  assert.ok(cut > 0 && cut < Array.from(LONG).length, 'precondition: something was cut');
  // clicking anywhere on the marker is the end of the visible text
  for (const frac of [0.1, 0.5, 0.9]) {
    assert.equal(layout.indexAt(m.x + m.width * frac, 2), cut);
  }
  // and an index into the dropped text clamps to that same place
  const end = layout.caretPosition(Array.from(LONG).length);
  assert.equal(end.line, 0);
  assert.equal(end.x, layout.caretPosition(cut).x);
  assert.ok(end.x <= line.width, 'the caret does not wander past the line');
});

test('an rtl paragraph puts the ellipsis on the left', () => {
  // `direction` rather than Hebrew text, so this asserts the paragraph-level
  // rule on any machine, whatever fonts it has
  const fonts = fixedFonts();
  const style = { family: 'sans-serif', size: 16 };
  const rtl = new TextLayout(fonts, LONG, style, { maxWidth: 160, maxLines: 1, overflow: 'ellipsis', direction: 'rtl' });
  assert.equal(rtl.truncated, true);
  assert.equal(rtl.baseLevel, 1);
  assert.equal(marker(rtl.lines[0]), rtl.lines[0].runs[0], 'leading edge of an rtl line is its left');
  assert.equal(marker(rtl.lines[0]).x, 0);

  // the same content with an ltr base keeps the marker on the right, so it
  // is the paragraph direction talking, not the script of the trailing run
  const ltr = new TextLayout(fonts, LONG, style, { maxWidth: 160, maxLines: 1, overflow: 'ellipsis', direction: 'ltr' });
  const line = ltr.lines[0];
  assert.equal(marker(line), line.runs[line.runs.length - 1]);
});

test('a cut inside a word keeps that word at its own bidi level', () => {
  // Regression: the force-break re-shaped its prefix at level 0 no matter
  // what level the text was, so a cut inside an rtl word produced an
  // ltr-shaped run — glyphs backwards, and an even level that stopped
  // reorderRuns from placing it. Visible as the ellipsis landing on the
  // wrong side, but wrong on master too for any force-broken rtl word.
  // Hebrew characters, so the bidi levels are genuinely odd — the test font
  // has no Hebrew glyphs and does not need any, because levels come from the
  // text and this is asserting levels, not shapes
  const fonts = fixedFonts();
  const style = { family: 'sans-serif', size: 16 };
  const unbroken = 'שלוםעולםוברוכיםהבאיםלכאןועודטקסטארוךמאוד'; // no break opportunity
  for (const opts of [
    { maxWidth: 90 }, // plain force-break, no elision: wrong on master too
    { maxWidth: 90, maxLines: 1, overflow: 'ellipsis' }
  ]) {
    const layout = new TextLayout(fonts, unbroken, style, opts);
    for (const r of layout.lines[0].runs) {
      assert.equal(r.run.level & 1, 1, `run ${JSON.stringify(r.run.text)} lost its rtl level`);
      assert.equal(r.run.direction, 'rtl');
    }
  }
  const elided = new TextLayout(fonts, unbroken, style, { maxWidth: 90, maxLines: 1, overflow: 'ellipsis' });
  assert.equal(marker(elided.lines[0]), elided.lines[0].runs[0], 'and the marker still lands on the left');
});

test('real rtl script elides on the left, at a word and mid-word', needsFonts, () => {
  const fonts = new FontManager();
  const style = { family: 'sans-serif', size: 16 };
  const opts = { maxWidth: 90, maxLines: 1, overflow: 'ellipsis' };
  for (const text of [
    'שלום עולם וברוכים הבאים לכאן', // the cut can land on a space
    'שלוםעולםוברוכיםהבאיםלכאןועודטקסט' // one long word: the cut is mid-token
  ]) {
    const layout = new TextLayout(fonts, text, style, opts);
    assert.equal(layout.truncated, true, text);
    assert.equal(marker(layout.lines[0]), layout.lines[0].runs[0], text);
    assert.equal(marker(layout.lines[0]).x, 0, text);
  }
});

test('TextLayout aligns center and right', needsFonts, () => {
  const fonts = new FontManager();
  const mk = (align) =>
    new TextLayout(fonts, 'hi', { family: 'sans-serif', size: 16 }, { maxWidth: 200, align });
  const left = mk('left');
  const center = mk('center');
  const right = mk('right');
  assert.equal(left.lines[0].x, 0);
  assert.ok(Math.abs(center.lines[0].x - (200 - center.lines[0].width) / 2) < 0.01);
  assert.ok(Math.abs(right.lines[0].x - (200 - right.lines[0].width)) < 0.01);
});

test('TextLayout styled spans produce separate runs with span colors', needsFonts, () => {
  const fonts = new FontManager();
  const layout = new TextLayout(
    fonts,
    [
      { text: 'red', color: 'red' },
      { text: ' plain ' },
      { text: 'bold', weight: 700 }
    ],
    { family: 'sans-serif', size: 16 },
    {}
  );
  const runs = layout.lines[0].runs;
  assert.ok(runs.length >= 3);
  assert.equal(runs[0].span.color, 'red');
  assert.equal(runs[runs.length - 1].span.color, null);
});

test('shaping cache reuses results across layouts', needsFonts, () => {
  const fonts = new FontManager();
  const style = { family: 'sans-serif', size: 16 };
  new TextLayout(fonts, 'repeat me repeat me', style, { maxWidth: 500 });
  const shaped = fonts._shapeCount;
  new TextLayout(fonts, 'repeat me repeat me', style, { maxWidth: 300 });
  assert.equal(fonts._shapeCount, shaped, 'relayout added no new shaping work');
});

test('shaping cache keeps what the last generation asked for, and drops the rest', () => {
  const fonts = fixedFonts();
  const style = { font: fonts.match('sans-serif'), family: 'sans-serif', size: 16 };
  const keep = fonts._shapeCached('keep', style);
  const drop = fonts._shapeCached('drop', style);
  let i = 0;
  const turn = () => {
    // fill the generation; the next word starts a new one
    while (fonts._shapeCount < 4000) fonts._shapeCached(`w${i++}`, style);
    fonts._shapeCached(`w${i++}`, style);
    assert.equal(fonts._shapeCount, 1, 'the generation turned');
  };
  turn();
  assert.equal(fonts._shapeCached('keep', style), keep, 'the generation before still answers');
  turn(); // 'drop' was asked for in neither of the two now kept
  assert.equal(fonts._shapeCached('keep', style), keep, 'asked for in the last generation: kept');
  assert.notEqual(fonts._shapeCached('drop', style), drop, 'asked for in neither: dropped');
});

test('a hit is the entry itself, and a new style object with the same fields shares it', () => {
  const fonts = fixedFonts();
  const font = fonts.match('sans-serif');
  const first = fonts._shapeCached('shared', { font, family: 'sans-serif', size: 16 });
  const count = fonts._shapeCount;
  assert.equal(fonts._shapeCached('shared', { font, family: 'sans-serif', size: 16 }), first);
  assert.equal(fonts._shapeCount, count, 'no second entry');
  assert.notEqual(
    fonts._shapeCached('shared', { font, family: 'sans-serif', size: 17 }),
    first,
    'another size is another entry'
  );
});

test('fillText-path shaping reuses the memo and keeps the paragraph level', () => {
  const fonts = fixedFonts();
  const style = { font: fonts.match('sans-serif'), family: 'sans-serif', size: 16 };
  const first = fonts._shapeCachedWhole('hello', style);
  assert.equal(fonts._shapeCachedWhole('hello', style), first, 'ltr string shapes once');
  // rtl: the memoed entry alone reads back as an even base level, and
  // start/end alignment flips for rtl strings if the paragraph level is lost
  const rtl = fonts._shapeCachedWhole('שלום', style);
  const direct = shapeText(fonts, 'שלום', style);
  assert.equal(rtl.baseLevel & 1, 1, 'rtl paragraph level preserved');
  assert.equal(rtl.baseLevel, direct.baseLevel);
  assert.equal(rtl.width, direct.width);
  assert.equal(fonts._shapeCachedWhole('שלום', style).runs, rtl.runs, 'rtl shaping still cached');
});

// ---------- markdown parser ----------

test('TextLayout: a narrow maxWidth is not a min-content probe', needsFonts, () => {
  const fonts = new FontManager();
  const style = { family: 'sans-serif', size: 16 };
  const span = { text: 'value', ...style };
  const whole = new TextLayout(fonts, [span], style, {}).width;

  // Laying a single token out at a tiny maxWidth looks like a way to measure
  // min-content, and is not one. `_forceBreak` splits a token wider than the
  // container whenever a single cluster fits, so the reported width is a
  // *fragment* — and whether a cluster fits at a given maxWidth depends on the
  // font, which is how a table column floor built on this probe came out below
  // the word it existed to protect on one machine and not another.
  //
  // The width is therefore not monotonic in maxWidth. This pins that, so the
  // probe does not come back as an obvious simplification.
  const widths = [1, 16].map(
    (maxWidth) => new TextLayout(fonts, [span], style, { maxWidth }).width
  );
  assert.equal(widths[0], whole, 'at maxWidth 1 no cluster fits, so it overflows whole');
  assert.ok(
    widths[1] < whole,
    `at maxWidth 16 the token force-breaks and reports a fragment, got ${widths[1]} of ${whole}`
  );

  // Measuring one token unconstrained is the reliable answer, and is what a
  // table column floor has to be built on.
  assert.equal(new TextLayout(fonts, [span], style, {}).width, whole);
});

test('TextLayout: at a width no cluster fits, a word is not searched for a cut', () => {
  // Width 0 is where a layout is asked for the narrowest it can be — react-x11
  // measures a column's width floor there, once a word of every paragraph.
  // Every word overflows whole, and the search for a cut used to find that
  // out by segmenting the whole word and shaping a dozen prefixes of it, each
  // a word the memo had never seen.
  const fonts = fixedFonts();
  const style = { family: 'Test', size: 16 };
  const words = ['Pneumonoultramicroscopicsilicovolcanoconiosis', 'antidisestablishment', 'x'];
  const text = words.join(' ');
  const shaped = [];
  const inner = fonts._shapeCached;
  fonts._shapeCached = function (word, ...rest) {
    shaped.push(word);
    return inner.call(this, word, ...rest);
  };
  const layout = new TextLayout(fonts, text, style, { maxWidth: 0 });
  fonts._shapeCached = inner;

  assert.deepEqual(
    layout.lines.map((line) => text.slice(line.start, line._contentEnd)),
    words,
    'a word a line, each whole'
  );
  const prefixes = shaped.filter((w) => !words.includes(w.trimEnd()));
  assert.ok(
    prefixes.length <= words.length,
    `${prefixes.length} pieces shaped to find no cut: ${prefixes.join(', ')}`
  );
});


test('TextLayout: a pair kerned across a break opportunity is kerned on a line, and not across a line break', () => {
  // Each token between break opportunities is shaped apart, so a pair
  // either side of one — Trebuchet MS kerns a space against an A — was
  // never kerned, and a line of it came out wider than a browser's. A face
  // standing in for it here: its space and an A set 2px closer together.
  const fonts = fixedFonts();
  const inner = fonts._shapeCached;
  fonts._shapeCached = function (text, ...rest) {
    const shaped = inner.call(this, text, ...rest);
    if (!text.includes(' A')) return shaped;
    const runs = shaped.runs.map((r, i) => (i ? r : { ...r, width: r.width - 2 }));
    return { ...shaped, width: shaped.width - 2, runs };
  };
  const style = { family: 'Test', size: 16 };
  // and its tables say so, as Trebuchet's do (./pairs.js)
  fonts.match('Test', style).mayKern = () => true;
  const apart = (text) => inner.call(fonts, text, { ...style, font: fonts.match('Test', style) }).width;
  const kerned = apart('x ') + apart('A') - 2;

  const one = new TextLayout(fonts, 'x A', style);
  assert.equal(one.lines.length, 1);
  assert.ok(Math.abs(one.width - kerned) < 1e-6, `${one.width} is the kerned ${kerned}`);
  const [first, second] = one.lines[0].runs;
  assert.ok(Math.abs(second.x - (first.width - 2)) < 1e-6, 'the A is set 2px closer');

  // a line just as wide as the kerned pair holds both
  assert.equal(new TextLayout(fonts, 'x A', style, { maxWidth: kerned + 1e-3 }).lines.length, 1);
  // and where the line breaks between them, the A starts its own line
  const broken = new TextLayout(fonts, 'x A', style, { maxWidth: apart('x') + 1 });
  assert.equal(broken.lines.length, 2);
  assert.equal(broken.lines[1].runs[0].x, 0);
  assert.ok(Math.abs(broken.lines[1].width - apart('A')) < 1e-6);
});

test('TextLayout: a pair shaped otherwise together than apart is left as it is', () => {
  // a contextual glyph across a break opportunity is no offset between the
  // two: only a pair whose glyphs are the same either way is kerned
  const fonts = fixedFonts();
  const inner = fonts._shapeCached;
  fonts._shapeCached = function (text, ...rest) {
    const shaped = inner.call(this, text, ...rest);
    if (!text.includes(' A')) return shaped;
    const runs = shaped.runs.map((r, i) =>
      i ? r : { ...r, width: r.width - 2, glyphs: r.glyphs.map((g, j) => (j ? g : { ...g, id: g.id + 1 })) }
    );
    return { ...shaped, width: shaped.width - 2, runs };
  };
  const style = { family: 'Test', size: 16 };
  fonts.match('Test', style).mayKern = () => true;
  const apart = (text) => inner.call(fonts, text, { ...style, font: fonts.match('Test', style) }).width;
  const layout = new TextLayout(fonts, 'x A', style);
  assert.ok(Math.abs(layout.width - (apart('x ') + apart('A'))) < 1e-6);
});

test('a face whose tables kern no space is not asked to shape a pair', () => {
  // KaTeX's main face kerns letters and not its space: a paragraph of it
  // shapes its words and nothing more
  const fonts = fixedFonts();
  const shaped = [];
  const inner = fonts._shapeCached;
  fonts._shapeCached = function (text, ...rest) {
    shaped.push(text);
    return inner.call(this, text, ...rest);
  };
  new TextLayout(fonts, 'x A b C', { family: 'Test', size: 16 });
  assert.deepEqual(shaped.sort(), ['A ', 'C', 'b ', 'x ']);
});

test('TextLayout: Trebuchet MS kerns a space against an A, as a browser sets it', needsFonts, (t) => {
  const fonts = new FontManager();
  const face = fonts.match('Trebuchet MS', { size: 12 });
  if (face.fk?.familyName !== 'Trebuchet MS') return t.skip('Trebuchet MS is not installed');
  const style = { family: 'Trebuchet MS', size: 12 };
  // Chrome sets this sentence 429.73px wide, and on one line at 430
  const text = 'Chrome, Firefox, iOS and Android browsers (run by over 90% of the population).';
  const layout = new TextLayout(fonts, text, style, { maxWidth: 430 });
  assert.equal(layout.lines.length, 1);
  assert.ok(Math.abs(layout.width - 429.73) < 0.05, `${layout.width}`);
});

test('TextLayout: a line a hair past its width fits it, as a browser fits it', () => {
  // A line's advances summed in floating point come out a hair over the
  // width they were set to fill, and a browser takes the line as fitting,
  // comparing in 64ths of a pixel with one to spare: under a 64th past,
  // the words stay on the line; past it, the last one goes to the next
  const fonts = fixedFonts();
  const style = { family: 'Test', size: 16 };
  const width = new TextLayout(fonts, 'alpha beta', style).width;
  assert.equal(new TextLayout(fonts, 'alpha beta', style, { maxWidth: width - 1 / 128 }).lines.length, 1);
  assert.equal(new TextLayout(fonts, 'alpha beta', style, { maxWidth: width - 1 / 32 }).lines.length, 2);
});

test('TextLayout: a pair either side of a kernAcross span is kerned, as it is unspaced', () => {
  // Spacing is in addition to kerning (CSS Text 3, 7.2), and a justified
  // line spaces its spaces alone, each a span of its own: the pairs a space
  // makes with the letters beside it were dropped there, and the line came
  // out wider than the same line unjustified. A face standing in for
  // Arial: a space set 2px closer to an A after it, and an A 3px closer to
  // a space after it.
  const fonts = fixedFonts();
  const inner = fonts._shapeCached;
  fonts._shapeCached = function (text, ...rest) {
    const shaped = inner.call(this, text, ...rest);
    const kern = (text.includes(' A') ? 2 : 0) + (text.includes('A ') ? 3 : 0);
    if (!kern) return shaped;
    const runs = shaped.runs.map((r, i) => (i ? r : { ...r, width: r.width - kern }));
    return { ...shaped, width: shaped.width - kern, runs };
  };
  const style = { family: 'Test', size: 16 };
  fonts.match('Test', style).mayKern = () => true;
  const spaced = (text) =>
    text
      .split(/( )/)
      .filter(Boolean)
      .map((t) => (t === ' ' ? { text: t, letterSpacing: 1, kernAcross: true } : { text: t }));

  // the pair across a break opportunity, and the pair inside a word
  const plain = new TextLayout(fonts, 'x A x', style).width;
  const apart = new TextLayout(fonts, spaced('x A x'), style).width;
  assert.ok(Math.abs(apart - (plain + 2)) < 1e-6, `${apart} is ${plain} and its two spaces' spacing`);

  // an A a line ends on keeps its kerning with the space it hangs
  const head = new TextLayout(fonts, spaced('x A'), style).width;
  const broken = new TextLayout(fonts, spaced('x A x'), style, { maxWidth: head + 1 });
  assert.equal(broken.lines.length, 2);
  assert.ok(Math.abs(broken.lines[0].width - (head - 3)) < 1e-6, `${broken.lines[0].width}`);

  // an element's letter spacing is shaped apart, as a browser shapes it,
  // and so is a span that differs in more than its spacing
  const bare = (text) => inner.call(fonts, text, { ...style, font: fonts.match('Test', style) }).width;
  const spacedA = inner.call(fonts, 'A', { ...style, letterSpacing: 1, font: fonts.match('Test', style) }).width;
  const element = new TextLayout(fonts, [{ text: 'x ' }, { text: 'A', letterSpacing: 1 }], style).width;
  assert.ok(Math.abs(element - (bare('x ') + spacedA)) < 1e-6, `${element}`);
  const bold = new TextLayout(fonts, [{ text: 'x ' }, { text: 'A', weight: 700, kernAcross: true }], style).width;
  assert.ok(Math.abs(bold - (bare('x ') + bare('A'))) < 1e-6, `${bold}`);
});

test('TextLayout: a line of Arial with its spaces spaced for justifying keeps their pairs', needsFonts, (t) => {
  const fonts = new FontManager();
  const face = fonts.match('Arial', { size: 11 });
  if (face.fk?.familyName !== 'Arial') return t.skip('Arial is not installed');
  const style = { family: 'Arial', size: 11 };
  // Chrome sets this line 188.94px wide, justified or not, and on one line
  // in a column of 189: Arial kerns a space against a T, and an L against
  // a space
  const text = 'into this very page. The HTML remains';
  const spaced = text
    .split(/( )/)
    .filter(Boolean)
    .map((s) => (s === ' ' ? { text: s, letterSpacing: 1e-6, kernAcross: true } : { text: s }));
  const plain = new TextLayout(fonts, text, style, { maxWidth: 189 });
  const justified = new TextLayout(fonts, spaced, style, { maxWidth: 189 });
  assert.equal(justified.lines.length, 1);
  assert.ok(Math.abs(justified.width - plain.width) < 1e-4, `${justified.width} is ${plain.width}`);
});

test('TextLayout: a line fits as a browser fits it, each span rounded up to a 64th', () => {
  // A browser rounds each item of a line, an element's text, up to a 64th
  // of a pixel before it adds it (Blink's SnappedWidth), and fits the sum
  // with a 64th to spare. Words that fit as one span, a hair over, break as
  // three, each part rounded up; spaces spaced out apart, as a justified
  // line's are, are part of the text around them and round with it; and a
  // line is as wide as it was fitted, so it fits its own width again
  const fonts = fixedFonts();
  const style = { family: 'Test', size: 16.3 };
  const items = { fit: 'items' };
  const up = (width) => Math.ceil(width * 64 - 1e-7) / 64;
  const words = ['alpha ', 'beta', ' gamma'];
  const spans = words.map((text) => ({ text }));
  const whole = new TextLayout(fonts, words.join(''), style).width;
  const split = new TextLayout(fonts, spans, style);
  const rounded = split.lines[0].runs.reduce((sum, run) => sum + up(run.width), 0);
  assert.ok(rounded > up(whole), `the parts round up past the whole: ${rounded} ${up(whole)}`);
  const maxWidth = up(whole) - 1 / 64;
  assert.equal(new TextLayout(fonts, words.join(''), style, { ...items, maxWidth }).lines.length, 1, 'one span fits');
  assert.equal(
    new TextLayout(fonts, spans, style, { ...items, maxWidth }).lines.length,
    2,
    'three spans, rounded up, do not'
  );
  assert.equal(new TextLayout(fonts, spans, style, { maxWidth }).lines.length, 1, 'unless asked to be');
  const spaced = [
    { text: 'alpha' },
    { text: ' ', kernAcross: true },
    { text: 'beta' },
    { text: ' ', kernAcross: true },
    { text: 'gamma' }
  ];
  assert.equal(
    new TextLayout(fonts, spaced, style, { ...items, maxWidth }).lines.length,
    1,
    'spaces spaced apart round with the text around them'
  );
  const measured = new TextLayout(fonts, spans, style, items);
  assert.equal(measured.width, rounded, 'as wide as it was fitted');
  assert.equal(measured.lines[0].width, rounded, 'and so is its line');
  assert.equal(
    new TextLayout(fonts, spans, style, { ...items, maxWidth: measured.width }).lines.length,
    1,
    'and it fits its own width'
  );
});

/**
 * A WOFF of a TrueType font with its last glyph emptied: its `loca` entry
 * made the same as the one after it, and the glyph table cut to where its
 * data ends, so the empty glyph sits at the table's very end. Each table is
 * compressed, as a WOFF's are, which gives the glyph table a buffer of its
 * own in fontkit.
 */
function woffWithEmptyLastGlyph(ttf) {
  const numTables = ttf.readUInt16BE(4);
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const at = 12 + i * 16;
    const tag = ttf.toString('latin1', at, at + 4);
    const offset = ttf.readUInt32BE(at + 8);
    const length = ttf.readUInt32BE(at + 12);
    tables.push({ tag, data: Buffer.from(ttf.subarray(offset, offset + length)) });
  }
  const table = (tag) => tables.find((t) => t.tag === tag);
  const numGlyphs = table('maxp').data.readUInt16BE(4);
  const long = table('head').data.readInt16BE(50) === 1;
  const loca = table('loca').data;
  const read = (i) => (long ? loca.readUInt32BE(i * 4) : loca.readUInt16BE(i * 2) * 2);
  const write = (i, v) => (long ? loca.writeUInt32BE(v, i * 4) : loca.writeUInt16BE(v / 2, i * 2));
  const end = read(numGlyphs);
  write(numGlyphs - 1, end);
  const glyf = table('glyf');
  glyf.data = glyf.data.subarray(0, end);
  const entries = tables.map((t) => ({ ...t, packed: deflateSync(t.data) }));
  let offset = 44 + 20 * numTables;
  const header = Buffer.alloc(offset);
  header.write('wOFF', 0, 'latin1');
  header.writeUInt32BE(ttf.readUInt32BE(0), 4);
  header.writeUInt16BE(numTables, 12);
  let sfntSize = 12 + 16 * numTables;
  const bodies = [];
  entries.forEach((t, i) => {
    const stored = t.packed.length < t.data.length ? t.packed : t.data;
    const at = 44 + i * 20;
    header.write(t.tag, at, 'latin1');
    header.writeUInt32BE(offset, at + 4);
    header.writeUInt32BE(stored.length, at + 8);
    header.writeUInt32BE(t.data.length, at + 12);
    const padded = Buffer.alloc((stored.length + 3) & ~3);
    stored.copy(padded);
    bodies.push(padded);
    offset += padded.length;
    sfntSize += (t.data.length + 3) & ~3;
  });
  header.writeUInt32BE(offset, 8);
  header.writeUInt32BE(sfntSize, 16);
  return Buffer.concat([header, ...bodies]);
}

test('Font: an empty glyph at the end of a WOFF glyph table has an empty box', () => {
  // fontkit reads a TrueType glyph's box from a header the glyph may not
  // have: at the end of a WOFF's glyph table, past it, and every layout in
  // a face from fonts.com that ends on four empty glyphs threw
  const font = Font.fromData(woffWithEmptyLastGlyph(fontBytes('KaTeX_Main-Regular.ttf')));
  const last = font.fk.getGlyph(font.fk.numGlyphs - 1);
  let advance;
  assert.doesNotThrow(() => {
    advance = last.advanceWidth;
  }, 'its metrics read');
  assert.ok(Number.isFinite(advance), `an advance of its own: ${advance}`);
  const box = font.glyphExtents(font.fk.numGlyphs - 1, 16);
  assert.ok(!(box.maxX > box.minX), `an empty box: ${JSON.stringify(box)}`);
  const a = font.fk.glyphForCodePoint(0x41).cbox;
  assert.ok(a.maxX > a.minX, `and a drawn glyph keeps its own: ${JSON.stringify(a)}`);
});
