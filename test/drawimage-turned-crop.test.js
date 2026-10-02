// A crop drawn under a transform is the crop, and nothing beside it.
//
// Under a transform, drawImage composites over the whole-pixel box around the
// turned destination rectangle and samples the image through the inverse
// transform across all of it. Turned, skewed or off the pixel grid, that box
// holds pixels outside the rectangle. Past a whole image they read
// transparent; past a crop they read the rest of the image. The red half of a
// red-and-blue image turned 30° came out with a wedge of the blue half beside
// it, 377 pixels of a colour the call never asked for, and the same crop
// moved a tenth of a pixel came out with a column of it.
//
// What is asserted here: a crop under a transform draws what the same pixels
// cut out into an image of their own draw, for every kind of source. The
// copy that takes is paid only where the box is wider than the rectangle,
// and only for the part of the crop the draw can show.
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import xserver from "x11/lib/xserver/index.js";

import { createClient, Image, StaticFontSource, Surface } from "../lib/index.js";

let app = null;
const W = 80;
const H = 80;

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

const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];

/** straight RGBA, w x h: red left of `split`, blue from it on */
function twoTone(w, h, split) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data.set(x < split ? RED : BLUE, (y * w + x) * 4);
  }
  return data;
}

/** the 40x40 image whose red left half is the crop */
const halves = () => new Image({ width: 40, height: 40, data: twoTone(40, 40, 20) });

/** that crop, cut out into an image of its own */
const redHalf = () => new Image({ width: 20, height: 40, data: twoTone(20, 40, 20) });

function freshCtx(width = W, height = H) {
  const ctx = app.createPixmap({ width, height, depth: 24 }).getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, height);
  return ctx;
}

const read = (ctx) => ctx.getImageData(0, 0, ctx.width, ctx.height);

const px = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

/** The call the leak was found with: turned 30° about (40, 10). */
function turned30(ctx, image, ...args) {
  ctx.save();
  ctx.translate(40, 10);
  ctx.rotate(Math.PI / 6);
  ctx.drawImage(image, ...args);
  ctx.restore();
}

/**
 * Pixels that took in anything from beyond a red crop: red over white keeps
 * green and blue equal, so a pixel where they differ has blue in it.
 */
function beyondCrop(img) {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 2] !== img.data[i + 1]) n++;
  }
  return n;
}

/** pixels of the crop's own red, drawn opaque */
function solidRed(img) {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i] === 255 && img.data[i + 1] === 0 && img.data[i + 2] === 0) n++;
  }
  return n;
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
  const p = where >> 2;
  assert.equal(
    worst,
    0,
    `${what}: ${worst} levels apart at (${p % a.width}, ${Math.floor(p / a.width)})`,
  );
}

/** The pixmaps a drawing creates, as [depth, width, height]: the copy is one. */
function pixmapsDuring(ctx, fn) {
  const X = ctx.X;
  const original = X.CreatePixmap;
  const made = [];
  X.CreatePixmap = function (pid, drawable, depth, width, height) {
    made.push([depth, width, height]);
    return original.apply(this, arguments);
  };
  try {
    fn();
  } finally {
    X.CreatePixmap = original;
  }
  return made;
}

async function xErrorsDuring(fn) {
  const errors = [];
  const report = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.error = report;
  }
  return errors.filter((e) => /X error/.test(e));
}

test("the red half of an image turned 30° is the red half, and nothing beside it", async () => {
  const image = halves();
  image.picture(app); // uploaded already, so the one pixmap below is the copy
  const ctx = freshCtx();
  const made = pixmapsDuring(ctx, () => turned30(ctx, image, 0, 0, 20, 40, 0, 0, 20, 40));
  const ref = freshCtx();
  turned30(ref, redHalf(), 0, 0, 20, 40);

  const got = await read(ctx);
  assert.equal(beyondCrop(got), 0, "pixels of the blue half drawn beside the crop");
  assertSamePixels(got, await read(ref), "against the same pixels cut out");
  assert.ok(solidRed(got) > 700, `the crop is drawn: ${solidRed(got)} pixels of it`);
  assert.deepEqual(made, [[32, 20, 40]], "one copy, of the crop and no more");
});

describe("every kind of source is cut the same way", () => {
  const sources = {
    "an Image": () => halves(),
    "a Surface": () => {
      const surface = new Surface(app, { width: 40, height: 40 });
      surface.render((c) => {
        c.fillStyle = "red";
        c.fillRect(0, 0, 20, 40);
        c.fillStyle = "blue";
        c.fillRect(20, 0, 20, 40);
      });
      return surface;
    },
    "another 2d context": () => {
      const c = app.createPixmap({ width: 40, height: 40, depth: 32 }).getContext("2d");
      c.fillStyle = "red";
      c.fillRect(0, 0, 20, 40);
      c.fillStyle = "blue";
      c.fillRect(20, 0, 20, 40);
      return c;
    },
    "a node-canvas": () => ({
      width: 40,
      height: 40,
      context: {
        getImageData: (x, y, w, h) => ({
          width: w,
          height: h,
          data: new Uint8ClampedArray(twoTone(40, 40, 20)),
        }),
      },
    }),
  };
  for (const [kind, make] of Object.entries(sources)) {
    test(kind, async () => {
      const ctx = freshCtx();
      turned30(ctx, make(), 0, 0, 20, 40, 0, 0, 20, 40);
      const ref = freshCtx();
      turned30(ref, redHalf(), 0, 0, 20, 40);
      const got = await read(ctx);
      assert.equal(beyondCrop(got), 0, "pixels from beyond the crop");
      assertSamePixels(got, await read(ref), "against the same pixels cut out");
    });
  }

  test("a context cut from itself, turned over the pixels it reads", async () => {
    const paint = (c) => {
      c.fillStyle = "red";
      c.fillRect(0, 0, 20, 40);
      c.fillStyle = "blue";
      c.fillRect(20, 0, 20, 40);
    };
    const turn = (c, image, ...args) => {
      c.save();
      c.translate(30, 20);
      c.rotate(Math.PI / 6);
      c.drawImage(image, ...args);
      c.restore();
    };
    const ctx = freshCtx();
    paint(ctx);
    // one copy, of the crop: the one a draw onto its own pixels takes anyway
    const made = pixmapsDuring(ctx, () => turn(ctx, ctx, 0, 0, 20, 40, 0, 0, 20, 40));
    assert.deepEqual(made, [[32, 20, 40]]);
    const ref = freshCtx();
    paint(ref);
    turn(ref, redHalf(), 0, 0, 20, 40);
    assertSamePixels(await read(ctx), await read(ref), "against the same pixels cut out");
  });
});

test("a crop a tenth of a pixel off the grid draws no column beside it", async () => {
  const draw = (ctx, image, ...args) => {
    ctx.save();
    ctx.translate(10.1, 10);
    ctx.drawImage(image, ...args);
    ctx.restore();
  };
  const ctx = freshCtx();
  draw(ctx, halves(), 0, 0, 20, 40, 0, 0, 20, 40);
  const ref = freshCtx();
  draw(ref, redHalf(), 0, 0, 20, 40);
  const got = await read(ctx);
  assert.equal(beyondCrop(got), 0, "a column of the blue half at x 30");
  assertSamePixels(got, await read(ref), "against the same pixels cut out");
});

test("a crop scaled onto whole pixels, or turned a quarter, is drawn from the image itself", async () => {
  const image = halves();
  image.picture(app);
  const ctx = freshCtx();
  const made = pixmapsDuring(ctx, () => {
    ctx.save();
    ctx.translate(4, 40);
    ctx.scale(2, 2);
    ctx.drawImage(image, 0, 0, 20, 30, 0, 0, 10, 15); // device (4, 40) to (24, 70)
    ctx.restore();
    // (u, v) lands at (60 - v, 10 + u), but cos(π/2) is 6e-17, which puts
    // the corner meant for (20, 30) at y 30.000000000000004: the box rounded
    // that out to a row the rectangle does not reach, and the row sampled
    // the blue half all the way across
    ctx.save();
    ctx.translate(60, 10);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(image, 0, 0, 20, 40, 0, 0, 20, 40); // device (20, 10) to (60, 30)
    ctx.restore();
  });
  assert.deepEqual(made, [], "no copy where the box is the rectangle");

  const got = await read(ctx);
  const WHITE = [255, 255, 255];
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(px(got, 4 + i, 70), WHITE, `below the scaled crop, x ${4 + i}`);
    assert.deepEqual(px(got, 24, 40 + i), WHITE, `right of it, y ${40 + i}`);
    assert.deepEqual(px(got, 20 + 2 * i, 30), WHITE, `below the turned crop, x ${20 + 2 * i}`);
    assert.deepEqual(px(got, 19, 10 + i), WHITE, `left of it, y ${10 + i}`);
  }
  assert.deepEqual(px(got, 14, 55), [255, 0, 0], "the scaled crop is drawn");
  assert.deepEqual(px(got, 40, 20), [255, 0, 0], "and the turned one");
});

test("a turned crop the clip rejects copies nothing, and a node-canvas uploads nothing", async () => {
  const image = halves();
  image.picture(app);
  let reads = 0;
  const canvas = {
    width: 40,
    height: 40,
    context: {
      getImageData: (x, y, w, h) => {
        reads++;
        return { width: w, height: h, data: new Uint8ClampedArray(twoTone(40, 40, 20)) };
      },
    },
  };
  const ctx = freshCtx();
  const made = pixmapsDuring(ctx, () => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, 5, 5); // the turned rectangle's box is (20, 10) to (58, 55)
    ctx.clip();
    turned30(ctx, image, 0, 0, 20, 40, 0, 0, 20, 40);
    turned30(ctx, canvas, 0, 0, 20, 40, 0, 0, 20, 40);
    ctx.restore();
  });
  assert.deepEqual(made, []);
  assert.equal(reads, 0);
  assert.equal(solidRed(await read(ctx)), 0);
});

test("a big crop mostly off the surface copies only the part of it that shows", async () => {
  // a 200x200 image whose left 100 columns are the crop, drawn so that the
  // surface shows a corner of it, the crop's right edge included
  const big = new Image({ width: 200, height: 200, data: twoTone(200, 200, 100) });
  big.picture(app);
  const cut = new Image({ width: 100, height: 200, data: twoTone(100, 200, 100) });
  const draw = (ctx, image, ...args) => {
    ctx.save();
    ctx.translate(-30, -60);
    ctx.rotate(Math.PI / 6);
    ctx.drawImage(image, ...args);
    ctx.restore();
  };
  const ctx = freshCtx();
  const made = pixmapsDuring(ctx, () => draw(ctx, big, 0, 0, 100, 200, 0, 0, 100, 200));
  assert.equal(made.length, 1);
  const [, w, h] = made[0];
  assert.ok(w * h < 100 * 200 / 3, `the copy is ${w}x${h} of a 100x200 crop`);

  const ref = freshCtx();
  draw(ref, cut, 0, 0, 100, 200);
  const got = await read(ctx);
  assert.equal(beyondCrop(got), 0, "pixels from beyond the crop");
  assertSamePixels(got, await read(ref), "against the same pixels cut out");
  assert.ok(solidRed(got) > 1500, `the part that shows is drawn: ${solidRed(got)} pixels`);
});

test("under a rectangular clip a turned crop is its copy and one composite, the mask route's pixels", async () => {
  const image = halves();
  image.picture(app);
  const draw = (ctx, source, ...args) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(42, 14, 16, 24);
    ctx.clip();
    turned30(ctx, source, ...args);
    ctx.restore();
  };
  const boxed = freshCtx();
  const made = pixmapsDuring(boxed, () => draw(boxed, image, 0, 0, 20, 40, 0, 0, 20, 40));
  // no a8 mask: the clip narrows the composite box (issue #307), and the
  // copy is of what that box samples
  assert.equal(made.length, 1, `pixmaps made: ${JSON.stringify(made)}`);
  const [depth, w, h] = made[0];
  assert.equal(depth, 32);
  assert.ok(w * h < 20 * 40, `the copy is ${w}x${h} of a 20x40 crop`);

  const masked = freshCtx();
  masked._boxedComposite = () => null; // the route the box replaces
  draw(masked, image, 0, 0, 20, 40, 0, 0, 20, 40);
  const ref = freshCtx();
  draw(ref, redHalf(), 0, 0, 20, 40);

  const got = await read(boxed);
  assert.equal(beyondCrop(got), 0, "pixels from beyond the crop");
  assertSamePixels(got, await read(masked), "against the mask route");
  assertSamePixels(got, await read(ref), "against the same pixels cut out");
  assert.ok(solidRed(got) > 100, "the clipped part is drawn");
});

test("a turned crop casts the crop's shadow, and no more", async () => {
  const shadowed = (ctx) => {
    ctx.shadowColor = "black";
    ctx.shadowOffsetX = 6;
    ctx.shadowOffsetY = 4;
    ctx.shadowBlur = 3;
    return ctx;
  };
  const ctx = shadowed(freshCtx());
  turned30(ctx, halves(), 0, 0, 20, 40, 0, 0, 20, 40);
  const ref = shadowed(freshCtx());
  turned30(ref, redHalf(), 0, 0, 20, 40);
  const got = await read(ctx);
  assertSamePixels(got, await read(ref), "against the same pixels cut out");
  // the shadow shows where the blue half was drawn beside the crop
  const [r, g, b] = px(got, 50, 40);
  assert.ok(r < 128 && r === g && g === b, `shadow at (50, 40): ${[r, g, b]}`);
});

test("a cropped thumbnail far from the origin lands where the matrix puts it, off the grid", async () => {
  const CW = 2300;
  const CH = 100;
  const ctx = freshCtx(CW, CH);
  // a 2000x1200 image: red over green on the left, blue over green on the
  // right, and the crop is its top half
  const iw = 2000;
  const ih = 1200;
  const data = Buffer.alloc(iw * ih * 4);
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      const colour = y >= ih / 2 ? [0, 255, 0, 255] : x < iw / 2 ? RED : BLUE;
      data.set(colour, (y * iw + x) * 4);
    }
  }
  const img = new Image({ width: iw, height: ih, data });
  img.picture(app);

  // The crop as a 50x30 thumbnail turned a quarter about its centre at
  // x 2,200, half a pixel off the grid: the transform has to carry where in
  // the copy the box's corner is, as it does for the image itself. (u, v)
  // of the thumbnail lands at (2280.5 - v, u - 2170).
  const errors = await xErrorsDuring(async () => {
    const made = pixmapsDuring(ctx, () => {
      ctx.save();
      ctx.translate(2225.5, 55);
      ctx.rotate(Math.PI / 2);
      ctx.translate(-2225, -55);
      ctx.drawImage(img, 0, 0, 2000, 600, 2200, 40, 50, 30);
      // and one too small for the transform to say: no copy, no draw
      ctx.drawImage(img, 0, 0, 2000, 600, 2190, 50, 0.0002, 0.0002);
      ctx.restore();
    });
    assert.equal(made.length, 1, `pixmaps made: ${JSON.stringify(made)}`);
    await ctx.getImageData(0, 0, 1, 1);
  });
  assert.deepEqual(errors, []);

  const got = await read(ctx);
  assert.deepEqual(px(got, 2225, 38), [255, 0, 0], "the crop's left, at the top");
  assert.deepEqual(px(got, 2225, 72), [0, 0, 255], "its right, at the bottom");
  assert.deepEqual(px(got, 2205, 55), [255, 255, 255], "left of it");
  // Red and blue over white leave green no higher than the lower of the two;
  // the green beyond the crop would raise it. The crop ends on the
  // rectangle's left side, the one half a pixel off the grid.
  for (let y = 0; y < CH; y++) {
    for (let x = 2190; x < 2260; x++) {
      const [r, g, b] = px(got, x, y);
      assert.ok(g <= Math.min(r, b), `green from beyond the crop at (${x}, ${y}): ${[r, g, b]}`);
    }
  }
});
