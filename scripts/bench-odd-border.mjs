// Benchmark for one scenario only (issue #217): a wall of rounded cards with
// a *border*, drawn the way a UI draws one — the background filled on
// `roundRect(x, y, w, h, R)`, the border stroked on the path inset by half
// its width, `roundRect(x + bw/2, y + bw/2, w - bw, h - bw, R - bw/2)`, so
// the band's ink lands on integers and the border nests inside the
// background's corner. Everything is recoloured every frame, so the frame is
// box chrome and nothing else.
//
// The inset path radius is `R - bw/2` — half-integer whenever the border
// width is odd. The sweep is over the border width alone, with the geometry,
// the corner radius and the frame count fixed, so the only thing that moves
// between rows is the parity of `bw`.
//
//   node scripts/bench-odd-border.mjs [cards] [frames] [--js] [--radius=N]
//
// Runs against $DISPLAY by default (the real measurement: the polygon route's
// cost is mostly server-side); --js uses node-x11's in-process JS X server,
// which is hermetic but measures client + JS-server cost in one process.
import { performance } from 'node:perf_hooks';

import { createClient, StaticFontSource } from '../lib/index.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const has = (f) => flags.includes(f);
const opt = (name, dflt) => {
  const hit = flags.find((f) => f.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : dflt;
};

const CARDS = Math.max(1, Number(args[0]) || 24);
const FRAMES = Math.max(5, Number(args[1]) || 20);
const RADIUS = opt('radius', 10);
const WIDTHS = [1, 2, 3, 4];
const SURFACE = { width: 1200, height: 800 };

async function connect() {
  if (has('--js') || !process.env.DISPLAY) {
    const { default: xserver } = await import('x11/lib/xserver/index.js');
    const server = xserver.createServer({ width: 1600, height: 1200 });
    const [serverEnd, clientEnd] = xserver.createStreamPair();
    server.addClientStream(serverEnd);
    const app = await createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
    return { app, target: 'in-process JS X server' };
  }
  const app = await createClient();
  return { app, target: `X server on ${process.env.DISPLAY}` };
}

/** a grid of cards, geometry fixed across the whole sweep */
function makeCards() {
  const cols = Math.ceil(Math.sqrt((CARDS * SURFACE.width) / SURFACE.height));
  const rows = Math.ceil(CARDS / cols);
  const cellW = Math.floor(SURFACE.width / cols);
  const cellH = Math.floor(SURFACE.height / rows);
  const margin = 8;
  const cards = [];
  for (let i = 0; i < CARDS; i++) {
    cards.push({
      x: (i % cols) * cellW + margin,
      y: ((i / cols) | 0) * cellH + margin,
      w: Math.max(4 * RADIUS, cellW - 2 * margin),
      h: Math.max(4 * RADIUS, cellH - 2 * margin)
    });
  }
  return cards;
}

const hueOf = (frame, i) => (frame * 7 + i * 13) % 360;
const fillOf = (hue) => `hsl(${hue}, 60%, 88%)`;
const strokeOf = (hue) => `hsl(${hue}, 55%, 42%)`;

/**
 * Every colour the sweep will use, drawn once into a 1x1 corner. The app's
 * solid pictures are shared per connection, so without this the first width
 * measured pays every CreateSolidFill and the rest inherit them. Synced in
 * batches — the in-process JS server reads its socket recursively and a burst
 * this size overflows its stack.
 */
async function warmColors(app, ctx) {
  let n = 0;
  for (let frame = 0; frame < FRAMES; frame++) {
    for (let i = 0; i < CARDS; i++) {
      const hue = hueOf(frame, i);
      ctx.fillStyle = fillOf(hue);
      ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = strokeOf(hue);
      ctx.fillRect(0, 0, 1, 1);
      if (++n % 64 === 0) await app.X.sync();
    }
  }
  await app.X.sync();
}

/** one frame: every card refilled and re-bordered in a fresh colour */
function drawFrame(ctx, cards, bw, frame) {
  ctx.fillStyle = '#f1f3f5';
  ctx.fillRect(0, 0, SURFACE.width, SURFACE.height);
  const inset = bw / 2;
  const r = RADIUS - inset; // the border's path radius: half-integer for odd bw
  let i = 0;
  for (const c of cards) {
    const hue = hueOf(frame, i);
    ctx.fillStyle = fillOf(hue);
    ctx.beginPath();
    ctx.roundRect(c.x, c.y, c.w, c.h, RADIUS);
    ctx.fill();
    ctx.strokeStyle = strokeOf(hue);
    ctx.lineWidth = bw;
    ctx.beginPath();
    ctx.roundRect(c.x + inset, c.y + inset, c.w - bw, c.h - bw, r);
    ctx.stroke();
    i++;
  }
}

const median = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
const worst = (xs) => xs.reduce((a, b) => (b > a ? b : a), 0);

async function run(app, cards, bw) {
  const pixmap = app.createPixmap({ ...SURFACE, depth: 24 });
  const ctx = pixmap.getContext('2d');

  // warm up: solid pictures for every colour, then glyph uploads, GCs and
  // whatever the server caches on first use
  await warmColors(app, ctx);
  for (let i = 0; i < 3; i++) {
    drawFrame(ctx, cards, bw, i);
    await app.X.sync();
  }
  ctx.shapeStats.hits = 0;
  for (const k of Object.keys(ctx.shapeStats.misses)) delete ctx.shapeStats.misses[k];

  const paint = [];
  const wall = [];
  const seq0 = app.X.seq_num;
  const bytes0 = app.X.pack_stream.stats.bytes;
  for (let i = 0; i < FRAMES; i++) {
    const t0 = performance.now();
    drawFrame(ctx, cards, bw, i);
    const t1 = performance.now();
    await app.X.sync();
    const t2 = performance.now();
    paint.push(t1 - t0);
    wall.push(t2 - t0);
  }
  const requests = (app.X.seq_num - seq0) / FRAMES;
  const kb = (app.X.pack_stream.stats.bytes - bytes0) / FRAMES / 1024;

  const stats = ctx.shapeStats;
  const misses = Object.entries(stats.misses);
  const fallbacks = misses.reduce((a, [, n]) => a + n, 0);
  const out = {
    bw,
    r: RADIUS - bw / 2,
    paint: median(paint),
    wall: median(wall),
    wallMax: worst(wall),
    requests,
    kb,
    fast: stats.hits / FRAMES,
    fallbacks: fallbacks / FRAMES,
    why: misses.map(([k, n]) => `${k} x${(n / FRAMES).toFixed(0)}`).join(', ')
  };
  ctx.destroy();
  pixmap.destroy();
  return out;
}

const { app, target } = await connect();
const cards = makeCards();
console.log(`target: ${target}`);
console.log(
  `scene: ${CARDS} cards, radius ${RADIUS}, fill + inset border, ` +
    `all recoloured every frame, ${FRAMES} frames per width\n`
);

// prime the JIT on every width before measuring any of them, so the row
// that happens to run first is not also the one that compiles the code
{
  const pixmap = app.createPixmap({ ...SURFACE, depth: 24 });
  const ctx = pixmap.getContext('2d');
  await warmColors(app, ctx);
  for (const bw of WIDTHS) {
    for (let i = 0; i < 2; i++) drawFrame(ctx, cards, bw, i);
    await app.X.sync();
  }
  ctx.destroy();
  pixmap.destroy();
}

const rows = [];
for (const bw of WIDTHS) rows.push(await run(app, cards, bw));

const head =
  ' border  path r   paint    frame   worst   requests   wire/frame   boxes fast/fallback';
console.log(head);
console.log('-'.repeat(head.length));
for (const r of rows) {
  console.log(
    `  ${String(r.bw).padStart(2)}px` +
      `  ${String(r.r).padStart(7)}` +
      `  ${r.paint.toFixed(2).padStart(7)}` +
      `  ${r.wall.toFixed(2).padStart(7)}` +
      `  ${r.wallMax.toFixed(1).padStart(6)}` +
      `  ${r.requests.toFixed(0).padStart(9)}` +
      `  ${r.kb.toFixed(1).padStart(9)} KB` +
      `   ${r.fast.toFixed(0)} / ${r.fallbacks.toFixed(0)}` +
      (r.why ? `  (${r.why})` : '')
  );
}
console.log('\n(paint / frame / worst are ms; frame includes the round trip)');

const odd = rows.filter((r) => r.bw % 2 === 1);
const even = rows.filter((r) => r.bw % 2 === 0);
const avg = (xs, k) => xs.reduce((a, r) => a + r[k], 0) / xs.length;
const ratio = (k) => avg(odd, k) / avg(even, k);
console.log(
  `\nodd vs even border widths: ${ratio('paint').toFixed(1)}x the paint, ` +
    `${ratio('requests').toFixed(1)}x the requests, ${ratio('kb').toFixed(1)}x the wire, ` +
    `${ratio('wall').toFixed(1)}x the frame`
);
const stuck = rows.filter((r) => r.fallbacks > 0);
console.log(
  stuck.length
    ? `still on the polygon route: ${stuck.map((r) => `${r.bw}px`).join(', ')}`
    : 'every width is on the glyph route'
);

await app.close();
