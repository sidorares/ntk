// TextLayout caret positioning / hit testing (caretPosition, indexAt) —
// fully hermetic: uses the KaTeX .ttf files shipped with the katex
// dependency via a StaticFontSource, no fontconfig / X server required.
//
// The KaTeX faces have no Hebrew coverage, so the RTL/bidi cases shape to
// .notdef glyphs — which is fine here: embedding levels, run splitting and
// visual reordering come from bidi-js and the layout pipeline, not from the
// font, and the notdef glyphs still carry real advances and cluster data.
// Ligature clusters (no KaTeX face has GSUB ligatures) are exercised by
// substituting a synthetic multi-codepoint cluster into a real layout line.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import FontManager from '../lib/text/fontmanager.js';
import { StaticFontSource } from '../lib/text/fontsource.js';

const require = createRequire(import.meta.url);
const fontDir = join(dirname(require.resolve('katex/package.json')), 'dist', 'fonts');

function manager() {
  const source = new StaticFontSource();
  source.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), { family: 'Test Main' });
  source.alias('sans-serif', 'Test Main');
  return new FontManager({ source });
}

const style = { family: 'sans-serif', size: 16 };

test('caretPosition: LTR positions equal accumulated run advances (draw pen positions)', () => {
  const fm = manager();
  const layout = fm.layout('Hello, World', style);
  const line = layout.lines[0];
  // expected caret x at each boundary = line.x + run.x + cumulative glyph ax,
  // exactly how draw() advances the pen
  const expected = [line.x + line.runs[0].x];
  for (const r of line.runs) {
    let x = line.x + r.x;
    for (const g of r.run.glyphs) {
      x += g.ax;
      expected.push(x);
    }
  }
  for (let i = 0; i < expected.length; i++) {
    const c = layout.caretPosition(i);
    assert.ok(Math.abs(c.x - expected[i]) < 1e-6, `caret ${i}: ${c.x} != ${expected[i]}`);
    assert.equal(c.line, 0);
  }
});

test('caretPosition: strictly monotonic through trailing whitespace', () => {
  const fm = manager();
  const layout = fm.layout('a   ', style);
  // display width excludes the stripped spaces...
  const bare = fm.layout('a', style);
  assert.ok(Math.abs(layout.lines[0].width - bare.lines[0].width) < 0.01);
  // ...but the caret keeps advancing through them
  let prev = -Infinity;
  for (let i = 0; i <= 4; i++) {
    const { x } = layout.caretPosition(i);
    assert.ok(x > prev, `caret ${i}: ${x} <= ${prev}`);
    prev = x;
  }
});

test('caretPosition: mixed-direction line follows visual run order', () => {
  const fm = manager();
  // shapes into ltr runs around a Hebrew rtl run (visually reversed glyphs)
  const layout = fm.layout('abc שלום xyz', style);
  const line = layout.lines[0];
  assert.ok(line.runs.length >= 3);
  const c = (i) => layout.caretPosition(i).x;
  // ltr prefix increases
  assert.ok(c(0) < c(1) && c(1) < c(2) && c(2) < c(3));
  // interior of the rtl segment decreases as the logical index increases
  assert.ok(c(5) > c(6) && c(6) > c(7), `rtl interior: ${c(5)}, ${c(6)}, ${c(7)}`);
  // rtl carets sit within the rtl run's visual extent
  const rtlRun = line.runs.find((r) => r.run.direction === 'rtl');
  for (const i of [5, 6, 7]) {
    assert.ok(c(i) >= line.x + rtlRun.x - 1e-6 && c(i) <= line.x + rtlRun.x + rtlRun.width + 1e-6);
  }
  // direction-boundary convention (documented): previous character's run
  // wins, so index 8 (after the last rtl char) sits at the rtl run's left
  // edge, and index 4 (after the ltr space) at the ltr run's right edge —
  // both edges touch, so the two carets coincide
  assert.ok(Math.abs(c(8) - (line.x + rtlRun.x)) < 1e-6);
  assert.ok(Math.abs(c(4) - c(8)) < 1e-6);
  // ltr suffix increases again
  assert.ok(c(9) < c(10) && c(10) < c(11) && c(11) < c(12));
});

test('indexAt: round-trips caretPosition on LTR text incl. trailing spaces', () => {
  const fm = manager();
  const layout = fm.layout('The quick fox  ', style);
  const n = 15;
  for (let i = 0; i <= n; i++) {
    const c = layout.caretPosition(i);
    // clicks a hair to either side of the caret snap back to it
    assert.equal(layout.indexAt(c.x + 0.9, c.y + 1), i, `right of caret ${i}`);
    assert.equal(layout.indexAt(c.x - 0.9, c.y + 1), i, `left of caret ${i}`);
  }
});

test('indexAt: round-trips inside rtl segments of a mixed line', () => {
  const fm = manager();
  const layout = fm.layout('abc שלום xyz', style);
  // boundary indices 4/8 share one visual position (see convention above);
  // all interior boundaries must round-trip exactly
  for (const i of [0, 1, 2, 3, 5, 6, 7, 9, 10, 11, 12]) {
    const c = layout.caretPosition(i);
    assert.equal(layout.indexAt(c.x + 0.4, c.y + 1), i, `caret ${i}`);
  }
});

test('indexAt: past-midpoint clicks snap to the far cluster edge', () => {
  const fm = manager();
  const layout = fm.layout('mm', style);
  const [c0, c1] = [layout.caretPosition(0), layout.caretPosition(1)];
  const adv = c1.x - c0.x;
  assert.equal(layout.indexAt(c0.x + adv * 0.45, 1), 0);
  assert.equal(layout.indexAt(c0.x + adv * 0.55, 1), 1);
});

test('multi-line: caret y/line from the line the index falls on', () => {
  const fm = manager();
  const layout = fm.layout('aaaa bbbb', style, { maxWidth: 45 });
  assert.equal(layout.lines.length, 2);
  // index 4 = end of first word: still line 0, at its visual end
  const end0 = layout.caretPosition(4);
  assert.equal(end0.line, 0);
  assert.ok(Math.abs(end0.x - (layout.lines[0].x + layout.lines[0].width)) < 1e-6);
  // index 5 = the soft-wrap boundary maps to the start of the next line
  const start1 = layout.caretPosition(5);
  assert.equal(start1.line, 1);
  assert.equal(start1.y, layout.lines[1].y);
  assert.ok(Math.abs(start1.x - layout.lines[1].x) < 1e-6);
  // hit-test y clamps above the first and below the last line
  assert.equal(layout.indexAt(0, -100), 0);
  assert.equal(layout.indexAt(1e6, 1e6), 9);
  // hard breaks: index of '\n' sits at end of its line, index after it on the next
  const hard = fm.layout('a\n\nb', style);
  assert.equal(hard.caretPosition(1).line, 0);
  assert.equal(hard.caretPosition(2).line, 1); // blank paragraph
  assert.equal(hard.caretPosition(3).line, 2);
  assert.equal(hard.indexAt(50, hard.lines[1].y + 1), 2);
});

test('empty text: caret at the aligned line origin', () => {
  const fm = manager();
  const left = fm.layout('', style);
  assert.deepEqual(left.caretPosition(0), { x: 0, y: 0, height: left.lines[0].ascent + left.lines[0].descent, line: 0 });
  const center = fm.layout('', style, { maxWidth: 100, align: 'center' });
  assert.equal(center.caretPosition(0).x, 50);
  const right = fm.layout('', style, { maxWidth: 100, align: 'right' });
  assert.equal(right.caretPosition(0).x, 100);
  assert.equal(center.indexAt(50, 0), 0);
});

test('caretPosition clamps out-of-range indices', () => {
  const fm = manager();
  const layout = fm.layout('ab', style);
  assert.equal(layout.caretPosition(-5).x, layout.caretPosition(0).x);
  assert.equal(layout.caretPosition(99).x, layout.caretPosition(2).x);
});

test('code-point indexing: astral characters count as one position', () => {
  const fm = manager();
  const layout = fm.layout('a\u{1D465}b', style); // 3 code points, 4 code units
  const xs = [0, 1, 2, 3].map((i) => layout.caretPosition(i).x);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1], `caret ${i} advances`);
  const c = layout.caretPosition(2);
  assert.equal(layout.indexAt(c.x + 0.4, 1), 2);
  assert.equal(layout.indexAt(1e6, 1), 3);
});

test('ligature clusters: interior indices interpolate proportionally', () => {
  const fm = manager();
  // no KaTeX face carries GSUB ligatures, so emulate one: shape 'fi' and
  // replace the line's run with a single 2-codepoint cluster glyph — the
  // exact shape fontkit produces for a real 'fi' ligature
  const layout = fm.layout('fi', style);
  const line = layout.lines[0];
  const r = line.runs[0];
  line.runs[0] = {
    ...r,
    width: 10,
    run: {
      ...r.run,
      width: 10,
      glyphs: [{ id: 999, ax: 10, dx: 0, dy: 0, codePoints: [0x66, 0x69] }]
    }
  };
  line.width = 10;
  line._trailing = null;
  assert.equal(layout.caretPosition(0).x, 0);
  assert.equal(layout.caretPosition(1).x, 5); // halfway through the cluster
  assert.equal(layout.caretPosition(2).x, 10);
  // hit tests round to the nearest of the interpolated boundaries
  assert.equal(layout.indexAt(2, 1), 0);
  assert.equal(layout.indexAt(3, 1), 1);
  assert.equal(layout.indexAt(6, 1), 1);
  assert.equal(layout.indexAt(8, 1), 2);
});

test('rtl base direction: trailing spaces extend the caret leftwards', () => {
  const fm = manager();
  // an rtl paragraph made of ltr words: base level 1, right-aligned by
  // 'start', words at level 2, trailing whitespace stripped at level 1
  const layout = fm.layout('ab ', style, { direction: 'rtl', maxWidth: 100 });
  const line = layout.lines[0];
  assert.equal(layout.baseLevel, 1);
  assert.ok(line.x > 0, 'start-aligned rtl line is right-aligned');
  const c2 = layout.caretPosition(2);
  const c3 = layout.caretPosition(3);
  assert.ok(c3.x < c2.x, `trailing space advances leftwards: ${c3.x} !< ${c2.x}`);
  assert.equal(layout.indexAt(c3.x - 0.4, 1), 3);
});
