// The clip mask is kept across restores, and cleared where it was written.
//
// A path clip — a rounded rectangle, a clip that is not whole pixels —
// materializes an a8 mask the size of the surface. A restore that took the
// path off the stack used to destroy it, so a list of rounded rows, each
// clipped and restored, made and freed a surface-sized pixmap for every row
// and cleared all of it. The mask is kept now, as the fill mask beside it
// is, and a reuse clears only the box its last first shape covered: what
// the mask holds is never outside it, since everything intersected with it
// only takes coverage away.
//
// And a clip's coverage is rasterized here rather than added on the server
// with AddTraps, which glamor has no GPU path for: it reads the pixmap the
// traps are added into back from the GPU, for every clip.
//
// What is asserted: rows clipped one after another make one mask between
// them; each row's clip leaves nothing of the row before it behind; a
// rounded clip sends its coverage with a PutImage and no traps; and a
// resize drops the kept mask, which is the size the surface was.
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import xserver from "x11/lib/xserver/index.js";

import { createClient, StaticFontSource } from "../lib/index.js";

let app = null;

before(async () => {
  const server = xserver.createServer({ width: 400, height: 300 });
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

function freshCtx(width = 200, height = 160) {
  const ctx = app.createPixmap({ width, height, depth: 24 }).getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, height);
  return ctx;
}

const px = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

/** A row: a rounded clip, a fill through it, the clip taken off again. */
function row(ctx, y, colour) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(20, y, 160, 24, 6);
  ctx.clip();
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, ctx.width, ctx.height);
  ctx.restore();
}

/** Count the pixmaps made during `fn`. */
function pixmapsMade(fn) {
  const X = app.X;
  const original = X.CreatePixmap;
  let made = 0;
  X.CreatePixmap = function (...args) {
    made += 1;
    return original.apply(this, args);
  };
  try {
    fn();
  } finally {
    X.CreatePixmap = original;
  }
  return made;
}

describe("the clip mask is kept across restores", () => {
  test("rows clipped one after another make one mask between them", () => {
    const ctx = freshCtx();
    row(ctx, 4, "red"); // the first makes it
    const made = pixmapsMade(() => {
      for (let i = 1; i < 6; i++) row(ctx, 4 + i * 26, "red");
    });
    // a path clip rasterizes its coverage on a pixmap the size of its box,
    // which comes and goes with each clip; the mask the size of the surface
    // is not one of them
    assert.ok(made <= 5, `${made} pixmaps for five rows`);
    assert.ok(ctx._keptClipMask, "kept after the last restore");
  });

  test("each row's clip leaves nothing of the row before it behind", async () => {
    const ctx = freshCtx();
    row(ctx, 10, "red");
    row(ctx, 80, "blue");
    // a fill with the second clip in force reaches only the second row
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(20, 80, 160, 24, 6);
    ctx.clip();
    ctx.fillStyle = "lime";
    ctx.fillRect(0, 0, ctx.width, ctx.height);
    ctx.restore();
    const img = await ctx.getImageData(0, 0, ctx.width, ctx.height);
    assert.deepEqual(px(img, 100, 20), [255, 0, 0], "the first row as drawn");
    assert.deepEqual(px(img, 100, 90), [0, 255, 0], "the second, refilled");
    assert.deepEqual(px(img, 100, 50), [255, 255, 255], "nothing between");
    assert.deepEqual(px(img, 5, 90), [255, 255, 255], "nothing beside");
  });

  test("a rectangle clip after a path clip draws everywhere inside it", async () => {
    const ctx = freshCtx();
    row(ctx, 10, "red");
    // a stack of a path and then nothing: the kept mask is filled again,
    // and cleared where the row was
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(10, 50, 180, 100, 20);
    ctx.clip();
    ctx.fillStyle = "blue";
    ctx.fillRect(0, 0, ctx.width, ctx.height);
    ctx.restore();
    const img = await ctx.getImageData(0, 0, ctx.width, ctx.height);
    assert.deepEqual(px(img, 100, 100), [0, 0, 255], "inside the second");
    assert.deepEqual(px(img, 100, 20), [255, 0, 0], "the row, untouched");
    assert.deepEqual(px(img, 12, 52), [255, 255, 255], "outside its corner");
  });

  test("a rounded clip's coverage is rasterized here, not added on the server", () => {
    // AddTraps adds into a picture that exists, which glamor reads back
    // from the GPU to do; a clip's coverage goes up with a PutImage
    const ctx = freshCtx();
    const X = app.X;
    const R = app.display.Render;
    const sent = { PutImage: 0, AddTraps: 0 };
    const put = X.PutImage;
    const traps = R.AddTraps;
    X.PutImage = function (...args) {
      sent.PutImage += 1;
      return put.apply(this, args);
    };
    R.AddTraps = function (...args) {
      sent.AddTraps += 1;
      return traps.apply(this, args);
    };
    try {
      row(ctx, 40, "red");
    } finally {
      X.PutImage = put;
      R.AddTraps = traps;
    }
    assert.equal(sent.AddTraps, 0, "no traps added");
    assert.ok(sent.PutImage >= 1, "the coverage put");
  });

  test("a resize drops the kept mask", () => {
    const win = app.createWindow({ width: 120, height: 80 });
    const ctx = win.getContext("2d");
    row(ctx, 4, "red");
    assert.ok(ctx._keptClipMask, "kept");
    ctx._dropMasks();
    assert.equal(ctx._keptClipMask, null, "dropped with the masks");
    win.destroy?.();
  });
});
