// End-to-end smoke test against a real X server (Xvfb on CI, or whatever
// DISPLAY points at locally). Skipped when no server is reachable.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';

import { createClient } from '../lib/index.js';

const withTimeout = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${what}`)), ms).unref())
  ]);

let app = null;
let skip = false;

before(async () => {
  if (!process.env.DISPLAY) {
    skip = 'no DISPLAY set';
    return;
  }
  try {
    app = await withTimeout(createClient(), 5000, 'connecting to X server');
  } catch (err) {
    skip = `cannot connect to X server: ${err.message}`;
  }
});

after(async () => {
  if (app) await app.close();
});

test('connects and exposes screen info', (t) => {
  if (skip) return t.skip(skip);
  assert.ok(app.display.screen[0].root > 0);
  assert.ok(app.display.Render, 'render extension preloaded');
});

test('creates, maps and destroys a window', async (t) => {
  if (skip) return t.skip(skip);
  const wnd = app.createWindow({ width: 120, height: 80, title: 'ntk smoke' });
  assert.ok(wnd.id > 0);
  assert.equal(wnd.width, 120);

  const mapped = once(wnd, 'map');
  wnd.map();
  await withTimeout(mapped, 5000, 'MapNotify');

  wnd.destroy();
});

test('requestAnimationFrame paces frames against the server', async (t) => {
  if (skip) return t.skip(skip);
  const wnd = app.createWindow({ width: 60, height: 40, frameInterval: 0 });
  const stamps = [];
  await withTimeout(
    new Promise((resolve) => {
      const loop = (now) => {
        stamps.push(now);
        if (stamps.length >= 3) return resolve();
        wnd.requestAnimationFrame(loop);
      };
      wnd.requestAnimationFrame(loop);
    }),
    5000,
    'three animation frames'
  );
  assert.ok(stamps[0] <= stamps[1] && stamps[1] <= stamps[2], 'monotonic frame timestamps');
  assert.ok(typeof wnd.frameLatency === 'number' && wnd.frameLatency >= 0, 'fence round-trip measured');
  wnd.destroy();
});

test('2d context: fillRect pixels round-trip through the server', async (t) => {
  if (skip) return t.skip(skip);
  const pixmap = app.createPixmap({ width: 64, height: 64, depth: 24 });
  const ctx = pixmap.getContext('2d');

  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = 'red';
  ctx.fillRect(0, 0, 32, 32);

  const image = await ctx.getImageData(0, 0, 64, 64);

  const px = (x, y) => {
    const i = (y * 64 + x) * 4;
    return [image.data[i], image.data[i + 1], image.data[i + 2]];
  };
  assert.deepEqual(px(10, 10), [255, 0, 0], 'inside red rect');
  assert.deepEqual(px(50, 50), [255, 255, 255], 'outside red rect');

  pixmap.destroy();
});

test('2d context: gradients and paths render', async (t) => {
  if (skip) return t.skip(skip);
  const pixmap = app.createPixmap({ width: 64, height: 64, depth: 24 });
  const ctx = pixmap.getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, 64, 0);
  gradient.addColorStop(0, 'black');
  gradient.addColorStop(1, 'white');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);

  ctx.fillStyle = 'blue';
  ctx.beginPath();
  ctx.moveTo(8, 8);
  ctx.lineTo(56, 8);
  ctx.lineTo(32, 56);
  ctx.fill();

  const image = await ctx.getImageData(0, 0, 64, 64);
  // triangle centroid should be blue-dominant
  const i = (20 * 64 + 32) * 4;
  assert.ok(image.data[i + 2] > 200, `blue channel dominant, got ${image.data[i + 2]}`);
  assert.ok(image.data[i] < 100, 'red channel low inside triangle');

  pixmap.destroy();
});

const countDark = (image) => {
  let dark = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i] < 128 && image.data[i + 1] < 128 && image.data[i + 2] < 128) dark++;
  }
  return dark;
};

const readPixels = (ctx, w, h) => ctx.getImageData(0, 0, w, h);

test('text rendering: fillText draws shaped glyphs, measureText advances', async (t) => {
  if (skip) return t.skip(skip);
  try {
    app.fonts.match('sans-serif');
  } catch (err) {
    return t.skip(`no usable font: ${err.message}`);
  }

  const pixmap = app.createPixmap({ width: 128, height: 48, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 128, 48);

  ctx.font = '24px sans-serif';
  const metrics = ctx.measureText('Hello');
  assert.ok(metrics.width > 20, `measured width ${metrics.width}`);
  assert.ok(metrics.actualBoundingBoxAscent > 5, `ascent ${metrics.actualBoundingBoxAscent}`);
  assert.ok(metrics.fontBoundingBoxAscent >= metrics.actualBoundingBoxAscent);

  ctx.fillStyle = 'black';
  ctx.fillText('Hello', 4, 32);

  const darkPixels = countDark(await readPixels(ctx, 128, 48));
  assert.ok(darkPixels > 30, `expected drawn glyph pixels, got ${darkPixels} dark pixels`);

  pixmap.destroy();
});

test('text rendering: second draw reuses uploaded glyphs and still renders', async (t) => {
  if (skip) return t.skip(skip);
  try {
    app.fonts.match('sans-serif');
  } catch (err) {
    return t.skip(`no usable font: ${err.message}`);
  }

  const pixmap = app.createPixmap({ width: 128, height: 48, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.font = '24px sans-serif';
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 128, 48);
  ctx.fillStyle = 'black';
  // same glyphs as the previous test: glyph pages are cached per app, so
  // this draw sends only CompositeGlyphs (no AddGlyphs)
  ctx.fillText('Hello Hello', 2, 32);

  const darkPixels = countDark(await readPixels(ctx, 128, 48));
  assert.ok(darkPixels > 60, `expected two words drawn, got ${darkPixels} dark pixels`);

  pixmap.destroy();
});

test('text rendering: layoutText wraps to maxWidth and draws', async (t) => {
  if (skip) return t.skip(skip);
  try {
    app.fonts.match('sans-serif');
  } catch (err) {
    return t.skip(`no usable font: ${err.message}`);
  }

  const pixmap = app.createPixmap({ width: 160, height: 120, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.font = '16px sans-serif';
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 160, 120);

  const layout = ctx.layoutText('one two three four five six seven eight nine', {
    maxWidth: 150
  });
  assert.ok(layout.lines.length > 1, `expected wrapping, got ${layout.lines.length} line(s)`);
  for (const line of layout.lines) {
    assert.ok(line.width <= 150.5, `line width ${line.width} exceeds maxWidth`);
  }

  ctx.fillStyle = 'black';
  layout.draw(ctx, 0, 0);

  const darkPixels = countDark(await readPixels(ctx, 160, 120));
  assert.ok(darkPixels > 100, `expected multi-line text, got ${darkPixels} dark pixels`);

  pixmap.destroy();
});

test('backing store: window 2d context draws into backing pixmap', async (t) => {
  if (skip) return t.skip(skip);
  const wnd = app.createWindow({ width: 64, height: 64 });
  const ctx = wnd.getContext('2d');
  assert.ok(wnd._backing, 'backing pixmap allocated');
  assert.equal(ctx._target, wnd._backing, 'context bound to backing');

  // drawing works before the window is even mapped; getImageData reads the
  // backing pixmap so the result is deterministic
  ctx.fillStyle = 'red';
  ctx.fillRect(0, 0, 64, 64);
  const image = await ctx.getImageData(0, 0, 64, 64);
  assert.deepEqual([image.data[0], image.data[1], image.data[2]], [255, 0, 0]);

  wnd.destroy();
});

test('backing store: expose is served from cache without user redraw', async (t) => {
  if (skip) return t.skip(skip);
  const wnd = app.createWindow({ width: 64, height: 64 });
  const ctx = wnd.getContext('2d');
  ctx.fillStyle = 'blue';
  ctx.fillRect(0, 0, 64, 64); // backing now valid

  let exposeCalls = 0;
  wnd.on('expose', () => exposeCalls++);
  // synthesize a server Expose through the normal dispatch path
  wnd.emit('event', { type: 12, x: 0, y: 0, width: 64, height: 64, count: 0 });
  assert.equal(exposeCalls, 0, 'expose handler skipped, blit served from backing');

  wnd.destroy();
});

test('backing store: resize invalidates and requests one coalesced redraw', async (t) => {
  if (skip) return t.skip(skip);
  const wnd = app.createWindow({ width: 64, height: 64 });
  const ctx = wnd.getContext('2d');
  ctx.fillStyle = 'green';
  ctx.fillRect(0, 0, 64, 64);

  const draws = [];
  wnd.on('expose', (ev) => {
    draws.push([ev.width, ev.height]);
    ctx.fillRect(0, 0, wnd.width, wnd.height);
  });
  // a storm of ConfigureNotify events in one tick → a single redraw on the
  // next paced frame (which waits out the fence of the initial present)
  const redrawn = withTimeout(once(wnd, 'expose'), 5000, 'coalesced redraw');
  wnd.emit('event', { type: 22, x: 0, y: 0, width: 100, height: 80 });
  wnd.emit('event', { type: 22, x: 0, y: 0, width: 120, height: 90 });
  wnd.emit('event', { type: 22, x: 0, y: 0, width: 140, height: 100 });
  await redrawn;
  assert.deepEqual(draws, [[140, 100]], 'one redraw at the final size');
  assert.ok(wnd._backing.width >= 140 && wnd._backing.height >= 100, 'backing grew');

  wnd.destroy();
});

test('backing store: opt out keeps drawing direct', async (t) => {
  if (skip) return t.skip(skip);
  const wnd = app.createWindow({ width: 32, height: 32, backingStore: false });
  const ctx = wnd.getContext('2d');
  assert.equal(wnd._backing, null);
  assert.equal(ctx._target, wnd);
  wnd.destroy();
});

test('vector text: sizes above vectorFrom render via trapezoids', async (t) => {
  if (skip) return t.skip(skip);
  try {
    app.fonts.match('sans-serif');
  } catch (err) {
    return t.skip(`no usable font: ${err.message}`);
  }

  const pixmap = app.createPixmap({ width: 300, height: 300, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 300, 300);
  ctx.fillStyle = 'black';
  ctx.font = '280px sans-serif'; // > vectorFrom (256): routed to AddTraps
  ctx.fillText('R', 20, 260);

  const image = await readPixels(ctx, 300, 300);
  const darkPixels = countDark(image);
  assert.ok(darkPixels > 5000, `expected a filled 280px glyph, got ${darkPixels} dark pixels`);
  // no glyph page must have been created for the vector size
  for (const page of app._glyphPages?.values() ?? []) {
    assert.notEqual(page.size, 280, 'vector draw must not create a glyph page');
  }

  pixmap.destroy();
});

test('vector text: bitmap and vector paths draw the same glyphs consistently', async (t) => {
  if (skip) return t.skip(skip);
  try {
    app.fonts.match('sans-serif');
  } catch (err) {
    return t.skip(`no usable font: ${err.message}`);
  }

  const draw = async (policy) => {
    app.textPolicy = policy;
    const pixmap = app.createPixmap({ width: 300, height: 260, depth: 24 });
    const ctx = pixmap.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 300, 260);
    ctx.fillStyle = 'black';
    ctx.font = '200px sans-serif';
    ctx.fillText('Hg', 5, 200);
    const image = await readPixels(ctx, 300, 260);
    pixmap.destroy();
    return countDark(image);
  };

  const viaBitmap = await draw({ bitmapMax: 1000 });
  const viaVector = await draw({ bitmapMax: 1, vectorFrom: 2 });
  app.textPolicy = null;

  assert.ok(viaBitmap > 5000, `bitmap draw coverage ${viaBitmap}`);
  const ratio = viaVector / viaBitmap;
  assert.ok(ratio > 0.9 && ratio < 1.1, `coverage should agree, bitmap=${viaBitmap} vector=${viaVector}`);
});

test('vector text: fractional sizes render without quantizing', async (t) => {
  if (skip) return t.skip(skip);
  try {
    app.fonts.match('sans-serif');
  } catch (err) {
    return t.skip(`no usable font: ${err.message}`);
  }

  const pixmap = app.createPixmap({ width: 260, height: 260, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 260, 260);
  ctx.fillStyle = 'black';
  ctx.font = '200px sans-serif';
  const style = ctx._resolvedTextStyle();
  style.size = 200.5; // fractional: canvas shorthand parsing aside, the pipeline supports it
  ctx.fillText('E', 20, 220);

  const image = await readPixels(ctx, 260, 260);
  let bottom = -1;
  for (let y = 0; y < 260; y++) {
    for (let x = 0; x < 260; x++) {
      const i = (y * 260 + x) * 4;
      if (image.data[i] < 128) bottom = y;
    }
  }
  assert.ok(Math.abs(bottom - 220) <= 2, `glyph bottom ${bottom} should sit on the 220 baseline`);

  pixmap.destroy();
});

test('glyph page LRU: transient sizes are evicted under the cache budget', async (t) => {
  if (skip) return t.skip(skip);
  try {
    app.fonts.match('sans-serif');
  } catch (err) {
    return t.skip(`no usable font: ${err.message}`);
  }

  app.textPolicy = { cacheBytes: 200 * 1024 };
  const pixmap = app.createPixmap({ width: 220, height: 130, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 220, 130);
  ctx.fillStyle = 'black';
  for (let s = 20; s <= 90; s += 2) {
    ctx.font = `${s}px sans-serif`;
    ctx.fillText('Hamburgefonstiv', 2, 110);
  }
  let bytes = 0;
  for (const page of app._glyphPages.values()) bytes += page.bytes;
  assert.ok(bytes <= 200 * 1024, `cache stayed under budget: ${bytes}`);

  // and drawing with a previously evicted size still works (page recreated)
  ctx.font = '20px sans-serif';
  ctx.fillText('Hamburgefonstiv', 2, 40);
  const darkPixels = countDark(await readPixels(ctx, 220, 130));
  assert.ok(darkPixels > 100, `redraw after eviction, got ${darkPixels} dark pixels`);

  app.textPolicy = null;
  pixmap.destroy();
});

test('images: drawImage composites decoded PNG pixels, alpha blends', async (t) => {
  if (skip) return t.skip(skip);
  const { PNG } = await import('pngjs');
  const { decodeImage } = await import('../lib/image.js');

  // 2x2: red, green / blue, half-transparent black
  const png = new PNG({ width: 2, height: 2 });
  png.data.set([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 128]);
  const img = decodeImage(PNG.sync.write(png));

  const pixmap = app.createPixmap({ width: 8, height: 8, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 8, 8);
  ctx.drawImage(img, 1, 1);

  const image = await readPixels(ctx, 8, 8);
  const px = (x, y) => {
    const i = (y * 8 + x) * 4;
    return [image.data[i], image.data[i + 1], image.data[i + 2]];
  };
  assert.deepEqual(px(1, 1), [255, 0, 0], 'red pixel');
  assert.deepEqual(px(2, 1), [0, 255, 0], 'green pixel');
  assert.deepEqual(px(1, 2), [0, 0, 255], 'blue pixel');
  const blended = px(2, 2);
  assert.ok(blended.every((c) => c > 100 && c < 155), `half-alpha over white ≈ mid gray, got ${blended}`);
  assert.deepEqual(px(5, 5), [255, 255, 255], 'outside image untouched');

  img.destroy();
  pixmap.destroy();
});

test('images: drawImage scales server-side with filtering', async (t) => {
  if (skip) return t.skip(skip);
  const { PNG } = await import('pngjs');
  const { decodeImage } = await import('../lib/image.js');

  const png = new PNG({ width: 2, height: 2 });
  // all four pixels solid red
  for (let i = 0; i < 16; i += 4) png.data.set([255, 0, 0, 255], i);
  const img = decodeImage(PNG.sync.write(png));

  const pixmap = app.createPixmap({ width: 32, height: 32, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 32, 32);
  ctx.drawImage(img, 4, 4, 24, 24); // 2x2 -> 24x24

  const image = await readPixels(ctx, 32, 32);
  const at = (x, y) => (y * 32 + x) * 4;
  assert.ok(image.data[at(16, 16)] > 200, 'center scaled area red');
  assert.ok(image.data[at(16, 16) + 2] < 60, 'center blue channel low');
  assert.equal(image.data[at(1, 1)], 255, 'outside white');
  assert.equal(image.data[at(1, 1) + 2], 255, 'outside white');

  // second draw reuses the cached upload (no re-upload path errors)
  ctx.drawImage(img, 0, 0, 1, 1, 4, 4, 8, 8);

  img.destroy();
  pixmap.destroy();
});

test('tex: formulas draw with batched runs, rules and surd paths', async (t) => {
  if (skip) return t.skip(skip);
  const { layoutTex } = await import('../lib/widgets/tex.js');

  const pixmap = app.createPixmap({ width: 260, height: 120, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 260, 120);
  ctx.fillStyle = 'black';

  const box = layoutTex('\\sqrt{\\frac{a+b}{2}}', { size: 40, color: 'black' });
  assert.ok(box.width > 30 && box.height > 40, `box ${box.width}x${box.height}`);
  box.draw(ctx, 10, 10);

  const image = await readPixels(ctx, 260, 120);
  const darkPixels = countDark(image);
  assert.ok(darkPixels > 300, `expected formula ink, got ${darkPixels} dark pixels`);

  // the fraction line must be a solid horizontal dark row inside the box
  let bestRow = 0;
  for (let y = 10; y < 10 + box.height; y++) {
    let run = 0;
    let best = 0;
    for (let x = 10; x < 10 + box.width; x++) {
      const i = (y * 260 + x) * 4;
      run = image.data[i] < 128 ? run + 1 : 0;
      if (run > best) best = run;
    }
    if (best > bestRow) bestRow = best;
  }
  assert.ok(bestRow > box.width * 0.5, `longest dark row ${bestRow} vs width ${box.width}`);

  pixmap.destroy();
});

test('markdown: highlighted fences and math fences render', async (t) => {
  if (skip) return t.skip(skip);
  try {
    app.fonts.match('sans-serif');
  } catch (err) {
    return t.skip(`no usable font: ${err.message}`);
  }

  const { MarkdownView } = await import('../lib/index.js');
  const pixmap = app.createPixmap({ width: 320, height: 300, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 320, 300);

  const view = new MarkdownView(null, { fonts: app.fonts });
  view.setMarkdown(
    '```js\nconst x = "str"; // note\n```\n\n```math\n\\frac{a}{b}\n```\n'
  );
  view.layout(320);
  const texItems = view._items.filter((i) => i.kind === 'tex');
  assert.equal(texItems.length, 1, 'math fence became a formula');
  view.draw(ctx, 0, 0);

  const image = await readPixels(ctx, 320, 300);
  // count colored (non-gray) pixels: syntax highlighting produces them
  let colored = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const [b, g, r] = [image.data[i], image.data[i + 1], image.data[i + 2]];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 60) colored++;
  }
  assert.ok(colored > 50, `expected syntax colors, got ${colored} colored pixels`);
  assert.ok(countDark(image) > 50, 'formula/code ink present');

  pixmap.destroy();
});

test('markdown: invalid math falls back to a plain code block', async (t) => {
  if (skip) return t.skip(skip);
  try {
    app.fonts.match('sans-serif');
  } catch (err) {
    return t.skip(`no usable font: ${err.message}`);
  }

  const { MarkdownView } = await import('../lib/index.js');
  const view = new MarkdownView(null, { fonts: app.fonts });
  view.setMarkdown('```math\n\\frac{unclosed\n```\n');
  view.layout(300);
  assert.equal(view._items.filter((i) => i.kind === 'tex').length, 0);
  assert.ok(view._items.some((i) => i.kind === 'text'), 'rendered as code text instead');
});

test('markdown: links record hit rectangles and linkAt resolves them', async (t) => {
  if (skip) return t.skip(skip);
  try {
    app.fonts.match('sans-serif');
  } catch (err) {
    return t.skip(`no usable font: ${err.message}`);
  }

  const { MarkdownView } = await import('../lib/index.js');
  const pixmap = app.createPixmap({ width: 300, height: 120, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 300, 120);

  const view = new MarkdownView(null, { fonts: app.fonts });
  view.setMarkdown('plain [a link](target.md) more **[bold link](other.md)**');
  view.layout(300);
  view.draw(ctx, 10, 20);

  const hrefs = new Set(view._links.map((l) => l.href));
  assert.deepEqual([...hrefs].sort(), ['other.md', 'target.md']);
  const l = view._links.find((x) => x.href === 'target.md');
  assert.equal(view.linkAt(l.x + l.w / 2, l.y + l.h / 2), 'target.md');
  assert.equal(view.linkAt(1, 1), null, 'outside any link');

  // link underlines actually draw (colored pixels under the link baseline)
  const image = await readPixels(ctx, 300, 120);
  let blueish = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 2] > 140 && image.data[i] < 100) blueish++;
  }
  assert.ok(blueish > 20, `expected link color/underline pixels, got ${blueish}`);

  pixmap.destroy();
});

test('html: HtmlView renders backgrounds, borders, text, links and images', async (t) => {
  if (skip) return t.skip(skip);
  try {
    app.fonts.match('sans-serif');
  } catch (err) {
    return t.skip(`no usable font: ${err.message}`);
  }

  const { HtmlView } = await import('../lib/index.js');
  const { PNG } = await import('pngjs');
  const png = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < 64; i += 4) png.data.set([0, 180, 0, 255], i);
  const dataUri = 'data:image/png;base64,' + PNG.sync.write(png).toString('base64');

  const pixmap = app.createPixmap({ width: 320, height: 300, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 320, 300);

  const view = new HtmlView(null, { fonts: app.fonts });
  view.setHtml(`
    <div style="background: #2244cc; height: 20px; margin: 0"></div>
    <div style="border: 3px solid #cc2222; padding: 6px; margin: 0">
      <p style="margin: 0">Text with <a href="go.html">a link</a> inside.</p>
    </div>
    <img src="${dataUri}" width="40" height="20">
  `);
  await new Promise((resolve) => setTimeout(resolve, 30)); // data-uri decode
  const height = view.layout(320);
  assert.ok(height > 40, `content height ${height}`);
  view.draw(ctx, 0, 0);

  const image = await readPixels(ctx, 320, 300);
  const px = (x, y) => {
    const i = (y * 320 + x) * 4;
    return [image.data[i], image.data[i + 1], image.data[i + 2]];
  };
  assert.deepEqual(px(10, 10), [0x22, 0x44, 0xcc], 'background div');
  assert.deepEqual(px(1, 21), [0xcc, 0x22, 0x22], 'border left edge');
  assert.ok(countDark(image) > 30, 'text ink present');

  // link recorded (one rect per shaped run) and hit-testable
  assert.ok(view._links.length >= 1);
  assert.ok(view._links.every((x) => x.href === 'go.html'));
  const l = view._links[0];
  assert.equal(view.linkAt(l.x + l.w / 2, l.y + l.h / 2).href, 'go.html');
  assert.equal(view.linkAt(0, 0), null);

  // image drawn at attribute size below the bordered block
  const imgBox = (function findImg(b) {
    if (b.kind === 'image') return b;
    for (const c of b.children) {
      const r = findImg(c);
      if (r) return r;
    }
    return null;
  })(view._root);
  assert.equal(imgBox.w, 40);
  assert.deepEqual(px(Math.round(imgBox.x + 20), Math.round(imgBox.y + 10)), [0, 180, 0], 'image pixels');

  view.destroy();
  pixmap.destroy();
});

test('markdown widget renders into a window-less pixmap context', async (t) => {
  if (skip) return t.skip(skip);
  try {
    app.fonts.match('sans-serif');
  } catch (err) {
    return t.skip(`no usable font: ${err.message}`);
  }

  const { MarkdownView } = await import('../lib/index.js');
  const pixmap = app.createPixmap({ width: 200, height: 200, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 200, 200);

  const view = new MarkdownView(null, { fonts: app.fonts });
  view.setMarkdown('# Title\n\nBody with **bold** and `code`.\n\n- a\n- b');
  const height = view.layout(200);
  assert.ok(height > 60, `content height ${height}`);
  view.draw(ctx, 0, 0);

  const darkPixels = countDark(await readPixels(ctx, 200, 200));
  assert.ok(darkPixels > 100, `expected markdown text drawn, got ${darkPixels} dark pixels`);

  pixmap.destroy();
});
