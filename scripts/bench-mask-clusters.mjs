// Benchmark for mask clustering (issue #264): what a path holding N disjoint
// subpaths costs in a8 mask, with the clustering on and forced off.
//
//   node scripts/bench-mask-clusters.mjs [frames] [--js] [--png <file>]
//
// Two scenes, both at 1100x700 and both the shape of a node-graph frame:
//
//   spanning  735 long edges batched into one path per pen. Each edge
//             already spans most of the surface, so their union bbox is no
//             bigger than any one of them needs — batching is the win it
//             looks like, and there is nothing here to cluster.
//   scattered 19 edges plus 40 small handle discs, batched the same way.
//             The discs cover ~1% of the union bbox, so one mask over it is
//             most of a megabyte of coverage for a few hundred inked pixels.
//
// Reported per frame: mask passes, total mask area (the a8 bytes the server
// clears, scales and composites), requests, and wall time. `--js` runs
// against node-x11's in-process server instead of $DISPLAY, which is
// hermetic but measures client + JS-server cost in one process.
import { performance } from 'node:perf_hooks';

import { createClient, StaticFontSource } from '../lib/index.js';
import { clusterBoxes } from '../lib/maskcluster.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const FRAMES = Math.max(3, Number(args[0]) || 20);
const W = 1100;
const H = 700;

async function connect() {
  if (flags.has('--js') || !process.env.DISPLAY) {
    const { default: xserver } = await import('x11/lib/xserver/index.js');
    const server = xserver.createServer({ width: 1600, height: 1000 });
    const [serverEnd, clientEnd] = xserver.createStreamPair();
    server.addClientStream(serverEnd);
    const app = await createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
    return { app, target: 'in-process JS X server' };
  }
  const app = await createClient();
  return { app, target: `X server on ${process.env.DISPLAY}` };
}

// one deterministic scene, so every run compares the same geometry
function scene(edgeCount, discCount) {
  let seed = 20240264;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const edges = [];
  for (let i = 0; i < edgeCount; ++i) {
    edges.push([rand() * W, rand() * H, rand() * W, rand() * H]);
  }
  const discs = [];
  for (let i = 0; i < discCount; ++i) discs.push([rand() * W, rand() * H]);
  return { edges, discs };
}

const SCENES = {
  spanning: scene(735, 0),
  scattered: scene(19, 40)
};

/** the whole scene as one path per pen — what a batching renderer emits */
function drawBatched(ctx, { edges, discs }) {
  if (edges.length) {
    ctx.strokeStyle = 'rgba(20, 30, 40, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round'; // as a graph edge is drawn — and the mask route
    ctx.beginPath();
    for (const [x0, y0, x1, y1] of edges) {
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
    ctx.stroke();
  }
  if (discs.length) {
    ctx.fillStyle = 'rgba(40, 90, 200, 0.8)';
    ctx.beginPath();
    for (const [x, y] of discs) {
      ctx.moveTo(x + 5, y);
      ctx.arc(x, y, 5, 0, Math.PI * 2);
    }
    ctx.fill();
  }
}

/** and one draw per piece — what a caller does to dodge the cliff by hand */
function drawSingly(ctx, { edges, discs }) {
  ctx.strokeStyle = 'rgba(20, 30, 40, 0.55)';
  ctx.lineWidth = 1.5;
  for (const [x0, y0, x1, y1] of edges) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(40, 90, 200, 0.8)';
  for (const [x, y] of discs) {
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

async function run(app, ctx, draw, scene) {
  ctx.maskStats = { masks: 0, pixels: 0, split: 0 };
  const before = app.X.seq_num;
  const start = performance.now();
  for (let f = 0; f < FRAMES; ++f) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    draw(ctx, scene);
    await app.X.sync(); // one round trip per frame, as a real frame ends
  }
  const ms = (performance.now() - start) / FRAMES;
  const stats = ctx.maskStats;
  return {
    ms,
    masks: stats.masks / FRAMES,
    pixels: stats.pixels / FRAMES,
    requests: (app.X.seq_num - before) / FRAMES
  };
}

const mb = (n) => `${(n / (1 << 20)).toFixed(2)} MB`;

function line(label, r) {
  console.log(
    `  ${label.padEnd(26)} ${r.masks.toFixed(0).padStart(5)} masks  ` +
      `${mb(r.pixels).padStart(9)}  ${r.requests.toFixed(0).padStart(5)} req  ` +
      `${r.ms.toFixed(2).padStart(7)} ms/frame`
  );
}

/**
 * `--png <file>`: the scattered scene with the mask boxes drawn over it —
 * the union box on the left, the clusters on the right. The boxes come from
 * `clusterBoxes` over the same piece boxes the context builds (a piece box
 * is the ink bbox with a pixel of antialiasing slack), so the picture is the
 * partition, not an illustration of one.
 */
async function figure(app, file) {
  const { edges, discs } = SCENES.scattered;
  const pad = 12;
  const width = 2 * W + 3 * pad;
  const height = H + 2 * pad;
  const pixmap = app.createPixmap({ width, height, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // the piece boxes the context builds: the ink bbox of each piece with a
  // pixel of antialiasing slack
  const box = (x0, y0, x1, y1) => ({
    x: Math.floor(x0) - 1,
    y: Math.floor(y0) - 1,
    w: Math.ceil(x1) + 2 - Math.floor(x0),
    h: Math.ceil(y1) + 2 - Math.floor(y0)
  });
  // clustered per drawing, as the context does it: the edges are one
  // stroked path and the discs one filled path
  const edgePieces = edges.map(([x0, y0, x1, y1]) =>
    box(Math.min(x0, x1) - 1, Math.min(y0, y1) - 1, Math.max(x0, x1) + 1, Math.max(y0, y1) + 1)
  );
  const discPieces = discs.map(([x, y]) => box(x - 5, y - 5, x + 5, y + 5));
  const both = (policy) => [
    ...clusterBoxes(edgePieces, policy),
    ...clusterBoxes(discPieces, policy)
  ];
  const panels = [
    ['one box per drawing', both({ maxMasks: 1 })],
    ['clustered', both()]
  ];
  panels.forEach(([label, boxes], i) => {
    ctx.save();
    ctx.translate(pad + i * (W + pad), pad);
    ctx.fillStyle = '#f7f8fa';
    ctx.fillRect(0, 0, W, H);
    drawBatched(ctx, SCENES.scattered);
    ctx.strokeStyle = 'rgba(220, 40, 40, 0.9)';
    ctx.lineWidth = 1;
    ctx.lineCap = 'butt';
    for (const b of boxes) ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
    try {
      ctx.font = '18px sans-serif';
      ctx.fillStyle = '#b02020';
      const px = boxes.reduce((n, b) => n + b.w * b.h, 0);
      ctx.fillText(`${boxes.length} masks, ${mb(px)} — ${label}`, 14, H - 16);
    } catch {
      // no fonts on this connection (the JS server has none) — the boxes are
      // the point, the caption is not
    }
    ctx.restore();
  });

  const [{ PNG }, { writeFileSync }] = await Promise.all([
    import('pngjs'),
    import('node:fs')
  ]);
  const img = await ctx.getImageData(0, 0, width, height);
  const png = new PNG({ width, height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  writeFileSync(file, PNG.sync.write(png));
  console.log(`wrote ${file}`);
}

const { app, target } = await connect();
const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
const ctx = pixmap.getContext('2d');

console.log(`mask clustering, ${W}x${H}, ${FRAMES} frames against ${target}\n`);
for (const [name, s] of Object.entries(SCENES)) {
  console.log(`${name}: ${s.edges.length} edges, ${s.discs.length} discs`);
  app.maskPolicy = { maxMasks: 1 }; // the one-mask-per-path behaviour
  line('batched, one mask', await run(app, ctx, drawBatched, s));
  app.maskPolicy = null;
  line('batched, clustered', await run(app, ctx, drawBatched, s));
  line('drawn singly', await run(app, ctx, drawSingly, s));
  console.log('');
}

const pngArg = process.argv.indexOf('--png');
if (pngArg >= 0) await figure(app, process.argv[pngArg + 1] || 'mask-clusters.png');

await app.close();
