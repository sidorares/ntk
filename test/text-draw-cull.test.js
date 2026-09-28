// A layout taller than the surface it is drawn on draws only the lines the
// surface can show: a code block of twenty thousand lines in a scroll pane
// built, sent and had the server clip every line of itself on every paint
// (`TextLayout.draw`, `visibleRows`). The pixels are the same either way,
// which is what most of this asserts.
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';

const { createServer, createStreamPair } = xserver;
const require = createRequire(import.meta.url);
const fontDir = join(dirname(require.resolve('katex/package.json')), 'dist', 'fonts');

const N = 200;

let server = null;
let app = null;
let layout = null;
let reference = null;

before(async () => {
  server = createServer({ width: 200, height: 200 });
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);
  const source = new StaticFontSource();
  source.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), { family: 'Test Main' });
  source.alias('sans-serif', 'Test Main');
  app = await createClient({ stream: clientEnd, fontSource: source });

  layout = tallLayout(N);
  assert.ok(layout.lines.length >= N, `${layout.lines.length} lines`);
  // the whole layout on one surface: every line is on it, so nothing is
  // skipped, and every other drawing is compared with a window of this one
  const ctx = surface(Math.ceil(layout.height) + 20);
  layout.draw(ctx, 4, 10);
  reference = await ctx.getImageData(0, 0, W, Math.ceil(layout.height) + 20);
});

after(async () => {
  if (app) await app.close();
});

const W = 120;
const H = 50;

function surface(height) {
  const pixmap = app.createPixmap({ width: W, height, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, height);
  return ctx;
}

/** A paragraph of `n` short lines, each its own colour run every few lines. */
function tallLayout(n) {
  const spans = [];
  for (let i = 0; i < n; i++) {
    const color = i % 3 === 0 ? 'black' : i % 3 === 1 ? '#a00000' : '#0000a0';
    spans.push({ text: `${i} Wgjy|Å${i % 10}\n`, family: 'sans-serif', size: 16, color });
  }
  return app.fonts.layout(spans, { family: 'sans-serif', size: 16 });
}

/** How many lines `layout.draw` hands the context runs of, over `draw`. */
function linesSent(ctx, draw) {
  const inner = ctx.drawGlyphs;
  const baselines = new Set();
  ctx.drawGlyphs = function (op, src, positioned) {
    for (const p of positioned) baselines.add(p.y);
    return inner.call(this, op, src, positioned);
  };
  try {
    draw();
  } finally {
    ctx.drawGlyphs = inner;
  }
  return baselines.size;
}

function rows(image, from, count) {
  return Buffer.from(image.data.buffer, image.data.byteOffset + from * W * 4, count * W * 4);
}

function sameRows(actual, expected, what) {
  if (Buffer.compare(actual, expected) === 0) return;
  for (let i = 0; i < actual.length; i += 4) {
    if (actual.readUInt32LE(i) !== expected.readUInt32LE(i)) {
      const px = i / 4;
      assert.fail(`${what}: first difference at x=${px % W}, row ${Math.floor(px / W)}`);
    }
  }
}

test('a surface scrolled anywhere over the layout shows what the whole of it drew', async () => {
  const tall = Math.ceil(layout.height) + 20;
  for (const offset of [0, 7, 331, 1234, 2001, tall - H]) {
    // the layout placed with the scroll in its y, as a scroll pane draws
    const placed = surface(H);
    const sent = linesSent(placed, () => layout.draw(placed, 4, 10 - offset));
    const image = await placed.getImageData(0, 0, W, H);
    sameRows(rows(image, 0, H), rows(reference, offset, H), `y ${10 - offset}`);
    assert.ok(sent <= 10, `${sent} of ${N} lines sent for a surface ${H}px tall`);

    // and with the scroll in a translation, which is the same place
    const translated = surface(H);
    translated.translate(0, -offset);
    layout.draw(translated, 4, 10);
    const image2 = await translated.getImageData(0, 0, W, H);
    sameRows(rows(image2, 0, H), rows(reference, offset, H), `translated by ${-offset}`);
  }
});

test('under a clip, only the clip rows are drawn, and they are drawn right', async () => {
  const offset = 1500;
  const ctx = surface(H);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 18, W, 9);
  ctx.clip();
  const sent = linesSent(ctx, () => layout.draw(ctx, 4, 10 - offset));
  ctx.restore();
  const image = await ctx.getImageData(0, 0, W, H);
  sameRows(rows(image, 18, 9), rows(reference, offset + 18, 9), 'the clip rows');
  const white = Buffer.alloc(18 * W * 4, 0xff);
  const top = rows(image, 0, 18);
  for (let i = 0; i < top.length; i += 4) top[i + 3] = 0xff; // alpha is not ours to judge
  sameRows(top, white, 'above the clip');
  assert.ok(sent <= 7, `${sent} of ${N} lines sent for a clip 9px tall`);
});

// the lines with glyphs on them: the one after the last newline has none
const inked = (l) => l.lines.filter((line) => line.runs.length).length;

test('a layout that fits sends every line, as before', () => {
  const small = tallLayout(2);
  const ctx = surface(H);
  assert.equal(
    linesSent(ctx, () => small.draw(ctx, 4, 4)),
    inked(small),
  );
});

test('a shadow, or a transform that is more than a translation, draws every line', () => {
  const shadowed = surface(H);
  shadowed.shadowColor = 'rgba(0, 0, 0, 0.5)';
  shadowed.shadowOffsetY = 400;
  // a line far above the surface casts its shadow onto it
  assert.equal(linesSent(shadowed, () => layout.draw(shadowed, 4, -800)), inked(layout));

  const scaled = surface(H);
  scaled.scale(1, 0.5);
  assert.equal(linesSent(scaled, () => layout.draw(scaled, 4, -800)), inked(layout));
});
