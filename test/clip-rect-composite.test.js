// A rectangular clip is a smaller composite box, not an a8 mask (issue #307).
// `fillRect` and the `drawImage` branches that composite a whole box used to
// build a surface-sized depth-8 pixmap, clear it, stamp the clip rectangle
// into it and free it again — six requests and a full-surface clear per
// drawing — for a mask that is 255 over every pixel the composite touches.
//
// What is asserted here: no pixmap is created on those paths, and the pixels
// are the ones the mask path drew — checked against the same drawing done
// unclipped over the intersection, which is what the shrunk box means.
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import xserver from "x11/lib/xserver/index.js";

import { createClient, StaticFontSource, Surface } from "../lib/index.js";

let app = null;
const W = 120;
const H = 120;

before(async () => {
  const server = xserver.createServer({ width: 200, height: 200 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  app = await createClient({
    stream: clientEnd,
    fontSource: new StaticFontSource(),
  });
});

after(async () => {
  if (app) await app.close();
});

function freshCtx() {
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, W, H);
  return ctx;
}

const read = (ctx) => ctx.getImageData(0, 0, W, H);
const at = (img, x, y) => {
  const i = (y * W + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

/** Count the server resources a drawing allocates: pixmaps are the mask. */
function countingPixmaps(ctx, fn) {
  const X = ctx.X;
  const original = X.CreatePixmap;
  let count = 0;
  X.CreatePixmap = function (...args) {
    count += 1;
    return original.apply(this, args);
  };
  try {
    fn();
  } finally {
    X.CreatePixmap = original;
  }
  return count;
}

/** Byte-for-byte comparison of two getImageData results. */
function assertSamePixels(a, b, what) {
  let worst = 0;
  let where = -1;
  for (let i = 0; i < a.data.length; i++) {
    const d = Math.abs(a.data[i] - b.data[i]);
    if (d > worst) {
      worst = d;
      where = i;
    }
  }
  assert.equal(
    worst,
    0,
    `${what}: differs by ${worst} at byte ${where} (pixel ${Math.floor(
      (where / 4) % W,
    )},${Math.floor(where / 4 / W)})`,
  );
}

test("a clipped fillRect composites the intersection and builds no mask", async () => {
  const ctx = freshCtx();
  const pixmaps = countingPixmaps(ctx, () => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(20, 30, 40, 50);
    ctx.clip();
    ctx.fillStyle = "red";
    ctx.fillRect(0, 0, W, H);
    assert.equal(ctx.clipMask, null, "no mask materialized while drawing");
    ctx.restore();
  });
  assert.equal(pixmaps, 0, "no window-sized a8 pixmap for a rect-only clip");

  const clipped = await read(ctx);
  assert.deepEqual(at(clipped, 30, 40), [255, 0, 0], "inside the clip filled");
  assert.deepEqual(at(clipped, 10, 40), [255, 255, 255], "left of it kept");
  assert.deepEqual(at(clipped, 70, 40), [255, 255, 255], "right of it kept");

  // the shrunk box means exactly this drawing, and nothing else
  const ref = freshCtx();
  ref.fillStyle = "red";
  ref.fillRect(20, 30, 40, 50);
  assertSamePixels(clipped, await read(ref), "clipped fill vs the intersection");
});

test("the clip narrows a fill that already sits partly outside it", async () => {
  const ctx = freshCtx();
  ctx.save();
  ctx.beginPath();
  ctx.rect(20, 20, 60, 60);
  ctx.clip();
  ctx.fillStyle = "blue";
  ctx.fillRect(50, 50, 60, 60); // overlaps the clip in a 30x30 corner
  ctx.restore();

  const ref = freshCtx();
  ref.fillStyle = "blue";
  ref.fillRect(50, 50, 30, 30);
  assertSamePixels(await read(ctx), await read(ref), "overlapping fill");
});

test("a fill the clip rejects whole draws nothing at all", async () => {
  const ctx = freshCtx();
  const pixmaps = countingPixmaps(ctx, () => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, 20, 20);
    ctx.clip();
    ctx.fillStyle = "red";
    ctx.fillRect(60, 60, 30, 30);
    ctx.restore();
  });
  assert.equal(pixmaps, 0);
  assertSamePixels(await read(ctx), await read(freshCtx()), "nothing drawn");
});

test("a gradient stays put when the clip shrinks the box", async () => {
  // source and destination coordinates shift together, so the gradient is
  // sampled where it would have been without the clip
  const makeGradient = (ctx) => {
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, "black");
    g.addColorStop(1, "red");
    return g;
  };

  const ctx = freshCtx();
  ctx.save();
  ctx.beginPath();
  ctx.rect(40, 10, 40, 100);
  ctx.clip();
  ctx.fillStyle = makeGradient(ctx);
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  const ref = freshCtx();
  ref.fillStyle = makeGradient(ref);
  ref.fillRect(40, 10, 40, 100);
  assertSamePixels(await read(ctx), await read(ref), "gradient under a clip");
});

test("globalAlpha under a rect clip needs no mask either", async () => {
  const ctx = freshCtx();
  const pixmaps = countingPixmaps(ctx, () => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(20, 20, 40, 40);
    ctx.clip();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = "red";
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
    ctx.restore();
  });
  assert.equal(pixmaps, 0, "alpha is a 1x1 solid, not a surface-sized a8");

  const img = await read(ctx);
  const [r, g, b] = at(img, 30, 30);
  assert.equal(r, 255, "red channel saturated");
  assert.ok(g > 118 && g < 138, `half-covered green ${g}`);
  assert.equal(g, b, "grey stays grey");
  assert.deepEqual(at(img, 10, 10), [255, 255, 255], "outside the clip");
});

test("a non-rectangular clip still masks", async () => {
  const ctx = freshCtx();
  const pixmaps = countingPixmaps(ctx, () => {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(20, 20, 60, 60, 20);
    ctx.clip();
    ctx.fillStyle = "red";
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  });
  assert.ok(pixmaps > 0, "the mask is still built where it is needed");

  const img = await read(ctx);
  assert.deepEqual(at(img, 50, 50), [255, 0, 0], "center filled");
  assert.deepEqual(at(img, 22, 22), [255, 255, 255], "the rounded corner");
});

test("an op that writes where the mask is zero keeps the mask", async () => {
  // `copy` is `dst = src IN mask`, so it *clears* the box outside the clip
  // rather than leaving it alone: shrinking the box would leave those pixels
  // behind. The guard keeps the mask, and with it the old pixels.
  const ctx = freshCtx();
  const pixmaps = countingPixmaps(ctx, () => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(20, 20, 40, 40);
    ctx.clip();
    ctx.globalCompositeOperation = "copy";
    ctx.fillStyle = "red";
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();
  });
  assert.ok(pixmaps > 0, "copy is not mask-bounded, so it still needs one");

  const img = await read(ctx);
  assert.deepEqual(at(img, 30, 30), [255, 0, 0], "inside the clip: the source");
  assert.deepEqual(at(img, 90, 90), [0, 0, 0], "outside it: cleared, not kept");
});

test("a fractional fill rect falls back rather than rounding the clip", async () => {
  const ctx = freshCtx();
  ctx.save();
  ctx.beginPath();
  ctx.rect(20, 20, 40, 40);
  ctx.clip();
  ctx.fillStyle = "red";
  ctx.fillRect(10.5, 10.5, 80, 80);
  ctx.restore();

  const img = await read(ctx);
  assert.deepEqual(at(img, 40, 40), [255, 0, 0], "inside the clip filled");
  assert.deepEqual(at(img, 70, 70), [255, 255, 255], "outside it untouched");
});

test("drawImage of another context takes the same route", async () => {
  const src = freshCtx();
  src.fillStyle = "lime";
  src.fillRect(0, 0, W, H);

  const ctx = freshCtx();
  const pixmaps = countingPixmaps(ctx, () => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(30, 30, 40, 40);
    ctx.clip();
    ctx.drawImage(src, 0, 0);
    ctx.restore();
  });
  assert.equal(pixmaps, 0, "no mask for the whole-surface composite");

  const img = await read(ctx);
  assert.deepEqual(at(img, 50, 50), [0, 255, 0], "inside the clip");
  assert.deepEqual(at(img, 20, 20), [255, 255, 255], "outside it");
});

test("a transformed drawImage under a clip paints what the mask painted", async () => {
  // the general-affine route composites the transformed bounding box, and
  // the clip narrows that box the same way — checked against the mask route
  // itself rather than against a hand-computed reference
  const surface = new Surface(app, { width: 40, height: 40 });
  const paint = surface.getContext("2d");
  paint.fillStyle = "#4c6ef5";
  paint.fillRect(0, 0, 40, 40);
  paint.fillStyle = "#f76707";
  paint.fillRect(0, 0, 20, 20);

  const draw = (ctx) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(30, 30, 50, 40);
    ctx.clip();
    ctx.translate(60, 60);
    ctx.rotate(Math.PI / 5);
    ctx.scale(1.4, 1.4);
    ctx.drawImage(surface, -20, -20);
    ctx.restore();
  };

  const boxed = freshCtx();
  const pixmaps = countingPixmaps(boxed, () => draw(boxed));
  assert.equal(pixmaps, 0, "no mask for the transformed composite either");

  const masked = freshCtx();
  masked._boxedComposite = () => null; // the route this replaces
  draw(masked);

  assertSamePixels(await read(boxed), await read(masked), "transformed image");
  surface.destroy();
});
