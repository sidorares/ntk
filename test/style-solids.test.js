// The solids a context paints its colour styles with are let go of as
// colours animate, and asked for again by whoever still holds the style.
//
// `fillStyle`, `strokeStyle` and a TextLayout span's colour each paint with
// a server-side solid of their colour. An app's palette is a few dozen; a
// colour animated through a CSS transition or a tween is a new one every
// frame, and they went into the cache `createSolidPicture` uses, which never
// evicts — so every animated colour left a solid a frame on the server until
// app.close().
//
// They live in an LRU of their own now, and one let go is freed once the job
// that let it go has run. What could go wrong is a holder using one past
// that: its id goes back to the pool, the next solid made can take it, and a
// composite sent with it paints in another colour, or fails. A context holds
// its styles' solids from frame to frame, and asks again when it finds one
// let go; a drawing takes its style before painting its shadow, which asks
// for colours of its own in between. The animation below runs all of those
// through many more colours than the LRU keeps, and compares every frame
// with a run that frees nothing — and with one that keeps a single solid,
// which lets each of the others go as soon as the next is made.
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
import { cssColor, cssColorStraight } from '../lib/color.js';

const VF = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'MonelogicsSubset[wght].ttf'
);

const FRAMES = 300;
// what a frame redraws, and the strip every frame is kept in
const CELL = 48;
const COLS = 20;
const W = COLS * CELL;
const H = Math.ceil(FRAMES / COLS) * CELL;
const BACKGROUND = 'rgb(240, 236, 228)';
// the styles of a context that sets them once
const HELD_FILL = 'rgb(30, 90, 200)';
const HELD_STROKE = 'rgb(250, 200, 0)';

/** frame i's colour for animation k: a new one every frame */
const tween = (i, k) =>
  `rgb(${(i * 3 + k * 47) % 256}, ${(i * 5 + k * 23) % 256}, ${(Math.floor(i / 2) + k * 101) % 256})`;

/** the key the app keeps a solid of a CSS colour by */
const keyOf = (color) => cssColor(color).join('|');

/** the same, as a premultiplied [r, g, b, a] at half opacity */
const tweenArray = (i, k) => cssColor(tween(i, k)).map((v) => v * 0.5);

/** the 8-bit straight RGB a colour string paints as on a depth-24 target */
const rgb = (color) =>
  cssColorStraight(color)
    .slice(0, 3)
    .map((v) => Math.round(v * 255));

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

/**
 * Every way a colour style reaches a composite, redrawn frame after frame
 * in new colours, the way a transition redraws an element, and each frame
 * kept in a cell of a strip. `afterFrame(i)` runs after frame i, and may
 * return a promise to wait for. Resolves to the strip's pixels.
 */
async function animate(app, afterFrame) {
  const strip = app.createPixmap({ width: W, height: H, depth: 24 });
  const out = strip.getContext('2d');
  const frame = new Surface(app, { width: CELL, height: CELL });
  const ctx = frame.getContext('2d');
  ctx.font = '10px Fixture';
  // painted in the fill style, wherever it is drawn
  const coverage = new Surface(app, { width: 10, height: 10, format: 'a8' });
  coverage.render((s) => {
    s.fillStyle = '#fff';
    s.beginPath();
    s.arc(5, 5, 4, 0, Math.PI * 2);
    s.fill();
  });
  // a context whose styles are set once and drawn with every frame: as
  // colours animate around it, the app lets its solids go, and it has to
  // ask again rather than paint with an id that is someone else's by now
  const badge = new Surface(app, { width: 10, height: 10 });
  const held = badge.getContext('2d');
  held.fillStyle = HELD_FILL;
  held.strokeStyle = HELD_STROKE;
  held.lineWidth = 2;
  for (let i = 0; i < FRAMES; i++) {
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, CELL, CELL);
    // a composite straight from the style's solid
    ctx.fillStyle = tween(i, 0);
    ctx.fillRect(2, 2, 10, 10);
    // a path, in a premultiplied array
    ctx.fillStyle = tweenArray(i, 1);
    ctx.beginPath();
    ctx.arc(20, 7, 5, 0, Math.PI * 2);
    ctx.fill();
    // a stroked path, and a stroked rounded box, whose corners are glyphs
    // in the style's own solid
    ctx.strokeStyle = tween(i, 2);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(28, 2);
    ctx.lineTo(44, 12);
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(3, 15, 11, 8, 3);
    ctx.stroke();
    // coverage painted in the style; a rounded box's corner glyphs
    ctx.fillStyle = tween(i, 3);
    ctx.drawImage(coverage, 16, 14);
    ctx.beginPath();
    ctx.roundRect(28, 15, 16, 8, 3);
    ctx.fill();
    // a style set and taken back by restore, which asks for the old again
    ctx.save();
    ctx.fillStyle = tween(i, 4);
    ctx.fillRect(2, 26, 6, 6);
    ctx.restore();
    ctx.fillRect(9, 26, 6, 6);
    // shadows borrow the fill style for their colour: a tiled one, under a
    // rect, and one under text
    ctx.shadowBlur = 2;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    ctx.shadowColor = tween(i, 5);
    ctx.fillRect(18, 26, 8, 5);
    ctx.shadowColor = tween(i, 6);
    ctx.fillStyle = tween(i, 7);
    ctx.fillText('Hand', 28, 33);
    // A span's colour, and the fill style for the span without one: each
    // taken before drawGlyphs paints the shadow — whose coverage, for runs
    // it has not seen, is drawn by a context of its own, in colours of its
    // own — and composited after it.
    const layout = app.fonts.layout(
      [{ text: 'glo', color: tween(i, 8) }, { text: 'ves' }],
      { family: 'Fixture', size: 10 }
    );
    layout.draw(ctx, 2, 35);
    ctx.shadowColor = 'transparent';
    // a style under a fade, whose alpha goes in a solid of its own
    ctx.fillStyle = tween(i, 9);
    ctx.globalAlpha = 0.5;
    ctx.fillRect(26, 40, 8, 6);
    ctx.globalAlpha = 1;
    // and the context that never set its styles again
    held.clearRect(0, 0, 10, 10);
    held.fillRect(1, 1, 8, 8);
    held.beginPath();
    held.moveTo(1, 9);
    held.lineTo(9, 1);
    held.stroke();
    ctx.drawImage(badge, 36, 36);
    out.drawImage(frame, (i % COLS) * CELL, Math.floor(i / COLS) * CELL);
    await afterFrame?.(i);
  }
  const { data } = await out.getImageData(0, 0, W, H);
  ctx.destroy();
  held.destroy();
  for (const s of [frame, coverage, badge]) s.destroy();
  strip.destroy();
  return data;
}

/** the animation on an app of its own, keeping `limit` style solids */
async function run(limit, afterFrame) {
  const { server, app, errors } = await connect();
  try {
    if (limit !== undefined) app._styleSolidLimit = limit;
    // how many times each colour's solid was made
    const made = new Map();
    const create = app._createSolid;
    app._createSolid = function (key, ...rgba) {
      made.set(key, (made.get(key) ?? 0) + 1);
      return create.call(this, key, ...rgba);
    };
    const pixels = await animate(app, afterFrame && ((i) => afterFrame(server, app, i)));
    await settle(app);
    return {
      pixels,
      errors,
      made,
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

/** the strip's pixel of frame `i` at (x, y) in its cell */
const pixelOf = (i, x, y) =>
  ((Math.floor(i / COLS) * CELL + y) * W + (i % COLS) * CELL + x) * 4;

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

test('animated colours keep a bounded number of solids, and draw what keeping them all draws', async () => {
  // what every frame is checked against: nothing let go, so no id handed
  // out twice
  const all = await run(Infinity);
  // a solid per animated colour per frame — what each animation used to
  // leave behind
  assert.ok(all.styles >= FRAMES * 8, `the animation made ${all.styles} style solids`);
  assert.equal(all.live, all.held + all.styles + all.transient, 'and the server holds them all');
  // each frame in its own colour
  for (let i = 0; i < FRAMES; i++) {
    const at = pixelOf(i, 6, 6);
    assert.deepEqual([...all.pixels.slice(at, at + 3)], rgb(tween(i, 0)), `frame ${i}`);
  }

  const bounded = await run(undefined, async (server, app, i) => {
    if (i % 25 !== 24) return;
    await settle(app);
    const live = count(server, isSolid);
    const most = app._solidPictures.size + app._styleSolidLimit + app._transientSolidLimit;
    assert.ok(live <= most, `after frame ${i} the server holds ${live} solids`);
  });
  assert.ok(all.styles > 2 * bounded.limit, 'many times what the LRU holds');
  // full, and what it let go of freed on the server, not only forgotten
  assert.equal(bounded.styles, bounded.limit);
  assert.equal(bounded.live, bounded.held + bounded.styles + bounded.transient);
  assertSamePixels(bounded.pixels, all.pixels, 'bounded');

  // Room for one: every style solid but the newest is let go of the moment
  // another is made, mid-drawing as often as not, and freed once the frame
  // has run. A drawing that kept one past its frame, or a context that
  // painted with one it held without asking again, would draw in someone
  // else's colour here, or fail.
  const tight = await run(0);
  assert.equal(tight.styles, 1);
  assert.equal(tight.live, tight.held + tight.styles + tight.transient);
  // the context that set its styles once asked again every frame, where
  // keeping them all made each once
  for (const color of [HELD_FILL, HELD_STROKE]) {
    assert.equal(all.made.get(keyOf(color)), 1);
    assert.ok(tight.made.get(keyOf(color)) > FRAMES, `${color}: ${tight.made.get(keyOf(color))}`);
  }
  assertSamePixels(tight.pixels, all.pixels, 'one kept');

  for (const r of [all, bounded, tight]) assert.deepEqual(r.errors, []);
});

test('a context asks again for a solid the app let go of', async () => {
  const { server, app, errors } = await connect();
  try {
    app._styleSolidLimit = 4;
    const pixmap = app.createPixmap({ width: 8, height: 8, depth: 24 });
    const ctx = pixmap.getContext('2d');
    ctx.fillStyle = 'rgb(10, 200, 30)';
    ctx.strokeStyle = [0.5, 0.25, 0, 1];
    const fill = ctx._backgroundPicture;
    const stroke = ctx._strokePicture;
    // more colours than the app keeps, asked for elsewhere
    const other = app.createPixmap({ width: 8, height: 8, depth: 24 });
    const octx = other.getContext('2d');
    for (let i = 0; i < 8; i++) octx.fillStyle = `rgb(${i}, 0, 0)`;
    assert.ok(fill._evicted && stroke._evicted, 'both let go of');
    // and freed once the job is over, not before: a request sent with one
    // until then still finds it
    assert.ok(app._evictedSolids.includes(fill) && app._evictedSolids.includes(stroke));
    assert.ok(fill._owned && stroke._owned, 'not yet freed');
    await settle(app);
    for (const p of [fill, stroke]) assert.ok(!server.resources.has(p.id), 'freed');

    // asked for again: the same colour, in a solid that is alive
    const again = [ctx._backgroundPicture, ctx._strokePicture];
    for (const [p, was] of [[again[0], fill], [again[1], stroke]]) {
      assert.notEqual(p, was);
      assert.deepEqual(p._rgba, was._rgba);
    }
    // once, not on every read
    assert.equal(ctx._backgroundPicture, again[0]);
    assert.equal(ctx._strokePicture, again[1]);
    await settle(app);
    for (const p of again) assert.ok(paints(server.resources.get(p.id), p._rgba));

    // which is what it paints in
    ctx.fillRect(0, 0, 8, 8);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 6);
    ctx.lineTo(8, 6);
    ctx.stroke();
    const { data } = await ctx.getImageData(0, 0, 8, 8);
    assert.deepEqual([...data.slice(0, 3)], [10, 200, 30]);
    const line = (6 * 8 + 4) * 4;
    const want = [0.5, 0.25, 0].map((v) => v * 255);
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(data[line + c] - want[c]) <= 1, `stroke: ${data.slice(line, line + 3)}`);
    }
    assert.deepEqual(errors, []);
    pixmap.destroy();
    other.destroy();
  } finally {
    await app.close();
  }
});

test('createSolidPicture hands out solids that animated colours never push out', async () => {
  const { server, app, errors } = await connect();
  try {
    app._styleSolidLimit = 4;
    const pixmap = app.createPixmap({ width: 8, height: 8, depth: 24 });
    const ctx = pixmap.getContext('2d');
    const handed = ctx.createSolidPicture(0.25, 0.5, 0.75, 1);
    // a style's solid, then asked for by a caller: the caller's from then
    // on, rather than made a second time
    ctx.fillStyle = 'rgb(10, 200, 30)';
    const style = ctx._backgroundPicture;
    const promoted = ctx.createSolidPicture(...cssColor('rgb(10, 200, 30)'));
    assert.equal(promoted, style);
    assert.ok(![...app._styleSolids.values()].includes(style), 'out of the LRU');

    for (let i = 0; i < 16 * app._styleSolidLimit; i++) {
      ctx.fillStyle = `rgb(${i}, 1, 2)`;
      ctx.fillRect(0, 0, 1, 1);
      // its colour set as a style again, by the string and by the numbers,
      // finds the held solid, which is not the LRU's to move up or let go
      ctx.fillStyle = i % 2 ? 'rgb(10, 200, 30)' : cssColor('rgb(10, 200, 30)');
      ctx.fillRect(1, 0, 1, 1);
      assert.equal(ctx._backgroundPicture, promoted);
    }
    await settle(app);
    for (const [name, picture, color] of [
      ['createSolidPicture', handed, [0.25, 0.5, 0.75, 1]],
      ['the promoted solid', promoted, cssColor('rgb(10, 200, 30)')]
    ]) {
      const r = server.resources.get(picture.id);
      assert.ok(r && isSolid(r) && paints(r, color), `${name}'s picture is alive, in its colour`);
      assert.ok(!picture._evicted, `${name}'s is not let go of`);
    }
    // and a style of that colour paints with the held one
    ctx.fillStyle = 'rgb(10, 200, 30)';
    assert.equal(ctx._backgroundPicture, promoted);
    assert.deepEqual(errors, []);
    pixmap.destroy();
  } finally {
    await app.close();
  }
});

test('on a server with no CreateSolidFill, a style solid let go of takes its pixmap with it', async () => {
  const { server, app, errors } = await connect();
  try {
    // RENDER before 0.10: a solid is a picture of a 1x1 pixmap it repeats
    app.display.Render.version = [0, 9];
    app._styleSolidLimit = 8;
    const n = 64;
    const pixmap = app.createPixmap({ width: n, height: 1, depth: 24 });
    const ctx = pixmap.getContext('2d');
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = `rgb(${i * 4}, 100, 200)`;
      ctx.fillRect(i, 0, 1, 1);
    }
    await settle(app);
    const isSolidPixmap = (r) =>
      r.type === 'pixmap' && r.raster.width === 1 && r.raster.height === 1;
    const solids = [...app._solidPictures.values(), ...app._styleSolids.values()];
    assert.equal(app._styleSolids.size, 8);
    assert.equal(count(server, isSolidPixmap), solids.filter((p) => p._sourcePixmap).length);

    const { data } = await ctx.getImageData(0, 0, n, 1);
    for (let i = 0; i < n; i++) {
      assert.deepEqual([...data.slice(i * 4, i * 4 + 3)], [i * 4, 100, 200], `pixel ${i}`);
    }
    assert.deepEqual(errors, []);
    pixmap.destroy();
  } finally {
    await app.close();
  }
});
