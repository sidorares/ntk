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

// ---------------------------------------------------------------------------
// svg support: inline <svg> and <img> with an svg source

// minimal recording 2d context (transform-aware) for draw() assertions
function svgMockCtx() {
  const calls = [];
  const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
  ];
  return {
    calls,
    _m: [1, 0, 0, 1, 0, 0],
    _stack: [],
    fillStyle: null,
    strokeStyle: null,
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    font: '',
    textAlign: 'start',
    save() { this._stack.push({ m: this._m.slice() }); },
    restore() { const s = this._stack.pop(); if (s) this._m = s.m; },
    translate(x, y) { this._m = mul(this._m, [1, 0, 0, 1, x, y]); },
    scale(x, y = x) { this._m = mul(this._m, [x, 0, 0, y, 0, 0]); },
    transform(...a) { this._m = mul(this._m, a); },
    getTransform() { const [a, b, c, d, e, f] = this._m; return { a, b, c, d, e, f }; },
    fillRect(...a) { calls.push(['fillRect', ...a]); },
    fill(path, rule) { calls.push(['fill', path, rule, this.fillStyle, this._m.slice()]); },
    stroke(path) { calls.push(['stroke', path, this.strokeStyle]); },
    fillText(...a) { calls.push(['fillText', ...a]); },
    createLinearGradient(x1, y1, x2, y2) {
      return { type: 'linear', x1, y1, x2, y2, stops: [], addColorStop(o, c) { this.stops.push([o, c]); return this; } };
    },
    createRadialGradient() { return { stops: [], addColorStop(o, c) { this.stops.push([o, c]); return this; } }; }
  };
}

test('inline svg: sized from width/height attributes, first layout pass', needsFonts, () => {
  const view = layoutOf('<svg width="64" height="32" viewBox="0 0 8 4"><rect width="8" height="4"/></svg>');
  const svg = byName(view, 'svg')[0];
  assert.equal(svg.w, 64);
  assert.equal(svg.h, 32);
  const entry = view._images.get(svg.element);
  assert.ok(entry.svg, 'SvgView adopted synchronously');
});

test('inline svg: viewBox ratio drives sizing when width is styled', needsFonts, () => {
  const view = layoutOf('<svg viewBox="0 0 10 5" style="width: 200px"></svg>');
  const svg = byName(view, 'svg')[0];
  assert.equal(svg.w, 200);
  assert.equal(svg.h, 100, 'height follows the 2:1 viewBox ratio');
});

test('inline svg: shrinks ratio-preserving to the container width', needsFonts, () => {
  const view = layoutOf(
    '<div style="width: 100px; margin: 0"><svg width="200" height="100"><rect width="1" height="1"/></svg></div>'
  );
  const svg = byName(view, 'svg')[0];
  assert.equal(Math.round(svg.w), 100);
  assert.equal(Math.round(svg.h), 50);
});

test('inline svg: draws shapes through the context, scaled to the box', needsFonts, () => {
  const view = layoutOf(
    '<div style="margin: 0; padding: 0"><svg width="40" height="40" viewBox="0 0 4 4"><rect width="4" height="4" fill="#ff0000"/></svg></div>'
  );
  const ctx = svgMockCtx();
  view.draw(ctx, 0, 0);
  const fills = ctx.calls.filter((c) => c[0] === 'fill');
  assert.equal(fills.length, 1);
  assert.equal(fills[0][3], '#ff0000');
  const m = fills[0][4];
  assert.equal(m[0], 10, 'viewBox unit scaled 10x into the 40px box');
});

test('inline svg: html-lowercased camelCase (viewBox, linearGradient) still works', needsFonts, () => {
  const view = layoutOf(
    `<svg width="40" height="40" viewBox="0 0 4 4">
       <defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="4" y2="0">
         <stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/>
       </linearGradient></defs>
       <rect width="4" height="4" fill="url(#g)"/>
     </svg>`
  );
  const ctx = svgMockCtx();
  view.draw(ctx, 0, 0);
  const fill = ctx.calls.find((c) => c[0] === 'fill');
  assert.ok(fill, 'gradient-filled rect drew');
  assert.equal(fill[3].type, 'linear');
  assert.equal(fill[3].stops.length, 2);
  assert.equal(fill[3].x2, 40, 'userSpaceOnUse coords mapped through the 10x scale');
});

test('inline svg: display none hides it; children never join text flow', needsFonts, () => {
  const view = layoutOf(
    '<p style="margin:0">before<svg style="display: none" width="50" height="50"><title>tooltip text</title></svg>after</p>'
  );
  assert.equal(byName(view, 'svg').length, 0, 'display:none svg produces no box');
  const texts = find(view._root, (b) => b.kind === 'text');
  const spans = texts.flatMap((t) => t.spans ?? []).map((s) => s.text).join('');
  assert.ok(!spans.includes('tooltip'), 'svg children do not leak into text');
});

test('img: svg source via loadResource buffer is sniffed and adopted', needsFonts, async () => {
  const view = new HtmlView(null, {
    fonts,
    loadResource: async () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="60"><circle r="5"/></svg>')
  });
  view.setHtml('<img src="pic.svg">');
  await new Promise((r) => setTimeout(r, 20));
  view.layout(400);
  const img = byName(view, 'img')[0];
  const entry = view._images.get(img.element);
  assert.ok(entry.svg, 'sniffed as svg');
  assert.equal(entry.image, null);
  assert.equal(img.w, 30);
  assert.equal(img.h, 60);
});

test('img: data:image/svg+xml URI (utf8 and base64) loads', needsFonts, async () => {
  const svgText = '<svg width="24" height="24"><rect width="24" height="24" fill="#00ff00"/></svg>';
  const utf8 = 'data:image/svg+xml,' + encodeURIComponent(svgText);
  const b64 = 'data:image/svg+xml;base64,' + Buffer.from(svgText).toString('base64');
  for (const uri of [utf8, b64]) {
    const view = new HtmlView(null, { fonts });
    view.setHtml(`<img src="${uri}">`);
    await new Promise((r) => setTimeout(r, 20));
    view.layout(400);
    const img = byName(view, 'img')[0];
    assert.equal(img.w, 24, uri.slice(0, 30));
    assert.ok(view._images.get(img.element).svg);
  }
});

test('img: svg file loads through baseUrl and draws', needsFonts, async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'ntk-svg-'));
  await writeFile(join(dir, 'icon.svg'), '<svg viewBox="0 0 2 2" width="20" height="20"><rect width="2" height="2" fill="#0000ff"/></svg>');
  try {
    const view = new HtmlView(null, { fonts, baseUrl: dir });
    view.setHtml('<div style="margin:0;padding:0"><img src="icon.svg"></div>');
    await new Promise((r) => setTimeout(r, 30));
    view.layout(400);
    const img = byName(view, 'img')[0];
    assert.equal(img.w, 20);
    const ctx = svgMockCtx();
    view.draw(ctx, 0, 0);
    const fill = ctx.calls.find((c) => c[0] === 'fill');
    assert.equal(fill[3], '#0000ff');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('img: raster decoding is untouched by svg sniffing', needsFonts, async () => {
  const { PNG } = await import('pngjs');
  const png = new PNG({ width: 12, height: 8 });
  const view = new HtmlView(null, { fonts, loadResource: async () => PNG.sync.write(png) });
  view.setHtml('<img src="x.png">');
  await new Promise((r) => setTimeout(r, 20));
  view.layout(400);
  const entry = view._images.values().next().value;
  assert.ok(entry.image, 'decoded as raster');
  assert.equal(entry.svg, null);
  assert.equal(entry.image.width, 12);
});

test('standalone view fires onInvalidate when an image arrives', needsFonts, async () => {
  const { PNG } = await import('pngjs');
  const png = new PNG({ width: 16, height: 4 });
  let invalidated;
  const done = new Promise((r) => (invalidated = r));
  const view = new HtmlView(null, {
    fonts,
    loadResource: async () => PNG.sync.write(png),
    onInvalidate: invalidated
  });
  view.setHtml('<img src="x.png">');
  view.layout(400); // image still loading: no intrinsic size yet
  await done;
  view.layout(400);
  const img = byName(view, 'img')[0];
  assert.equal(img.w, 16, 'natural width after onInvalidate re-layout');
});
