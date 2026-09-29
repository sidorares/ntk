// Shadow tiles (lib/shadowtiles.js): the shadow of a rect, a rounded rect,
// or a rect less a rounded rect filled evenodd, drawn from a tile made once
// in place of a blur on every fill.
//
// The plan and the pixels are asserted with no X at all — that the pieces
// cover a shadow's reach once, that a tile is named by its corners and its
// blur and never by where the shape is or how long its sides are — and the
// 2d context against node-x11's in-process server: that a tiled shadow is
// the blurred one within a few levels of 8-bit alpha, that it is made once
// for any number of fills of shapes like it, and that everything a tile
// does not draw still takes the blur it always took.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';
import {
  planShadowTiles,
  shadowCoverage,
  shadowTileCoverage,
  tileScale,
} from '../lib/shadowtiles.js';

const require = createRequire(import.meta.url);
const fontDir = join(dirname(require.resolve('katex/package.json')), 'dist', 'fonts');

const round = (r) => [0, 0, 0, 0].map(() => ({ x: r, y: r }));
const box = (x0, y0, x1, y1, r = 0) => ({ x0, y0, x1, y1, corners: round(r) });

/** how many of `pieces` cover each pixel of `area`, as count -> pixels */
function coverage(pieces, area) {
  const counts = new Map();
  for (let y = area.y; y < area.y + area.height; y++) {
    for (let x = area.x; x < area.x + area.width; x++) {
      let n = 0;
      for (const [, , , , px, py, pw, ph] of pieces) {
        if (x >= px && x < px + pw && y >= py && y < py + ph) n++;
      }
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
  }
  return counts;
}

// ------------------------------------------------------------------
// the plan and the pixels, on their own

describe('a shadow tile', () => {
  test('is made smaller for a wide blur: σ never under 4 of its pixels', () => {
    assert.equal(tileScale(8), 1);
    assert.equal(tileScale(15), 1);
    assert.equal(tileScale(16), 2);
    assert.equal(tileScale(32), 4);
    assert.equal(tileScale(400), 16, 'and no smaller than a sixteenth');
  });

  test('draws the whole of the shadow once, in nine pieces', () => {
    for (const blur of [6, 20, 80]) {
      const plan = planShadowTiles(box(100, 50, 700, 450, 12), null, blur);
      assert.equal(plan.pieces.length, 9, `blur ${blur}`);
      const reach = plan.reach * plan.k;
      const counts = coverage(plan.pieces, {
        x: 100 - reach,
        y: 50 - reach,
        width: 600 + 2 * reach,
        height: 400 + 2 * reach,
      });
      assert.deepEqual([...counts.keys()], [1], `blur ${blur}: every pixel once`);
    }
  });

  test('is named by its corners and its blur, not by where the shape is or how long its sides are', () => {
    const a = planShadowTiles(box(0, 0, 400, 300, 16), null, 24);
    const b = planShadowTiles(box(-77, 900, 2000, 1280, 16), null, 24);
    assert.equal(a.key, b.key);
    assert.notEqual(a.key, planShadowTiles(box(0, 0, 400, 300, 12), null, 24).key);
    assert.notEqual(a.key, planShadowTiles(box(0, 0, 400, 300, 16), null, 30).key);
  });

  test('of a shape too short to stretch is the shape, and named by its size', () => {
    const a = planShadowTiles(box(0, 0, 400, 30, 8), null, 24);
    const b = planShadowTiles(box(0, 0, 400, 31, 8), null, 24);
    assert.equal(a.pieces.length, 3, 'stretched across, whole down');
    assert.notEqual(a.key, b.key);
  });

  test('of a frame leaves out its middle: inside the hole, the blur never gets there', () => {
    const outer = box(0, 0, 800, 500);
    const hole = box(60, 60, 740, 440, 10);
    const plan = planShadowTiles(outer, hole, 40);
    assert.equal(plan.pieces.length, 8);
    const reach = plan.reach * plan.k;
    const deep = reach + 10 + 2 * plan.k;
    const counts = coverage(plan.pieces, {
      x: 60 + deep,
      y: 60 + deep,
      width: 680 - 2 * deep,
      height: 380 - 2 * deep,
    });
    assert.deepEqual([...counts.keys()], [0]);
  });

  test('holds the blurred shape: full inside it, half at its edge, nothing at the reach', () => {
    const plan = planShadowTiles(box(40, 40, 440, 340), null, 12);
    const values = shadowTileCoverage(plan);
    const at = (x, y) => values[y * plan.width + x];
    const reach = plan.reach;
    const midY = plan.height >> 1;
    assert.ok(at(plan.width >> 1, midY) > 0.99, 'inside');
    // the edge falls between two pixels: one just outside, one just in
    const edge = (at(reach - 1, midY) + at(reach, midY)) / 2;
    assert.ok(Math.abs(edge - 0.5) < 0.01, `half at the edge, ${edge}`);
    assert.ok(at(0, midY) < 0.01, 'at the reach');
  });

  test("a corner's coverage is the ellipse's: an elliptical corner is not a circle", () => {
    const corners = [
      { x: 40, y: 10 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ];
    const plan = planShadowTiles({ x0: 0, y0: 0, x1: 200, y1: 100, corners }, null, 2);
    const raw = shadowCoverage(plan);
    const at = (x, y) => raw[(y + plan.reach) * plan.width + x + plan.reach];
    assert.ok(at(1, 1) < 0.01, 'the very corner is cut away');
    assert.ok(at(30, 1) > 0.99, 'three quarters along the flat ellipse, it is in');
    // half way down, a circle of the corner's height would already be in
    // at the second pixel; the ellipse, 40 across, is in only past six
    assert.ok(at(1, 4) < 0.01, 'the ellipse is shallow');
    assert.ok(at(8, 4) > 0.99);
  });

  test('is not made past a size: an ellipse with nothing straight in it', () => {
    const corners = [0, 0, 0, 0].map(() => ({ x: 1000, y: 1000 }));
    const plan = planShadowTiles({ x0: 0, y0: 0, x1: 2000, y1: 2000, corners }, null, 4);
    assert.equal(plan, null);
  });
});

// ------------------------------------------------------------------
// the 2d context

let app = null;

before(async () => {
  const server = xserver.createServer({ width: 400, height: 400 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), { family: 'Test Main' });
  fontSource.alias('sans-serif', 'Test Main');
  app = await createClient({ stream: clientEnd, fontSource });
});

after(async () => {
  await app?.close();
});

function target(w, h) {
  const pixmap = app.createPixmap({ width: w, height: h, depth: 32 });
  const ctx = pixmap.getContext('2d');
  const R = app.display.Render;
  R.FillRectangles(R.PictOp.Src, ctx.picture.id, [0, 0, 0, 0], [0, 0, w, h]);
  return ctx;
}

async function alphaOf(ctx, w, h) {
  const img = await ctx.getImageData(0, 0, w, h);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = img.data[i * 4 + 3];
  return out;
}

/** the shadow of `draw` alone — its shape thrown clear of the target — as
 *  alpha, with tiles on or off */
async function shadowOf(draw, { tiles, w = 240, h = 180, blur = 12 } = {}) {
  app.shadowPolicy = { tiles };
  try {
    const ctx = target(w, h);
    ctx.shadowColor = '#000000';
    ctx.shadowBlur = blur;
    ctx.shadowOffsetX = 1000;
    ctx.fillStyle = '#000000';
    draw(ctx, -1000);
    const alpha = await alphaOf(ctx, w, h);
    ctx.destroy();
    return alpha;
  } finally {
    app.shadowPolicy = undefined;
  }
}

const worst = (a, b) => {
  let most = 0;
  for (let i = 0; i < a.length; i++) most = Math.max(most, Math.abs(a[i] - b[i]));
  return most;
};

/** what went to the server's blur: a tile runs none */
function convolutions(fn) {
  const R = app.display.Render;
  const setFilter = R.SetPictureFilter;
  let n = 0;
  R.SetPictureFilter = function (id, name) {
    if (name === 'convolution') n++;
    return setFilter.apply(this, arguments);
  };
  try {
    fn();
  } finally {
    R.SetPictureFilter = setFilter;
  }
  return n;
}

describe('a shadowed fill, from a tile', () => {
  const shapes = {
    'fillRect': (ctx, dx) => ctx.fillRect(40 + dx, 40, 150, 90),
    'a rounded rect': (ctx, dx) => {
      ctx.beginPath();
      ctx.roundRect(40 + dx, 40, 150, 90, 14);
      ctx.fill();
    },
    'an elliptical one': (ctx, dx) => {
      ctx.beginPath();
      ctx.roundRect(40 + dx, 40, 150, 90, [{ x: 30, y: 12 }, 4, 18, { x: 8, y: 20 }]);
      ctx.fill();
    },
    'a frame, filled evenodd': (ctx, dx) => {
      ctx.beginPath();
      ctx.rect(10 + dx, 10, 220, 160);
      ctx.roundRect(40 + dx, 40, 150, 90, 12);
      ctx.fill('evenodd');
    },
  };
  for (const [name, draw] of Object.entries(shapes)) {
    test(`${name}: the shadow the blur draws, within a few levels`, async () => {
      const tiled = await shadowOf(draw, { tiles: true });
      const blurred = await shadowOf(draw, { tiles: false });
      assert.ok(tiled.some((v) => v > 100), 'the shadow is there');
      const off = worst(tiled, blurred);
      assert.ok(off <= 4, `off by ${off} of 255`);
    });
  }

  test('runs no blur on the server, and makes one tile for any number of fills like it', () => {
    const ctx = target(300, 300);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
    ctx.shadowBlur = 20;
    const before = [...(app._shadowSurfaces?.keys() ?? [])].filter((k) => k.startsWith('tile|'));
    const blurs = convolutions(() => {
      ctx.fillRect(20, 20, 200, 120);
      ctx.fillRect(60, 150, 180, 100);
      ctx.beginPath();
      ctx.rect(5, 5, 290, 290);
      ctx.fill();
    });
    const after = [...app._shadowSurfaces.keys()].filter((k) => k.startsWith('tile|'));
    assert.equal(blurs, 0);
    assert.equal(after.length - before.length, 1, 'one tile, three fills');
    ctx.destroy();
  });

  test('anything else still takes the blur: a path of lines, a rotated rect, the switch off', () => {
    const ctx = target(200, 200);
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 12;
    assert.ok(
      convolutions(() => {
        ctx.beginPath();
        ctx.moveTo(20, 20);
        ctx.lineTo(120, 20);
        ctx.lineTo(70, 120);
        ctx.fill();
      }) > 0,
      'a triangle',
    );
    ctx.save();
    ctx.rotate(0.2);
    assert.ok(convolutions(() => ctx.fillRect(40, 20, 60, 40)) > 0, 'a rotated rect');
    ctx.restore();
    ctx.beginPath();
    ctx.rect(0, 0, 100, 100);
    ctx.rect(50, 50, 100, 100);
    assert.ok(convolutions(() => ctx.fill('evenodd')) > 0, 'two rects neither holding the other');
    app.shadowPolicy = { tiles: false };
    try {
      assert.ok(convolutions(() => ctx.fillRect(40, 40, 60, 40)) > 0, 'tiles off');
    } finally {
      app.shadowPolicy = undefined;
    }
    ctx.destroy();
  });

  test('a clip draws only the part of the shadow in it, and the same part as a whole paint', async () => {
    const w = 300;
    const h = 200;
    const draw = (ctx) => {
      ctx.shadowColor = '#000000';
      ctx.shadowBlur = 16;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(40, 40, 220, 120);
    };
    const whole = target(w, h);
    draw(whole);
    const all = await alphaOf(whole, w, h);
    whole.destroy();
    // a strip, as a scroll exposes one
    const strip = target(w, h);
    strip.beginPath();
    strip.rect(0, 150, w, 20);
    strip.clip();
    draw(strip);
    const part = await alphaOf(strip, w, h);
    strip.destroy();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (y >= 150 && y < 170) assert.equal(part[i], all[i], `in the strip at ${x},${y}`);
        else assert.equal(part[i], 0, `outside it at ${x},${y}`);
      }
    }
  });
});
