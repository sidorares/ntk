// Rectangular clip stacks are virtual: no a8 mask, no AddTraps, no
// window-sized pixmap — consumers apply the intersected rectangle
// server-side. The mask exists only while the stack holds something
// genuinely non-rectangular, and its trapezoid work happens in temps
// sized to the entry's bounding box, never on the mask itself.
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
const isWhite = (p) => p[0] > 240 && p[1] > 240 && p[2] > 240;

/** Count AddTraps requests issued while `fn` runs. */
function countingTraps(ctx, fn) {
  const R = ctx.Render;
  const original = R.AddTraps;
  let count = 0;
  R.AddTraps = function (...args) {
    count += 1;
    return original.apply(this, args);
  };
  try {
    fn();
  } finally {
    R.AddTraps = original;
  }
  return count;
}

test("nested rectangular clips never build a mask or send trapezoids", async () => {
  const ctx = freshCtx();
  const traps = countingTraps(ctx, () => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(10, 10, 80, 80);
    ctx.clip();
    ctx.save();
    ctx.beginPath();
    ctx.rect(20, 20, 40, 40);
    ctx.clip();
    ctx.fillStyle = "red";
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    ctx.restore();
  });
  assert.equal(traps, 0, "a rect-only stack must not rasterize anything");
  assert.equal(ctx.clipMask, null, "no mask for a rect-only stack");

  const img = await read(ctx);
  assert.deepEqual(at(img, 30, 30), [255, 0, 0], "inside both clips filled");
  assert.ok(isWhite(at(img, 15, 15)), "inside outer, outside inner: clipped");
  assert.ok(isWhite(at(img, 95, 95)), "outside both: clipped");
});

test("a rounded clip still masks, and pixels honor the corner", async () => {
  const ctx = freshCtx();
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(10, 10, 80, 80, 24);
  ctx.clip();
  assert.ok(ctx.clipMask, "a non-rectangular clip materializes the mask");
  ctx.fillStyle = "red";
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  const img = await read(ctx);
  assert.deepEqual(at(img, 50, 50), [255, 0, 0], "center filled");
  assert.ok(isWhite(at(img, 12, 12)), "the corner the radius cuts off");
  assert.ok(isWhite(at(img, 95, 95)), "outside the clip");
});

test("restore drops the mask and later rect clips stay virtual", async () => {
  const ctx = freshCtx();
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(10, 10, 80, 80, 24);
  ctx.clip();
  ctx.restore();
  assert.equal(ctx.clipMask, null, "restore past the poly drops the mask");

  const traps = countingTraps(ctx, () => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(40, 40, 30, 30);
    ctx.clip();
    ctx.fillStyle = "blue";
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  });
  assert.equal(traps, 0, "back to rectangles, back to no mask");
  assert.equal(ctx.clipMask, null);

  const img = await read(ctx);
  assert.deepEqual(at(img, 50, 50), [0, 0, 255], "inside the rect clip");
  assert.ok(isWhite(at(img, 20, 20)), "outside it");
});
