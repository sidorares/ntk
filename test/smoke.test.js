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

test('text rendering: fillText draws glyphs, measureText advances', async (t) => {
  if (skip) return t.skip(skip);
  let match;
  try {
    const { listFontsSync } = await import('../lib/fontconfig.js');
    match = listFontsSync({ family: 'sans-serif', style: 'normal', weight: 'normal' });
  } catch (err) {
    return t.skip(`no usable font: ${err.message}`);
  }

  const pixmap = app.createPixmap({ width: 128, height: 48, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 128, 48);

  const gs = ctx.loadFont(match.path, 24);
  ctx.setFont(gs);

  const metrics = ctx.measureText('Hello');
  assert.ok(metrics.width > 20, `measured width ${metrics.width}`);
  assert.ok(metrics.height > 5, `measured height ${metrics.height}`);

  ctx.fillStyle = 'black';
  ctx.fillText('Hello', 4, 32);

  const image = await new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, 128, 48, (err, data) => (err ? reject(err) : resolve(data)))
  );
  let darkPixels = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i] < 128 && image.data[i + 1] < 128 && image.data[i + 2] < 128) darkPixels++;
  }
  assert.ok(darkPixels > 30, `expected drawn glyph pixels, got ${darkPixels} dark pixels`);

  pixmap.destroy();
});
