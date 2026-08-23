// The `_compositeMask` fallback writes only the composite's own box (issue
// #313). With a non-rectangular clip in the stack there is a real a8 mask to
// build, but the drawing that follows composites one box and samples the
// mask nowhere else — so stamping `globalAlpha` across the whole surface and
// intersecting the clip mask across it again is pixel work nothing reads. A
// translucent fill inside a rounded-corner clip used to pay two full
// surfaces per fill on top of the poly-clip mask it legitimately needs.
//
// What is asserted here: the two writes take the box, and the pixels are the
// ones the full-surface route drew — checked against that route itself,
// reinstated by making `_maskBox` answer with the whole surface again.
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

/** The route this replaces: both writes at full surface size. */
function fullSurfaceCtx() {
  const ctx = freshCtx();
  ctx._maskBox = () => ({ x: 0, y: 0, w: W, h: H });
  return ctx;
}

const read = (ctx) => ctx.getImageData(0, 0, W, H);

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

/**
 * Every write the drawing aims at the scratch fill mask, as boxes: the alpha
 * stamp (a FillRectangles) and the clip intersection (a Composite whose
 * destination it is).
 */
function maskWrites(ctx, fn) {
  const R = ctx.Render;
  const fills = R.FillRectangles;
  const composites = R.Composite;
  const calls = [];
  // the scratch is created lazily, and the temp pictures the clip mask
  // rasterizes through are freed before it exists — so "is this the scratch"
  // has to be asked at call time, before a recycled id can answer for it
  const isScratch = (dst) => ctx.fillMask != null && dst === ctx.fillMask.id;
  R.FillRectangles = function (op, dst, color, rects) {
    if (isScratch(dst)) calls.push({ kind: "fill", box: rectOf(rects) });
    return fills.apply(this, arguments);
  };
  R.Composite = function (op, src, mask, dst, sx, sy, mx, my, dx, dy, w, h) {
    if (isScratch(dst))
      calls.push({ kind: "composite", box: { x: dx, y: dy, w, h } });
    return composites.apply(this, arguments);
  };
  try {
    fn();
  } finally {
    R.FillRectangles = fills;
    R.Composite = composites;
  }
  return calls;
}

function rectOf(rects) {
  assert.equal(rects.length, 4, "one rectangle per stamp");
  const [x, y, w, h] = rects;
  return { x, y, w, h };
}

test("a translucent fill under a poly clip stamps only its own box", async () => {
  const draw = (ctx) => {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(20, 20, 80, 80, 20);
    ctx.clip();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = "red";
    ctx.fillRect(30, 40, 25, 20);
    ctx.restore();
  };

  const ctx = freshCtx();
  const writes = maskWrites(ctx, () => draw(ctx));
  assert.deepEqual(
    writes,
    [
      { kind: "fill", box: { x: 30, y: 40, w: 25, h: 20 } },
      { kind: "composite", box: { x: 30, y: 40, w: 25, h: 20 } },
    ],
    "alpha stamp and clip intersection both take the fill box",
  );

  const ref = fullSurfaceCtx();
  draw(ref);
  assertSamePixels(
    await read(ctx),
    await read(ref),
    "translucent clipped fill",
  );
});

test("the box is the fill's, not the clip's, and the clip still bites", async () => {
  // a fill overlapping the rounded corner: the corner has to come out of the
  // mask, which is the half of the work that is not the alpha stamp
  const draw = (ctx) => {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(20, 20, 80, 80, 20);
    ctx.clip();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = "blue";
    ctx.fillRect(0, 0, 60, 60);
    ctx.restore();
  };

  const ctx = freshCtx();
  const writes = maskWrites(ctx, () => draw(ctx));
  assert.deepEqual(
    writes.map((w) => w.box),
    [
      { x: 0, y: 0, w: 60, h: 60 },
      { x: 0, y: 0, w: 60, h: 60 },
    ],
    "the fill box, clamped to the surface",
  );

  const ref = fullSurfaceCtx();
  draw(ref);
  assertSamePixels(await read(ctx), await read(ref), "fill over the corner");
});

test("a fractional fill box grows to whole pixels rather than rounding", async () => {
  const draw = (ctx) => {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(20, 20, 80, 80, 20);
    ctx.clip();
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = "red";
    ctx.fillRect(30.5, 40.25, 20.5, 10.5);
    ctx.restore();
  };

  const ctx = freshCtx();
  const writes = maskWrites(ctx, () => draw(ctx));
  assert.deepEqual(
    writes.map((w) => w.box),
    [
      { x: 30, y: 40, w: 21, h: 11 },
      { x: 30, y: 40, w: 21, h: 11 },
    ],
    "outward: the mask covers every pixel the composite samples",
  );

  const ref = fullSurfaceCtx();
  draw(ref);
  assertSamePixels(await read(ctx), await read(ref), "fractional fill");
});

test("an unbounded op under a rect clip bounds the mask to its box too", async () => {
  // `copy` keeps the mask (issue #307's guard: it writes where the mask is
  // zero), so a rect clip lands here rather than on the boxed route — and
  // the box it clears is still just the fill's
  const draw = (ctx) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(20, 20, 60, 60);
    ctx.clip();
    ctx.globalAlpha = 0.5;
    ctx.globalCompositeOperation = "copy";
    ctx.fillStyle = "red";
    ctx.fillRect(10, 10, 50, 50);
    ctx.restore();
  };

  const ctx = freshCtx();
  const writes = maskWrites(ctx, () => draw(ctx));
  assert.deepEqual(
    writes.map((w) => w.box),
    [
      { x: 10, y: 10, w: 50, h: 50 },
      { x: 10, y: 10, w: 50, h: 50 },
    ],
    "the composite box, not the surface",
  );

  const ref = fullSurfaceCtx();
  draw(ref);
  assertSamePixels(await read(ctx), await read(ref), "copy under a rect clip");
});

test("drawImage under a poly clip masks only the destination box", async () => {
  const surface = new Surface(app, { width: 40, height: 40 });
  const paint = surface.getContext("2d");
  paint.fillStyle = "#4c6ef5";
  paint.fillRect(0, 0, 40, 40);
  paint.fillStyle = "#f76707";
  paint.fillRect(0, 0, 20, 20);

  const draw = (ctx) => {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(20, 20, 80, 80, 20);
    ctx.clip();
    ctx.globalAlpha = 0.6;
    ctx.drawImage(surface, 25, 35);
    ctx.restore();
  };

  const ctx = freshCtx();
  const writes = maskWrites(ctx, () => draw(ctx));
  assert.deepEqual(
    writes.map((w) => w.box),
    [
      { x: 25, y: 35, w: 40, h: 40 },
      { x: 25, y: 35, w: 40, h: 40 },
    ],
    "the image's destination box",
  );

  const ref = fullSurfaceCtx();
  draw(ref);
  assertSamePixels(await read(ctx), await read(ref), "clipped drawImage");
  surface.destroy();
});

test("a transformed drawImage under a poly clip masks its bounding box", async () => {
  const surface = new Surface(app, { width: 40, height: 40 });
  const paint = surface.getContext("2d");
  paint.fillStyle = "#4c6ef5";
  paint.fillRect(0, 0, 40, 40);
  paint.fillStyle = "#f76707";
  paint.fillRect(0, 0, 20, 20);

  const draw = (ctx) => {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(20, 20, 80, 80, 20);
    ctx.clip();
    ctx.globalAlpha = 0.5;
    ctx.translate(60, 60);
    ctx.rotate(Math.PI / 5);
    ctx.drawImage(surface, -20, -20);
    ctx.restore();
  };

  const ctx = freshCtx();
  const writes = maskWrites(ctx, () => draw(ctx));
  assert.equal(writes.length, 2, "one alpha stamp, one clip intersection");
  for (const { box } of writes) {
    assert.ok(
      box.w < W && box.h < H,
      `smaller than the surface: ${box.w}x${box.h}`,
    );
  }

  const ref = fullSurfaceCtx();
  draw(ref);
  assertSamePixels(await read(ctx), await read(ref), "transformed drawImage");
  surface.destroy();
});
