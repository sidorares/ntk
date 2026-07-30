import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

import { charsetHas } from '../lib/fontconfig.js';
import FontManager from '../lib/text/fontmanager.js';
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
