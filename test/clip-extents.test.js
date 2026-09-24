// A drawing under a clip mask is uploaded and composited only where the clip
// reaches (issue #372).
//
// A stroke across a rounded pane used to upload its whole bounding box as a8
// coverage and composite all of it through the clip mask, however little the
// clip let through: a react-x11 pan repaints a pane's rounded corners as
// passes a few pixels across, and every edge crossing one uploaded all of
// itself. Now the part of the box outside the clip's extents — the
// intersection of its rectangles and its paths' bounding boxes — never goes
// on the wire. The coverage is still rasterized over the whole box, so the
// bytes that do go are the ones they always were.
//
// What is asserted: nothing is uploaded outside the clip's extents, and the
// pixels are the ones the same clip draws with extents that cover the whole
// surface — the band plus a pixel in two far corners, which leaves nothing
// to cut — wherever the band covers fully, and the background outside it.
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import xserver from "x11/lib/xserver/index.js";

import { createClient, StaticFontSource } from "../lib/index.js";

let app = null;
const W = 160;
const H = 120;
// the clip: a thin rounded band, the shape of a pane's corner row
const CLIP = { x: 20, y: 50, w: 120, h: 12, r: 5 };

before(async () => {
  const server = xserver.createServer({ width: 200, height: 200 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  app = await createClient({
    stream: clientEnd,
    fontSource: new StaticFontSource(),
    // coverage rasterized here whatever the box, so the upload is what is
    // under test rather than the server's trapezoids
    rasterPolicy: { maxArea: 1 << 24, maxBytes: 1 << 24 },
  });
});

after(async () => {
  if (app) await app.close();
});

/** Paint `draw` on a white pixmap through the band — alone, or `wide`, with
 * a pixel in two far corners stretching its extents over the surface —
 * recording the coverage uploaded into the fill mask. */
async function paint(draw, { wide = false } = {}) {
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, W, H);
  const uploads = [];
  const X = ctx.X;
  const original = X.PutImage;
  X.PutImage = function (format, drawable, gc, w, h, x, y, ...rest) {
    if (ctx.fillMaskDrawable && drawable === ctx.fillMaskDrawable.id) {
      uploads.push({ x, y, w, h });
    }
    return original.call(this, format, drawable, gc, w, h, x, y, ...rest);
  };
  try {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(CLIP.x, CLIP.y, CLIP.w, CLIP.h, CLIP.r);
    if (wide) {
      ctx.rect(0, 0, 1, 1);
      ctx.rect(W - 1, H - 1, 1, 1);
    }
    ctx.clip();
    draw(ctx);
    ctx.restore();
  } finally {
    X.PutImage = original;
  }
  const img = await ctx.getImageData(0, 0, W, H);
  pixmap.destroy();
  return { img, uploads };
}

const px = (img, x, y) => {
  const i = (y * W + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

/** The drawing is the wide clip's where the band covers fully, and white
 * where nothing of the band reaches. */
function assertClippedTo(clipped, wide) {
  let inked = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inside =
        x >= CLIP.x + CLIP.r &&
        x < CLIP.x + CLIP.w - CLIP.r &&
        y >= CLIP.y &&
        y < CLIP.y + CLIP.h;
      const beyond =
        x < CLIP.x - 1 ||
        x >= CLIP.x + CLIP.w + 1 ||
        y < CLIP.y - 1 ||
        y >= CLIP.y + CLIP.h + 1;
      const got = px(clipped, x, y);
      if (inside) {
        assert.deepEqual(got, px(wide, x, y), `${x},${y} inside the band`);
        if (got[0] < 250) inked++;
      } else if (beyond) {
        assert.deepEqual(got, [255, 255, 255], `${x},${y} outside the band`);
      }
    }
  }
  assert.ok(inked > 0, "the drawing reached the band");
}

/** Every upload into the fill mask lies inside the band's extents, give or
 * take the pixel of slack a path's box carries. */
function assertUploadsInside(uploads) {
  assert.ok(uploads.length > 0, "the coverage was uploaded");
  for (const u of uploads) {
    assert.ok(
      u.x >= CLIP.x - 1 &&
        u.y >= CLIP.y - 1 &&
        u.x + u.w <= CLIP.x + CLIP.w + 1 &&
        u.y + u.h <= CLIP.y + CLIP.h + 1,
      `uploaded ${u.w}x${u.h} at ${u.x},${u.y}, outside the clip`,
    );
  }
}

test("a stroke through a rounded clip uploads only what the clip reaches", async () => {
  // a long, shallow edge: its box is most of the pixmap, the clip a band
  const draw = (ctx) => {
    ctx.strokeStyle = "#1f3a93";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-10, 20);
    ctx.lineTo(W + 10, 95);
    ctx.stroke();
  };
  const narrow = await paint(draw);
  const wide = await paint(draw, { wide: true });
  assertUploadsInside(narrow.uploads);
  assertClippedTo(narrow.img, wide.img);
});

test("so does a fill", async () => {
  const draw = (ctx) => {
    ctx.fillStyle = "#c0392b";
    ctx.beginPath();
    ctx.moveTo(-30, 0);
    ctx.lineTo(W + 30, 40);
    ctx.lineTo(W - 20, H + 10);
    ctx.lineTo(10, 70);
    ctx.closePath();
    ctx.fill();
  };
  const narrow = await paint(draw);
  const wide = await paint(draw, { wide: true });
  assertUploadsInside(narrow.uploads);
  assertClippedTo(narrow.img, wide.img);
});

test("a drawing the clip's extents miss uploads and draws nothing", async () => {
  const draw = (ctx) => {
    ctx.fillStyle = "black";
    ctx.beginPath();
    ctx.arc(60, 20, 12, 0, Math.PI * 2); // wholly above the band
    ctx.fill();
  };
  const result = await paint(draw);
  assert.equal(result.uploads.length, 0);
  for (let i = 0; i < result.img.data.length; i += 4) {
    assert.equal(result.img.data[i], 255);
  }
});
