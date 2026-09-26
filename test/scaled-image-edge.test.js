// A scaled image is its own colour out to its edge.
//
// drawImage scales on the server, bilinear, through the picture transform.
// Sampling at the rim reads half a source pixel past the image, and with the
// picture's default repeat — none — that reads transparent: an upscaled image
// faded into whatever was under it across its outer pixels, where the canvas
// spec clamps to the edge, as browsers do. A document's image swatches came
// out with soft borders, and so did an icon scaled up.
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import xserver from "x11/lib/xserver/index.js";

import { createClient, Image, StaticFontSource, Surface } from "../lib/index.js";

let app = null;
const W = 60;
const H = 60;

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

async function pixels(ctx) {
  const img = await ctx.getImageData(0, 0, W, H);
  return (x, y) => {
    const i = (y * W + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
}

const BLUE = [0, 0, 255];
const WHITE = [255, 255, 255];

/** The destination's four edges, a pixel in from each, and one pixel out. */
function assertCrisp(at, x, y, w, h, colour) {
  const mid = (a, b) => Math.floor((a + b) / 2);
  for (const [px, py, what] of [
    [x, mid(y, y + h), "left edge"],
    [x + w - 1, mid(y, y + h), "right edge"],
    [mid(x, x + w), y, "top edge"],
    [mid(x, x + w), y + h - 1, "bottom edge"],
    [x, y, "corner"],
  ]) {
    assert.deepEqual(at(px, py), colour, `${what} (${px}, ${py})`);
  }
  for (const [px, py, what] of [
    [x - 1, mid(y, y + h), "left of it"],
    [x + w, mid(y, y + h), "right of it"],
    [mid(x, x + w), y - 1, "above it"],
    [mid(x, x + w), y + h, "below it"],
  ]) {
    assert.deepEqual(at(px, py), WHITE, `${what} (${px}, ${py})`);
  }
}

test("an image drawn larger is its colour out to its edge, and no further", async () => {
  const data = Buffer.alloc(3 * 3 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([0, 0, 255, 255], i);
  const image = new Image({ width: 3, height: 3, data });
  const ctx = freshCtx();
  ctx.drawImage(image, 10, 10, 30, 30);
  assertCrisp(await pixels(ctx), 10, 10, 30, 30, BLUE);
});

test("a coverage surface drawn larger is filled out to its edge", async () => {
  const coverage = new Surface(app, { width: 3, height: 3, format: "a8" });
  coverage.render((c) => {
    c.fillStyle = "white";
    c.fillRect(0, 0, 3, 3);
  });
  const ctx = freshCtx();
  ctx.fillStyle = "blue";
  ctx.drawImage(coverage, 10, 10, 30, 30);
  assertCrisp(await pixels(ctx), 10, 10, 30, 30, BLUE);
  coverage.destroy();
});

test("an image drawn at its own size is untouched by the clamp", async () => {
  const data = Buffer.alloc(4 * 4 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([0, 0, 255, 255], i);
  const image = new Image({ width: 4, height: 4, data });
  const ctx = freshCtx();
  ctx.drawImage(image, 10, 10);
  assertCrisp(await pixels(ctx), 10, 10, 4, 4, BLUE);
});
