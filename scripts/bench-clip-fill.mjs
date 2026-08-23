// Benchmark for the rectangular-clip composite path (issue #307): the damage
// repaint a retained renderer does every frame —
//
//   ctx.save(); ctx.clip(damage); ctx.fillRect(background); …; ctx.restore()
//
// — where the background fill used to build a *window-sized* a8 mask, clear
// it, stamp the damage rectangle into it, composite through it and free it
// again, for a mask that is 255 over every pixel the composite touches.
//
//   node scripts/bench-clip-fill.mjs [damage] [frames] [--js]
//
// `damage` is the side of the square damage rect (default 18, the size of a
// checkbox hover). Runs against $DISPLAY by default — most of what the mask
// costs is server-side pixel work — and `--js` uses node-x11's in-process JS
// X server, which is hermetic but measures client and server in one process.
//
// "old" is the same drawing with the fast path switched off, so both columns
// run the same scene through the same client.
import { performance } from "node:perf_hooks";

import { createClient, StaticFontSource } from "../lib/index.js";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const DAMAGE = Math.max(1, Number(args[0]) || 18);
const FRAMES = Math.max(5, Number(args[1]) || 200);
const SURFACE = { width: 420, height: 380 };

async function connect() {
  if (flags.has("--js") || !process.env.DISPLAY) {
    const { default: xserver } = await import("x11/lib/xserver/index.js");
    const server = xserver.createServer({ width: 800, height: 600 });
    const [serverEnd, clientEnd] = xserver.createStreamPair();
    server.addClientStream(serverEnd);
    const app = await createClient({
      stream: clientEnd,
      fontSource: new StaticFontSource(),
    });
    return { app, target: "in-process JS X server" };
  }
  const app = await createClient();
  return { app, target: `X server on ${process.env.DISPLAY}` };
}

// one frame of a hover repaint: clip to the damage, repaint the background
// under it, then the widget that changed colour
function drawFrame(ctx, x, y, hot) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, DAMAGE, DAMAGE);
  ctx.clip();

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, SURFACE.width, SURFACE.height);

  ctx.fillStyle = hot ? "#4c6ef5" : "#adb5bd";
  ctx.fillRect(x, y, DAMAGE, DAMAGE);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x + 3, y + 3, DAMAGE - 6, DAMAGE - 6);

  ctx.restore();
}

const median = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];

async function run(app, mode) {
  const pixmap = app.createPixmap({ ...SURFACE, depth: 24 });
  const ctx = pixmap.getContext("2d");
  // "old": refuse the box route, so every clipped fill materializes the mask
  if (mode === "old") ctx._boxedComposite = () => null;

  for (let i = 0; i < 3; i++) {
    drawFrame(ctx, 40, 40, true);
    await app.X.sync();
  }

  const wall = [];
  const seq0 = app.X.seq_num;
  const bytes0 = app.X.pack_stream.stats.bytes;
  for (let i = 0; i < FRAMES; i++) {
    const x = 20 + ((i * 7) % (SURFACE.width - DAMAGE - 40));
    const y = 20 + ((i * 11) % (SURFACE.height - DAMAGE - 40));
    const t0 = performance.now();
    drawFrame(ctx, x, y, i % 2 === 0);
    await app.X.sync();
    wall.push(performance.now() - t0);
  }
  const requests = (app.X.seq_num - seq0) / FRAMES;
  const bytes = (app.X.pack_stream.stats.bytes - bytes0) / FRAMES;

  ctx.destroy();
  pixmap.destroy();
  return { mode, wall: median(wall), requests, bytes };
}

const { app, target } = await connect();
console.log(`target: ${target}`);
console.log(
  `scene: ${SURFACE.width}x${SURFACE.height} surface, ` +
    `${DAMAGE}x${DAMAGE} damage clip, 3 fills per frame, ${FRAMES} frames\n`,
);

const results = [];
for (const mode of ["old", "new"]) results.push(await run(app, mode));

for (const r of results) {
  console.log(
    `${r.mode === "new" ? "new (box)  " : "old (mask) "}` +
      ` wall ${r.wall.toFixed(3)} ms/frame` +
      `  ${r.requests.toFixed(1)} requests/frame` +
      `  ${r.bytes.toFixed(0)} B/frame`,
  );
}
const [old, fresh] = results;
console.log(
  `\nper frame: ${(old.requests - fresh.requests).toFixed(0)} fewer requests, ` +
    `${(old.bytes - fresh.bytes).toFixed(0)} fewer bytes, ` +
    `${(old.wall / fresh.wall).toFixed(2)}x wall`,
);

await app.close();
