// Coverage drawn under a transform is painted in the fill style.
//
// An a8 coverage surface is a mask: drawImage paints the current fillStyle
// through it, which is what lets one rendered icon be drawn in any colour.
// That held under the identity transform only. Under any other, a translate
// included, drawImage composited the a8 picture itself as the source, and
// RENDER reads an a8 source as alpha over black: a lime mask drawn at
// translate(10, 10) came out black.
//
// What is asserted here: under a transform, coverage paints what it paints
// without one — in the fill style, solid, gradient or pattern, through the
// clip, at globalAlpha, with the composite op and under its shadow — and,
// turned, what an image of the fill colour with the same coverage paints.
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import xserver from "x11/lib/xserver/index.js";

import { createClient, StaticFontSource, Surface } from "../lib/index.js";

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

const LIME = [0, 255, 0];
const WHITE = [255, 255, 255];

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

/** An a8 surface of `paint`'s coverage: white on transparent, so every
 *  pixel is its own alpha. */
function coverage(width, height, paint) {
  const surface = new Surface(app, { width, height, format: "a8" });
  surface.render((c) => {
    c.fillStyle = "white";
    paint(c);
  });
  return surface;
}

const disc = (c) => {
  c.beginPath();
  c.arc(10, 10, 8, 0, Math.PI * 2);
  c.fill();
};

/** the 10x10 mask covered all over that the bug was found with */
const square = () => coverage(10, 10, (c) => c.fillRect(0, 0, 10, 10));

/** a 20x20 disc, for coverage with antialiased edges */
const discMask = () => coverage(20, 20, disc);

/** the same disc as an image in `colour`: what the mask painted in it is */
function discImage(colour) {
  const surface = new Surface(app, { width: 20, height: 20 });
  surface.render((c) => {
    c.fillStyle = colour;
    disc(c);
  });
  return surface;
}

/** `image` drawn onto a fresh context with a lime fill style, under
 *  `setup`'s state */
async function drawn(image, setup, ...args) {
  const ctx = freshCtx();
  ctx.fillStyle = "lime";
  ctx.save();
  setup(ctx);
  ctx.drawImage(image, ...args);
  ctx.restore();
  return read(ctx);
}

/** a fillRect of the same rectangle under the same state */
async function filled(setup, x, y, w, h) {
  const ctx = freshCtx();
  ctx.save();
  setup(ctx);
  ctx.fillRect(x, y, w, h);
  ctx.restore();
  return read(ctx);
}

const turn30 = (c) => {
  c.translate(40, 10);
  c.rotate(Math.PI / 6);
};

/** Compare two getImageData results, channel by channel. */
function assertSamePixels(a, b, what, tolerance = 0) {
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
  assert.ok(
    worst <= tolerance,
    `${what}: ${worst} levels apart at (${p % a.width}, ${Math.floor(p / a.width)})`,
  );
}

/** pixels drawn the fill colour itself, at full coverage */
function limes(img) {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i] === 0 && img.data[i + 1] === 255 && img.data[i + 2] === 0) n++;
  }
  return n;
}

/**
 * Lime over white keeps red and blue equal and green at 255; the black the
 * mask was painted in takes green down with them.
 */
function notLimeOverWhite(img) {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 1] !== 255 || img.data[i] !== img.data[i + 2]) n++;
  }
  return n;
}

/** The pixmaps a drawing creates, as [depth, width, height]. */
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

/** the names of the Render requests `body` sends */
function renderRequests(names, body) {
  const R = app.display.Render;
  const sent = [];
  const saved = names.map((n) => R[n]);
  names.forEach((n, i) => {
    R[n] = (...a) => {
      sent.push(n);
      return saved[i].apply(R, a);
    };
  });
  try {
    body();
  } finally {
    names.forEach((n, i) => {
      R[n] = saved[i];
    });
  }
  return sent;
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

test("a mask drawn at translate(10, 10) is painted in the fill style, as one drawn at (10, 10)", async () => {
  const mask = square();
  const got = await drawn(mask, (c) => c.translate(10, 10), 0, 0);
  assert.deepEqual(px(got, 15, 15), LIME, "inside the mask");
  assertSamePixels(got, await drawn(mask, () => {}, 10, 10), "against the mask drawn at (10, 10)");
});

describe("turned, a mask paints what an image of the fill colour paints", () => {
  for (const [what, setup, ...args] of [
    ["turned 30°", turn30, 0, 0],
    ["turned and scaled up", turn30, 0, 0, 36, 36],
    ["turned and scaled down", turn30, 0, 0, 13, 13],
    ["skewed", (c) => c.transform(1, 0.3, -0.4, 1, 30, 10), 0, 0, 30, 30],
    ["moved off the pixel grid", (c) => c.translate(10.3, 10.6), 0, 0],
    ["cropped, scaled and turned", turn30, 4, 4, 12, 12, 0, 0, 24, 24],
  ]) {
    test(what, async () => {
      const got = await drawn(discMask(), setup, ...args);
      assertSamePixels(got, await drawn(discImage("lime"), setup, ...args), "against a lime disc", 1);
      assert.equal(notLimeOverWhite(got), 0, "pixels not lime over white");
      assert.ok(limes(got) > 30, `the disc is painted: ${limes(got)} pixels of solid lime`);
    });
  }
});

describe("a gradient or a pattern lands where a fill of the same rectangle puts it", () => {
  const styles = {
    "a linear gradient": (c) => {
      const g = c.createLinearGradient(0, 0, 20, 8);
      g.addColorStop(0, "red");
      g.addColorStop(1, "blue");
      return g;
    },
    "a radial gradient": (c) => {
      const g = c.createRadialGradient(6, 6, 1, 10, 10, 12);
      g.addColorStop(0, "yellow");
      g.addColorStop(1, "purple");
      return g;
    },
    "a pattern": (c) => {
      const tile = new Surface(app, { width: 4, height: 4 });
      tile.render((t) => {
        t.fillStyle = "red";
        t.fillRect(0, 0, 4, 4);
        t.fillStyle = "blue";
        t.fillRect(0, 0, 2, 2);
        t.fillRect(2, 2, 2, 2);
      });
      return c.createPattern(tile, "repeat");
    },
  };
  // covered all over, so drawn it is exactly the fill of its rectangle
  const full = () => coverage(20, 20, (c) => c.fillRect(0, 0, 20, 20));

  for (const [kind, style] of Object.entries(styles)) {
    test(`${kind}, translated`, async () => {
      const setup = (c) => {
        c.translate(10, 10);
        c.fillStyle = style(c);
      };
      assertSamePixels(
        await drawn(full(), setup, 0, 0),
        await filled(setup, 0, 0, 20, 20),
        "against fillRect",
      );
    });

    test(`${kind}, turned`, async () => {
      const setup = (c) => {
        turn30(c);
        c.fillStyle = style(c);
      };
      const got = await drawn(full(), setup, 0, 0);
      const want = await filled(setup, 0, 0, 20, 20);
      // Their edges are antialiased two ways, so the pixels compared are
      // the ones both cover whole: centres two pixels inside the rectangle.
      const cos = Math.cos(Math.PI / 6);
      const sin = Math.sin(Math.PI / 6);
      let compared = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const u = cos * (x + 0.5 - 40) + sin * (y + 0.5 - 10);
          const v = -sin * (x + 0.5 - 40) + cos * (y + 0.5 - 10);
          if (u < 2 || u > 18 || v < 2 || v > 18) continue;
          assert.deepEqual(px(got, x, y), px(want, x, y), `at (${x}, ${y})`);
          compared++;
        }
      }
      assert.ok(compared > 200, `${compared} pixels compared`);
    });
  }
});

describe("globalAlpha", () => {
  test("folds into the colour, as it does untransformed", async () => {
    const mask = discMask();
    const got = await drawn(
      mask,
      (c) => {
        c.globalAlpha = 0.5;
        c.translate(10, 10);
      },
      0,
      0,
    );
    const want = await drawn(mask, (c) => (c.globalAlpha = 0.5), 10, 10);
    assertSamePixels(got, want, "against the disc drawn at (10, 10)");
    const [r, g, b] = px(got, 20, 20);
    assert.ok(g === 255 && r === b && Math.abs(r - 128) <= 1, `half lime over white: ${[r, g, b]}`);
  });

  test("over a gradient, goes through the scratch mask as it does untransformed", async () => {
    // the same gradient on the device either way: drawn untransformed at
    // (10, 10), its points are 10 further along
    const gradient = (c, at) => {
      const g = c.createLinearGradient(at, at, at + 20, at);
      g.addColorStop(0, "red");
      g.addColorStop(1, "blue");
      return g;
    };
    const mask = discMask();
    const got = await drawn(
      mask,
      (c) => {
        c.globalAlpha = 0.5;
        c.translate(10, 10);
        c.fillStyle = gradient(c, 0);
      },
      0,
      0,
    );
    const want = await drawn(
      mask,
      (c) => {
        c.globalAlpha = 0.5;
        c.fillStyle = gradient(c, 10);
      },
      10,
      10,
    );
    assertSamePixels(got, want, "against the disc drawn at (10, 10)");
    const [r, g, b] = px(got, 20, 20);
    assert.ok(r < 255 && g < 255 && b < 255 && r !== b, `half the gradient over white: ${[r, g, b]}`);
  });

  test("turned, fades as an image of the fill colour does", async () => {
    const setup = (c) => {
      c.globalAlpha = 0.4;
      turn30(c);
    };
    assertSamePixels(
      await drawn(discMask(), setup, 0, 0, 30, 30),
      await drawn(discImage("lime"), setup, 0, 0, 30, 30),
      "against a lime disc",
      1,
    );
  });
});

describe("the clip applies", () => {
  test("a rectangle, turned: the draw unclipped inside it, and nothing outside it", async () => {
    const mask = discMask();
    const clipped = (c) => {
      c.beginPath();
      c.rect(36, 18, 12, 30);
      c.clip();
      turn30(c);
    };
    const got = await drawn(mask, clipped, 0, 0, 40, 40);
    const all = await drawn(mask, turn30, 0, 0, 40, 40);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const inside = x >= 36 && x < 48 && y >= 18 && y < 48;
        assert.deepEqual(px(got, x, y), inside ? px(all, x, y) : WHITE, `at (${x}, ${y})`);
      }
    }
    assert.ok(limes(got) > 100, "the part inside the clip is drawn");
    assertSamePixels(got, await drawn(discImage("lime"), clipped, 0, 0, 40, 40), "against a lime disc", 1);
  });

  test("a path, translated: as untransformed, through the scratch mask", async () => {
    const mask = discMask();
    const clip = (c) => {
      c.beginPath();
      c.arc(14, 14, 7, 0, Math.PI * 2);
      c.clip();
    };
    const got = await drawn(
      mask,
      (c) => {
        clip(c);
        c.translate(10, 10);
      },
      0,
      0,
    );
    assertSamePixels(got, await drawn(mask, clip, 10, 10), "against the disc drawn at (10, 10)");
    assert.deepEqual(px(got, 17, 17), LIME, "inside both");
    assert.deepEqual(px(got, 25, 20), WHITE, "inside the disc, outside the clip");
  });

  test("a path, turned: as an image of the fill colour", async () => {
    const setup = (c) => {
      c.beginPath();
      c.arc(40, 30, 12, 0, Math.PI * 2);
      c.clip();
      turn30(c);
    };
    const got = await drawn(discMask(), setup, 0, 0, 40, 40);
    assertSamePixels(got, await drawn(discImage("lime"), setup, 0, 0, 40, 40), "against a lime disc", 1);
    assert.equal(notLimeOverWhite(got), 0, "pixels not lime over white");
  });

  test("a turned mask a clip rectangle misses sends nothing, whatever the op", async () => {
    const mask = discMask();
    for (const op of ["source-over", "copy"]) {
      const ctx = freshCtx();
      const sent = renderRequests(["Composite", "SetPictureTransform", "SetPictureFilter"], () => {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, 5, 5); // the turned rectangle's box is (30, 10) to (58, 38)
        ctx.clip();
        ctx.globalCompositeOperation = op;
        turn30(ctx);
        ctx.drawImage(mask, 0, 0, 20, 20);
        ctx.restore();
      });
      assert.deepEqual(sent, [], op);
      assert.equal(notLimeOverWhite(await read(ctx)) + limes(await read(ctx)), 0, `${op}: drew`);
    }
  });
});

test("every composite op paints as it does untransformed", async () => {
  const mask = discMask();
  const backdrop = (c) => {
    c.save();
    c.fillStyle = "blue";
    c.fillRect(0, 0, 20, H);
    c.restore();
  };
  for (const op of [
    "source-over",
    "copy",
    "source-in",
    "destination-in",
    "source-out",
    "destination-out",
    "source-atop",
    "destination-atop",
    "destination-over",
    "xor",
    "lighter",
  ]) {
    const got = await drawn(
      mask,
      (c) => {
        backdrop(c);
        c.globalCompositeOperation = op;
        c.translate(10, 10);
      },
      0,
      0,
    );
    const want = await drawn(
      mask,
      (c) => {
        backdrop(c);
        c.globalCompositeOperation = op;
      },
      10,
      10,
    );
    assertSamePixels(got, want, `${op}: against the disc drawn at (10, 10)`);
  }
});

test("turned, an op like copy clears the box round the mask, as an image's draw does", async () => {
  const setup = (c) => {
    c.globalCompositeOperation = "copy";
    turn30(c);
  };
  // the turned 30x30 rectangle's box is (25, 10) to (66, 51)
  const got = await drawn(discMask(), setup, 0, 0, 30, 30);
  assertSamePixels(got, await drawn(discImage("lime"), setup, 0, 0, 30, 30), "against a lime disc", 1);
  assert.deepEqual(px(got, 26, 11), [0, 0, 0], "a corner of the box, cleared");
  assert.deepEqual(px(got, 20, 20), WHITE, "outside the box, untouched");
  assert.ok(limes(got) > 100, "the disc is painted");
});

test("the mask casts its shadow, and is painted in the fill style over it", async () => {
  const shadowed = (c) => {
    c.shadowColor = "black";
    c.shadowOffsetX = 5;
    c.shadowOffsetY = 4;
    c.shadowBlur = 3;
  };
  const mask = discMask();
  const got = await drawn(
    mask,
    (c) => {
      shadowed(c);
      c.translate(10, 10);
    },
    0,
    0,
  );
  assertSamePixels(got, await drawn(mask, shadowed, 10, 10), "against the disc drawn at (10, 10)");
  assert.deepEqual(px(got, 20, 20), LIME, "the disc");
  const [r, g, b] = px(got, 28, 26);
  assert.ok(r < 64 && r === g && g === b, `its shadow, beside it: ${[r, g, b]}`);
});

test("a turned crop of a mask is cut into an a8 copy, and painted in the fill style", async () => {
  // a 40x40 mask covered all over, of which the crop is the left half: a
  // crop drawn from the mask itself would paint the right half beside it
  const sheet = coverage(40, 40, (c) => c.fillRect(0, 0, 40, 40));
  const half = coverage(20, 40, (c) => c.fillRect(0, 0, 20, 40));
  const ctx = freshCtx();
  ctx.fillStyle = "lime";
  ctx.save();
  turn30(ctx);
  const made = pixmapsDuring(ctx, () => ctx.drawImage(sheet, 0, 0, 20, 40, 0, 0, 20, 40));
  ctx.restore();
  assert.deepEqual(made, [[8, 20, 40]], "one a8 copy, of the crop and no more");
  const got = await read(ctx);
  assertSamePixels(got, await drawn(half, turn30, 0, 0), "against the same coverage cut out");
  assert.equal(notLimeOverWhite(got), 0, "pixels not lime over white");
  assert.ok(limes(got) > 700, `the crop is painted: ${limes(got)} pixels of solid lime`);
});

describe("every kind of coverage source", () => {
  const sources = {
    "an a8 Surface": () => discMask(),
    "a 2d context drawing into a depth-8 pixmap": () => {
      const c = app.createPixmap({ width: 20, height: 20, depth: 8 }).getContext("2d");
      c.globalCompositeOperation = "copy";
      c.fillStyle = "rgba(0, 0, 0, 0)";
      c.fillRect(0, 0, 20, 20);
      c.globalCompositeOperation = "source-over";
      c.fillStyle = "white";
      disc(c);
      return c;
    },
    "a picture source that says it is a8": () => {
      const mask = discMask();
      return { width: 20, height: 20, format: "a8", picture: (a) => mask.picture(a) };
    },
  };
  for (const [kind, make] of Object.entries(sources)) {
    test(kind, async () => {
      const got = await drawn(make(), turn30, 0, 0, 30, 30);
      assertSamePixels(got, await drawn(discMask(), turn30, 0, 0, 30, 30), "against an a8 Surface");
      assert.ok(limes(got) > 100, `painted in the fill style: ${limes(got)} pixels of solid lime`);
    });
  }
});

test("drawn into coverage, a mask is the fill style's alpha through it, as untransformed", async () => {
  const mask = discMask();
  const into = (setup, ...args) => {
    const target = coverage(30, 30, () => {});
    target.render((c) => {
      c.fillStyle = "rgba(255, 255, 255, 0.5)";
      setup(c);
      c.drawImage(mask, ...args);
    });
    return target;
  };
  const got = await drawn(into((c) => c.translate(5, 5), 0, 0), () => {}, 0, 0);
  const want = await drawn(into(() => {}, 5, 5), () => {}, 0, 0);
  assertSamePixels(got, want, "against the mask drawn at (5, 5)");
  const [r, g, b] = px(got, 15, 15);
  assert.ok(g === 255 && Math.abs(r - 128) <= 1 && r === b, `half coverage: ${[r, g, b]}`);
});

test("a turned draw leaves the mask as it found it", async () => {
  const mask = discMask();
  await drawn(mask, turn30, 0, 0, 30, 30);
  assertSamePixels(
    await drawn(mask, () => {}, 10, 10, 30, 30),
    await drawn(discMask(), () => {}, 10, 10, 30, 30),
    "drawn scaled and untransformed afterwards",
  );
});

test("a mask too small for the transform to say draws nothing, and throws nothing", async () => {
  const ctx = freshCtx();
  ctx.fillStyle = "lime";
  const errors = await xErrorsDuring(async () => {
    ctx.save();
    turn30(ctx);
    ctx.drawImage(square(), 0, 0, 10, 10, 10, 10, 0.0002, 0.0002);
    ctx.restore();
    await ctx.getImageData(0, 0, 1, 1);
  });
  assert.deepEqual(errors, []);
  assert.equal(notLimeOverWhite(await read(ctx)), 0);
  assert.equal(limes(await read(ctx)), 0);
});

test("a gradient the transform puts past the wire paints nothing, as a fill of it does", async () => {
  // A hundred-thousandth of a pixel per unit: the gradient's inverse is a
  // hundred thousand, past what 16.16 carries, while the mask's, drawn four
  // million units across, is a quarter.
  const setup = (c) => {
    c.scale(1e-5, 1e-5);
    const g = c.createLinearGradient(0, 0, 10, 0);
    g.addColorStop(0, "red");
    g.addColorStop(1, "blue");
    c.fillStyle = g;
  };
  const errors = await xErrorsDuring(async () => {
    const got = await drawn(square(), setup, 0, 0, 4e6, 4e6);
    assertSamePixels(got, await filled(setup, 0, 0, 4e6, 4e6), "against fillRect");
    assert.deepEqual(px(got, 20, 20), WHITE, "nothing painted");
  });
  assert.deepEqual(errors, []);
});

test("a big mask drawn small far from the origin lands where the matrix puts it, in its gradient", async () => {
  const CW = 2300;
  const CH = 100;
  const ctx = freshCtx(CW, CH);
  // A 2000x1200 mask covered all over, drawn as a 50x30 thumbnail turned a
  // quarter about (2225.5, 55), half a pixel off the grid: (u, v) of the
  // thumbnail lands at (2240.5 - v, 30 + u). Measured from the device
  // origin, the mask transform's translation would be forty times 2,240,
  // past what 16.16 carries; from the corner of the box it lands in, it is
  // under the mask's own size. The gradient runs along u, red to blue, from
  // x 2200 in user space.
  const errors = await xErrorsDuring(async () => {
    ctx.save();
    ctx.translate(2225.5, 55);
    ctx.rotate(Math.PI / 2);
    ctx.translate(-2225, -55);
    const g = ctx.createLinearGradient(2200, 0, 2240, 0);
    g.addColorStop(0, "red");
    g.addColorStop(1, "blue");
    ctx.fillStyle = g;
    ctx.drawImage(coverage(2000, 1200, (c) => c.fillRect(0, 0, 2000, 1200)), 2200, 40, 50, 30);
    ctx.restore();
    await ctx.getImageData(0, 0, 1, 1);
  });
  assert.deepEqual(errors, []);

  const got = await read(ctx);
  const [r, g, b] = px(got, 2225, 31); // u 1.5 of 40
  assert.ok(r > 235 && g === 0 && b < 20, `red at the start of the gradient: ${[r, g, b]}`);
  assert.deepEqual(px(got, 2225, 75), [0, 0, 255], "blue past its end");
  assert.deepEqual(px(got, 2225, 29), WHITE, "above it");
  assert.deepEqual(px(got, 2205, 55), WHITE, "left of it");
  assert.deepEqual(px(got, 2245, 55), WHITE, "right of it");
});
