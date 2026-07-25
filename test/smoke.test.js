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

test('2d context: fillRect pixels round-trip through the server', async (t) => {
  if (skip) return t.skip(skip);
  const pixmap = app.createPixmap({ width: 64, height: 64, depth: 24 });
  const ctx = pixmap.getContext('2d');

  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = 'red';
  ctx.fillRect(0, 0, 32, 32);

  const image = await new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, 64, 64, (err, data) => (err ? reject(err) : resolve(data)))
  );

  const px = (x, y) => {
    const i = (y * 64 + x) * 4; // BGRA
    return [image.data[i + 2], image.data[i + 1], image.data[i]];
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

  const image = await new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, 64, 64, (err, data) => (err ? reject(err) : resolve(data)))
  );
  // triangle centroid should be blue-dominant
  const i = (20 * 64 + 32) * 4;
  assert.ok(image.data[i] > 200, `blue channel dominant, got ${image.data[i]}`);
  assert.ok(image.data[i + 2] < 100, 'red channel low inside triangle');

  pixmap.destroy();
});

const countDark = (image) => {
  let dark = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i] < 128 && image.data[i + 1] < 128 && image.data[i + 2] < 128) dark++;
  }
  return dark;
};

const readPixels = (ctx, w, h) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, w, h, (err, data) => (err ? reject(err) : resolve(data)))
  );

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
  const image = await new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, 64, 64, (err, data) => (err ? reject(err) : resolve(data)))
  );
  assert.deepEqual([image.data[2], image.data[1], image.data[0]], [255, 0, 0]);

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
  // a storm of ConfigureNotify events in one tick → a single redraw
  wnd.emit('event', { type: 22, x: 0, y: 0, width: 100, height: 80 });
  wnd.emit('event', { type: 22, x: 0, y: 0, width: 120, height: 90 });
  wnd.emit('event', { type: 22, x: 0, y: 0, width: 140, height: 100 });
  await new Promise((resolve) => setImmediate(resolve));
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
