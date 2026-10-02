// drawGlyphs and drawTraps take a colour for their source, and paint it with
// a solid the app lets go of as colours change.
//
// Their source was a picture, and the way the docs gave to make one of a
// colour was createSolidPicture, whose solids are held until app.close():
// whoever asked for one may keep it. A terminal draws a run for each
// foreground colour in a frame, and react-x11-components' made a solid for
// each, every frame — so truecolor output, or a colour animated through a
// tween, left one on the server for every colour it ever drew.
//
// A colour handed over now goes through the LRU the colour styles share
// (App#styleSolid), for that call. What could go wrong is its solid let go
// of between being asked for and the composite that paints with it:
// drawGlyphs asks for its source, then paints the shadow, in colours of its
// own. The animation below draws glyph runs and trapezoids in new colours
// every frame, in each form a source takes and down each road a composite
// takes, and compares every frame, byte for byte, with the same frames drawn
// from createSolidPicture's solids, which nothing frees — at the LRU's own
// size, and at a size of 0, which lets every solid but the newest go the
// moment another is made.
//
// Hermetic: node-x11's in-process pure-JS X server + the fixture font. Each
// app gets a server of its own, whose resource table counts its solids.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource, Surface } from '../lib/index.js';
import { cssColor } from '../lib/color.js';
import { trapezoidize } from '../lib/trapezoid.js';

const VF = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'MonelogicsSubset[wght].ttf'
);

const FRAMES = 300;
// what a frame redraws, and the strip every frame is kept in
const CELL = 56;
const COLS = 20;
const W = COLS * CELL;
const H = Math.ceil(FRAMES / COLS) * CELL;
const BACKGROUND = 'rgb(240, 236, 228)';
// a grid's cell, which the runs below are built on, as a terminal builds them
const SIZE = 10;
const CELL_W = 6;

/** frame i's colour for animation k: a new one every frame */
const tween = (i, k) =>
  `rgb(${(i * 3 + k * 47) % 256}, ${(i * 5 + k * 23) % 256}, ${(Math.floor(i / 2) + k * 101) % 256})`;

/** the same, as a premultiplied [r, g, b, a] at half opacity */
const tweenArray = (i, k) => cssColor(tween(i, k)).map((v) => v * 0.5);

/** what a call is handed for a colour (null: the fill style): the colour */
const asColor = (ctx, color) => color;

/**
 * ...or, as the docs had it until now, a solid of it from
 * createSolidPicture, which holds each until the app closes. `handed`
 * collects them.
 */
const asSolid = (handed) => (ctx, color) => {
  const c = color ?? ctx.fillStyle;
  const p = ctx.createSolidPicture(...(Array.isArray(c) ? c : cssColor(c)));
  handed.push(p);
  return p;
};

async function connect() {
  const server = xserver.createServer({ width: 64, height: 64 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(VF), { family: 'Fixture' });
  const errors = [];
  const app = await createClient({
    stream: clientEnd,
    fontSource,
    onXError: (err) => errors.push(err)
  });
  return { server, app, errors };
}

/** the server-side resources `keep` picks */
function count(server, keep) {
  let n = 0;
  for (const r of server.resources.values()) if (keep(r)) n++;
  return n;
}

const isSolid = (r) => r.type === 'picture' && r.kind === 'solid';

/**
 * Once it answers, the server has run every request sent before, the frees
 * a job leaves to its end among them: let those go out first.
 */
async function settle(app) {
  await null;
  await new Promise((resolve) => app.X.GetInputFocus(() => resolve()));
}

/** whether the server's solid `r` paints premultiplied `rgba` */
function paints(r, rgba) {
  // the server keeps [a, r, g, b] on a 0..255 scale
  const [a, red, g, b] = r.color.map((v) => v / 255);
  return [red, g, b, a].every((have, i) => Math.abs(have - rgba[i]) < 1e-4);
}

/** `text` as a run of a grid: a glyph to a cell, by codepoint, unshaped */
function gridRun(font, text) {
  const glyphs = [...text].map((ch) => ({
    id: font.glyphIdFor(ch.codePointAt(0)) ?? 0,
    ax: CELL_W,
    dx: 0,
    dy: 0
  }));
  return { font, size: SIZE, glyphs };
}

/** the Render requests `body` sends, by name */
function countRender(app, names, body) {
  const R = app.display.Render;
  const counts = Object.fromEntries(names.map((n) => [n, 0]));
  const saved = names.map((n) => R[n]);
  names.forEach((n, i) => {
    R[n] = (...a) => {
      counts[n]++;
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
  return counts;
}

/** what a drawing sends, the solids it asks for among them */
const DRAWING = [
  'CompositeGlyphs',
  'Composite',
  'FillRectangles',
  'AddGlyphs',
  'AddTraps',
  'CreateSolidFill'
];

/**
 * Glyph runs and trapezoids redrawn frame after frame in new colours, the
 * way a terminal redraws its rows, each frame kept in a cell of a strip.
 * `source(ctx, color)` is what each call is handed. `afterFrame(i)` runs
 * after frame i, and may return a promise to wait for. Resolves to the
 * strip's pixels.
 */
async function animate(app, source, afterFrame) {
  const strip = app.createPixmap({ width: W, height: H, depth: 24 });
  const out = strip.getContext('2d');
  const frame = new Surface(app, { width: CELL, height: CELL });
  const ctx = frame.getContext('2d');
  const font = app.fonts.match('Fixture');
  const hand = gridRun(font, 'Hand');
  const digits = gridRun(font, '0123');
  const at = (run, x, y) => [{ run, x, y }];
  const Over = ctx.Render.PictOp.Over;
  const wedge = trapezoidize([[2, 42, 22, 45, 16, 54, 3, 50]], 0, 0, []);
  const sliver = trapezoidize([[26, 44, 46, 42, 44, 54, 30, 52]], 0, 0, []);
  for (let i = 0; i < FRAMES; i++) {
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, CELL, CELL);
    // a CSS colour, the form a terminal's palette is in
    ctx.drawGlyphs(Over, source(ctx, tween(i, 0)), at(hand, 1, 9));
    // a premultiplied array, at half opacity
    ctx.drawGlyphs(Over, source(ctx, tweenArray(i, 1)), at(digits, 24, 9));
    // null: the fill style, itself animated
    ctx.fillStyle = tween(i, 2);
    ctx.drawGlyphs(Over, source(ctx, null), at(hand, 1, 19));
    // Under a shadow. The source is asked for first, and the shadow then
    // asks for its own colour, so at a limit of 0 the source's solid has
    // been let go of by the time the glyphs composite with it.
    ctx.shadowColor = tween(i, 3);
    ctx.shadowBlur = 2;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    ctx.drawGlyphs(Over, source(ctx, tween(i, 4)), at(digits, 24, 19));
    ctx.shadowColor = 'transparent';
    // faded: the alpha folded into a solid of its own
    ctx.globalAlpha = 0.5;
    ctx.drawGlyphs(Over, source(ctx, tween(i, 5)), at(hand, 1, 29));
    ctx.globalAlpha = 1;
    // under a clip that is not a rectangle: through the scratch mask
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(36, 26, 12, 5, 0, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawGlyphs(Over, source(ctx, tween(i, 6)), at(digits, 24, 29));
    ctx.restore();
    // an op that clears the box round the ink, `copy`: through the scratch
    // mask too, over that box
    ctx.drawGlyphs(ctx.Render.PictOp.Src, source(ctx, tween(i, 9)), at(hand, 1, 39));
    // trapezoids, in a colour and in an array
    ctx.drawTraps(Over, source(ctx, tween(i, 7)), wedge);
    ctx.drawTraps(Over, source(ctx, tweenArray(i, 8)), sliver);
    out.drawImage(frame, (i % COLS) * CELL, Math.floor(i / COLS) * CELL);
    await afterFrame?.(i);
  }
  const { data } = await out.getImageData(0, 0, W, H);
  ctx.destroy();
  frame.destroy();
  strip.destroy();
  return data;
}

/**
 * The animation on an app of its own, keeping `limit` style solids.
 * `atEnd(server, app)` looks at the server once the animation has settled,
 * before the app closes.
 */
async function run(source, { limit, afterFrame, atEnd } = {}) {
  const { server, app, errors } = await connect();
  try {
    if (limit !== undefined) app._styleSolidLimit = limit;
    const pixels = await animate(app, source, afterFrame && ((i) => afterFrame(server, app, i)));
    await settle(app);
    atEnd?.(server, app);
    return {
      pixels,
      errors,
      limit: app._styleSolidLimit,
      live: count(server, isSolid),
      held: app._solidPictures.size,
      styles: app._styleSolids.size,
      transient: app._transientSolids.size
    };
  } finally {
    await app.close();
  }
}

/** the strip's pixels of frame `i`, row after row */
function frameOf(pixels, i) {
  const x0 = (i % COLS) * CELL;
  const y0 = Math.floor(i / COLS) * CELL;
  const rows = [];
  for (let y = 0; y < CELL; y++) {
    const at = ((y0 + y) * W + x0) * 4;
    rows.push(...pixels.subarray(at, at + CELL * 4));
  }
  return rows;
}

function assertSamePixels(got, want, label) {
  assert.equal(got.length, want.length);
  for (let i = 0; i < want.length; i++) {
    if (got[i] === want[i]) continue;
    const p = Math.floor(i / 4);
    const [x, y] = [p % W, Math.floor(p / W)];
    const frame = Math.floor(y / CELL) * COLS + Math.floor(x / CELL);
    const at = `${x % CELL},${y % CELL}`;
    assert.fail(`${label}: frame ${frame} differs at ${at}: ${got[i]}, not ${want[i]}`);
  }
}

test('glyph runs and trapezoids in animated colours keep a bounded number of solids, and draw what createSolidPicture draws', async () => {
  // what every frame is checked against: a solid of each colour from
  // createSolidPicture, as the docs had it, which the app holds for good
  const handed = [];
  const all = await run(asSolid(handed), {
    atEnd(server) {
      // every one of them, still on the server and still its colour
      for (const p of handed) {
        const r = server.resources.get(p.id);
        assert.ok(r && isSolid(r) && paints(r, p._rgba), `${p._rgba} is alive`);
      }
    }
  });
  const colours = new Set(handed);
  assert.ok(colours.size >= FRAMES * 9, `${colours.size} colours, a solid each`);
  assert.ok(all.held >= colours.size, 'held until the app closes');
  // the animation animates, and draws something every frame
  const background = cssColor(BACKGROUND).slice(0, 3).map((v) => Math.round(v * 255));
  for (let i = 0; i < FRAMES; i++) {
    const pixels = frameOf(all.pixels, i);
    let inked = 0;
    for (let p = 0; p < pixels.length; p += 4) {
      if (pixels.slice(p, p + 3).some((v, c) => v !== background[c])) inked++;
    }
    assert.ok(inked > 100, `frame ${i} inks ${inked} pixels`);
    if (i > 0) assert.notDeepEqual(pixels, frameOf(all.pixels, i - 1), `frame ${i} changed`);
  }

  // The colours themselves. Asked every 25 frames, the server holds no more
  // than the caches allow, and what it holds for good does not grow.
  let heldEarly = null;
  const bounded = await run(asColor, {
    async afterFrame(server, app, i) {
      if (i === 0) heldEarly = app._solidPictures.size;
      if (i % 25 !== 24) return;
      await settle(app);
      const live = count(server, isSolid);
      const most = app._solidPictures.size + app._styleSolidLimit + app._transientSolidLimit;
      assert.ok(live <= most, `after frame ${i} the server holds ${live} solids`);
    }
  });
  assert.equal(bounded.held, heldEarly, 'no colour handed over is held for good');
  assert.ok(colours.size > 2 * bounded.limit, 'many times what the LRU holds');
  // full, and what it let go of freed on the server, not only forgotten
  assert.equal(bounded.styles, bounded.limit);
  assert.equal(bounded.live, bounded.held + bounded.styles + bounded.transient);
  assertSamePixels(bounded.pixels, all.pixels, 'bounded');

  // Room for one: every colour's solid but the newest is let go of the
  // moment another is asked for — the source of the shadowed run before it
  // composites — and freed once the frame has run.
  const tight = await run(asColor, { limit: 0 });
  assert.equal(tight.styles, 1);
  assert.equal(tight.live, tight.held + tight.styles + tight.transient);
  assertSamePixels(tight.pixels, all.pixels, 'one kept');

  for (const r of [all, bounded, tight]) assert.deepEqual(r.errors, []);
});

test('null paints with the fill style, and asks again for a solid let go of', async () => {
  const { app, errors } = await connect();
  try {
    app._styleSolidLimit = 4;
    const font = app.fonts.match('Fixture');
    const runs = [{ run: font.shape('Hand', 24), x: 2, y: 22 }];
    const traps = trapezoidize([[50, 4, 70, 6, 66, 26, 54, 22]], 0, 0, []);
    // the same drawing, handed `src` and with `fill` as the fill style
    const draw = async (fill, src) => {
      const pixmap = app.createPixmap({ width: 72, height: 28, depth: 24 });
      const ctx = pixmap.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 72, 28);
      ctx.fillStyle = fill(ctx);
      const style = ctx._fillSource;
      // more colours than the app keeps, asked for elsewhere: a solid
      // colour's solid is let go of
      const other = app.createPixmap({ width: 1, height: 1, depth: 24 });
      const octx = other.getContext('2d');
      for (let i = 0; i < 8; i++) octx.fillStyle = `rgb(${i}, 0, 0)`;
      const evicted = Boolean(style._evicted);
      await settle(app);
      const Over = ctx.Render.PictOp.Over;
      ctx.drawGlyphs(Over, src(ctx), runs);
      ctx.drawTraps(Over, src(ctx), traps);
      const { data } = await ctx.getImageData(0, 0, 72, 28);
      other.destroy();
      pixmap.destroy();
      return { data, evicted };
    };
    const green = () => 'rgb(10, 200, 30)';
    const solid = (ctx) => ctx.createSolidPicture(...cssColor('rgb(10, 200, 30)'));
    const byNull = await draw(green, () => null);
    assert.ok(byNull.evicted, "the fill style's solid was let go of");
    const bySolid = await draw(green, solid);
    assert.deepEqual(byNull.data, bySolid.data, 'a colour fill style');

    const gradient = (ctx) => {
      const g = ctx.createLinearGradient(0, 0, 72, 0);
      g.addColorStop(0, '#ff0000');
      g.addColorStop(1, '#0000ff');
      return g;
    };
    // the same gradient both times: the one the fill style is
    const viaNull = await draw(gradient, () => null);
    const viaGradient = await draw(gradient, (ctx) => ctx.fillStyle);
    assert.deepEqual(viaNull.data, viaGradient.data, 'a gradient fill style');
    assert.notDeepEqual(viaNull.data, byNull.data, 'which is not the colour');
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
  }
});

test('ctx.takesColorSources says so, for code handed a context it did not make', async () => {
  // a renderer hands drawGlyphs a colour where this is true, and makes a
  // solid with createSolidPicture where it is not: an older ntk, another
  // backend's context
  const { app } = await connect();
  try {
    const pixmap = app.createPixmap({ width: 8, height: 8, depth: 24 });
    const ctx = pixmap.getContext('2d');
    assert.equal(ctx.takesColorSources, true);
    assert.throws(() => {
      ctx.takesColorSources = false;
    }, TypeError);
    pixmap.destroy();
    const surface = new Surface(app, { width: 8, height: 8 });
    surface.render((sctx) => assert.equal(sctx.takesColorSources, true, 'and on a surface'));
    surface.destroy();
  } finally {
    await app.close();
  }
});

test('a source that is neither a colour nor a picture throws, with nothing drawn', async () => {
  const { app, errors } = await connect();
  try {
    const pixmap = app.createPixmap({ width: 64, height: 32, depth: 24 });
    const ctx = pixmap.getContext('2d');
    const runs = [{ run: app.fonts.match('Fixture').shape('Hand', 16), x: 2, y: 20 }];
    const traps = trapezoidize([[2, 2, 20, 2, 20, 20]], 0, 0, []);
    const Over = ctx.Render.PictOp.Over;
    // a shadow, which a drawing that got as far as painting it would send
    ctx.shadowColor = '#000';
    ctx.shadowOffsetX = ctx.shadowOffsetY = 2;
    const sent = countRender(app, DRAWING, () => {
      assert.throws(() => ctx.drawGlyphs(Over, 'not a colour', runs), /Not a color: "not a colour"/);
      assert.throws(() => ctx.drawTraps(Over, 'not a colour', traps), /Not a color/);
      // A grid keeps its colours as numbers, and one handed over as it is
      // used to go to the server as a picture id: nothing drawn, and an
      // error from the server once the call had long returned.
      assert.throws(
        () => ctx.drawGlyphs(Over, 0xe5c07b, runs),
        (err) =>
          err instanceof TypeError &&
          /^drawGlyphs: src is 15057019, neither a colour nor a picture/.test(err.message) &&
          err.message.includes("'#e5c07b' is that number read as 0xRRGGBB")
      );
      assert.throws(() => ctx.drawTraps(Over, true, traps), /^TypeError: drawTraps: src is a boolean/);
    });
    assert.deepEqual(sent, Object.fromEntries(DRAWING.map((n) => [n, 0])));

    // at globalAlpha 0 nothing is drawn, so a colour is not even looked at,
    // and no solid is made for it
    ctx.globalAlpha = 0;
    const faded = countRender(app, DRAWING, () => {
      ctx.drawGlyphs(Over, 'rgb(1, 2, 3)', runs);
      ctx.drawTraps(Over, [0.1, 0.2, 0.3, 1], traps);
    });
    assert.deepEqual(faded, Object.fromEntries(DRAWING.map((n) => [n, 0])));
    await settle(app);
    assert.deepEqual(errors, []);
    pixmap.destroy();
  } finally {
    await app.close();
  }
});
