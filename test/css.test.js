// Pure CSS engine tests: parsing, specificity, cascade, inheritance.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { selectAll } from 'css-select';
import { parseDocument } from 'htmlparser2';

import {
  computeStyles,
  cssColor,
  cssLength,
  parseInlineStyle,
  parseStylesheet,
  specificity
} from '../lib/widgets/css.js';

const styleOf = (html, selector, sheets = []) => {
  const dom = parseDocument(html);
  const styles = computeStyles(dom, sheets);
  return styles.get(selectAll(selector, dom)[0]);
};

test('cssColor: named, hex, rgba, transparent', () => {
  assert.deepEqual(cssColor('red'), [1, 0, 0, 1]);
  assert.deepEqual(cssColor('#0000ff'), [0, 0, 1, 1]);
  // premultiplied, because these go to XRender as-is: r, g and b are each
  // scaled by alpha, so half-alpha red is 0.5 and not 1
  assert.deepEqual(cssColor('rgba(255, 0, 0, 0.5)'), [0.5, 0, 0, 0.5]);
  assert.deepEqual(cssColor('transparent'), [0, 0, 0, 0]);
  assert.equal(cssColor('bogus-color'), null);
});

test('cssColorStraight: unassociated alpha, and premultiply converts', async () => {
  const { cssColorStraight, premultiply } = await import('../lib/index.js');

  // straight: the components are not scaled by alpha
  assert.deepEqual(cssColorStraight('rgba(255, 0, 0, 0.5)'), [1, 0, 0, 0.5]);
  assert.deepEqual(cssColorStraight('red'), [1, 0, 0, 1]);
  assert.equal(cssColorStraight('bogus-color'), null);

  // hex alpha is parsed here too, not just in cssColor
  const [r, g, b, a] = cssColorStraight('#ff000080');
  assert.deepEqual([r, g, b], [1, 0, 0]);
  assert.ok(Math.abs(a - 0x80 / 255) < 1e-9, `alpha ${a}`);

  // the pair composes back to cssColor
  assert.deepEqual(
    premultiply(cssColorStraight('rgba(255, 0, 0, 0.5)')),
    cssColor('rgba(255, 0, 0, 0.5)'),
  );

  // ...and round-trips through an rgba() string, which premultiplied does
  // not: that is the bug this export exists to prevent, where a colour comes
  // back half as bright at the same alpha
  const toCss = (c) =>
    `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${c[3]})`;
  assert.equal(
    toCss(cssColorStraight('rgba(255, 0, 0, 0.5)')),
    'rgba(255, 0, 0, 0.5)',
  );
  assert.equal(
    toCss(cssColor('rgba(255, 0, 0, 0.5)')),
    'rgba(128, 0, 0, 0.5)',
    'premultiplied values must not be formatted as a CSS colour',
  );
});

test('cssColor: hex alpha, which parse-color does not understand', () => {
  // parse-color returns rgba [0, 0, 0, 34, 1] here — five entries, with the
  // alpha still a 0..255 byte. 34 clamped to 1, so this rendered opaque.
  const black13 = cssColor('#00000022');
  assert.equal(black13.length, 4);
  assert.ok(Math.abs(black13[3] - 0x22 / 255) < 1e-9, `alpha ${black13[3]}`);
  assert.deepEqual(black13.slice(0, 3), [0, 0, 0]);

  // four-digit form: parse-color reads '#0002' as a truncated six-digit hex
  assert.deepEqual(cssColor('#0002'), cssColor('#00000022'));
  assert.deepEqual(cssColor('#f008'), cssColor('#ff000088'));

  // opaque hex alpha still equals the alpha-less form, and stays exact
  assert.deepEqual(cssColor('#ff0000ff'), [1, 0, 0, 1]);
  assert.deepEqual(cssColor('#fff'), [1, 1, 1, 1]);
  assert.deepEqual(cssColor('#00000000'), [0, 0, 0, 0]);

  // premultiplied: white at half alpha is grey, not white
  const [r, g, b, a] = cssColor('#ffffff80');
  assert.ok(r <= a && g <= a && b <= a, `not premultiplied: ${[r, g, b, a]}`);
  assert.ok(Math.abs(r - 0x80 / 255) < 1e-9, `r ${r}`);
});

test('cssColor: hex forms that are not CSS are rejected, not guessed', () => {
  // '#' never falls back to parse-color, which turns '#1234567' into
  // rgba [18, 52, 86, 7, 1] — an alpha of 7
  for (const bad of ['#12345', '#1234567', '#12', '#', '#gg0000']) {
    assert.equal(cssColor(bad), null, bad);
  }
  for (const bad of ['', null, undefined, 42, [1, 0, 0, 1]]) {
    assert.equal(cssColor(bad), null, JSON.stringify(bad));
  }
});

test('cssLength: units resolve against em base and root size', () => {
  assert.deepEqual(cssLength('10px'), { px: 10 });
  assert.deepEqual(cssLength('2em', 20), { px: 40 });
  assert.deepEqual(cssLength('1.5rem', 20, 10), { px: 15 });
  assert.deepEqual(cssLength('50%'), { pct: 50 });
  assert.deepEqual(cssLength('12pt'), { px: 16 });
  assert.equal(cssLength('auto'), 'auto');
  assert.equal(cssLength('10vw'), null);
});

test('specificity: id > class > type, :not() counts its argument', () => {
  assert.ok(specificity('#a') > specificity('.a.b.c.d'));
  assert.ok(specificity('.a') > specificity('div span p'));
  assert.equal(specificity('div p:not(.foo)::before'), specificity('div p .foo ::x'));
  assert.equal(specificity('*'), 0);
});

test('parseStylesheet: selector lists split, @media conditional skipped', () => {
  const rules = parseStylesheet(
    'h1, h2 { color: red } @media print { p { color: blue } } @media screen { b { color: green } }'
  );
  assert.deepEqual(rules.map((r) => r.selector), ['h1', 'h2', 'b']);
});

test('parseStylesheet: invalid css yields no rules instead of throwing', () => {
  assert.deepEqual(parseStylesheet('p { color: '), []);
  assert.deepEqual(parseStylesheet('} } {'), []);
});

test('parseInlineStyle: declarations with !important flag', () => {
  const decls = parseInlineStyle('color: red; margin-top: 4px !important');
  assert.equal(decls.length, 2);
  assert.equal(decls[1].important, true);
});

test('cascade: specificity beats order, inline style beats sheets', () => {
  const st = styleOf('<p class="a" style="font-weight: bold">x</p>', 'p', [
    '.a { color: green } p { color: red }'
  ]);
  assert.deepEqual(st.color, [0, 128 / 255, 0, 1]);
  assert.equal(st.fontWeight, 700);
});

test('cascade: !important wins over later normal declarations', () => {
  const st = styleOf('<p class=a>x</p>', 'p', ['p { color: red !important } .a { color: blue }']);
  assert.deepEqual(st.color, [1, 0, 0, 1]);
});

test('inheritance: font cascades down, margins do not', () => {
  const dom = parseDocument('<div style="font-size: 20px; margin: 10px"><p>x</p></div>');
  const styles = computeStyles(dom);
  const p = styles.get(selectAll('p', dom)[0]);
  assert.equal(p.fontSize, 20);
  assert.deepEqual(p.margin[1], { px: 0 });
  // UA p margins are 1em of the inherited size
  assert.deepEqual(p.margin[0], { px: 20 });
});

test('em resolves against the element own font-size after font-size applies', () => {
  const st = styleOf('<p style="font-size: 2em; padding-left: 1em">x</p>', 'p');
  assert.equal(st.fontSize, 32);
  assert.deepEqual(st.padding[3], { px: 32 });
});

test('UA sheet: headings, lists, links, pre get expected defaults', () => {
  const html = '<h1>t</h1><ul><li>i</li></ul><a href=x>l</a><pre>p</pre><b>b</b>';
  const dom = parseDocument(html);
  const styles = computeStyles(dom);
  const get = (sel) => styles.get(selectAll(sel, dom)[0]);
  assert.equal(get('h1').fontSize, 32);
  assert.equal(get('h1').fontWeight, 700);
  assert.equal(get('h1').display, 'block');
  assert.deepEqual(get('ul').padding[3], { px: 40 });
  assert.equal(get('li').display, 'list-item');
  assert.equal(get('a').textDecoration, 'underline');
  assert.equal(get('pre').whiteSpace, 'pre');
  assert.equal(get('b').fontWeight, 700);
  assert.equal(get('b').display, 'inline');
});

test('style/script elements are display: none', () => {
  const dom = parseDocument('<style>p{}</style><script>x</script><p>t</p>');
  const styles = computeStyles(dom);
  assert.equal(styles.get(selectAll('style', dom)[0]).display, 'none');
  assert.equal(styles.get(selectAll('script', dom)[0]).display, 'none');
});

test('shorthands: margin box expansion, border, flex', () => {
  const st = styleOf('<div style="margin: 1px 2px 3px; border: 2px dashed blue; flex: 2">x</div>', 'div');
  assert.deepEqual(st.margin, [{ px: 1 }, { px: 2 }, { px: 3 }, { px: 2 }]);
  assert.deepEqual(st.borderWidth, [2, 2, 2, 2]);
  assert.deepEqual(st.borderColor[0], [0, 0, 1, 1]);
  assert.equal(st.flexGrow, 2);
  assert.equal(st.flexShrink, 1);
  assert.deepEqual(st.flexBasis, { px: 0 });
});

test('border: none zeroes width; percent width and margin auto survive', () => {
  const st = styleOf('<div style="border: none; width: 50%; margin: 0 auto">x</div>', 'div');
  assert.deepEqual(st.borderWidth, [0, 0, 0, 0]);
  assert.deepEqual(st.width, { pct: 50 });
  assert.equal(st.margin[1], 'auto');
  assert.equal(st.margin[3], 'auto');
});

test('display values: flex, none, inline-block parse; unknown ignored', () => {
  assert.equal(styleOf('<div style="display: flex">x</div>', 'div').display, 'flex');
  assert.equal(styleOf('<div style="display: none">x</div>', 'div').display, 'none');
  assert.equal(styleOf('<div style="display: grid">x</div>', 'div').display, 'block');
});

test('img width/height attributes act as presentational hints', () => {
  const st = styleOf('<img src=x width=120 height=80>', 'img');
  assert.deepEqual(st.width, { px: 120 });
  assert.deepEqual(st.height, { px: 80 });
  // CSS overrides the attribute
  const st2 = styleOf('<img src=x width=120 style="width: 60px">', 'img');
  assert.deepEqual(st2.width, { px: 60 });
});

test('line-height: number, px and percent forms', () => {
  assert.deepEqual(styleOf('<p style="line-height: 1.5">x</p>', 'p').lineHeight, { mult: 1.5 });
  assert.deepEqual(styleOf('<p style="line-height: 24px">x</p>', 'p').lineHeight, { px: 24 });
  assert.deepEqual(styleOf('<p style="line-height: 150%">x</p>', 'p').lineHeight, { mult: 1.5 });
});
