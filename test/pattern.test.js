// ctx.createPattern: a tile repeated by the server as one composite, in
// place of the caller drawing thousands of little subpaths that rasterize
// client-side into a pane-sized coverage mask (issue #263).
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed. It
// implements the two things this rests on — Repeat on a source picture and
// SetPictureTransform — so the tiling can be asserted pixel by pixel.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { CanvasPattern, Image, StaticFontSource, Surface, createClient } from '../lib/index.js';

const docsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');

let app = null;
const W = 64;
const H = 64;

const RED = [255, 0, 0];
const BLUE = [0, 0, 255];
const WHITE = [255, 255, 255];

before(async () => {
  const server = xserver.createServer({ width: 200, height: 200 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  app = await createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
});

after(async () => {
  if (app) await app.close();
});

/** a fresh context painted opaque white, so every test owns its pixels */
function freshCtx() {
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H);
  return ctx;
}

/**
 * A 4x4 tile: red in the top-left 2x2, blue in the bottom-right 2x2, the
 * other two quadrants transparent. Every quadrant tells the phase of the
 * tiling apart from every other, which is what these tests read off.
 */
function checkerTile(size = 4) {
  const half = size / 2;
  const tile = new Surface(app, { width: size, height: size });
  tile.render((c) => {
    c.fillStyle = 'red';
    c.fillRect(0, 0, half, half);
    c.fillStyle = 'blue';
    c.fillRect(half, half, half, half);
  });
  return tile;
}

const pixels = async (ctx) => {
  const img = await ctx.getImageData(0, 0, W, H);
  return (x, y) => [...img.data.slice((y * W + x) * 4, (y * W + x) * 4 + 3)];
};

test('a repeating tile fills the whole rectangle', async () => {
  const ctx = freshCtx();
  const tile = checkerTile();
  ctx.fillStyle = ctx.createPattern(tile, 'repeat');
  ctx.fillRect(0, 0, W, H);

  const at = await pixels(ctx);
  // every 4x4 cell repeats the tile: (0,0) red, (2,2) blue, (2,0) untouched
  for (const [ox, oy] of [
    [0, 0],
    [16, 0],
    [0, 20],
    [60, 60],
  ]) {
    assert.deepEqual(at(ox, oy), RED, `red quadrant of the tile at ${ox},${oy}`);
    assert.deepEqual(at(ox + 2, oy + 2), BLUE, `blue quadrant at ${ox},${oy}`);
    assert.deepEqual(at(ox + 2, oy), WHITE, `transparent quadrant at ${ox},${oy}`);
  }
  tile.destroy();
});

test('tiling is anchored in user space, not to the rectangle being filled', async () => {
  const ctx = freshCtx();
  const tile = checkerTile();
  ctx.fillStyle = ctx.createPattern(tile, 'repeat');
  // a rect starting mid-tile shows the phase of the surface grid, exactly as
  // a background grid must when it is repainted one damaged strip at a time
  ctx.fillRect(2, 2, 8, 8);

  const at = await pixels(ctx);
  assert.deepEqual(at(2, 2), BLUE, 'the rect starts on the tile blue quadrant');
  assert.deepEqual(at(4, 4), RED, 'and picks up the next tile at 4,4');
  assert.deepEqual(at(1, 1), WHITE, 'nothing outside the rect was touched');
  tile.destroy();
});

test("'no-repeat' places one tile and leaves the rest of the fill alone", async () => {
  const ctx = freshCtx();
  const tile = checkerTile();
  ctx.fillStyle = ctx.createPattern(tile, 'no-repeat');
  ctx.fillRect(0, 0, W, H);

  const at = await pixels(ctx);
  assert.deepEqual(at(0, 0), RED, 'the one tile is painted');
  assert.deepEqual(at(3, 3), BLUE);
  assert.deepEqual(at(4, 0), WHITE, 'and does not repeat');
  assert.deepEqual(at(0, 4), WHITE);
  tile.destroy();
});

test("'pad' extends the edge pixels, 'reflect' mirrors every other tile", async () => {
  const tile = checkerTile();

  const pad = freshCtx();
  pad.fillStyle = pad.createPattern(tile, 'pad');
  pad.fillRect(0, 0, W, H);
  const padded = await pixels(pad);
  assert.deepEqual(padded(0, 0), RED, 'the tile itself');
  assert.deepEqual(padded(20, 1), WHITE, 'the top-right quadrant is transparent, and stays so');
  assert.deepEqual(padded(20, 3), BLUE, 'the bottom-right edge pixel is held past the tile');

  const reflect = freshCtx();
  reflect.fillStyle = reflect.createPattern(tile, 'reflect');
  reflect.fillRect(0, 0, W, H);
  const mirrored = await pixels(reflect);
  assert.deepEqual(mirrored(0, 0), RED);
  // x in [4,8) mirrors x in [0,4): column 7 samples column 0
  assert.deepEqual(mirrored(7, 0), RED, 'the next tile across is mirrored');
  assert.deepEqual(mirrored(4, 0), WHITE, 'and column 4 samples column 3');
  tile.destroy();
});

test('setTransform moves the tile, which is how a grid follows a scroll', async () => {
  const ctx = freshCtx();
  const tile = checkerTile();
  const pattern = ctx.createPattern(tile, 'repeat');
  pattern.setTransform([1, 0, 0, 1, 2, 1]);
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, W, H);

  const at = await pixels(ctx);
  assert.deepEqual(at(2, 1), RED, 'the tile origin moved to (2,1)');
  assert.deepEqual(at(0, 0), BLUE, 'and the tile that wrapped in shows its blue quadrant');

  // the DOMMatrix-shaped form is the same matrix
  pattern.setTransform({ a: 1, b: 0, c: 0, d: 1, e: 2, f: 1 });
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, W, H);
  const again = await pixels(ctx);
  assert.deepEqual(again(2, 1), RED);
  tile.destroy();
});

test('a pattern is painted in user space: the CTM moves it', async () => {
  const ctx = freshCtx();
  const tile = checkerTile();
  ctx.fillStyle = ctx.createPattern(tile, 'repeat');

  ctx.save();
  ctx.translate(1, 2);
  ctx.fillRect(0, 0, 16, 16);
  ctx.restore();

  const at = await pixels(ctx);
  assert.deepEqual(at(1, 2), RED, 'the tile origin followed the translate');
  assert.deepEqual(at(3, 4), BLUE);
  assert.deepEqual(at(0, 0), WHITE, 'and the fill itself moved with it');
  tile.destroy();
});

test('a scaled CTM scales the tile with the drawing', async () => {
  const ctx = freshCtx();
  const tile = checkerTile();
  ctx.fillStyle = ctx.createPattern(tile, 'repeat');
  ctx.save();
  ctx.scale(4, 4);
  ctx.fillRect(0, 0, 8, 8); // 32x32 device pixels, tiles every 16
  ctx.restore();

  const at = await pixels(ctx);
  assert.deepEqual(at(3, 3), RED, 'the 2x2 red quadrant covers 8x8 device pixels');
  assert.deepEqual(at(12, 12), BLUE, 'and the blue one lands at 8..15');
  assert.deepEqual(at(19, 3), RED, 'the second tile starts at 16');
  tile.destroy();
});

test('a degenerate pattern transform paints nothing rather than the last one', async () => {
  const ctx = freshCtx();
  const tile = checkerTile();
  const pattern = ctx.createPattern(tile, 'repeat');
  pattern.setTransform([0, 0, 0, 0, 0, 0]);
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, W, H);

  const at = await pixels(ctx);
  assert.deepEqual(at(0, 0), WHITE, 'a collapsed tile has nothing to sample');
  tile.destroy();
});

test('patterns fill paths and stroke them, like any other style', async () => {
  const ctx = freshCtx();
  const tile = checkerTile();
  const pattern = ctx.createPattern(tile, 'repeat');

  ctx.fillStyle = pattern;
  ctx.beginPath();
  ctx.arc(20, 20, 10, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = pattern;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, 48);
  ctx.lineTo(W, 48);
  ctx.stroke();

  const at = await pixels(ctx);
  assert.deepEqual(at(20, 20), RED, 'inside the disc, on a red quadrant');
  assert.deepEqual(at(22, 22), BLUE, 'and on a blue one two pixels along');
  assert.deepEqual(at(2, 2), WHITE, 'outside the disc');
  assert.deepEqual(at(48, 48), RED, 'the stroke picks up the same tiling');
  tile.destroy();
});

test('a stroked style samples in canvas space, gradients included', async () => {
  // RENDER aligns the source of a Triangles request with the first vertex,
  // so a stroke used to sample its paint from wherever the stroke started —
  // visible on a pattern as a tile phase that moves with the line, and on a
  // gradient as a stroke whose colours do not agree with a fill of the same
  // gradient. Both are the same offset, so assert it on the gradient too.
  const ctx = freshCtx();
  const gradient = ctx.createLinearGradient(0, 0, W, 0);
  gradient.addColorStop(0, 'red');
  gradient.addColorStop(1, 'blue');

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, W, 8);
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(0, 20);
  ctx.lineTo(W, 20);
  ctx.stroke();

  const at = await pixels(ctx);
  for (const x of [4, 32, 60]) {
    const [fr, fg, fb] = at(x, 4);
    const [sr, sg, sb] = at(x, 20);
    assert.ok(
      Math.abs(fr - sr) <= 2 && Math.abs(fg - sg) <= 2 && Math.abs(fb - sb) <= 2,
      `x=${x}: stroke ${sr},${sg},${sb} matches the fill ${fr},${fg},${fb}`
    );
  }
});

test('globalAlpha applies to a pattern fill', async () => {
  const ctx = freshCtx();
  const tile = checkerTile();
  ctx.fillStyle = ctx.createPattern(tile, 'repeat');
  ctx.globalAlpha = 0.5;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 1;

  const at = await pixels(ctx);
  const [r, g, b] = at(0, 0);
  assert.ok(r > 200 && g < 160 && b < 160, `half-strength red over white, got ${r},${g},${b}`);
  assert.deepEqual(at(2, 0), WHITE, 'the transparent quadrant is still transparent');
  tile.destroy();
});

test('a pane-sized pattern fill is one request, whatever the tile pitch', async () => {
  const ctx = freshCtx();
  const tile = checkerTile();
  const pattern = ctx.createPattern(tile, 'repeat');
  ctx.fillStyle = pattern;
  // warm up: the repeating picture is created on first use
  ctx.fillRect(0, 0, 1, 1);
  await app.X.sync();

  // seq_num counts requests; a client-rasterized grid would show up here as
  // the PutImage of its mask, and a per-dot one as thousands of composites
  const before = app.X.seq_num;
  ctx.fillRect(0, 0, W, H);
  const emitted = app.X.seq_num - before;
  await app.X.sync();
  assert.equal(emitted, 1, 'one Composite covers the pane');
  tile.destroy();
});

test('an Image tiles too, over the pixmap its pixels were uploaded to', async () => {
  const ctx = freshCtx();
  // 2x2: red, transparent / transparent, blue — straight (non-premultiplied) RGBA
  const data = Uint8Array.from([
    255, 0, 0, 255, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 255, 255,
  ]);
  const image = new Image({ width: 2, height: 2, data: Buffer.from(data) });
  ctx.fillStyle = ctx.createPattern(image, 'repeat');
  ctx.fillRect(0, 0, W, H);

  const at = await pixels(ctx);
  assert.deepEqual(at(0, 0), RED);
  assert.deepEqual(at(1, 1), BLUE);
  assert.deepEqual(at(2, 0), RED, 'tiled every 2 pixels');
  assert.deepEqual(at(1, 0), WHITE, 'the transparent texel leaves the surface alone');
  // the same upload backs both: a pattern must not re-send the pixels
  assert.equal(image.pixmap(app), image.pixmap(app));
  image.destroy();
});

test('a pattern outlives the context that created it and works on another', async () => {
  const first = freshCtx();
  const tile = checkerTile();
  const pattern = first.createPattern(tile, 'repeat');
  first.fillStyle = pattern;
  first.fillRect(0, 0, 8, 8);
  first.destroy();

  const second = freshCtx();
  second.fillStyle = pattern;
  second.fillRect(0, 0, 8, 8);
  const at = await pixels(second);
  assert.deepEqual(at(0, 0), RED, 'the same pattern paints on a second context');

  // destroy is idempotent, and the picture comes back if it is used again
  pattern.destroy();
  pattern.destroy();
  const third = freshCtx();
  third.fillStyle = pattern;
  third.fillRect(0, 0, 8, 8);
  const later = await pixels(third);
  assert.deepEqual(later(2, 2), BLUE, 'a destroyed pattern re-creates its picture on use');
  pattern.destroy();
  tile.destroy();
});

test('a pattern is a CanvasPattern, and an unknown style still throws', () => {
  const ctx = freshCtx();
  const tile = checkerTile();
  assert.ok(ctx.createPattern(tile) instanceof CanvasPattern, "'repeat' is the default");
  assert.equal(ctx.createPattern(tile, null).repetition, 'repeat', 'null means repeat, per the spec');
  assert.throws(() => {
    ctx.fillStyle = { not: 'a style' };
  }, /Unknown fill style/);
  tile.destroy();
});

test('the repetitions XRender has no mode for say what to do instead', () => {
  const ctx = freshCtx();
  const tile = checkerTile();
  for (const repetition of ['repeat-x', 'repeat-y']) {
    assert.throws(
      () => ctx.createPattern(tile, repetition),
      (err) => {
        assert.match(err.message, /per-axis/, 'names why it cannot be mapped');
        assert.match(err.message, /tile\.height/, 'and the fillRect that does the same thing');
        assert.match(err.message, /'repeat'.*'no-repeat'/, 'and lists what is supported');
        return true;
      },
      repetition
    );
  }
  assert.throws(() => ctx.createPattern(tile, 'sideways'), /unsupported repetition "sideways"/);
  tile.destroy();
});

test('the docs anchor the pattern errors point at exists', () => {
  // nothing else in CI checks a doc anchor referenced from a string literal
  const doc = readFileSync(join(docsDir, 'context-2d.md'), 'utf8');
  assert.ok(/^## Patterns$/m.test(doc), 'docs/context-2d.md#patterns');
});

test('a coverage tile is refused, with the two ways to paint one', () => {
  const ctx = freshCtx();
  const mask = new Surface(app, { width: 4, height: 4, format: 'a8' });
  assert.throws(
    () => ctx.createPattern(mask, 'repeat'),
    (err) => {
      assert.match(err.message, /a8/);
      assert.match(err.message, /drawImage/, 'points at the call that paints coverage');
      return true;
    }
  );
  mask.destroy();
});

test('a source that is not a drawable names what would have worked', () => {
  const ctx = freshCtx();
  for (const bad of [null, undefined, 42, 'tile.png', {}]) {
    assert.throws(() => ctx.createPattern(bad, 'repeat'), /expected a Surface, an Image, a Pixmap or a Window/);
  }
});

test('a window whose depth is unknown names a wait that exists (issue #293)', async () => {
  const ctx = freshCtx();
  // a window this connection did not make a wrapper for: what a compositor
  // or a window manager is handed, and what `new Window(app, { id })` adopts
  const id = app.X.AllocID();
  app.X.CreateWindow(id, app.display.screen[0].root, 0, 0, 8, 8, 0, 0, 1, 0, {});
  const wnd = app.createWindow({ id });

  assert.throws(
    () => ctx.createPattern(wnd, 'repeat'),
    (err) => {
      assert.match(err.message, /await tile\.getGeometry\(\)/, 'the remedy that works on any tile');
      assert.match(err.message, /await tile\.ready/, 'and the cheaper one for an adopted one');
      // both are real API, which is the whole point of the issue
      assert.equal(typeof wnd.getGeometry, 'function');
      assert.equal(typeof wnd.ready?.then, 'function');
      return true;
    }
  );

  await wnd.ready;
  assert.equal(wnd.depth, 24, 'the wait is what makes the depth known');
  assert.ok(ctx.createPattern(wnd, 'repeat') instanceof CanvasPattern);
  wnd.destroy();
});

test('setTransform rejects a matrix it cannot use', () => {
  const ctx = freshCtx();
  const tile = checkerTile();
  const pattern = ctx.createPattern(tile, 'repeat');
  assert.throws(() => pattern.setTransform([1, 0, 0, 1, NaN, 0]), /finite numbers/);
  assert.throws(() => pattern.setTransform([1, 0, 0, 1]), /finite numbers/);
  tile.destroy();
});
