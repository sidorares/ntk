// drawImage of another 2d context, or of a node-canvas, in every form of the
// call — drawn as a Surface or an Image is.
//
// A context source used to be composited whole, at (0, 0), with Over,
// whatever the call said: a grid of cells drawn with ctx.drawImage(cell, x, y)
// landed in a pile at the origin, the 5- and 9-argument forms neither scaled
// nor cropped, and the transform and the composite op went unread. A
// node-canvas source had the same branch shape and the same problems.
//
// Hermetic: node-x11's in-process pure-JS X server, no $DISPLAY needed. It
// smears a composite whose source and destination overlap, as pixman does,
// so the self-draw tests below fail here without the copy they test.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, ImageData, StaticFontSource, Surface } from '../lib/index.js';

const W = 64;
const H = 64;

const RED = [255, 0, 0, 255];
const LIME = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const YELLOW = [255, 255, 0, 255];
const CLEAR = [0, 0, 0, 0];

let server = null;
let app = null;

const connect = () => {
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  return createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
};

before(async () => {
  server = xserver.createServer({ width: 200, height: 200 });
  app = await connect();
});

after(async () => {
  await app?.close();
});

/** a transparent W x H target */
function target() {
  const ctx = app.createPixmap({ width: W, height: H, depth: 32 }).getContext('2d');
  ctx.clearRect(0, 0, W, H);
  return ctx;
}

/** a 20x20 context in four 10x10 quadrants: red, lime over blue, yellow */
function quadrants() {
  const ctx = app.createPixmap({ width: 20, height: 20, depth: 32 }).getContext('2d');
  for (const [x, y, colour] of [
    [0, 0, 'red'],
    [10, 0, 'lime'],
    [0, 10, 'blue'],
    [10, 10, 'yellow']
  ]) {
    ctx.fillStyle = colour;
    ctx.fillRect(x, y, 10, 10);
  }
  return ctx;
}

async function pixels(ctx) {
  const { width } = ctx;
  const img = await ctx.getImageData(0, 0, width, ctx.height);
  return (x, y) => [...img.data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
}

/** opaque pixels that say where they are: (x, y) is [6x, 6y, 100] */
const whereabouts = (x, y) => [x * 6, y * 6, 100, 255];

function paintWhereabouts(ctx) {
  const data = new Uint8ClampedArray(40 * 40 * 4);
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) data.set(whereabouts(x, y), (y * 40 + x) * 4);
  }
  ctx.putImageData(new ImageData(data, 40, 40), 0, 0);
}

/** the 30x30 block from the origin, found 4 right and 7 down, as it was */
function assertMovedIntact(at, what) {
  for (let j = 0; j < 30; j++) {
    for (let i = 0; i < 30; i++) {
      assert.deepEqual(at(4 + i, 7 + j), whereabouts(i, j), `${what}: (${4 + i}, ${7 + j})`);
    }
  }
}

describe('drawImage(context)', () => {
  test('the three-argument form draws it where the call says, not at the origin', async () => {
    const cell = quadrants();
    const ctx = target();
    // a grid of cells, drawn one by one as a table draws them
    ctx.drawImage(cell, 30, 40);
    ctx.drawImage(cell, 4, 4);

    const at = await pixels(ctx);
    assert.deepEqual(at(35, 45), RED);
    assert.deepEqual(at(45, 45), LIME);
    assert.deepEqual(at(35, 55), BLUE);
    assert.deepEqual(at(45, 55), YELLOW);
    assert.deepEqual(at(9, 9), RED, 'the second cell, at its own place');
    assert.deepEqual(at(19, 19), YELLOW);
    assert.deepEqual(at(2, 2), CLEAR, 'nothing at the origin');
    assert.deepEqual(at(27, 30), CLEAR, 'nor between the cells');
  });

  test('the five-argument form scales it to the destination', async () => {
    const ctx = target();
    ctx.drawImage(quadrants(), 10, 10, 40, 20); // twice as wide, as tall as it was

    const at = await pixels(ctx);
    assert.deepEqual(at(15, 15), RED);
    assert.deepEqual(at(45, 15), LIME);
    assert.deepEqual(at(15, 25), BLUE);
    assert.deepEqual(at(45, 25), YELLOW);
    assert.deepEqual(at(52, 20), CLEAR, 'right of it');
    assert.deepEqual(at(30, 32), CLEAR, 'below it');
  });

  test('the nine-argument form crops, then scales', async () => {
    const ctx = target();
    ctx.drawImage(quadrants(), 10, 0, 10, 10, 5, 5, 30, 30); // the lime quadrant, at 3x

    const at = await pixels(ctx);
    // two pixels and more inside: the rim is a bilinear blend
    for (let y = 8; y < 32; y++) {
      for (let x = 8; x < 32; x++) assert.deepEqual(at(x, y), LIME, `(${x}, ${y})`);
    }
    assert.deepEqual(at(37, 20), CLEAR, 'right of it');
    assert.deepEqual(at(20, 37), CLEAR, 'below it');
  });

  test('the transform carries it, and turns it', async () => {
    const ctx = target();
    ctx.translate(60, 10);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(quadrants(), 0, 0);

    // source (u, v) lands at (60 - v, 10 + u)
    const at = await pixels(ctx);
    assert.deepEqual(at(55, 15), RED);
    assert.deepEqual(at(55, 25), LIME);
    assert.deepEqual(at(45, 15), BLUE);
    assert.deepEqual(at(45, 25), YELLOW);
    assert.deepEqual(at(35, 20), CLEAR);
    assert.deepEqual(at(5, 5), CLEAR, 'nothing where it would be untransformed');
  });

  test('a clip cuts it, rectangular or not', async () => {
    const ctx = target();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, 25, H); // the server's picture clip
    ctx.clip();
    ctx.drawImage(quadrants(), 10, 10);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(50, 50, 6, 0, Math.PI * 2); // a mask
    ctx.clip();
    ctx.drawImage(quadrants(), 40, 40);
    ctx.restore();

    const at = await pixels(ctx);
    assert.deepEqual(at(15, 15), RED, 'inside the rectangle');
    assert.deepEqual(at(15, 25), BLUE);
    assert.deepEqual(at(24, 25), YELLOW, 'up to its edge');
    assert.deepEqual(at(25, 15), CLEAR, 'its lime quadrant, cut off');
    assert.deepEqual(at(27, 25), CLEAR, 'its yellow one too');
    assert.deepEqual(at(47, 47), RED, 'inside the circle');
    assert.deepEqual(at(52, 52), YELLOW);
    assert.deepEqual(at(41, 41), CLEAR, 'a corner of it, outside the circle');
  });

  test('a composite op other than source-over is the one used', async () => {
    const ctx = target();
    ctx.fillStyle = 'blue';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(quadrants(), 10, 10);

    const at = await pixels(ctx);
    assert.deepEqual(at(15, 15), CLEAR, 'cut out where it is opaque');
    assert.deepEqual(at(25, 25), CLEAR);
    assert.deepEqual(at(5, 5), BLUE, 'outside it, untouched');
    assert.deepEqual(at(35, 35), BLUE);
  });

  test('a coverage context paints in the fillStyle, as its Surface does', async () => {
    const coverage = new Surface(app, { width: 8, height: 8, format: 'a8' });
    const cover = coverage.getContext('2d');
    cover.fillStyle = 'white';
    cover.fillRect(0, 0, 8, 8);

    const ctx = target();
    ctx.fillStyle = 'lime';
    ctx.drawImage(cover, 2, 2);
    ctx.drawImage(coverage, 20, 2);

    const at = await pixels(ctx);
    assert.deepEqual(at(5, 5), LIME, 'the context');
    assert.deepEqual(at(23, 5), LIME, 'its surface, the same');
    cover.destroy();
    coverage.destroy();
  });

  test('its clip slot is empty while it is read, and its clip is back after', async () => {
    // A rect-clipped fast path leaves the slot narrowed and a reset owed.
    // glamor cuts a composite down to its source's clip — fb and this server
    // read past it — so a read with the slot still narrowed would draw a
    // quarter of the source there. fillRects is a fast path that stamps the
    // slot; fillRect fills the intersection and never touches it.
    const src = quadrants();
    const id = src._picture.id;
    const R = app.display.Render;
    const saved = { clip: R.SetPictureClipRectangles, composite: R.Composite };
    let slot = null;
    const reads = [];
    R.SetPictureClipRectangles = function (pic, x, y, rects) {
      if (pic === id) slot = rects;
      return saved.clip.apply(this, arguments);
    };
    R.Composite = function (op, from) {
      if (from === id) reads.push(slot);
      return saved.composite.apply(this, arguments);
    };
    try {
      src.save();
      src.beginPath();
      src.rect(0, 0, 10, 10);
      src.clip();
      src.fillStyle = 'white';
      src.fillRects([[0, 0, 20, 20]]);
      assert.deepEqual(slot, [0, 0, 10, 10], 'the fast path narrowed the slot');

      target().drawImage(src, 30, 30);
    } finally {
      R.SetPictureClipRectangles = saved.clip;
      R.Composite = saved.composite;
    }
    assert.deepEqual(reads, [[0, 0, 0x7fff, 0x7fff]], 'read through a slot that clips nothing');

    src.fillStyle = 'black';
    src.fillRects([[0, 0, 20, 20]]); // the clip is still in force, and stamped again
    src.restore();
    const at = await pixels(src);
    assert.deepEqual(at(5, 5), [0, 0, 0, 255], 'inside the clip');
    assert.deepEqual(at(15, 15), YELLOW, 'outside it, untouched');
  });

  test('a destroyed context, or one on another connection, is refused with what to do', async () => {
    const surface = new Surface(app, { width: 4, height: 4 });
    let lent = null;
    surface.render((c) => {
      lent = c;
    });
    assert.throws(() => target().drawImage(lent, 0, 0), /has been destroyed[\s\S]*Draw the Surface itself/);

    const other = await connect();
    try {
      const foreign = other.createPixmap({ width: 4, height: 4, depth: 32 }).getContext('2d');
      assert.throws(
        () => target().drawImage(foreign, 0, 0),
        /another X\nconnection[\s\S]*new Image\(pixels\)/
      );
    } finally {
      await other.close();
    }
  });
});

describe('drawImage onto the pixels it reads', () => {
  test('a context drawn onto itself draws its pixels as they were before the call', async () => {
    const ctx = target();
    paintWhereabouts(ctx);
    // down and right, the direction a server working row by row smears in
    ctx.drawImage(ctx, 0, 0, 30, 30, 4, 7, 30, 30);
    assertMovedIntact(await pixels(ctx), 'itself');
  });

  test('so does another context on the same pixmap, and a Surface inside its own render', async () => {
    const pixmap = app.createPixmap({ width: W, height: H, depth: 32 });
    const a = pixmap.getContext('2d');
    a.clearRect(0, 0, W, H);
    paintWhereabouts(a);
    pixmap.getContext('2d').drawImage(a, 0, 0, 30, 30, 4, 7, 30, 30);
    assertMovedIntact(await pixels(a), 'another context');

    const surface = new Surface(app, { width: W, height: H });
    surface.render((c) => {
      paintWhereabouts(c);
      c.drawImage(surface, 0, 0, 30, 30, 4, 7, 30, 30);
    });
    const read = surface.getContext('2d');
    assertMovedIntact(await pixels(read), 'a Surface');
    read.destroy();
    surface.destroy();
  });

  test('its shadow is cast from the pixels as they were, not onto them first', async () => {
    const ctx = target();
    ctx.fillStyle = 'red';
    ctx.fillRect(0, 0, 20, 20);
    ctx.shadowColor = 'blue';
    ctx.shadowOffsetX = -20; // straight back over the source
    ctx.drawImage(ctx, 0, 0, 20, 20, 20, 0, 20, 20);

    const at = await pixels(ctx);
    assert.deepEqual(at(30, 10), RED, 'the copy is red, as its source was');
    assert.deepEqual(at(10, 10), BLUE, 'and its shadow lands on that source');
  });

  test('a window drawn larger is its colour out to its edge, not its backing pixmap past it', async () => {
    const win = app.createWindow({ width: 30, height: 30 });
    const winCtx = win.getContext('2d');
    winCtx.fillStyle = 'red';
    winCtx.fillRect(0, 0, 30, 30);
    assert.ok(win._backing.width > 30, 'the backing pixmap has room past the window');

    const ctx = target();
    ctx.drawImage(winCtx, 0, 0, 60, 60);
    const at = await pixels(ctx);
    assert.deepEqual(at(59, 30), RED, 'the right edge');
    assert.deepEqual(at(30, 59), RED, 'the bottom edge');
    assert.deepEqual(at(59, 59), RED, 'the corner');
    assert.deepEqual(at(61, 30), CLEAR, 'and nothing past it');
    win.destroy();
  });
});

describe('drawImage(node-canvas)', () => {
  /** a node-canvas stand-in holding the four quadrants as straight RGBA */
  function canvasLike() {
    const data = new Uint8ClampedArray(20 * 20 * 4);
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) {
        const colour = y < 10 ? (x < 10 ? RED : LIME) : x < 10 ? BLUE : YELLOW;
        data.set(colour, (y * 20 + x) * 4);
      }
    }
    const canvas = {
      width: 20,
      height: 20,
      reads: 0,
      context: {
        getImageData: (x, y, w, h) => {
          canvas.reads++;
          return { width: w, height: h, data };
        }
      }
    };
    return canvas;
  }

  test('every form of the call works on it too', async () => {
    const ctx = target();
    ctx.drawImage(canvasLike(), 30, 40);
    ctx.drawImage(canvasLike(), 10, 0, 10, 10, 2, 2, 20, 20); // the lime quadrant, at 2x
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(canvasLike(), 40, 50, 10, 10); // over the first one's yellow

    const at = await pixels(ctx);
    assert.deepEqual(at(35, 45), RED);
    assert.deepEqual(at(45, 45), LIME);
    assert.deepEqual(at(35, 55), BLUE);
    assert.deepEqual(at(45, 55), CLEAR, 'cut out again by the third draw');
    assert.deepEqual(at(12, 12), LIME);
    assert.deepEqual(at(2, 25), CLEAR, 'below the crop');
  });

  test('a clip that rejects the draw uploads nothing', () => {
    const canvas = canvasLike();
    const ctx = target();
    ctx.save();
    ctx.beginPath();
    ctx.rect(10, 10, 0, 0);
    ctx.clip();
    ctx.drawImage(canvas, 0, 0);
    ctx.translate(5, 5);
    ctx.rotate(0.3);
    ctx.drawImage(canvas, 0, 0);
    ctx.restore();
    assert.equal(canvas.reads, 0);
  });
});
