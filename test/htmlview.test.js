// Headless HtmlView tests: box tree construction and yoga layout (no X
// server; needs fontconfig for text measurement).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

import FontManager from '../lib/text/fontmanager.js';
import HtmlView from '../lib/widgets/htmlview.js';

let hasFontconfig = true;
try {
  execFileSync('fc-match', ['--version'], { stdio: 'ignore' });
} catch {
  hasFontconfig = false;
}
const needsFonts = { skip: !hasFontconfig && 'fc-match not installed' };

const fonts = hasFontconfig ? new FontManager() : null;

const layoutOf = (html, width = 400, opts = {}) => {
  const view = new HtmlView(null, { fonts, ...opts });
  view.setHtml(html);
  view.layout(width);
  return view;
};

const find = (box, pred, out = []) => {
  if (pred(box)) out.push(box);
  for (const c of box.children) find(c, pred, out);
  return out;
};
const byName = (view, name) => find(view._root, (b) => b.element?.name === name);

test('block flow: paragraphs stack with collapsed margins', needsFonts, () => {
  const view = layoutOf('<p>one</p><p>two</p>');
  const [p1, p2] = byName(view, 'p');
  assert.ok(p1.h > 0);
  // adjacent 1em margins collapse: gap is 16, not 32
  assert.equal(Math.round(p2.y - (p1.y + p1.h)), 16);
  assert.equal(p1.w, 400);
});

test('flex: row children split available width by flex-grow', needsFonts, () => {
  const view = layoutOf(
    `<div style="display: flex">
       <div id=a style="flex: 1">a</div>
       <div id=b style="flex: 3">b</div>
     </div>`
  );
  const divs = byName(view, 'div');
  const a = divs.find((b) => b.element.attribs.id === 'a');
  const b = divs.find((b) => b.element.attribs.id === 'b');
  assert.equal(Math.round(a.w), 100);
  assert.equal(Math.round(b.w), 300);
  assert.equal(a.y, b.y, 'row children share the top edge');
});

test('text wraps to the container and grows content height', needsFonts, () => {
  const wide = layoutOf('<p>' + 'word '.repeat(40) + '</p>', 600);
  const narrow = layoutOf('<p>' + 'word '.repeat(40) + '</p>', 150);
  assert.ok(narrow.contentHeight > wide.contentHeight * 2);
});

test('white-space: pre keeps line structure; nowrap keeps one line', needsFonts, () => {
  const view = layoutOf('<pre>a\nb\nc</pre><p style="white-space: nowrap">x '.repeat(30) + '</p>', 120);
  const pre = byName(view, 'pre')[0];
  const p = byName(view, 'p')[0];
  const preText = find(pre, (b) => b.kind === 'text')[0];
  const layout = view._textLayout(preText, preText.w);
  assert.equal(layout.lines.length, 3);
  const pText = find(p, (b) => b.kind === 'text')[0];
  assert.equal(view._textLayout(pText, pText.w).lines.length, 1);
});

test('display: none subtrees produce no boxes', needsFonts, () => {
  const view = layoutOf('<div style="display: none"><p>hidden</p></div><p>shown</p>');
  assert.equal(byName(view, 'p').length, 1);
});

test('inline elements merge into one text box; blocks split runs', needsFonts, () => {
  const view = layoutOf('<div>start <b>bold</b> end<p>block</p>tail</div>');
  const div = byName(view, 'div')[0];
  const kinds = div.children.map((b) => b.kind + (b.element ? ':' + b.element.name : ''));
  assert.deepEqual(kinds, ['text', 'container:p', 'text']);
  const spans = div.children[0].spans;
  assert.deepEqual(spans.map((s) => s.text), ['start ', 'bold', ' end']);
  assert.equal(spans[1].weight, 700);
});

test('img: attribute size without a loaded resource', needsFonts, () => {
  const view = layoutOf('<img src="missing.png" width=100 height=50>');
  const img = byName(view, 'img')[0];
  assert.equal(img.w, 100);
  assert.equal(img.h, 50);
});

test('img: data URI loads, natural size, shrinks to container width', needsFonts, async () => {
  const { PNG } = await import('pngjs');
  const png = new PNG({ width: 200, height: 100 });
  const uri = 'data:image/png;base64,' + PNG.sync.write(png).toString('base64');
  const view = new HtmlView(null, { fonts });
  view.setHtml(`<div style="width: 100px; margin: 0"><img src="${uri}"></div>`);
  await new Promise((r) => setTimeout(r, 20));
  view.layout(400);
  const img = byName(view, 'img')[0];
  assert.equal(Math.round(img.w), 100, 'clamped to container');
  assert.equal(Math.round(img.h), 50, 'aspect ratio preserved');
});

test('images: no baseUrl means relative sources do not load', needsFonts, async () => {
  const view = new HtmlView(null, { fonts });
  view.setHtml('<img src="../../etc/passwd">');
  await new Promise((r) => setTimeout(r, 20));
  const entry = view._images.values().next().value;
  assert.equal(entry.image, null);
});

test('images: custom loadResource hook is used and can veto', needsFonts, async () => {
  const asked = [];
  const view = new HtmlView(null, {
    fonts,
    loadResource: async (url) => {
      asked.push(url);
      return null;
    }
  });
  view.setHtml('<img src="http://example.com/x.png">');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(asked, ['http://example.com/x.png']);
});

test('list markers: ordered items get sequential indices', needsFonts, () => {
  const view = layoutOf('<ol><li>a</li><li>b</li><li>c</li></ol>');
  const lis = byName(view, 'li');
  assert.deepEqual(lis.map((b) => b.style._liIndex), [1, 2, 3]);
  assert.equal(lis[0].style.listStyleType, 'decimal');
});

test('document styles from <style> tags apply', needsFonts, () => {
  const view = layoutOf('<style>p { margin: 0; padding: 25px }</style><p>x</p>');
  const p = byName(view, 'p')[0];
  const text = find(p, (b) => b.kind === 'text')[0];
  assert.equal(text.x - p.x, 25);
});

test('user stylesheet option cascades after document styles', needsFonts, () => {
  const view = new HtmlView(null, { fonts, stylesheet: 'p { padding-left: 30px; margin: 0 }' });
  view.setHtml('<p>x</p>');
  view.layout(300);
  const p = byName(view, 'p')[0];
  const text = find(p, (b) => b.kind === 'text')[0];
  assert.equal(text.x - p.x, 30);
});

test('elementAt: finds the deepest element for a point', needsFonts, () => {
  const view = layoutOf('<div style="padding: 20px; margin: 0"><p style="margin: 0">x</p></div>');
  const p = byName(view, 'p')[0];
  assert.equal(view.elementAt(p.x + 2, p.y + 2)?.name, 'p');
  assert.equal(view.elementAt(2, 2)?.name, 'div');
  assert.equal(view.elementAt(9999, 2), null);
});

test('setHtml twice replaces the document cleanly', needsFonts, () => {
  const view = layoutOf('<p>one</p>');
  assert.equal(byName(view, 'p').length, 1);
  view.setHtml('<h2>two</h2>');
  view.layout(400);
  assert.equal(byName(view, 'p').length, 0);
  assert.equal(byName(view, 'h2').length, 1);
  view.destroy();
});
