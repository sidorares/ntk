// Benchmark for the local rasterizer (issue #462): what PreciseRasterizer,
// which samples as the X server does so that a mask's route never shows,
// costs against the analytic ScanlineRasterizer it replaced as the default.
//
//   node scripts/bench-raster-route.mjs [frames] [--js]
//
// Four scenes that route most of their masks local under the default
// policy. Each frame draws the scene into a pixmap and waits one round trip;
// the two rasterizers run interleaved, A/B/A/B, three rounds each. Reported
// per frame: wall time, and the time spent inside rasterize() alone.
// `--js` runs against node-x11's in-process server instead of $DISPLAY,
// which is hermetic but measures client + JS-server cost in one process.
import { performance } from 'node:perf_hooks';

import { createClient, PreciseRasterizer, ScanlineRasterizer, StaticFontSource } from '../lib/index.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const FRAMES = Math.max(3, Number(args[0]) || 20);
const W = 1200;
const H = 800;

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

const SCENES = {
  'icon wall, 400 icons': (ctx) => {
    ctx.lineWidth = 2;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.strokeStyle = '#333';
    ctx.fillStyle = '#4a8';
    for (let i = 0; i < 400; i++) {
      const x = (i % 40) * 28 + 4.3;
      const y = Math.floor(i / 40) * 28 + 4.7;
      ctx.beginPath();
      ctx.roundRect(x, y, 20, 20, 5);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x + 10, y + 10, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + 6, y + 10);
      ctx.lineTo(x + 9, y + 13);
      ctx.lineTo(x + 14, y + 7);
      ctx.stroke();
    }
  },
  'graph edges, 120 curves': (ctx) => {
    ctx.lineWidth = 2.55;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.strokeStyle = '#7f8c8d';
    for (let i = 0; i < 120; i++) {
      const x = (i % 12) * 95 + 10.5;
      const y = Math.floor(i / 12) * 75 + 20.25;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.bezierCurveTo(x + 40, y - 15, x + 50, y + 60, x + 85, y + 45);
      ctx.stroke();
    }
  },
  'chart line, 600 points': (ctx) => {
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#06c';
    ctx.beginPath();
    for (let i = 0; i < 600; i++) ctx.lineTo(10 + i * 1.9, 400 + Math.sin(i / 7) * 160 + Math.sin(i * 1.7) * 20);
    ctx.stroke();
  },
  'discs and cards, 100 × 48 px': (ctx) => {
    ctx.fillStyle = '#c63';
    for (let i = 0; i < 100; i++) {
      const x = (i % 20) * 58 + 3.5;
      const y = Math.floor(i / 20) * 58 + 3.5;
      ctx.beginPath();
      if (i % 2) ctx.arc(x + 24, y + 24, 24, 0, Math.PI * 2);
      else ctx.roundRect(x, y, 48, 48, 9);
      ctx.fill();
    }
  }
};

const { app, target } = await connect();
const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
const ctx = pixmap.getContext('2d');
const fence = () => ctx.getImageData(0, 0, 1, 1);

let spent = 0;
const timed = (inner) => ({
  rasterize(job) {
    const t = performance.now();
    const out = inner.rasterize(job);
    spent += performance.now() - t;
    return out;
  }
});
const RASTERIZERS = {
  analytic: timed(new ScanlineRasterizer()),
  precise: timed(new PreciseRasterizer())
};

async function run(draw, rasterizer) {
  app.rasterizer = rasterizer;
  spent = 0;
  const t = performance.now();
  for (let f = 0; f < FRAMES; f++) {
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    draw(ctx);
    ctx.restore();
    await fence();
  }
  return { wall: (performance.now() - t) / FRAMES, raster: spent / FRAMES };
}

console.log(`${target}, ${W}×${H}, ${FRAMES} frames a run, 3 runs each, interleaved\n`);
console.log('scene                          rasterizer   frame (ms)          rasterize() (ms)');
for (const [name, draw] of Object.entries(SCENES)) {
  for (const r of Object.values(RASTERIZERS)) await run(draw, r); // warm up
  const runs = { analytic: [], precise: [] };
  for (let k = 0; k < 3; k++) {
    for (const [label, r] of Object.entries(RASTERIZERS)) runs[label].push(await run(draw, r));
  }
  for (const [label, rs] of Object.entries(runs)) {
    const wall = rs.map((r) => r.wall.toFixed(1)).join(', ');
    const raster = rs.map((r) => r.raster.toFixed(2)).join(', ');
    console.log(`${(label === 'analytic' ? name : '').padEnd(30)} ${label.padEnd(12)} ${wall.padEnd(19)} ${raster}`);
  }
}
pixmap.destroy();
await app.close();
