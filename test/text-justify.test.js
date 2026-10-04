// TextLayout's `justify`: lines set to fill the width, what each leaves of
// it shared among its word separators, after the lines are broken — so a
// paragraph laid out again at another width is broken and spaced again,
// and not shaped again, where a caller that spaced its words through letter
// spacing shaped it at every width (react-x11-components' <Html>).
//
// Hermetic: a font from the KaTeX package, and for the pixels node-x11's
// in-process pure-JS X server, no $DISPLAY needed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';
import FontManager from '../lib/text/fontmanager.js';

const require = createRequire(import.meta.url);
const fontDir = join(dirname(require.resolve('katex/package.json')), 'dist', 'fonts');
const FONT = readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf'));

function source() {
  const s = new StaticFontSource();
  s.add(FONT, { family: 'Test Main' });
  s.alias('sans-serif', 'Test Main');
  return s;
}

const fonts = new FontManager({ source: source() });
const STYLE = { family: 'Test Main', size: 16 };
const WORDS = 'the quick brown fox jumps over the lazy dog and back again ';
const WIDTH = 200;

const layout = (text, options = {}) => fonts.layout(text, STYLE, { maxWidth: WIDTH, ...options });
const near = (a, b, by = 1e-6) => Math.abs(a - b) <= by;

/** Where each line's ink ends: its last run's right edge. */
const rightEdge = (line) => line.x + Math.max(...line.runs.map((r) => r.x + r.width));

/** The advances of a line's glyphs, in visual order, with their code points. */
function advances(line) {
  const out = [];
  for (const r of line.runs) {
    for (const g of r.run.glyphs) out.push({ cps: g.codePoints, ax: g.ax });
  }
  return out;
}

test('every line but the last fills the width, broken where it was', () => {
  const plain = layout(WORDS.repeat(3));
  const justified = layout(WORDS.repeat(3), { justify: true });
  assert.ok(plain.lines.length > 2, `${plain.lines.length} lines`);
  assert.deepEqual(
    justified.lines.map((l) => [l.start, l.end]),
    plain.lines.map((l) => [l.start, l.end]),
    'the same breaks'
  );
  for (const line of justified.lines.slice(0, -1)) {
    assert.ok(near(line.width, WIDTH, 1e-9), `width ${line.width}`);
    assert.ok(near(rightEdge(line), WIDTH, 1e-6), `ink to ${rightEdge(line)}`);
    assert.equal(line.x, 0);
  }
  const last = justified.lines.at(-1);
  const lastPlain = plain.lines.at(-1);
  assert.equal(last.width, lastPlain.width, 'the last is as it was');
  assert.equal(justified.width, WIDTH);
});

test('the room is shared equally among the spaces inside a line, and none to the one it ends on', () => {
  const plain = layout(WORDS.repeat(2));
  const justified = layout(WORDS.repeat(2), { justify: true });
  const before = advances(plain.lines[0]);
  const after = advances(justified.lines[0]);
  assert.equal(after.length, before.length);
  const spaces = before.filter((g) => g.cps.length === 1 && g.cps[0] === 0x20).length;
  const share = (WIDTH - plain.lines[0].width) / spaces;
  assert.ok(share > 0);
  for (let i = 0; i < after.length; i++) {
    const space = after[i].cps.length === 1 && after[i].cps[0] === 0x20;
    assert.ok(near(after[i].ax, before[i].ax + (space ? share : 0)), `glyph ${i}`);
  }
  // the space the line broke at hangs past the edge, as wide as ever
  assert.deepEqual(justified.lines[0]._trailing.glyphs, plain.lines[0]._trailing.glyphs);
});

test('a no-break space is a separator, and a line without one keeps its alignment', () => {
  const text = 'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll';
  const plain = layout(text);
  const justified = layout(text, { justify: true });
  const before = advances(plain.lines[0]);
  const after = advances(justified.lines[0]);
  const nbsp = before.findIndex((g) => g.cps[0] === 0xa0);
  assert.ok(nbsp > 0 && after[nbsp].ax > before[nbsp].ax, 'the no-break space is widened');
  // a word cut to fit, a line at a time: no separator in any of them
  const long = layout('Supercalifragilisticexpialidociouslylongword and more', {
    justify: true,
    maxWidth: 100,
    align: 'center'
  });
  const first = long.lines[0];
  assert.ok(first.width < 99, `a piece of the word, ${first.width} wide`);
  assert.ok(near(first.x, (100 - first.width) / 2, 1e-9), 'centred, as it would be unjustified');
});

test('a line a forced break ends is set as the last is; `last` sets only those, and `all` every line', () => {
  const text = `${WORDS.repeat(2)}\n${WORDS.repeat(2)}`;
  const plain = layout(text);
  const ended = plain.lines.findIndex((l) => /\n$/.test(text.slice(l.start, l.end)));
  assert.ok(ended > 0 && ended < plain.lines.length - 1, `line ${ended} of ${plain.lines.length}`);
  const widths = (justify) => layout(text, { justify }).lines.map((l) => near(l.width, WIDTH, 1e-9));
  const rest = widths(true);
  assert.equal(rest[ended], false, 'not the one a forced break ends');
  assert.equal(rest.at(-1), false, 'nor the last');
  assert.ok(rest.filter((full, i) => i !== ended && i !== rest.length - 1).every(Boolean));
  const last = widths('last');
  assert.equal(last[ended], true, '`last`: the one a break ends');
  assert.equal(last.at(-1), true, 'and the last');
  assert.ok(last.filter((full, i) => i !== ended && i !== last.length - 1).every((full) => !full));
  assert.ok(widths('all').every(Boolean), '`all`: every line');
  // a line separator is no forced break: a caller asks for a break there
  const separated = layout(`${WORDS.slice(0, 30)} ${WORDS}`, { justify: true });
  assert.ok(near(separated.lines[0].width, WIDTH, 1e-9), 'justified up to a line separator');
});

test('a caret and a hit test agree with the spaced glyphs', () => {
  const text = WORDS.repeat(2);
  const plain = layout(text);
  const justified = layout(text, { justify: true });
  const line = plain.lines[0];
  const spaces = advances(line).filter((g) => g.cps[0] === 0x20).length;
  const share = (WIDTH - line.width) / spaces;
  // after the k-th space of the line, k shares further on
  let k = 0;
  for (let i = 0; i < line._contentEnd; i++) {
    if (text[i - 1] === ' ') k++;
    const a = plain.caretPosition(i).x;
    const b = justified.caretPosition(i).x;
    assert.ok(near(b, a + k * share, 1e-6), `caret ${i}: ${b} against ${a} + ${k} shares`);
    // and the point there finds the index again
    assert.equal(justified.indexAt(b + 0.01, 1), i, `hit ${i}`);
  }
});

test('a right-to-left paragraph fills its lines from the right edge', () => {
  const text = 'שלום עולם זה טקסט בעברית '.repeat(4);
  const justified = fonts.layout(text, STYLE, { maxWidth: WIDTH, justify: true, direction: 'rtl' });
  assert.ok(justified.lines.length > 1);
  for (const line of justified.lines.slice(0, -1)) {
    assert.ok(near(line.width, WIDTH, 1e-9));
    assert.ok(near(line.x, 0, 1e-9), `x ${line.x}`);
  }
});

test('a cut line with an ellipsis is not justified, and the paragraph is shaped once for both', () => {
  const cut = layout(WORDS.repeat(3), { justify: true, maxLines: 2, overflow: 'ellipsis' });
  assert.ok(cut.truncated);
  assert.ok(near(cut.lines[0].width, WIDTH, 1e-9));
  assert.ok(cut.lines[1].width < WIDTH - 1, 'the line the ellipsis ends is set as it is');
  // and a layout justified does nothing to the shaped text the next one
  // breaks: a run is the paragraph's, and every layout of it shares it
  const text = WORDS.repeat(6);
  const before = layout(text).lines.map((l) => l.width);
  layout(text, { justify: true });
  assert.deepEqual(layout(text).lines.map((l) => l.width), before);
});

test('the font manager says it justifies', () => {
  assert.equal(fonts.justifies, true);
});

test('drawn justified, the last word of a line ends at the width', async () => {
  const { createServer, createStreamPair } = xserver;
  const server = createServer({ width: 260, height: 80 });
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);
  const app = await createClient({ stream: clientEnd, fontSource: source() });
  try {
    const W = 240;
    const H = 30;
    /** the rightmost column with ink in a drawn layout's first line */
    const inkRight = async (justify) => {
      const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
      const ctx = pixmap.getContext('2d');
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'black';
      app.fonts.layout(WORDS.repeat(2), STYLE, { maxWidth: WIDTH, justify }).draw(ctx, 10, 2);
      const { data } = await ctx.getImageData(0, 0, W, H);
      let right = -1;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (data[(y * W + x) * 4] < 128) right = Math.max(right, x);
        }
      }
      return right;
    };
    const plain = await inkRight(false);
    const justified = await inkRight(true);
    assert.ok(plain < 10 + WIDTH - 6, `unjustified, ink to ${plain}`);
    assert.ok(justified >= 10 + WIDTH - 3 && justified <= 10 + WIDTH, `justified, ink to ${justified}`);
  } finally {
    await app.close();
  }
});
