// Where the local route stops paying: the measurement behind
// DEFAULT_RASTER_POLICY (lib/rasterize.js). Each shape is drawn at growing
// sizes, so its area grows while its edge count stays roughly put, with
// every mask forced local and then forced to the server, interleaved. The
// crossover in area per edge is what `bytesPerEdge` should sit at.
//
//   node scripts/bench-raster-policy.mjs [frames] [--js] [--analytic]
//
// Per row: the drawing's box area over its edge count, as routeRaster sees
// them; the time per drawing on each route, median of three runs; which
// route was faster; and which one the current policy picks. `--js` runs
// against node-x11's in-process server instead of $DISPLAY, which measures
// client + JS-server cost in one process and says little about a real one.
// `--analytic` rasterizes locally with ScanlineRasterizer, the default
// before PreciseRasterizer, for comparison.
import { performance } from 'node:perf_hooks';

import { createClient, DEFAULT_RASTER_POLICY, ScanlineRasterizer, StaticFontSource } from '../lib/index.js';
import { routeRaster } from '../lib/rasterize.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const FRAMES = Math.max(3, Number(args[0]) || 12);
const W = 1200;
const H = 800;
const COPIES = 40;
const SIZES = [16, 24, 32, 48, 64, 96, 128, 192, 256];

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

// each draws one copy of size `s` with its box's corner at (x, y)
const SHAPES = {
  'ellipse, filled': (ctx, x, y, s) => {
    ctx.beginPath();
    ctx.ellipse(x + s / 2, y + s / 2, s / 2, s / 3, 0.3, 0, Math.PI * 2);
    ctx.fill();
  },
  'rounded card, filled': (ctx, x, y, s) => {
    ctx.beginPath();
    ctx.roundRect(x, y, s, s * 0.7, s / 6);
    ctx.fill();
  },
  'icon, stroked': (ctx, x, y, s) => {
    ctx.lineWidth = Math.max(1, s / 12);
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.arc(x + s / 2, y + s / 2, s * 0.4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + s * 0.3, y + s * 0.5);
    ctx.lineTo(x + s * 0.45, y + s * 0.65);
    ctx.lineTo(x + s * 0.7, y + s * 0.35);
    ctx.stroke();
  },
  'curve, stroked': (ctx, x, y, s) => {
    ctx.lineWidth = 2;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y + s);
    ctx.bezierCurveTo(x + s * 0.3, y - s * 0.2, x + s * 0.7, y + s * 1.2, x + s, y);
    ctx.stroke();
  }
};

const { app, target } = await connect();
const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
const ctx = pixmap.getContext('2d');
const rasterizer = flags.has('--analytic') ? new ScanlineRasterizer() : app.rasterizer;

function frame(draw, s) {
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = ctx.strokeStyle = '#246';
  for (let i = 0; i < COPIES; i++) {
    ctx.save();
    draw(ctx, ((i * 137.3) % (W - s - 2)) + 1.3, ((i * 71.7) % (H - s - 2)) + 1.6, s);
    ctx.restore();
  }
}

/** the masks one copy makes, as routeRaster sees them: [{ w, h, edges }] */
function masksOf(draw, s) {
  const masks = [];
  app.options.rasterPolicy = { maxArea: Infinity, maxBytes: Infinity };
  app.rasterizer = {
    rasterize(job) {
      const edges = job.triangles
        ? job.triangles.length / 2
        : job.polys.reduce((n, p) => n + p.length / 2, 0);
      masks.push({ w: job.width, h: job.height, edges });
      return null;
    }
  };
  ctx.save();
  draw(ctx, 10.3, 10.6, s);
  ctx.restore();
  app.options.rasterPolicy = undefined;
  app.rasterizer = rasterizer;
  return masks;
}

async function timed(route, draw, s) {
  app.options.rasterPolicy =
    route === 'local' ? { maxArea: Infinity, bytesPerEdge: Infinity, maxBytes: 1 << 24 } : undefined;
  app.rasterizer = route === 'local' ? rasterizer : null;
  frame(draw, s);
  await ctx.getImageData(0, 0, 1, 1);
  const t = performance.now();
  for (let f = 0; f < FRAMES; f++) {
    frame(draw, s);
    await ctx.getImageData(0, 0, 1, 1);
  }
  return ((performance.now() - t) / FRAMES / COPIES) * 1000;
}

const median = (xs) => xs.sort((a, b) => a - b)[xs.length >> 1];

console.log(`${target}, ${rasterizer.constructor.name} locally, ${COPIES} copies a frame, ${FRAMES} frames a run, 3 runs each, interleaved\n`);
console.log('shape                    size  area/edge   local µs  server µs  faster  policy picks');
for (const [name, draw] of Object.entries(SHAPES)) {
  for (const s of SIZES) {
    const masks = masksOf(draw, s);
    const area = masks.reduce((n, m) => n + m.w * m.h, 0);
    const edges = masks.reduce((n, m) => n + m.edges, 0);
    const picks = [...new Set(masks.map((m) => routeRaster(m.w, m.h, m.edges, DEFAULT_RASTER_POLICY)))].join('+');
    const runs = { local: [], server: [] };
    for (let k = 0; k < 3; k++) {
      runs.local.push(await timed('local', draw, s));
      runs.server.push(await timed('server', draw, s));
    }
    const local = median(runs.local);
    const server = median(runs.server);
    console.log(
      `${(s === SIZES[0] ? name : '').padEnd(24)} ${String(s).padStart(4)} ${(area / edges).toFixed(0).padStart(10)} ${local.toFixed(1).padStart(10)} ${server.toFixed(1).padStart(10)}  ${(local < server ? 'local' : 'server').padEnd(7)} ${picks}`
    );
  }
}
app.options.rasterPolicy = undefined;
app.rasterizer = rasterizer;
pixmap.destroy();
await app.close();
