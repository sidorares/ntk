// How a picture is read is left for the next draw to set.
//
// A picture's transform, filter and repeat are properties of the picture
// on the server, and `drawImage` used to set them for each scaled or turned
// draw and put them all back after it — five requests where two do, and the
// putting back the costly part: a filter changed and changed back around
// each of 256 composites cost Xwayland's glamor 36 ms where the composites
// took 0.6, and a transform put back to identity after each cost pixman 7.
// A surface drawn through a perspective a tile at a time paid it every tile.
//
// What is asserted: an `Image`'s or a `Surface`'s picture is set to what a
// draw reads it through only where it differs, and is not put back; what a
// draw left is put back for anything that reads the pixels as they are — an
// untransformed draw, `picture(app)` — and what a caller set on the picture
// is not; and a picture ntk does not keep, a context's own or a caller's
// handle, is put back after every read, as before.
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import xserver from "x11/lib/xserver/index.js";

import { createClient, StaticFontSource, Surface } from "../lib/index.js";

let app = null;

before(async () => {
  const server = xserver.createServer({ width: 300, height: 300 });
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

function freshCtx(width = 120, height = 120) {
  const ctx = app.createPixmap({ width, height, depth: 24 }).getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, height);
  return ctx;
}

const read = (ctx) => ctx.getImageData(0, 0, ctx.width, ctx.height);

/** A 20x20 surface of four coloured quarters: every pixel says where in
 *  the surface it came from, as far as a quarter can. */
function quarters() {
  const surface = new Surface(app, { width: 20, height: 20 });
  surface.render((c) => {
    c.fillStyle = "red";
    c.fillRect(0, 0, 10, 10);
    c.fillStyle = "lime";
    c.fillRect(10, 0, 10, 10);
    c.fillStyle = "blue";
    c.fillRect(0, 10, 10, 10);
    c.fillStyle = "black";
    c.fillRect(10, 10, 10, 10);
  });
  return surface;
}

/** Count the RENDER requests that set how a picture is read, during `fn`. */
function counting(fn) {
  const R = app.display.Render;
  const names = ["SetPictureTransform", "SetPictureFilter", "ChangePicture"];
  const seen = { SetPictureTransform: [], SetPictureFilter: [], ChangePicture: [] };
  const originals = names.map((n) => R[n]);
  names.forEach((n, i) => {
    R[n] = function (...args) {
      seen[n].push(args);
      return originals[i].apply(this, args);
    };
  });
  try {
    fn();
  } finally {
    names.forEach((n, i) => {
      R[n] = originals[i];
    });
  }
  return seen;
}

const isIdentity = (m) =>
  m.length === 9 && m.every((v, i) => v === (i % 4 === 0 ? 1 : 0));

describe("a picture is read as a draw needs, and left so", () => {
  test("a surface drawn through a matrix a tile at a time: its filter once, a transform a tile, nothing put back", () => {
    const ctx = freshCtx();
    const surface = quarters();
    const tiles = [];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) tiles.push([x * 5, y * 5]);
    const seen = counting(() => {
      for (const [x, y] of tiles) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(20 + x, 20 + y, 5, 5);
        ctx.clip();
        // each tile its own matrix, as a perspective's tiles are
        ctx.transform(1, 0.01 * x, 0.01 * y, 1, 20, 20);
        ctx.drawImage(surface, 0, 0);
        ctx.restore();
      }
    });
    assert.equal(seen.SetPictureFilter.length, 1, "the filter is set once");
    // at most one a tile: one that reads through the matrix the tile before
    // left sends nothing
    assert.ok(seen.SetPictureTransform.length <= tiles.length, "no more than a transform a tile");
    assert.ok(seen.SetPictureTransform.length >= tiles.length / 2, "each tile its own matrix");
    assert.ok(
      !seen.SetPictureTransform.some(([, m]) => isIdentity(m)),
      "no transform is put back to identity",
    );
    assert.equal(seen.ChangePicture.length, 0, "its repeat is left alone");
    surface.destroy();
  });

  test("a draw of the pixels as they are puts back what a scaled draw left", async () => {
    const surface = quarters();
    const a = freshCtx();
    a.drawImage(surface, 0, 0, 60, 60); // scaled: a transform, bilinear, pad
    a.drawImage(surface, 70, 70); // as it is
    const b = freshCtx();
    b.drawImage(surface, 70, 70);
    const got = await read(a);
    const want = await read(b);
    for (let y = 70; y < 90; y++) {
      for (let x = 70; x < 90; x++) {
        const i = (y * got.width + x) * 4;
        assert.deepEqual(
          [...got.data.subarray(i, i + 3)],
          [...want.data.subarray(i, i + 3)],
          `pixel ${x},${y} is the surface's own`,
        );
      }
    }
    surface.destroy();
  });

  test("a turned draw after a scaled one does not pad: the corners of its box stay clear", async () => {
    const surface = quarters();
    const ctx = freshCtx();
    ctx.drawImage(surface, 0, 0, 40, 40); // leaves Repeat.Pad on the picture
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 120, 120);
    ctx.translate(60, 30);
    ctx.rotate(Math.PI / 4);
    ctx.drawImage(surface, 0, 0);
    const img = await read(ctx);
    // the turned square's bounding box runs from about (46, 30) to (74, 58);
    // its corners are outside the square, and must be the paper
    for (const [x, y] of [
      [47, 31],
      [73, 31],
      [47, 57],
      [73, 57],
    ]) {
      const i = (y * img.width + x) * 4;
      assert.deepEqual([...img.data.subarray(i, i + 3)], [255, 255, 255], `${x},${y}`);
    }
    surface.destroy();
  });

  test("picture(app) hands out the picture as stored, and costs nothing when it is", () => {
    const surface = quarters();
    const ctx = freshCtx();
    ctx.drawImage(surface, 0, 0, 60, 60);
    const seen = counting(() => {
      const picture = surface.picture(app);
      assert.ok(isIdentity(picture._transform));
      assert.equal(picture._filter, "nearest");
      assert.equal(picture._repeat, 0);
    });
    assert.ok(seen.SetPictureTransform.length + seen.SetPictureFilter.length > 0);
    const again = counting(() => surface.picture(app));
    assert.equal(
      again.SetPictureTransform.length + again.SetPictureFilter.length + again.ChangePicture.length,
      0,
      "already as stored: nothing sent",
    );
    surface.destroy();
  });

  test("a filter set on a surface stays through a draw of it as it is", async () => {
    const surface = quarters();
    surface.picture(app).setBlurFilter(5, 2);
    const ctx = freshCtx();
    const seen = counting(() => ctx.drawImage(surface, 10, 10));
    assert.equal(seen.SetPictureFilter.length, 0, "the caller's filter is not touched");
    // and it blurred: red and lime meet in a blend at the middle of the top
    const img = await read(ctx);
    const i = (15 * img.width + 20) * 4;
    const [r, g] = img.data.subarray(i, i + 2);
    assert.ok(r > 30 && r < 225 && g > 30 && g < 225, `blended, got ${r},${g}`);
    surface.destroy();
  });

  test("a context drawn as an image is put back after a scaled draw, as before", () => {
    const source = freshCtx(20, 20);
    source.fillStyle = "red";
    source.fillRect(0, 0, 20, 20);
    const ctx = freshCtx();
    ctx.drawImage(source, 0, 0, 40, 40);
    const picture = source._picture;
    assert.ok(isIdentity(picture._transform));
    assert.equal(picture._filter, "nearest");
    assert.equal(picture._repeat, 0);
  });

  test("a caller's picture handle is put back after a scaled draw, as before", () => {
    const surface = quarters();
    const id = surface.picture(app).id;
    const handle = {
      width: 20,
      height: 20,
      picture: () => ({
        id,
        setFilter: (name, params) => app.display.Render.SetPictureFilter(id, name, params),
      }),
    };
    const ctx = freshCtx();
    const seen = counting(() => ctx.drawImage(handle, 0, 0, 40, 40));
    const transforms = seen.SetPictureTransform.map(([, m]) => m);
    assert.ok(isIdentity(transforms.at(-1)), "its transform put back");
    assert.equal(seen.SetPictureFilter.at(-1)[1], "nearest", "its filter put back");
    assert.equal(seen.ChangePicture.at(-1)[1].repeat, 0, "its repeat put back");
    surface.destroy();
  });
});
