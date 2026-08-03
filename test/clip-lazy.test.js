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

// The clip mask's own routing (#177): a non-rectangular entry is coverage
// like any other, so it goes through the same local/server decision as a
// fill. Before this it always went to the server, which meant an app that
// asked for everything local still paid an AddTraps per rounded clip — and
// on glamor that fallback is the whole frame cost.

/** Run `draw` on a fresh context under `policy`, counting AddTraps. */
async function underPolicy(policy, draw) {
  if (policy) app.options.rasterPolicy = policy;
  else delete app.options.rasterPolicy;
  const ctx = freshCtx();
  const traps = countingTraps(ctx, () => draw(ctx));
  const img = await read(ctx);
  delete app.options.rasterPolicy;
  return { traps, img };
}

const roundedClipFill = (ctx) => {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(10, 10, 80, 80, 24);
  ctx.clip();
  ctx.fillStyle = "red";
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
};

test("a rounded clip rasterizes locally when the policy allows", async () => {
  const local = await underPolicy(
    { maxArea: Infinity, bytesPerEdge: Infinity, maxBytes: 1 << 22 },
    roundedClipFill,
  );
  assert.equal(local.traps, 0, "the clip mask went out as coverage");
  assert.deepEqual(at(local.img, 50, 50), [255, 0, 0], "center filled");
  assert.ok(isWhite(at(local.img, 12, 12)), "the corner the radius cuts off");
  assert.ok(isWhite(at(local.img, 95, 95)), "outside the clip");
});

test("...and falls back to trapezoids when the policy says server", async () => {
  const server = await underPolicy(
    { maxArea: 0, bytesPerEdge: 0, maxBytes: 0 },
    roundedClipFill,
  );
  assert.ok(server.traps > 0, "the server route is still reachable");
  assert.deepEqual(at(server.img, 50, 50), [255, 0, 0], "center filled");
  assert.ok(isWhite(at(server.img, 12, 12)), "corner still cut");
});

test("both clip routes paint the same pixels", async () => {
  const local = await underPolicy(
    { maxArea: Infinity, bytesPerEdge: Infinity, maxBytes: 1 << 22 },
    roundedClipFill,
  );
  const server = await underPolicy(
    { maxArea: 0, bytesPerEdge: 0, maxBytes: 0 },
    roundedClipFill,
  );
  let sum = 0;
  let max = 0;
  for (let i = 0; i < local.img.data.length; i++) {
    const d = Math.abs(local.img.data[i] - server.img.data[i]);
    sum += d;
    if (d > max) max = d;
  }
  const mean = sum / local.img.data.length;
  // the two rasterizers antialias the corner arc slightly differently;
  // everything else must agree
  assert.ok(mean < 2, `mean channel difference ${mean.toFixed(2)}`);
});

test("a clip temp GC is created once and freed with the context", async () => {
  app.options.rasterPolicy = {
    maxArea: Infinity,
    bytesPerEdge: Infinity,
    maxBytes: 1 << 22,
  };
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext("2d");
  let created = 0;
  const realCreateGC = ctx.X.CreateGC;
  ctx.X.CreateGC = function (...args) {
    created += 1;
    return realCreateGC.apply(this, args);
  };
  try {
    for (let i = 0; i < 4; i++) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(10 + i, 10, 60, 60, 20);
      ctx.clip();
      ctx.fillStyle = "red";
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  } finally {
    ctx.X.CreateGC = realCreateGC;
    delete app.options.rasterPolicy;
  }
  assert.ok(
    created <= 2,
    `one GC for the temps, not one per clip (${created})`,
  );
  ctx.destroy();
  assert.equal(ctx._clipMaskGC, null, "and it is released with the context");
  pixmap.destroy();
});
