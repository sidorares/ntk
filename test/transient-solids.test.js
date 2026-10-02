// The solids a drawing makes for itself are freed as the drawing goes on.
//
// `globalAlpha` reaches a composite folded into a colour: a solid style
// scaled by it (fillText, a coverage drawImage, a shadow, a rounded box's
// corner glyphs), or the alpha alone in a mask slot (fillRect, drawImage).
// Each is a new premultiplied colour, so a new server-side solid, and an
// animated fade asks for a new alpha nearly every frame. They used to go in
// the cache `createSolidPicture` hands out from, which never evicts, so
// every fade left frames × colours of them on the server until app.close().
//
// They live in a small LRU now, and an evicted one is freed. What could go
// wrong is freeing one that something still means to use: its id goes back
// to the pool, the next solid made can take it, and a composite sent after
// that paints in another colour. X runs a client's requests in order, so
// that can only happen if a solid outlives the drawing call that made it.
// The fade below runs every such drawing through many more alphas than the
// LRU holds, and compares each frame with a run that frees nothing.
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
const CELL = 40;
const COLS = 20;
const W = COLS * CELL;
const H = Math.ceil(FRAMES / COLS) * CELL;
const BACKGROUND = 'rgb(240, 236, 228)';
const RED = 'rgb(200, 40, 40)';

/** frame i's alpha: no two the same, and none 0 or 1 */
const alphaOf = (i) => (i + 1) / (FRAMES + 1);

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

/** once it answers, the server has run every request sent before */
const roundTrip = (app) => new Promise((resolve) => app.X.GetInputFocus(() => resolve()));

/**
 * Every drawing that folds `globalAlpha` into a solid, redrawn frame after
 * frame at a new alpha, the way a fade redraws an element, and each frame
 * kept in a cell of a strip. `afterFrame(i)` runs after frame i, and may
 * return a promise to wait for. Resolves to the strip's pixels.
 */
async function animate(app, afterFrame) {
  const strip = app.createPixmap({ width: W, height: H, depth: 24 });
  const out = strip.getContext('2d');
  const frame = new Surface(app, { width: CELL, height: CELL });
  const ctx = frame.getContext('2d');
  // drawn once, at full opacity, and composited faded every frame
  const image = new Surface(app, { width: 12, height: 12 });
  image.render((s) => {
    s.fillStyle = 'rgb(30, 90, 200)';
    s.fillRect(0, 0, 12, 12);
    s.fillStyle = 'rgba(255, 200, 0, 0.5)';
    s.fillRect(3, 3, 6, 6);
  });
  const coverage = new Surface(app, { width: 12, height: 12, format: 'a8' });
  coverage.render((s) => {
    s.fillStyle = '#fff';
    s.beginPath();
    s.arc(6, 6, 5, 0, Math.PI * 2);
    s.fill();
  });
  const gradient = ctx.createLinearGradient(0, 0, CELL, 0);
  gradient.addColorStop(0, '#c03');
  gradient.addColorStop(1, '#30c');
  ctx.font = '14px Fixture';
  for (let i = 0; i < FRAMES; i++) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, CELL, CELL);
    ctx.globalAlpha = alphaOf(i);
    // the alpha alone, in the mask slot of a direct composite
    ctx.fillStyle = RED;
    ctx.fillRect(2, 2, 10, 10);
    ctx.drawImage(image, 14, 2);
    // folded into the colour a coverage surface paints in; a gradient has
    // none to fold into, and the alpha scales the scratch mask instead
    ctx.fillStyle = 'rgb(20, 140, 90)';
    ctx.drawImage(coverage, 26, 2);
    ctx.fillStyle = gradient;
    ctx.drawImage(coverage, 26, 16);
    // folded into a rounded box's colour, for its corner glyphs
    ctx.fillStyle = 'rgb(120, 60, 160)';
    ctx.beginPath();
    ctx.roundRect(2, 16, 20, 8, 3);
    ctx.fill();
    // into the text's colour, and into its shadow's
    ctx.shadowColor = 'rgba(0, 60, 200, 0.8)';
    ctx.shadowBlur = 2;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = 'rgb(30, 30, 30)';
    ctx.fillText('Hi', 4, 37);
    ctx.shadowColor = 'transparent';
    out.drawImage(frame, (i % COLS) * CELL, Math.floor(i / COLS) * CELL);
    await afterFrame?.(i);
  }
  const { data } = await out.getImageData(0, 0, W, H);
  ctx.destroy();
  for (const s of [frame, image, coverage]) s.destroy();
  strip.destroy();
  return data;
}

/** the fade on an app of its own, keeping `limit` solids when one is given */
async function fade(limit, afterFrame) {
  const { server, app, errors } = await connect();
  try {
    if (limit !== undefined) app._transientSolidLimit = limit;
    const pixels = await animate(app, afterFrame && ((i) => afterFrame(server, app, i)));
    await roundTrip(app);
    return {
      pixels,
      errors,
      limit: app._transientSolidLimit,
      live: count(server, isSolid),
      held: app._solidPictures.size,
      // fillStyle's, in an LRU of their own (test/style-solids.test.js)
      styles: app._styleSolids.size,
      kept: app._transientSolids.size
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

test('a fade keeps a bounded number of solids, and draws what keeping them all draws', async () => {
  // what every frame is checked against: nothing freed, so no id handed out
  // twice
  const all = await fade(Infinity);
  // a solid per drawing per frame — what each fade used to leave behind
  assert.ok(all.kept >= FRAMES * 5, `the fade made ${all.kept} solids`);
  assert.equal(all.live, all.held + all.styles + all.kept, 'and the server holds them all');
  // faded, each frame by its own alpha: the inside of the red square is the
  // background that much of the way to red
  const [bg, red] = [rgb(BACKGROUND), rgb(RED)];
  for (let i = 0; i < FRAMES; i++) {
    const at = pixelOf(i, 7, 7);
    for (let c = 0; c < 3; c++) {
      const want = bg[c] + alphaOf(i) * (red[c] - bg[c]);
      const have = all.pixels[at + c];
      assert.ok(Math.abs(have - want) <= 1, `frame ${i}: ${have}, not ${want}`);
    }
  }

  const bounded = await fade(undefined, async (server, app, i) => {
    if (i % 25 !== 24) return;
    await roundTrip(app);
    const live = count(server, isSolid);
    const styles = app._solidPictures.size + app._styleSolids.size;
    assert.ok(
      live <= styles + app._transientSolidLimit,
      `after frame ${i} the server holds ${live} solids`
    );
  });
  assert.ok(all.kept > 4 * bounded.limit, 'many times what the LRU holds');
  // full, and what it let go of freed on the server, not only forgotten
  assert.equal(bounded.kept, bounded.limit);
  assert.equal(bounded.live, bounded.held + bounded.styles + bounded.limit);
  const styles = bounded.held + bounded.styles;
  assert.ok(styles < 20, `the styles are a handful (${styles})`);
  assertSamePixels(bounded.pixels, all.pixels, 'bounded');

  // Room for two: a drawing call uses one at a time, so this frees each
  // solid a call or two after the one that made it — and a request sent
  // with one any later would draw in someone else's colour.
  const tight = await fade(2);
  assertSamePixels(tight.pixels, all.pixels, 'two kept');

  for (const run of [all, bounded, tight]) assert.deepEqual(run.errors, []);
});

test('a solid a caller holds is never evicted', async () => {
  const { server, app, errors } = await connect();
  try {
    const pixmap = app.createPixmap({ width: CELL, height: CELL, depth: 24 });
    const ctx = pixmap.getContext('2d');
    ctx.font = '14px Fixture';
    // handed out by createSolidPicture, and fillStyle's, which the solids a
    // fade makes for itself do not push out
    const handed = ctx.createSolidPicture(0.25, 0.5, 0.75, 1);
    ctx.fillStyle = 'rgb(10, 200, 30)';
    const style = ctx._backgroundPicture;
    // made by a fade for itself, then asked for by a caller: the caller's
    // from then on, rather than made a second time
    ctx.globalAlpha = 0.5;
    ctx.fillText('Hi', 4, 30);
    const folded = cssColor('rgb(10, 200, 30)').map((v) => v * 0.5);
    const made = [...app._transientSolids.values()].at(-1);
    assert.deepEqual(made._rgba, folded);
    const promoted = ctx.createSolidPicture(...folded);
    assert.equal(promoted, made);
    assert.ok(![...app._transientSolids.values()].includes(made), 'out of the LRU');

    // many more fades than the LRU holds, every one of them evicting
    for (let i = 0; i < 2 * app._transientSolidLimit; i++) {
      ctx.globalAlpha = alphaOf(i);
      ctx.fillText('Hi', 4, 30);
    }
    await roundTrip(app);
    for (const [name, picture, color] of [
      ['createSolidPicture', handed, [0.25, 0.5, 0.75, 1]],
      ['fillStyle', style, cssColor('rgb(10, 200, 30)')],
      ['the promoted solid', promoted, folded]
    ]) {
      const held = server.resources.get(picture.id);
      assert.ok(held && isSolid(held), `${name}'s picture is alive`);
      // and still its colour: a freed solid's id goes to the next one made.
      // The server keeps [a, r, g, b] on a 0..255 scale
      const [a, r, g, b] = held.color.map((v) => v / 255);
      for (const [have, want] of [[r, color[0]], [g, color[1]], [b, color[2]], [a, color[3]]]) {
        assert.ok(Math.abs(have - want) < 1e-4, `${name}: ${held.color}, not ${color}`);
      }
    }
    assert.deepEqual(errors, []);
    pixmap.destroy();
  } finally {
    await app.close();
  }
});

test('on a server with no CreateSolidFill, an evicted solid takes its pixmap with it', async () => {
  const { server, app, errors } = await connect();
  try {
    // RENDER before 0.10: a solid is a picture of a 1x1 pixmap it repeats
    app.display.Render.version = [0, 9];
    const limit = app._transientSolidLimit;
    const frames = 2 * limit;
    const alpha = (i) => (i + 1) / (frames + 1);
    // a frame a pixel, faded by its own alpha
    const pixmap = app.createPixmap({ width: frames, height: 1, depth: 24 });
    const ctx = pixmap.getContext('2d');
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, frames, 1);
    ctx.fillStyle = RED;
    for (let i = 0; i < frames; i++) {
      ctx.globalAlpha = alpha(i);
      ctx.fillRect(i, 0, 1, 1);
    }
    await roundTrip(app);
    const isSolidPixmap = (r) =>
      r.type === 'pixmap' && r.raster.width === 1 && r.raster.height === 1;
    const styles = [...app._solidPictures.values(), ...app._styleSolids.values()];
    const held = styles.filter((p) => p._sourcePixmap).length;
    assert.equal(app._transientSolids.size, limit);
    assert.equal(count(server, isSolidPixmap), held + limit);

    const { data } = await ctx.getImageData(0, 0, frames, 1);
    const [bg, red] = [rgb(BACKGROUND), rgb(RED)];
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < 3; c++) {
        const want = bg[c] + alpha(i) * (red[c] - bg[c]);
        const have = data[i * 4 + c];
        assert.ok(Math.abs(have - want) <= 1, `frame ${i}: ${have}, not ${want}`);
      }
    }
    assert.deepEqual(errors, []);
    pixmap.destroy();
  } finally {
    await app.close();
  }
});
