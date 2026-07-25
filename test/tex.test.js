// Headless KaTeX layout tests — no X server needed (KaTeX bundles its fonts,
// so nothing depends on fontconfig either).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { layoutTex } from '../lib/widgets/tex.js';

const runsOf = (box) => box.items.filter((i) => i.type === 'run');
const glyphCount = (box) => runsOf(box).reduce((n, r) => n + r.run.glyphs.length, 0);

test('simple formula produces a box with sane metrics', () => {
  const box = layoutTex('x+1', { size: 20 });
  assert.ok(box.width > 20, `width ${box.width}`);
  assert.ok(box.height > 10, `height ${box.height}`);
  assert.ok(box.baseline > 0 && box.baseline <= box.height);
  assert.ok(glyphCount(box) === 3, `expected 3 glyphs, got ${glyphCount(box)}`);
});

test('adjacent same-style symbols merge into single shaped runs', () => {
  // \sin -> s i n in one upright run; digits merge too
  const box = layoutTex('\\sin 123', { size: 20 });
  const runs = runsOf(box);
  assert.equal(glyphCount(box), 6);
  assert.ok(
    runs.length <= 2,
    `expected at most 2 runs (sin | 123), got ${runs.length}`
  );
});

test('superscripts are raised and smaller', () => {
  const box = layoutTex('x^2', { size: 20 });
  const runs = runsOf(box);
  assert.equal(runs.length, 2);
  const [base, sup] = runs[0].run.size >= runs[1].run.size ? runs : [runs[1], runs[0]];
  assert.ok(sup.run.size < base.run.size, 'superscript uses a smaller size');
  assert.ok(sup.y < base.y, 'superscript sits above the baseline');
});

test('subscripts are lowered', () => {
  const box = layoutTex('x_i', { size: 20 });
  const runs = runsOf(box);
  const sub = runs.find((r) => r.run.size < 20);
  assert.ok(sub, 'subscript run exists');
  assert.ok(sub.y > 0, 'subscript sits below the baseline');
});

test('fractions draw a rule between numerator and denominator', () => {
  const box = layoutTex('\\frac{a}{b}', { size: 20 });
  const rects = box.items.filter((i) => i.type === 'rect');
  assert.equal(rects.length, 1, 'one frac-line');
  const rule = rects[0];
  const runs = runsOf(box);
  const above = runs.filter((r) => r.y < rule.y);
  const below = runs.filter((r) => r.y > rule.y);
  assert.equal(above.length, 1, 'numerator above the line');
  assert.equal(below.length, 1, 'denominator below the line');
  assert.ok(rule.w > 0 && rule.h >= 1, 'rule has resolved extent');
});

test('fraction numerator and denominator are centered on each other', () => {
  const box = layoutTex('\\frac{1}{100}', { size: 20 });
  const runs = runsOf(box);
  const num = runs.find((r) => r.run.glyphs.length === 1);
  const den = runs.find((r) => r.run.glyphs.length === 3);
  const numCenter = num.x + num.run.width / 2;
  const denCenter = den.x + den.run.width / 2;
  assert.ok(Math.abs(numCenter - denCenter) < 1, `centers ${numCenter} vs ${denCenter}`);
});

test('sqrt produces a filled surd path spanning the radicand', () => {
  const box = layoutTex('\\sqrt{x}', { size: 20 });
  const paths = box.items.filter((i) => i.type === 'path');
  assert.equal(paths.length, 1);
  assert.ok(paths[0].polys.length >= 1, 'surd outline present');
  const run = runsOf(box)[0];
  assert.ok(run.x > 5, 'radicand shifted right of the radical sign');
});

test('display-mode sum places limits above and below', () => {
  const box = layoutTex('\\sum_{i=0}^{n}', { size: 20, displayMode: true });
  const runs = runsOf(box);
  const sum = runs.find((r) => r.run.size === 20);
  const above = runs.filter((r) => r !== sum && r.y < sum.y);
  const below = runs.filter((r) => r !== sum && r.y > sum.y);
  assert.ok(above.length >= 1, 'upper limit present');
  assert.ok(below.length >= 1, 'lower limit present');
});

test('colors from \\color reach the draw items', () => {
  const box = layoutTex('a \\color{red} b', { size: 20 });
  const colors = new Set(runsOf(box).map((r) => r.color));
  assert.ok([...colors].some((c) => c === 'red'), `colors: ${[...colors]}`);
});

test('default color comes from options', () => {
  const box = layoutTex('a', { size: 20, color: '#123456' });
  assert.equal(runsOf(box)[0].color, '#123456');
});

test('size scales the whole layout linearly', () => {
  const small = layoutTex('\\frac{a+b}{c}', { size: 16 });
  const big = layoutTex('\\frac{a+b}{c}', { size: 32 });
  assert.ok(Math.abs(big.width / small.width - 2) < 0.01, `${big.width} vs ${small.width}`);
  assert.ok(Math.abs(big.height / small.height - 2) < 0.01);
});

test('parse errors throw (callers decide the fallback)', () => {
  assert.throws(() => layoutTex('\\frac{1', { size: 16 }));
});

test('matrix lays out rows and columns without overlap', () => {
  const box = layoutTex('\\begin{pmatrix} 1 & 22 \\\\ 333 & 4 \\end{pmatrix}', { size: 20 });
  const runs = runsOf(box);
  assert.equal(glyphCount(box), 9); // 7 digits + 2 parens
  // parens (Size fonts) should bracket the columns
  const xs = runs.map((r) => r.x);
  assert.ok(Math.max(...xs) > Math.min(...xs) + 20, 'columns spread horizontally');
});
