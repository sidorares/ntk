// TextLayout.coverage(): how much of each pixel a layout's glyphs cover, one
// byte a pixel, without drawing them anywhere — what a GL surface's label
// atlas makes a distance field from (react-x11#673). No display: the outlines
// go through the same analytic rasterizer glyph bitmaps do, into a buffer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import FontManager from '../lib/text/fontmanager.js';
import { StaticFontSource } from '../lib/text/fontsource.js';
import { TextLayout } from '../lib/text/layout.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'MonelogicsSubset[wght].ttf');

function fonts() {
  const source = new StaticFontSource();
  source.add(readFileSync(FIXTURE), { family: 'Test' });
  source.alias('sans-serif', 'Test');
  return new FontManager({ source });
}

const layoutOf = (text, size = 24) => new TextLayout(fonts(), [{ text }], { family: 'Test', size });

/** The rows and columns that hold any coverage. */
function inkBounds({ width, height, data }) {
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x] === 0) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return { left, right, top, bottom };
}

test('the raster is the layout box in whole pixels, with pad round it', () => {
  const layout = layoutOf('Hamburg');
  const plain = layout.coverage();
  assert.equal(plain.width, Math.ceil(layout.width));
  assert.equal(plain.height, Math.ceil(layout.height));
  assert.equal(plain.data.length, plain.width * plain.height);
  const padded = layout.coverage({ pad: 5 });
  assert.equal(padded.width, plain.width + 10);
  assert.equal(padded.height, plain.height + 10);
  // The layout's origin is at (pad, pad): the same ink, moved by the pad.
  const a = inkBounds(plain);
  const b = inkBounds(padded);
  assert.deepEqual(
    [b.left - 5, b.right - 5, b.top - 5, b.bottom - 5],
    [a.left, a.right, a.top, a.bottom],
  );
  assert.ok(b.top > 0 && b.left > 0, 'nothing reaches the pad at the top or the left');
});

test('it is the glyphs’ own coverage: grey at the edges, whole inside', () => {
  const { data } = layoutOf('Hamburg', 32).coverage({ pad: 2 });
  let full = 0;
  let edge = 0;
  for (const a of data) {
    if (a === 255) full++;
    else if (a > 0) edge++;
  }
  assert.ok(full > 50, `pixels wholly inside the stems: ${full}`);
  assert.ok(edge > 50, `antialiased edge pixels: ${edge}`);
});

test('glyphs sit where the shaped runs put them, unrounded', () => {
  // The coverage of a layout is the sum of its glyphs' outlines wherever
  // they are, so its total ink is the glyphs' total area — the same as the
  // bitmaps each glyph rasterizes to on its own, whatever fraction of a
  // pixel each one sits at.
  const layout = layoutOf('Hamburg', 20);
  const { data } = layout.coverage({ pad: 2 });
  const total = data.reduce((s, a) => s + a, 0);
  let expected = 0;
  for (const line of layout.lines) {
    for (const r of line.runs) {
      for (const g of r.run.glyphs) {
        const bitmap = r.run.font.rasterize(g.id, r.run.size);
        if (bitmap) expected += bitmap.data.reduce((s, a) => s + a, 0);
      }
    }
  }
  assert.ok(expected > 0, 'precondition: the glyphs have ink');
  assert.ok(
    Math.abs(total - expected) / expected < 0.01,
    `layout ink ${total} against the glyphs' own ${expected}`,
  );
});

test('every line is covered, at its own baseline', () => {
  const layout = new TextLayout(fonts(), [{ text: 'one\ntwo' }], { family: 'Test', size: 20 });
  assert.equal(layout.lines.length, 2, 'precondition: two lines');
  const coverage = layout.coverage();
  const rowInk = (y0, y1) => {
    let s = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < coverage.width; x++) s += coverage.data[y * coverage.width + x];
    return s;
  };
  const middle = Math.round(layout.lines[1].y);
  assert.ok(rowInk(0, middle) > 0, 'the first line has ink');
  assert.ok(rowInk(middle, coverage.height) > 0, 'and so does the second');
});

test('an empty layout covers nothing', () => {
  const coverage = layoutOf('').coverage({ pad: 3 });
  if (coverage) assert.ok(coverage.data.every((a) => a === 0));
});
