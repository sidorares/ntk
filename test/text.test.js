import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { charsetHas } from '../lib/fontconfig.js';
import FontManager from '../lib/text/fontmanager.js';
import { StaticFontSource } from '../lib/text/fontsource.js';
import { encodeGlyphItems } from '../lib/text/glyphs.js';
import { TextLayout } from '../lib/text/layout.js';
import { reorderRuns, shapeText } from '../lib/text/shape.js';
import { parseInline, parseMarkdown } from '../lib/widgets/markdown.js';
import MarkdownView from '../lib/widgets/markdownview.js';

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
  // MarkdownView hands over an empty span list for a blank block, which
  // happens while a document is being typed — every line still needs a
  // style to take its metrics from, and this used to throw on the first
  // one ("undefined is not an object (evaluating 'baseSpan.font')")
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
  for (const text of ['aaaaéaaaa', 'aa\u{1F468}‍\u{1F469}‍\u{1F466}aa', 'नमस्ते नमस्ते']) {
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
  const cacheSize = fonts._shapeCache.size;
  new TextLayout(fonts, 'repeat me repeat me', style, { maxWidth: 300 });
  assert.equal(fonts._shapeCache.size, cacheSize, 'relayout added no new shaping work');
});

test('shaping cache evicts its stale half on overflow, not everything', () => {
  const fonts = fixedFonts();
  const style = { font: fonts.match('sans-serif'), family: 'sans-serif', size: 16 };
  const keep = fonts._shapeCached('keep', style);
  const drop = fonts._shapeCached('drop', style);
  // fill to the bound with distinct entries, then refresh 'keep' so it sits
  // at the recently-used end when the sweep runs
  let i = 0;
  while (fonts._shapeCache.size <= 4000) fonts._shapeCached(`w${i++}`, style);
  assert.equal(fonts._shapeCached('keep', style), keep, 'hit before overflow');
  const before = fonts._shapeCache.size;
  fonts._shapeCached('straw', style); // one past the bound: triggers the sweep
  assert.ok(fonts._shapeCache.size < before, 'the sweep ran');
  assert.ok(fonts._shapeCache.size > before / 4, 'and kept the recent half');
  assert.equal(fonts._shapeCached('keep', style), keep, 'recently-used entry survived');
  assert.notEqual(fonts._shapeCached('drop', style), drop, 'stale entries were evicted');
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

test('parseMarkdown: blocks', () => {
  const ast = parseMarkdown('# H1\n\ntext\n\n```js\ncode();\n```\n\n> quote\n\n---\n\n1. one\n2. two');
  assert.deepEqual(
    ast.map((b) => b.type),
    ['heading', 'paragraph', 'code', 'blockquote', 'hr', 'list']
  );
  assert.equal(ast[0].level, 1);
  assert.equal(ast[2].text, 'code();');
  assert.equal(ast[2].lang, 'js');
  assert.equal(ast[5].ordered, true);
  assert.equal(ast[5].items.length, 2);
});

test('parseMarkdown: nested lists', () => {
  const ast = parseMarkdown('- a\n- b\n  - b1\n  - b2\n- c');
  assert.equal(ast.length, 1);
  assert.equal(ast[0].items.length, 3);
  const nested = ast[0].items[1].find((b) => b.type === 'list');
  assert.ok(nested, 'nested list parsed');
  assert.equal(nested.items.length, 2);
});

test('parseMarkdown: tables', () => {
  const ast = parseMarkdown('| Name | Score |\n|:-----|------:|\n| **a** | 1 |\n| b | 2 |');
  assert.equal(ast.length, 1);
  const table = ast[0];
  assert.equal(table.type, 'table');
  assert.deepEqual(table.align, ['left', 'right']);
  assert.equal(table.header.length, 2);
  assert.equal(table.header[0][0].text, 'Name');
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0][0][0].type, 'strong');
  assert.equal(table.rows[1][1][0].text, '2');
});

test('parseInline: emphasis, code, links, escapes', () => {
  const nodes = parseInline('a **b** *c* `d` [e](f) \\*g\\*');
  const types = nodes.map((n) => n.type);
  assert.deepEqual(types, ['text', 'strong', 'text', 'em', 'text', 'code', 'text', 'link', 'text']);
  assert.equal(nodes[1].children[0].text, 'b');
  assert.equal(nodes[5].text, 'd');
  assert.equal(nodes[7].href, 'f');
  assert.ok(nodes[8].text.includes('*g*'));
});

test('parseMarkdown: soft-wrapped paragraph lines join', () => {
  const ast = parseMarkdown('line one\nline two');
  assert.equal(ast.length, 1);
  assert.equal(ast[0].children[0].text, 'line one line two');
});

test('parseInline: no intra-word underscore emphasis (WM_DELETE_WINDOW)', () => {
  const nodes = parseInline('set WM_DELETE_WINDOW and _real emphasis_');
  assert.deepEqual(
    nodes.map((n) => n.type),
    ['text', 'em']
  );
  assert.equal(nodes[0].text, 'set WM_DELETE_WINDOW and ');
  assert.equal(nodes[1].children[0].text, 'real emphasis');
});

test('parseMarkdown: snake_case survives inside styled and plain contexts', () => {
  const ast = parseMarkdown('`code_name` plus **bold_name_here** plus plain_name_x');
  const para = ast[0];
  const flat = JSON.stringify(para);
  assert.ok(!flat.includes('"em"'), `no emphasis nodes expected: ${flat}`);
});

test('MarkdownView: table layout places cells and grid', needsFonts, () => {
  const fonts = new FontManager();
  const view = new MarkdownView(null, { fonts });
  view.setMarkdown('| Name | Score |\n|:-----|------:|\n| alpha | 1 |\n| beta | 22 |');
  const height = view.layout(400);
  assert.ok(height > 0);
  const items = view._items;
  const texts = items.filter((i) => i.kind === 'text');
  const rects = items.filter((i) => i.kind === 'rect');
  assert.equal(texts.length, 6, '2 cols x 3 rows of cell text');
  // header background + 4 horizontal + 3 vertical grid lines
  assert.equal(rects.length, 8);
  // header cells are bold
  const header = texts[0];
  assert.equal(header.layout.lines[0].runs[0].span.weight, 700);
  // right-aligned numeric column: the two body cells share a right edge
  const right = (i) => i.x + i.layout.lines[0].x + i.layout.lines[0].width;
  assert.ok(Math.abs(right(texts[3]) - right(texts[5])) < 0.5, 'right-aligned column');
});

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

  // Measuring one token unconstrained is the reliable answer, and is what
  // MarkdownView's table layout uses.
  assert.equal(new TextLayout(fonts, [span], style, {}).width, whole);
});

test('MarkdownView: a squeezed column never narrows past its longest word', needsFonts, () => {
  const fonts = new FontManager();
  // Every cell is a single unbreakable word, so no column can give up width by
  // wrapping. The floor used to be a flat 2.5em guess unrelated to the content,
  // which handed TextLayout a maxWidth narrower than the word itself — and
  // TextLayout force-breaks a token wider than its container, so a `value`
  // header rendered as `valu` over `e`. Overflowing is the right answer here,
  // and it is what a browser does with the same table.
  //
  // The assertion is on the *text*, not the line count: a cell can land on a
  // second line that holds nothing, which is not a broken word. Whatever fails
  // here has to say what it actually saw, because the only way it fails is a
  // font whose metrics differ from the one you ran it with.
  const md = '| column | value |\n| ------ | ----: |\n| alpha | 12 |\n| beta | 345 |';
  for (const width of [400, 200, 120, 90, 60, 30]) {
    const view = new MarkdownView(null, { fonts });
    view.setMarkdown(md);
    view.layout(width);
    for (const item of view._items.filter((i) => i.kind === 'text')) {
      // _text is the layout's full string; line.start/end index into it
      const full = item.layout._text;
      const pieces = item.layout.lines
        .map((l) => full.slice(l.start, l.end).trim())
        .filter((t) => t !== '');
      assert.deepEqual(
        pieces,
        pieces.length ? [full.trim()] : [],
        `at width ${width} a cell was split into ${JSON.stringify(pieces)}; ` +
          `it holds ${JSON.stringify(full)} and was laid out at ` +
          `maxWidth ${item.layout.options?.maxWidth}`
      );
    }
  }
});

test('MarkdownView: no table cell is laid out below its widest token', needsFonts, () => {
  const fonts = new FontManager();
  // The invariant behind the test above, checked directly instead of through a
  // symptom that only appears on an unlucky font. A cell handed a maxWidth
  // below the measured width of a word it holds is a word wider than its
  // container, and TextLayout force-breaks those.
  //
  // It used to be violated by arithmetic alone: the content width was derived
  // as `cols[c] - hpad * 2` from a `cols[c]` that had just had `hpad * 2`
  // added, and that round trip is not the identity in floating point. At size
  // 16, a natural width of 48.953125 comes back as 48.95312499999999 — seven
  // ULPs low, and enough.
  const md = '| column | value |\n| ------ | ----: |\n| alpha | 12 |\n| beta | 345 |';
  for (const size of [12, 13, 16, 19]) {
    for (const width of [400, 220, 140, 80, 40]) {
      const view = new MarkdownView(null, { fonts, theme: { size } });
      view.setMarkdown(md);
      view.layout(width);
      for (const item of view._items.filter((i) => i.kind === 'text')) {
        const maxWidth = item.layout.options?.maxWidth;
        if (maxWidth === undefined) continue;
        const text = item.layout._text;
        for (const token of text.split(/\s+/)) {
          if (!token) continue;
          const style = { family: 'sans-serif', size, weight: item.layout.lines[0]?.runs[0]?.span.weight };
          const tokenWidth = new TextLayout(fonts, [{ ...style, text: token }], style, {}).width;
          assert.ok(
            maxWidth >= tokenWidth,
            `size ${size} width ${width}: "${token}" measures ${tokenWidth} but its ` +
              `cell was laid out at maxWidth ${maxWidth}`
          );
        }
      }
    }
  }
});

test('MarkdownView: wide table shrinks columns to the container', needsFonts, () => {
  const fonts = new FontManager();
  const view = new MarkdownView(null, { fonts });
  const long = 'a very long cell that will definitely not fit unwrapped in a narrow container';
  view.setMarkdown(`| One | Two |\n|-----|-----|\n| ${long} | ${long} |`);
  view.layout(300);
  const gridTop = view._items.filter((i) => i.kind === 'rect' && i.height === 1)[0];
  assert.ok(gridTop.width <= 300 - 16 * 2 + 1, `table width ${gridTop.width} fits container`);
  // cells wrapped onto multiple lines
  const body = view._items.filter((i) => i.kind === 'text');
  assert.ok(body.some((i) => i.layout.lines.length > 1), 'long cells wrap');
});
