// Rounded-box wall: a visual benchmark for the rounded-rect fast path
// (issue #211), which lowers fill/stroke of an axis-aligned rounded rect to
// cached corner glyphs + FillRectangles instead of polygon rasterization.
//
// A wall of boxes — different sizes, corner radii and border widths, drawn
// from a small repeated palette so the corner-glyph cache is hit constantly —
// animates a gentle size pulse every frame. Every box stays fully on screen:
// what is measured is drawing cost, not clip-away culling. Widths and
// heights change every frame while radii do not, exercising the cache's
// design (the box size is not part of the glyph key).
//
//   node rounded-boxes.js [boxCount]
//
//   g            toggle the glyph fast path (app.shapePolicy maxRadius 0
//                forces the old polygon route; the title shows which)
//   q / Escape   quit
//
// The title bar and a once-per-second console line report frames per
// second, mean draw time (the client-side cost of emitting one frame), and
// the fast path's hit/miss counters. Run with NTK_DEBUG_SHAPES=1 to get the
// process-wide counter summary at exit, or NTK_NO_SHAPE_GLYPHS=1 to start
// with the fast path disabled.
import { createClient } from '../lib/index.js';

const BOXES = Math.max(1, Number(process.argv[2]) || 300);

const app = await createClient();
const wnd = app.createWindow({
  title: 'rounded boxes',
  width: 1200,
  height: 800
});
const ctx = wnd.getContext('2d');
wnd.map();

// the repeated palette: few distinct (radius, borderWidth) pairs across many
// boxes is exactly the shape population a real UI has, and what makes the
// corner cache pay — every radius below is shared by dozens of boxes
const RADII = [4, 6, 8, 10, 12, 16];
const BORDERS = [0, 1, 2, 3];
const FILLS = ['#4c6ef5', '#37b24d', '#f59f00', '#e64980', '#845ef7', '#15aabf'];
const STROKES = ['#1b1f3b', '#2b8a3e', '#e8590c', '#a61e4d', '#5f3dc4', '#0b7285'];

// deterministic layout: a tiny LCG instead of Math.random, so every run
// (and both sides of a comparison) draws the identical scene
let seed = 12345;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

let boxes = [];
function layout() {
  boxes = [];
  const cols = Math.ceil(Math.sqrt((BOXES * wnd.width) / wnd.height));
  const rows = Math.ceil(BOXES / cols);
  const cellW = Math.floor(wnd.width / cols);
  const cellH = Math.floor(wnd.height / rows);
  seed = 12345;
  for (let i = 0; i < BOXES; i++) {
    const col = i % cols;
    const row = (i / cols) | 0;
    // leave room for the border band and the pulse so the box never leaves
    // its cell (everything stays on screen at every animation phase)
    const margin = 6;
    const maxW = Math.max(10, cellW - 2 * margin);
    const maxH = Math.max(10, cellH - 2 * margin);
    const w = Math.max(10, Math.floor(maxW * (0.6 + 0.4 * rand())));
    const h = Math.max(10, Math.floor(maxH * (0.6 + 0.4 * rand())));
    // clamp radius and border to the box so every combination stays a
    // valid rounded rect at every pulse phase; the palettes stay small, so
    // the clamped population is still a handful of distinct (r, bw) pairs
    const r = Math.max(1, Math.min(RADII[i % RADII.length], (Math.min(w, h) >> 1) - 6));
    const bw = Math.min(BORDERS[((i / RADII.length) | 0) % BORDERS.length], 2 * r);
    boxes.push({
      x: col * cellW + margin,
      y: row * cellH + margin,
      w,
      h,
      r,
      bw,
      fill: FILLS[i % FILLS.length],
      stroke: STROKES[i % STROKES.length],
      phase: rand() * Math.PI * 2
    });
  }
}
layout();
wnd.on('resize', layout);

let fastPath = !process.env.NTK_NO_SHAPE_GLYPHS;
const applyMode = () => {
  app.shapePolicy = fastPath ? null : { maxRadius: 0 };
};
applyMode();

let frames = 0;
let drawMs = 0;
let lastStats = { hits: 0, misses: 0 };

const missCount = () =>
  Object.values(ctx.shapeStats.misses).reduce((a, b) => a + b, 0);

setInterval(() => {
  const hits = ctx.shapeStats.hits - lastStats.hits;
  const misses = missCount() - lastStats.misses;
  lastStats = { hits: ctx.shapeStats.hits, misses: missCount() };
  const mode = fastPath ? 'glyph fast path' : 'polygon fallback';
  const mean = frames ? (drawMs / frames).toFixed(2) : '?';
  const line =
    `${mode} — ${frames} fps, draw ${mean} ms/frame, ` +
    `${hits} hits / ${misses} misses`;
  wnd.setTitle(`rounded boxes (${BOXES}) — ${line} — press g to toggle`);
  console.log(line, misses ? JSON.stringify(ctx.shapeStats.misses) : '');
  frames = 0;
  drawMs = 0;
}, 1000).unref();

function frame(now) {
  frames++;
  const t0 = performance.now();
  const t = now / 600;

  ctx.fillStyle = '#e9ecef';
  ctx.fillRect(0, 0, wnd.width, wnd.height);
  for (const b of boxes) {
    // pulse the size, never the radius: integer deltas keep the fast path
    // eligible and the glyph cache keyed on (r, bw) keeps hitting while the
    // rectangles stretch — the pattern an animating pill/progress bar has
    const dw = Math.round(3 * Math.sin(t + b.phase));
    const dh = Math.round(2 * Math.sin(t * 1.3 + b.phase));
    const w = b.w + 2 * dw;
    const h = b.h + 2 * dh;
    ctx.fillStyle = b.fill;
    ctx.beginPath();
    ctx.roundRect(b.x - dw, b.y - dh, w, h, b.r);
    ctx.fill();
    if (b.bw > 0) {
      ctx.strokeStyle = b.stroke;
      ctx.lineWidth = b.bw;
      const inset = b.bw / 2;
      ctx.beginPath();
      // the border band sits on pixel boundaries when the path is inset by
      // half the line width — the way a correct 1px border is drawn
      ctx.roundRect(b.x - dw + inset, b.y - dh + inset, w - b.bw, h - b.bw, b.r);
      ctx.stroke();
    }
  }

  drawMs += performance.now() - t0;
  wnd.requestAnimationFrame(frame);
}

wnd.on('keydown', (ev) => {
  const key = String.fromCodePoint(ev.codepoint ?? 0).toLowerCase();
  if (key === 'g') {
    fastPath = !fastPath;
    applyMode();
  } else if (key === 'q' || ev.keysym === 0xff1b) {
    app.close();
  }
});

wnd.on('close', () => app.close());
wnd.requestAnimationFrame(frame);
