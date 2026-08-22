// Region clips (issue #292): an XFIXES region as a clip the 2d context knows
// about, and the picture-clip bookkeeping that keeps it alive.
//
// The bug this replaces: ntk's fast paths narrowed the picture to a rectangle
// around a drawing and then "undid" it by stamping a full-plane rectangle,
// which is a clip and not the absence of one — so any region on that picture
// was gone, silently, from whichever drawing happened to take that route.
//
// Needs a real X server: node-x11's pure-JS one implements RENDER but not
// XFIXES, so there are no regions to clip with there. Skips without one.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import { createClient, Region, StaticFontSource } from '../lib/index.js';
import { withTimeout } from './helpers/async.js';

const require = createRequire(import.meta.url);
const fontDir = join(dirname(require.resolve('katex/package.json')), 'dist', 'fonts');

let app = null;
let skip = false;

const W = 200;
const H = 200;

before(async () => {
  if (!process.env.DISPLAY) {
    skip = 'no DISPLAY set';
    return;
  }
  // a font of our own rather than fontconfig's: the glyph fast path is what
  // the issue was reported against, and it should not depend on the box
  const source = new StaticFontSource();
  source.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), { family: 'Test Main' });
  source.alias('sans-serif', 'Test Main');
  try {
    app = await withTimeout(createClient({ fontSource: source }), 5000, 'connecting to X server');
  } catch (err) {
    skip = `cannot connect to X server: ${err.message}`;
    return;
  }
  try {
    await withTimeout(app.fixes(), 5000, 'loading XFIXES');
  } catch (err) {
    skip = `no XFIXES on this server: ${err.message}`;
  }
});

after(async () => {
  if (app) await app.close();
});

function freshCtx() {
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H);
  return { pixmap, ctx };
}

const at = (image, x, y) => {
  const i = (y * W + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
};
const RED = [255, 0, 0];
const BLUE = [0, 0, 255];
const WHITE = [255, 255, 255];

test('a region clips ntk drawing, and restore() lifts it', async (t) => {
  if (skip) return t.skip(skip);
  const { pixmap, ctx } = freshCtx();
  const region = await app.createRegion([{ x: 0, y: 0, width: 100, height: 100 }]);

  ctx.save();
  ctx.clipRegion(region);
  ctx.fillStyle = 'red';
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  ctx.fillStyle = 'blue';
  ctx.fillRect(150, 150, 20, 20); // outside the region, after the restore

  const image = await ctx.getImageData(0, 0, W, H);
  assert.deepEqual(at(image, 50, 50), RED, 'inside the region');
  assert.deepEqual(at(image, 150, 50), WHITE, 'right of the region');
  assert.deepEqual(at(image, 50, 150), WHITE, 'below the region');
  assert.deepEqual(at(image, 155, 155), BLUE, 'the clip is gone after restore');
  region.destroy();
  pixmap.destroy();
});

test('a multi-rect region clips to its rectangles, not their bounding box', async (t) => {
  if (skip) return t.skip(skip);
  const { pixmap, ctx } = freshCtx();
  const region = await app.createRegion([
    { x: 0, y: 0, width: 60, height: 60 },
    { x: 120, y: 120, width: 60, height: 60 }
  ]);

  ctx.clipRegion(region);
  ctx.fillStyle = 'red';
  ctx.fillRect(0, 0, W, H);

  const image = await ctx.getImageData(0, 0, W, H);
  assert.deepEqual(at(image, 30, 30), RED, 'first rectangle');
  assert.deepEqual(at(image, 150, 150), RED, 'second rectangle');
  assert.deepEqual(at(image, 100, 100), WHITE, 'the gap between them');
  assert.deepEqual(at(image, 150, 30), WHITE, 'the bounding box corner');
  region.destroy();
  pixmap.destroy();
});

// The reported failure, end to end. A glyph run under a rectangular clip takes
// the SetPictureClipRectangles fast path; before the fix its "undo" replaced
// the region with a full-plane rectangle and every later drawing spilled.
test('a clipped text draw does not wipe the region clip', async (t) => {
  if (skip) return t.skip(skip);
  const { pixmap, ctx } = freshCtx();
  const region = await app.createRegion([{ x: 0, y: 0, width: 100, height: 100 }]);
  ctx.clipRegion(region);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, 50, 50);
  ctx.clip();
  ctx.fillStyle = 'black';
  ctx.font = '20px sans-serif';
  ctx.fillText('hi', 5, 25); // glyph fast path: clip stamped, then undone
  ctx.restore();

  ctx.fillStyle = 'red';
  ctx.fillRect(0, 0, W, H);

  const image = await ctx.getImageData(0, 0, W, H);
  assert.deepEqual(at(image, 50, 50), RED, 'the region still lets this through');
  assert.deepEqual(at(image, 150, 150), WHITE, 'and still clips this out');
  region.destroy();
  pixmap.destroy();
});

// Same shape of bug, the other server-side-clip routes: a batched fillRects,
// a rounded box (the shape-glyph path) and drawImage all bracket their drawing
// with a picture clip.
test('the other clip-rectangle fast paths leave the region alone', async (t) => {
  if (skip) return t.skip(skip);
  const { pixmap, ctx } = freshCtx();
  const region = await app.createRegion([{ x: 0, y: 0, width: 100, height: 100 }]);
  ctx.clipRegion(region);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, 40, 40);
  ctx.clip();

  ctx.fillStyle = 'black';
  ctx.fillRects([
    [0, 0, 10, 10],
    [12, 0, 10, 10]
  ]);
  ctx.beginPath();
  ctx.roundRect(0, 20, 20, 12, 4);
  ctx.fill();

  const tile = app.createPixmap({ width: 8, height: 8, depth: 24 });
  const tileCtx = tile.getContext('2d');
  tileCtx.fillStyle = 'black';
  tileCtx.fillRect(0, 0, 8, 8);
  ctx.drawImage(tileCtx, 24, 20);
  ctx.restore();

  ctx.fillStyle = 'red';
  ctx.fillRect(0, 0, W, H);

  const image = await ctx.getImageData(0, 0, W, H);
  assert.deepEqual(at(image, 50, 50), RED, 'inside the region');
  assert.deepEqual(at(image, 150, 150), WHITE, 'outside it, still clipped');
  region.destroy();
  tile.destroy();
  pixmap.destroy();
});

test('a region and a rectangular clip intersect, in either order', async (t) => {
  if (skip) return t.skip(skip);
  const region = await app.createRegion([{ x: 0, y: 0, width: 100, height: 100 }]);

  for (const regionFirst of [true, false]) {
    const { pixmap, ctx } = freshCtx();
    const rect = () => {
      ctx.beginPath();
      ctx.rect(60, 0, 100, 100);
      ctx.clip();
    };
    if (regionFirst) {
      ctx.clipRegion(region);
      rect();
    } else {
      rect();
      ctx.clipRegion(region);
    }
    ctx.fillStyle = 'red';
    ctx.fillRect(0, 0, W, H);

    const image = await ctx.getImageData(0, 0, W, H);
    const where = regionFirst ? 'region then rect' : 'rect then region';
    assert.deepEqual(at(image, 80, 50), RED, `${where}: inside both`);
    assert.deepEqual(at(image, 30, 50), WHITE, `${where}: region only`);
    assert.deepEqual(at(image, 130, 50), WHITE, `${where}: rectangle only`);
    pixmap.destroy();
  }
  region.destroy();
});

test('a region intersects a path clip too — the a8 mask route', async (t) => {
  if (skip) return t.skip(skip);
  const { pixmap, ctx } = freshCtx();
  const region = await app.createRegion([{ x: 0, y: 0, width: 100, height: 200 }]);
  ctx.clipRegion(region);

  ctx.beginPath();
  ctx.arc(100, 100, 70, 0, Math.PI * 2); // a circle, so the mask materializes
  ctx.clip();
  assert.ok(ctx.clipMask, 'the path clip built a mask');
  ctx.fillStyle = 'red';
  ctx.fillRect(0, 0, W, H);

  const image = await ctx.getImageData(0, 0, W, H);
  assert.deepEqual(at(image, 60, 100), RED, 'inside the circle, inside the region');
  assert.deepEqual(at(image, 140, 100), WHITE, 'inside the circle, right of the region');
  assert.deepEqual(at(image, 20, 20), WHITE, 'inside the region, outside the circle');
  region.destroy();
  pixmap.destroy();
});

test('nested region clips intersect', async (t) => {
  if (skip) return t.skip(skip);
  const { pixmap, ctx } = freshCtx();
  const outer = await app.createRegion([{ x: 0, y: 0, width: 120, height: 120 }]);
  const inner = await app.createRegion([{ x: 60, y: 0, width: 120, height: 120 }]);

  ctx.clipRegion(outer);
  ctx.save();
  ctx.clipRegion(inner);
  ctx.fillStyle = 'red';
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  // back to the outer region alone: a band across the whole surface, which
  // only the outer region is left to trim
  ctx.fillStyle = 'blue';
  ctx.fillRect(0, 60, W, 20);

  const image = await ctx.getImageData(0, 0, W, H);
  assert.deepEqual(at(image, 80, 20), RED, 'inside both regions');
  assert.deepEqual(at(image, 30, 20), WHITE, 'outer only');
  assert.deepEqual(at(image, 150, 20), WHITE, 'inner only');
  assert.deepEqual(at(image, 30, 65), BLUE, 'the inner region came off with restore');
  assert.deepEqual(at(image, 150, 65), WHITE, 'the outer one did not');
  inner.destroy();
  outer.destroy();
  pixmap.destroy();
});

test('clipRegion takes a raw region id as well as a Region', async (t) => {
  if (skip) return t.skip(skip);
  const { pixmap, ctx } = freshCtx();
  const fixes = await app.fixes();
  const id = app.X.AllocID();
  fixes.CreateRegion(id, [{ x: 0, y: 0, width: 100, height: 100 }]);

  ctx.clipRegion(id);
  ctx.fillStyle = 'red';
  ctx.fillRect(0, 0, W, H);

  const image = await ctx.getImageData(0, 0, W, H);
  assert.deepEqual(at(image, 50, 50), RED);
  assert.deepEqual(at(image, 150, 150), WHITE);
  fixes.DestroyRegion(id);
  app.X.ReleaseID(id);
  pixmap.destroy();
});

test('clipRegion rejects something that is not a region', async (t) => {
  if (skip) return t.skip(skip);
  const { pixmap, ctx } = freshCtx();
  assert.throws(() => ctx.clipRegion(null), /expected an XFIXES region/);
  assert.throws(() => ctx.clipRegion({}), /expected an XFIXES region/);
  pixmap.destroy();
});

test('region operations happen server-side', async (t) => {
  if (skip) return t.skip(skip);
  const a = await app.createRegion([{ x: 0, y: 0, width: 100, height: 100 }]);
  const b = await app.createRegion([{ x: 40, y: 0, width: 100, height: 100 }]);

  const intersection = await a.intersect(b).fetch();
  assert.deepEqual(intersection.rectangles, [{ x: 40, y: 0, width: 60, height: 100 }]);

  // ntk's own box spelling is accepted alongside the protocol's
  const c = await app.createRegion([{ x: 0, y: 0, w: 200, h: 100 }]);
  const remainder = await c.subtract(b).fetch();
  assert.deepEqual(remainder.rectangles, [
    { x: 0, y: 0, width: 40, height: 100 },
    { x: 140, y: 0, width: 60, height: 100 }
  ]);

  const moved = await b.translate(10, 5).fetch();
  assert.deepEqual(moved.extents, { x: 50, y: 5, width: 100, height: 100 });
  for (const region of [a, b, c]) region.destroy();
});

test('a region-clipped context still reports damage, conservatively', async (t) => {
  if (skip) return t.skip(skip);
  const { pixmap, ctx } = freshCtx();
  const region = await app.createRegion([{ x: 0, y: 0, width: 100, height: 100 }]);
  ctx.clipRegion(region);
  // _clipRect() is the damage box a double-buffered window blits; a region is
  // not a rectangle, so it must report nothing (full blit) rather than a wrong
  // box or a crash
  assert.equal(ctx._clipRect(), null);
  ctx.beginPath();
  ctx.rect(10, 10, 30, 30);
  ctx.clip();
  assert.deepEqual(ctx._clipRect(), { x: 10, y: 10, w: 30, h: 30 }, 'the rectangle still shows through');
  region.destroy();
  pixmap.destroy();
});

test('clipRegion before XFIXES is loaded says what to do about it', async (t) => {
  if (skip) return t.skip(skip);
  // a connection that has never touched XFIXES: clipRegion cannot load it from
  // under a synchronous call, so it has to explain the one await that would
  const other = await withTimeout(
    createClient({ fontSource: new StaticFontSource() }),
    5000,
    'second connection'
  );
  try {
    const pixmap = other.createPixmap({ width: 32, height: 32, depth: 24 });
    const ctx = pixmap.getContext('2d');
    assert.throws(() => ctx.clipRegion(1234), (err) => {
      assert.match(err.message, /app\.createRegion/, 'names the call that makes a region');
      assert.match(err.message, /app\.fixes\(\)/, 'and the one that only loads the extension');
      return true;
    });
    pixmap.destroy();
  } finally {
    await other.close();
  }
});

test('the docs anchor the errors point at exists', () => {
  const root = join(dirname(new URL(import.meta.url).pathname), '..');
  const docs = readFileSync(join(root, 'docs/context-2d.md'), 'utf8');
  assert.match(docs, /^## Region clips$/m);
});

test('Region is exported for instanceof', () => {
  assert.equal(typeof Region, 'function');
});
