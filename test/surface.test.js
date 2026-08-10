// Surface: draw something once, composite it many times.
//
// Runs against node-x11's in-process pure-JS X server, which implements
// Render compositing for real — so these assert on *pixels*, not on the
// requests that produced them. The one exception is the clip fast path,
// where the whole point is which requests go out, so that one counts them.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource, Surface } from '../lib/index.js';

const W = 40;
const H = 40;

let app = null;

before(async () => {
  const server = xserver.createServer({ width: 200, height: 200 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  app = await createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
});

after(async () => {
  await app?.close();
});

/** a transparent depth-32 target and its context */
function target() {
  const pixmap = app.createPixmap({ width: W, height: H, depth: 32 });
  const ctx = pixmap.getContext('2d');
  const R = app.display.Render;
  R.FillRectangles(R.PictOp.Src, ctx.picture.id, [0, 0, 0, 0], [0, 0, W, H]);
  return ctx;
}

const readPixels = async (ctx) => {
  const img = await ctx.getImageData(0, 0, W, H);
  return (x, y) => [...img.data.slice((y * W + x) * 4, (y * W + x) * 4 + 4)];
};

/** an 8x8 block of full coverage, or of solid colour */
function block(format, fill = '#ffffff') {
  const surface = new Surface(app, { width: 8, height: 8, format });
  surface.render((ctx) => {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, 8, 8);
  });
  return surface;
}

/** count the Render requests a body issues */
function countRender(names, body) {
  const R = app.display.Render;
  const counts = Object.fromEntries(names.map((n) => [n, 0]));
  const saved = {};
  for (const name of names) {
    saved[name] = R[name];
    R[name] = (...a) => {
      counts[name]++;
      return saved[name].apply(R, a);
    };
  }
  try {
    body();
  } finally {
    for (const name of names) R[name] = saved[name];
  }
  return counts;
}

describe('Surface', () => {
  test('rejects sizes and formats it cannot honour', () => {
    assert.throws(() => new Surface(app, { width: 0, height: 8 }), /positive integers/);
    assert.throws(() => new Surface(app, { width: 8.5, height: 8 }), /positive integers/);
    assert.throws(() => new Surface(app, { width: 8, height: 8, format: 'rgb24' }), /unknown format/);
  });

  test('reports the storage a cache would budget against', () => {
    assert.equal(new Surface(app, { width: 20, height: 10 }).bytes, 800); // argb32
    assert.equal(new Surface(app, { width: 20, height: 10, format: 'a8' }).bytes, 200);
  });

  test('refuses to hand its picture to another connection', () => {
    const surface = new Surface(app, { width: 4, height: 4 });
    assert.equal(surface.picture(app), surface.picture());
    assert.throws(() => surface.picture({ different: true }), /different X connection/);
  });

  test('starts blank, because a fresh pixmap holds undefined bytes', async () => {
    const surface = new Surface(app, { width: 8, height: 8 });
    const ctx = target();
    ctx.drawImage(surface, 0, 0);
    const px = await readPixels(ctx);
    assert.deepEqual(px(4, 4), [0, 0, 0, 0]);
  });
});

describe('drawImage(surface)', () => {
  test('composites what was drawn into it, at the destination', async () => {
    const ctx = target();
    ctx.drawImage(block('argb32', '#ff0000'), 2, 2);
    const px = await readPixels(ctx);
    assert.deepEqual(px(4, 4), [255, 0, 0, 255]);
    assert.deepEqual(px(12, 12), [0, 0, 0, 0], 'outside the 8x8 block');
  });

  test('scales to the destination rect', async () => {
    const ctx = target();
    ctx.drawImage(block('argb32', '#ff0000'), 0, 0, 24, 24);
    const px = await readPixels(ctx);
    assert.deepEqual(px(20, 20), [255, 0, 0, 255], 'inside the scaled-up block');
    assert.deepEqual(px(30, 30), [0, 0, 0, 0]);
  });

  test('takes anything with a size and a picture, not just its own types', async () => {
    const surface = block('argb32', '#00ff00');
    // the contract is these three members; the type is nobody's business
    const alike = {
      width: surface.width,
      height: surface.height,
      picture: (a) => surface.picture(a)
    };
    const ctx = target();
    ctx.drawImage(alike, 1, 1);
    const px = await readPixels(ctx);
    assert.deepEqual(px(4, 4), [0, 255, 0, 255]);
  });
});

describe('coverage surfaces', () => {
  test('one rendered copy paints in every colour it is asked for', async () => {
    const mask = block('a8');
    const ctx = target();
    ctx.fillStyle = '#00ff00';
    ctx.drawImage(mask, 2, 2);
    ctx.fillStyle = '#0000ff';
    ctx.drawImage(mask, 2, 20);

    const px = await readPixels(ctx);
    assert.deepEqual(px(4, 4), [0, 255, 0, 255]);
    assert.deepEqual(px(4, 22), [0, 0, 255, 255]);
  });

  test('globalAlpha folds into the colour, since the mask slot is taken', async () => {
    const ctx = target();
    ctx.fillStyle = '#ff0000';
    ctx.globalAlpha = 0.5;
    ctx.drawImage(block('a8'), 2, 2);
    ctx.globalAlpha = 1;

    const px = await readPixels(ctx);
    const [r, g, b, a] = px(4, 4);
    assert.equal(g, 0);
    assert.equal(b, 0);
    assert.ok(Math.abs(a - 128) <= 2, `alpha ~128, got ${a}`);
    assert.ok(r > 200, `colour survives the fold, got r=${r}`);
  });

  test('a gradient fill is sampled where the coverage lands', async () => {
    const ctx = target();
    const g = ctx.createLinearGradient(0, 0, W, 0); // black at x=0, white at x=W
    g.addColorStop(0, '#000000');
    g.addColorStop(1, '#ffffff');
    ctx.fillStyle = g;
    ctx.drawImage(block('a8'), 24, 16);

    const px = await readPixels(ctx);
    // the gradient is surface-aligned, so at x=28 it is ~28/40 of the way to
    // white; sampling it from the origin would read the value at x=4 instead
    const [r, , , a] = px(28, 20);
    assert.equal(a, 255);
    assert.ok(Math.abs(r - 182) <= 8, `gradient value at x=28, got ${r}`);
  });

  test('globalAlpha over a gradient goes through the scratch mask', async () => {
    const ctx = target();
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, '#000000');
    g.addColorStop(1, '#ffffff');
    ctx.fillStyle = g;
    ctx.globalAlpha = 0.5; // no colour to fold the alpha into: scratch mask
    ctx.drawImage(block('a8'), 24, 16);
    ctx.globalAlpha = 1;

    const px = await readPixels(ctx);
    const [r, , , a] = px(28, 20);
    assert.ok(Math.abs(a - 128) <= 4, `half alpha, got ${a}`);
    assert.ok(Math.abs(r - 182) <= 8, `gradient value at x=28, got ${r}`);
  });

  test('partial coverage comes through as partial alpha', async () => {
    const mask = new Surface(app, { width: 8, height: 8, format: 'a8' });
    mask.render((m) => {
      m.fillStyle = '#ffffff';
      m.globalAlpha = 0.5;
      m.fillRect(0, 0, 8, 8);
    });
    const ctx = target();
    ctx.fillStyle = '#ff0000';
    ctx.drawImage(mask, 2, 2);
    const px = await readPixels(ctx);
    assert.ok(Math.abs(px(4, 4)[3] - 128) <= 4, `half coverage, got ${px(4, 4)[3]}`);
  });
});

describe('clipping a surface composite', () => {
  test('a rectangular clip goes to the server, not through a full-surface mask', async () => {
    const red = block('argb32', '#ff0000'); // painted before anything is counted
    const ctx = target();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, 6, 40);
    ctx.clip();
    const counts = countRender(['SetPictureClipRectangles', 'Composite'], () => {
      ctx.drawImage(red, 2, 2);
    });
    ctx.restore();

    assert.equal(counts.SetPictureClipRectangles, 2, 'set and reset around the composite');
    assert.equal(counts.Composite, 1, 'one composite, with no mask to intersect first');

    const px = await readPixels(ctx);
    assert.deepEqual(px(4, 4), [255, 0, 0, 255], 'inside the clip');
    assert.deepEqual(px(8, 4), [0, 0, 0, 0], 'outside the clip');
  });

  test('a rectangular clip clips coverage surfaces too', async () => {
    const ctx = target();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, 6, 40);
    ctx.clip();
    ctx.fillStyle = '#00ff00';
    ctx.drawImage(block('a8'), 2, 2);
    ctx.restore();

    const px = await readPixels(ctx);
    assert.deepEqual(px(4, 4), [0, 255, 0, 255]);
    assert.deepEqual(px(8, 4), [0, 0, 0, 0]);
  });

  test('a non-rectangular clip still clips, through the scratch mask', async () => {
    const ctx = target();
    ctx.save();
    ctx.beginPath();
    ctx.arc(4, 4, 4, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#00ff00';
    ctx.drawImage(block('a8'), 0, 0);
    ctx.restore();

    const px = await readPixels(ctx);
    assert.ok(px(4, 4)[3] > 200, 'the middle of the circle is painted');
    // the far corner of the 8x8 block is outside a radius-4 circle centred at 4,4
    assert.equal(px(9, 9)[3], 0, 'outside the circular clip');
  });

  test('a non-rectangular clip paints coverage that is not at the origin', async () => {
    const ctx = target();
    ctx.save();
    ctx.beginPath();
    ctx.arc(20, 20, 16, 0, Math.PI * 2); // wide enough to contain the block
    ctx.clip();
    ctx.fillStyle = '#00ff00';
    ctx.drawImage(block('a8'), 16, 16);
    ctx.restore();

    // the scratch mask is surface-sized and surface-aligned, so the coverage
    // in it has to be read back at (dx, dy); reading from (0, 0) samples the
    // region just cleared to zero and paints nothing at all (#243)
    const px = await readPixels(ctx);
    assert.deepEqual(px(20, 20), [0, 255, 0, 255], 'the middle of the block');
    assert.deepEqual(px(17, 23), [0, 255, 0, 255], 'and its far corner');
    assert.deepEqual(px(30, 30), [0, 0, 0, 0], 'outside the block');
  });

  test('a non-rectangular clip still bites where it crosses that coverage', async () => {
    const ctx = target();
    ctx.save();
    ctx.beginPath();
    ctx.arc(16, 16, 4, 0, Math.PI * 2); // covers one corner of the block
    ctx.clip();
    ctx.fillStyle = '#00ff00';
    ctx.drawImage(block('a8'), 16, 16);
    ctx.restore();

    const px = await readPixels(ctx);
    assert.deepEqual(px(17, 17), [0, 255, 0, 255], 'inside the circle');
    assert.equal(px(22, 22)[3], 0, 'inside the block, outside the circle');
  });

  test('an empty clip draws nothing at all', () => {
    const red = block('argb32', '#ff0000');
    const ctx = target();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, 6, 6);
    ctx.clip();
    ctx.beginPath();
    ctx.rect(20, 20, 6, 6); // disjoint: the intersection is empty
    ctx.clip();
    const counts = countRender(['Composite'], () => {
      ctx.drawImage(red, 2, 2);
    });
    ctx.restore();
    assert.equal(counts.Composite, 0);
  });
});

describe('context teardown', () => {
  test('destroy() releases and is idempotent', () => {
    const pixmap = app.createPixmap({ width: 8, height: 8, depth: 32 });
    const ctx = pixmap.getContext('2d');
    ctx.fillStyle = '#123456';
    ctx.fillRect(0, 0, 8, 8);
    assert.ok(ctx.picture);
    ctx.destroy();
    assert.equal(ctx.picture, null);
    ctx.destroy(); // must not throw or double-free
  });

  test('render() does not leave a context behind', () => {
    const surface = new Surface(app, { width: 8, height: 8 });
    let seen = null;
    surface.render((ctx) => {
      seen = ctx;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 8, 8);
    });
    assert.equal(seen.picture, null, 'destroyed on the way out');
  });

  test('a surface still composites after the context that drew it is gone', async () => {
    const surface = block('argb32', '#ff00ff');
    const ctx = target();
    ctx.drawImage(surface, 0, 0);
    const px = await readPixels(ctx);
    assert.deepEqual(px(2, 2), [255, 0, 255, 255]);
  });
});

describe('server resources are not leaked', () => {
  /** count the requests a body issues, by name */
  function countX(names, body) {
    const X = app.X;
    const counts = Object.fromEntries(names.map((n) => [n, 0]));
    const saved = {};
    for (const name of names) {
      saved[name] = X[name];
      X[name] = (...a) => {
        counts[name]++;
        return saved[name].apply(X, a);
      };
    }
    try {
      body();
    } finally {
      for (const name of names) X[name] = saved[name];
    }
    return counts;
  }

  test('drawing a node-canvas source repeatedly allocates once, not per call', () => {
    // this used to create a GC, a pixmap and a picture per call and free
    // none of them, so an animation loop leaked three resources a frame
    const ctx = target();
    const fake = {
      width: 4,
      height: 4,
      context: {
        getImageData: () => ({
          width: 4,
          height: 4,
          data: new Uint8ClampedArray(4 * 4 * 4).fill(200),
        }),
      },
    };
    ctx.drawImage(fake, 0, 0); // first call may create the shared upload GC
    const counts = countX(['CreateGC', 'CreatePixmap', 'FreePixmap'], () => {
      for (let i = 0; i < 5; i++) ctx.drawImage(fake, 0, 0);
    });
    assert.equal(counts.CreateGC, 0, 'the upload GC is shared across calls');
    assert.equal(counts.CreatePixmap, 5, 'one scratch pixmap per call');
    assert.equal(counts.FreePixmap, 5, 'and every one of them freed again');
  });

  test('solid fill colours are cached on the app, not rebuilt per context', () => {
    // render() builds a context per call, so per-context solids used to make
    // every render recreate its colours server-side (pixmap + fill + picture
    // each). They now live on the app, one CreateSolidFill per colour ever.
    const surface = new Surface(app, { width: 8, height: 8 });
    const paint = (colour) => (ctx) => {
      ctx.fillStyle = colour;
      ctx.fillRect(0, 0, 8, 8);
    };
    surface.render(paint('#8090a0')); // primes the colour and the defaults
    const counts = countRender(['CreateSolidFill'], () => {
      surface.render(paint('#8090a0'));
      surface.render(paint('#8090a0'));
    });
    assert.equal(counts.CreateSolidFill, 0, 'renders after the first create no solids');
    const fresh = countRender(['CreateSolidFill'], () => surface.render(paint('#8191a1')));
    assert.equal(fresh.CreateSolidFill, 1, 'a colour not seen before costs one request');
  });

  test('destroy() frees the GCs it allocated', () => {
    const pixmap = app.createPixmap({ width: 8, height: 8, depth: 32 });
    const ctx = pixmap.getContext('2d');
    ctx.fillStyle = '#123456';
    ctx.fillRect(0, 0, 8, 8);
    const counts = countX(['FreeGC'], () => ctx.destroy());
    assert.ok(counts.FreeGC >= 1, `at least the target GC, got ${counts.FreeGC}`);
  });
});
