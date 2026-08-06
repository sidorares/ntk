// A bordered card, drawn both ways, magnified (issue #217).
//
// `examples/rounded-boxes.js` insets its borders by half the line width but
// keeps an integer path radius, so it never shows this case. A border that
// *nests* inside its background — the usual reason to draw one — takes the
// background's radius minus the inset: `roundRect(x + bw/2, y + bw/2,
// w - bw, h - bw, R - bw/2)`, a half-integer radius at every odd width.
//
// Each row is one border width, drawn twice from identical geometry: left on
// the corner-glyph route, right on the polygon route, with the top-left
// corner of each blown up so the antialiasing can be compared pixel by
// pixel. The two should be indistinguishable — that is the claim. Colours are
// translucent, so a pixel the glyphs and the FillRectangles both painted
// would show up as a dark seam.
//
// The last row is the odd one out: `lineWidth = 1.5` on an *integer* path
// radius, which is not the nesting geometry but did pass every test the old
// recognizer applied. It took the fast path and then emitted FillRectangles
// with fractional extents, dropping the half-covered row of ink — a border
// visibly thinner on the left than on the right. Now it falls back and the
// two columns agree.
//
//   node odd-border.js                    a window; g toggles, q quits
//   node odd-border.js --png=out.png      render once to a PNG, no window
//
// The header line counts what each route did: with the fix every row is a
// fast-path hit on the left, and the `fractional` counter stays at zero.
import { writeFileSync } from 'node:fs';

import { PNG } from 'pngjs';

import { createClient } from '../lib/index.js';

const pngPath = (process.argv.find((a) => a.startsWith('--png=')) || '').slice(6);

const R = 16; // the background's corner radius, shared by every row
// one row per border width, path radius R - bw/2 unless the row overrides it
const ROWS = [
  { bw: 1 },
  { bw: 2 },
  { bw: 3 },
  { bw: 4 },
  { bw: 1.5, r: R, note: 'integer r' }
].map((row) => ({ r: R - row.bw / 2, ...row }));
const CARD = { w: 190, h: 92 };
const ZOOM = { size: 22, scale: 6 }; // corner pixels, magnification
const ROW = Math.max(CARD.h, ZOOM.size * ZOOM.scale) + 22;
const COL = CARD.w + ZOOM.size * ZOOM.scale + 26;
const PAD = { x: 74, y: 52 };
const SURFACE = {
  width: PAD.x + 2 * COL + 16,
  height: PAD.y + ROWS.length * ROW + 12
};

const BACKDROP = '#dee2e6';
const FILL = 'rgba(120, 150, 230, 0.85)';
const STROKE = 'rgba(24, 28, 52, 0.7)';
const INK = '#212529';

const app = await createClient();

/** where row i's card sits on route column `col` (0 fast, 1 polygon) */
const cardAt = (i, col) => ({
  x: PAD.x + col * COL,
  y: PAD.y + i * ROW
});

/** the card's background */
function background(ctx, x, y) {
  ctx.fillStyle = FILL;
  ctx.beginPath();
  ctx.roundRect(x, y, CARD.w, CARD.h, R);
  ctx.fill();
}

/**
 * The border, stroked on the path inset by half its width — the nesting
 * geometry, whose radius is R - bw/2.
 */
function border(ctx, x, y, bw, r) {
  ctx.strokeStyle = STROKE;
  ctx.lineWidth = bw;
  ctx.beginPath();
  ctx.roundRect(x + bw / 2, y + bw / 2, CARD.w - bw, CARD.h - bw, r);
  ctx.stroke();
}

/** what the route did during one drawing: hits, and any bail-out reasons */
function measure(ctx, draw) {
  const hits = ctx.shapeStats.hits;
  const before = { ...ctx.shapeStats.misses };
  draw();
  const misses = [];
  for (const [k, n] of Object.entries(ctx.shapeStats.misses)) {
    if (n - (before[k] || 0) > 0) misses.push(k);
  }
  return { hit: ctx.shapeStats.hits > hits, misses };
}

/** the scene, minus the magnifiers: both routes, one row per border width */
function drawCards(ctx, fastPath) {
  ctx.fillStyle = BACKDROP;
  ctx.fillRect(0, 0, SURFACE.width, SURFACE.height);
  ctx.fillStyle = INK;
  ctx.font = '12px sans-serif';
  ctx.fillText(fastPath ? 'corner glyphs' : 'polygon route (forced)', PAD.x, PAD.y - 30);
  ctx.fillText('polygon route (forced)', PAD.x + COL, PAD.y - 30);

  const stats = [];
  for (let i = 0; i < ROWS.length; i++) {
    const { bw, r, note } = ROWS[i];
    const a = cardAt(i, 0);
    const b = cardAt(i, 1);
    ctx.fillStyle = INK;
    ctx.fillText(`${bw}px`, 20, a.y + 18);
    ctx.fillText(`r ${r}`, 20, a.y + 34);
    if (note) ctx.fillText(note, 20, a.y + 50);

    // left column on whichever route is selected, right column always forced
    app.shapePolicy = fastPath ? null : { maxRadius: 0 };
    background(ctx, a.x, a.y);
    const took = measure(ctx, () => border(ctx, a.x, a.y, bw, r));
    app.shapePolicy = { maxRadius: 0 };
    background(ctx, b.x, b.y);
    border(ctx, b.x, b.y, bw, r);
    stats.push({ bw, ...took });
  }
  app.shapePolicy = fastPath ? null : { maxRadius: 0 };
  return stats;
}

/**
 * Magnify each card's top-left corner from the pixels actually drawn — one
 * readback per card, scaled by nearest neighbour so every pixel is a block.
 */
async function drawZooms(ctx) {
  const { size, scale } = ZOOM;
  for (let i = 0; i < ROWS.length; i++) {
    const { bw } = ROWS[i];
    for (const col of [0, 1]) {
      const at = cardAt(i, col);
      // start one pixel outside the band's outer corner
      const sx = Math.floor(at.x - bw / 2) - 1;
      const sy = Math.floor(at.y - bw / 2) - 1;
      const src = await ctx.getImageData(sx, sy, size, size);
      const out = ctx.createImageData(size * scale, size * scale);
      for (let y = 0; y < size * scale; y++) {
        for (let x = 0; x < size * scale; x++) {
          const s = (((y / scale) | 0) * size + ((x / scale) | 0)) * 4;
          const d = (y * size * scale + x) * 4;
          out.data[d] = src.data[s];
          out.data[d + 1] = src.data[s + 1];
          out.data[d + 2] = src.data[s + 2];
          out.data[d + 3] = 255;
        }
      }
      ctx.putImageData(out, at.x + CARD.w + 14, at.y);
    }
  }
}

async function paint(ctx, fastPath) {
  const stats = drawCards(ctx, fastPath);
  await drawZooms(ctx);
  return stats;
}

/** what each border width did on the left column */
function report(stats, fastPath) {
  const took = stats
    .map((s) => `${s.bw}px ${s.hit ? 'glyphs' : `polygons (${s.misses.join(' ') || 'no tag'})`}`)
    .join(', ');
  return `left column ${fastPath ? 'on the glyph route' : 'forced to polygons'} — borders: ${took}`;
}

if (pngPath) {
  const pixmap = app.createPixmap({ ...SURFACE, depth: 24 });
  const ctx = pixmap.getContext('2d');
  const stats = await paint(ctx, true);
  console.log(report(stats, true));
  const img = await ctx.getImageData(0, 0, SURFACE.width, SURFACE.height);
  const png = new PNG({ width: SURFACE.width, height: SURFACE.height });
  png.data.set(img.data);
  writeFileSync(pngPath, PNG.sync.write(png));
  console.log(`wrote ${pngPath}`);
  await app.close();
} else {
  const wnd = app.createWindow({
    title: 'odd border widths',
    width: SURFACE.width,
    height: SURFACE.height
  });
  const ctx = wnd.getContext('2d');
  wnd.map();
  let fastPath = !process.env.NTK_NO_SHAPE_GLYPHS;
  const redraw = async () => {
    const stats = await paint(ctx, fastPath);
    const line = report(stats, fastPath);
    wnd.setTitle(`odd border widths — ${line} — g toggles, q quits`);
    console.log(line);
  };
  await redraw();
  wnd.on('keydown', (ev) => {
    const key = String.fromCodePoint(ev.codepoint ?? 0).toLowerCase();
    if (key === 'g') {
      fastPath = !fastPath;
      redraw();
    } else if (key === 'q' || ev.keysym === 0xff1b) {
      app.close();
    }
  });
  wnd.on('close', () => app.close());
}
