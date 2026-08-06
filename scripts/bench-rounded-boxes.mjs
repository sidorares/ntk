// Benchmark for the rounded-rect fast path (issue #211): draws a wall of
// rounded boxes into a pixmap, one X round trip per frame, and reports
// wall time, client emit time, requests and bytes per frame — with the
// glyph fast path on (new) and forced off (old, the polygon route).
//
//   node scripts/bench-rounded-boxes.mjs [boxes] [frames] [--js]
//
// Runs against $DISPLAY by default (the real measurement: the polygon
// route's cost is mostly server-side); --js uses node-x11's in-process JS X
// server instead, which is hermetic but measures client + JS-server cost in
// one process. Also prints the corner-rasterization microbenchmark behind
// the "mirror one master bitmap" choice.
import { performance } from 'node:perf_hooks';

import { createClient, StaticFontSource } from '../lib/index.js';
import { orientCorner, rasterizeCornerMaster } from '../lib/shapeglyphs.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const BOXES = Math.max(1, Number(args[0]) || 300);
const FRAMES = Math.max(5, Number(args[1]) || 40);
const SURFACE = { width: 1200, height: 800 };

const RADII = [4, 6, 8, 10, 12, 16];
const BORDERS = [0, 1, 2, 3];

async function connect() {
  if (flags.has('--js') || !process.env.DISPLAY) {
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

// the same deterministic wall the rounded-boxes example draws
function makeBoxes() {
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const boxes = [];
  const cols = Math.ceil(Math.sqrt((BOXES * SURFACE.width) / SURFACE.height));
  const rows = Math.ceil(BOXES / cols);
  const cellW = Math.floor(SURFACE.width / cols);
  const cellH = Math.floor(SURFACE.height / rows);
  for (let i = 0; i < BOXES; i++) {
    const margin = 6;
    const maxW = Math.max(10, cellW - 2 * margin);
    const maxH = Math.max(10, cellH - 2 * margin);
    const w = Math.max(10, Math.floor(maxW * (0.6 + 0.4 * rand())));
    const h = Math.max(10, Math.floor(maxH * (0.6 + 0.4 * rand())));
    const r = Math.max(1, Math.min(RADII[i % RADII.length], (Math.min(w, h) >> 1) - 6));
    const bw = Math.min(BORDERS[((i / RADII.length) | 0) % BORDERS.length], 2 * r);
    boxes.push({ x: (i % cols) * cellW + margin, y: ((i / cols) | 0) * cellH + margin, w, h, r, bw });
  }
  return boxes;
}

const FILLS = ['#4c6ef5', '#37b24d', '#f59f00', '#e64980', '#845ef7', '#15aabf'];
const STROKES = ['#1b1f3b', '#2b8a3e', '#e8590c', '#a61e4d', '#5f3dc4', '#0b7285'];

function drawWall(ctx, boxes) {
  ctx.fillStyle = '#e9ecef';
  ctx.fillRect(0, 0, SURFACE.width, SURFACE.height);
  let i = 0;
  for (const b of boxes) {
    ctx.fillStyle = FILLS[i % FILLS.length];
    ctx.beginPath();
    ctx.roundRect(b.x, b.y, b.w, b.h, b.r);
    ctx.fill();
    if (b.bw > 0) {
      ctx.strokeStyle = STROKES[i % STROKES.length];
      ctx.lineWidth = b.bw;
      const inset = b.bw / 2;
      ctx.beginPath();
      ctx.roundRect(b.x + inset, b.y + inset, b.w - b.bw, b.h - b.bw, b.r);
      ctx.stroke();
    }
    i++;
  }
}

const median = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
const p90 = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length * 0.9)];

async function run(app, boxes, mode) {
  app.shapePolicy = mode === 'new' ? null : { maxRadius: 0 };
  const pixmap = app.createPixmap({ ...SURFACE, depth: 24 });
  const ctx = pixmap.getContext('2d');

  // warm up: glyph uploads, solid pictures, GCs, server caches
  for (let i = 0; i < 3; i++) {
    drawWall(ctx, boxes);
    await app.X.sync();
  }

  const wall = [];
  const emit = [];
  let requests = 0;
  let bytes = 0;
  const seq0 = app.X.seq_num;
  const bytes0 = app.X.pack_stream.stats.bytes;
  for (let i = 0; i < FRAMES; i++) {
    const t0 = performance.now();
    drawWall(ctx, boxes);
    const t1 = performance.now();
    await app.X.sync();
    const t2 = performance.now();
    emit.push(t1 - t0);
    wall.push(t2 - t0);
  }
  requests = (app.X.seq_num - seq0) / FRAMES;
  bytes = (app.X.pack_stream.stats.bytes - bytes0) / FRAMES;

  const stats = ctx.shapeStats;
  ctx.destroy();
  pixmap.destroy();
  app.shapePolicy = null;
  return {
    mode,
    wallMedian: median(wall),
    wallP90: p90(wall),
    emitMedian: median(emit),
    requests,
    kb: bytes / 1024,
    hits: stats.hits,
    misses: Object.values(stats.misses).reduce((a, b) => a + b, 0)
  };
}

function mirrorMicrobench() {
  // the raster-time half of "reuse mirrored glyphs": one master + 3 byte
  // flips, against rasterizing all four corners independently
  const radii = [4, 6, 8, 10, 12, 16, 24, 32];
  const N = 200;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    for (const r of radii) {
      const m = rasterizeCornerMaster('fill', r, r, 0);
      for (const c of [0, 1, 2, 3]) orientCorner(m, c);
    }
  }
  const mirrored = performance.now() - t0;
  const t1 = performance.now();
  for (let i = 0; i < N; i++) {
    for (const r of radii) {
      for (let c = 0; c < 4; c++) {
        const m = rasterizeCornerMaster('fill', r, r, 0);
        orientCorner(m, 0);
      }
    }
  }
  const direct = performance.now() - t1;
  const sets = N * radii.length;
  return { mirrored: mirrored / sets, direct: direct / sets };
}

const { app, target } = await connect();
const boxes = makeBoxes();
const strokes = boxes.filter((b) => b.bw > 0).length;
console.log(`target: ${target}`);
console.log(`scene: ${BOXES} filled boxes, ${strokes} of them bordered, ${FRAMES} frames\n`);

const results = [];
for (const mode of ['old', 'new']) {
  results.push(await run(app, boxes, mode));
}

const fmt = (r) =>
  `${r.mode === 'new' ? 'new (corner glyphs)' : 'old (polygon route)'}` +
  `  wall ${r.wallMedian.toFixed(2)} ms/frame (p90 ${r.wallP90.toFixed(2)})` +
  `  emit ${r.emitMedian.toFixed(2)} ms` +
  `  ${r.requests.toFixed(0)} requests` +
  `  ${r.kb.toFixed(0)} KB/frame`;
for (const r of results) console.log(fmt(r));
const [old, fresh] = results;
console.log(
  `\nspeedup: ${(old.wallMedian / fresh.wallMedian).toFixed(1)}x wall, ` +
    `${(old.requests / fresh.requests).toFixed(1)}x fewer requests, ` +
    `${(old.kb / fresh.kb).toFixed(0)}x fewer bytes`
);

const micro = mirrorMicrobench();
console.log(
  `\ncorner rasterization (8 radii per set): mirrored master ` +
    `${micro.mirrored.toFixed(3)} ms/set vs 4x direct ${micro.direct.toFixed(3)} ms/set ` +
    `(${(micro.direct / micro.mirrored).toFixed(1)}x)`
);

await app.close();
