// The picture clip is context state, not something stamped per drawing
// (issue #308).
//
// Every rect-clipped fast path brackets its own drawing — set the clip, draw,
// put it back — so two drawings under one clip used to emit a reset
// immediately followed by an identical set, with nothing in between that
// reads the slot. A rounded box is exactly that shape: the fill's corner
// glyphs and strips, then the border's. Four stamps where one does.
//
// What this pins: the stamps that disappear, and the flush points that keep
// them from mattering — anything drawing into the picture without setting its
// own clip must not inherit the one the last fast path left there.
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import xserver from "x11/lib/xserver/index.js";

import { createClient, StaticFontSource } from "../lib/index.js";

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
const RED = [255, 0, 0];
const BLUE = [0, 0, 255];
const WHITE = [255, 255, 255];

/** The clip rectangles stamped on `ctx`'s own picture while `fn` runs. */
function stamps(ctx, fn) {
  const R = ctx.Render;
  const original = R.SetPictureClipRectangles;
  // the internal field: reading `ctx.picture` would settle the slot, which
  // is one of the things under test here
  const id = ctx._picture.id;
  const seen = [];
  R.SetPictureClipRectangles = function (pid, ...rest) {
    if (pid === id) seen.push(rest[2]);
    return original.call(this, pid, ...rest);
  };
  try {
    fn();
  } finally {
    R.SetPictureClipRectangles = original;
  }
  return seen;
}

/** Clip to a box the way a renderer clips to a damage rectangle. */
function clipTo(ctx, x, y, w, h) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
}

test("two drawings under one clip stamp it once", () => {
  const ctx = freshCtx();
  clipTo(ctx, 10, 10, 60, 60);
  ctx.fillStyle = "red";
  const seen = stamps(ctx, () => {
    ctx.fillRects([[0, 0, 100, 20]]);
    ctx.fillRects([[0, 40, 100, 20]]);
  });
  ctx.restore();

  assert.deepEqual(
    seen,
    [[10, 10, 60, 60]],
    "one stamp: the second drawing found the slot already holding it",
  );
});

test("a rounded box costs one stamp, not four", () => {
  const ctx = freshCtx();
  clipTo(ctx, 8, 8, 100, 100);
  const seen = stamps(ctx, () => {
    // the fill's corner glyphs + strips, then the border's — the two
    // drawings the issue was traced on
    ctx.fillStyle = "red";
    ctx.beginPath();
    ctx.roundRect(20, 20, 60, 40, 8);
    ctx.fill();
    ctx.strokeStyle = "blue";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(20, 20, 60, 40, 8);
    ctx.stroke();
  });
  ctx.restore();

  assert.equal(ctx.shapeStats.hits, 2, "both took the rounded-box fast path");
  assert.deepEqual(seen, [[8, 8, 100, 100]], "one stamp for the pair");
});

test("repainting the same rectangle next frame stamps nothing", () => {
  const ctx = freshCtx();
  const frame = () => {
    clipTo(ctx, 10, 10, 60, 60);
    ctx.fillStyle = "red";
    ctx.fillRects([[0, 0, 100, 100]]);
    ctx.restore();
  };
  frame();
  const seen = stamps(ctx, frame);
  assert.deepEqual(seen, [], "the slot already holds the damage rectangle");
});

test("a different rectangle is stamped, and only once", () => {
  const ctx = freshCtx();
  clipTo(ctx, 10, 10, 60, 60);
  ctx.fillStyle = "red";
  ctx.fillRects([[0, 0, 100, 100]]);
  ctx.restore();

  clipTo(ctx, 20, 20, 30, 30);
  const seen = stamps(ctx, () => {
    ctx.fillRects([[0, 0, 100, 100]]);
  });
  ctx.restore();
  assert.deepEqual(seen, [[20, 20, 30, 30]], "narrowed, in one request");
});

// ------------------------------------------------------------------
// the flush points: a clip that outlives its drawing must not reach the
// next one

test("an unclipped fillRect after a clipped one is not clipped", async () => {
  const ctx = freshCtx();
  clipTo(ctx, 0, 0, 20, 20);
  ctx.fillStyle = "red";
  ctx.fillRects([[0, 0, W, H]]);
  ctx.restore();

  // no clip stack now, and this route composites straight to the picture
  // without stamping anything of its own
  ctx.fillStyle = "blue";
  ctx.fillRect(40, 40, 40, 40);

  const img = await read(ctx);
  assert.deepEqual(at(img, 10, 10), RED, "the clipped fill stayed inside");
  assert.deepEqual(at(img, 60, 60), BLUE, "the unclipped one was not narrowed");
  assert.deepEqual(at(img, 100, 10), WHITE, "and painted only its own box");
});

test("an unclipped fillRects batch after a clipped one is not clipped", async () => {
  const ctx = freshCtx();
  clipTo(ctx, 0, 0, 20, 20);
  ctx.fillStyle = "red";
  ctx.fillRects([[0, 0, W, H]]);
  ctx.restore();

  ctx.fillStyle = "blue";
  ctx.fillRects([[40, 40, 40, 40]]);

  const img = await read(ctx);
  assert.deepEqual(at(img, 60, 60), BLUE, "the no-clip branch flushed first");
});

test("an unclipped clearRect after a clipped drawing clears everything", async () => {
  const ctx = freshCtx();
  clipTo(ctx, 0, 0, 20, 20);
  ctx.fillStyle = "red";
  ctx.fillRects([[0, 0, W, H]]);
  ctx.restore();

  // the clearRect fast path is another composite that sets no clip of its own
  ctx.clearRect(0, 0, W, H);
  const img = await read(ctx);
  assert.deepEqual(at(img, 10, 10), WHITE, "cleared inside the old clip");
  assert.deepEqual(at(img, 60, 60), WHITE, "and outside it");
});

test("a masked fill after a clipped drawing is not clipped", async () => {
  const ctx = freshCtx();
  clipTo(ctx, 0, 0, 20, 20);
  ctx.fillStyle = "red";
  ctx.fillRects([[0, 0, W, H]]);
  ctx.restore();

  // a transform forces the coverage-mask route, which composites onto the
  // picture without a clip rectangle anywhere
  ctx.save();
  ctx.translate(40, 40);
  ctx.fillStyle = "blue";
  ctx.fillRect(0, 0, 40, 40);
  ctx.restore();

  const img = await read(ctx);
  assert.deepEqual(at(img, 60, 60), BLUE, "the mask route flushed first");
});

test("reading ctx.picture settles the slot", () => {
  const ctx = freshCtx();
  clipTo(ctx, 10, 10, 20, 20);
  ctx.fillStyle = "red";
  ctx.fillRects([[0, 0, W, H]]);
  ctx.restore();

  // an outside caller compositing onto (or from) the picture must not
  // inherit a rectangle from whatever ntk drew last
  const seen = stamps(ctx, () => {
    void ctx.picture;
  });
  assert.deepEqual(
    seen,
    [[0, 0, 0x7fff, 0x7fff]],
    "the owed reset went out on the read",
  );
});
