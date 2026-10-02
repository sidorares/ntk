// Text composites with `globalCompositeOperation`, as a fill does. `fillText`
// and `TextLayout.draw` used to hard-code source-over, while their shadow
// took the context's op, so a shadowed `destination-out` label erased with
// its shadow and painted its letters back in.
//
// Taking the op is the easy half. The ops that write where the drawing has
// no ink — `copy`, `source-in`, `destination-in`, `source-out`,
// `destination-atop` — took text two different ways, neither a fill's.
// CompositeGlyphs composites each glyph over its own box, so it cleared
// glyph-shaped boxes and the neighbour's ink inside them; the scratch-mask
// route composited over the whole surface and cleared everything, outside
// the clip too. A fill clears the rest of its own box: its ink, a pixel of
// slack round it, cut by the clip. So does text now, on every route.
//
// The reference is a fill of exactly that: the text's coverage, drawn into
// an a8 surface the size of its box, then painted in the colour with the op
// through `drawImage`, which composites over the surface's box. Text drawn
// with each op has to be that, to the byte.
//
// Hermetic: node-x11's in-process pure-JS X server + the fixture font.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource, Surface } from '../lib/index.js';
import { cssColor } from '../lib/color.js';
import { positionedRunsInk } from '../lib/text/glyphs.js';
import { trapezoidize } from '../lib/trapezoid.js';

const VF = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'MonelogicsSubset[wght].ttf');

const W = 160;
const H = 64;
const SIZE = 40;
const TEXT = 'HHHH';
const X = 8;
const BASELINE = 48;
const BACKGROUND = '#cc9966';
const COLOUR = '#336699';

// globalCompositeOperation -> the XRender op it names, for drawGlyphs
const PICTOP = {
  'source-over': 'Over',
  copy: 'Src',
  'destination-over': 'OverReverse',
  'source-in': 'In',
  'destination-in': 'InReverse',
  'source-out': 'Out',
  'destination-out': 'OutReverse',
  'source-atop': 'Atop',
  'destination-atop': 'AtopReverse',
  xor: 'Xor',
  lighter: 'Add'
};
const OPS = Object.keys(PICTOP);
// the ones whose result is not the destination where the mask is zero
const CLEARING = ['copy', 'source-in', 'destination-in', 'source-out', 'destination-atop'];

let app = null;
let font = null;

before(async () => {
  const server = xserver.createServer({ width: 320, height: 480 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(VF), { family: 'Fixture' });
  app = await createClient({ stream: clientEnd, fontSource });
  font = app.fonts.match('Fixture');
});

after(async () => {
  if (app) await app.close();
});

/**
 * `draw` on a depth-32 canvas of the background, read back as straight
 * RGBA. An alpha channel is what tells a cleared pixel from a dark one.
 */
async function paint(draw, { width = W, height = H } = {}) {
  const pixmap = app.createPixmap({ width, height, depth: 32 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, width, height);
  draw(ctx);
  const image = await ctx.getImageData(0, 0, width, height);
  pixmap.destroy();
  return image.data;
}

/**
 * The box a drawing of `positioned` owns — its glyphs' ink, out to whole
 * pixels with one of slack on every side, the box a fill's mask has — on
 * the surface.
 */
function boxOf(positioned) {
  const ink = positionedRunsInk(positioned);
  const x = Math.max(0, Math.floor(ink.minX) - 1);
  const y = Math.max(0, Math.floor(ink.minY) - 1);
  const right = Math.min(W, Math.ceil(ink.maxX) + 1);
  const bottom = Math.min(H, Math.ceil(ink.maxY) + 1);
  return { x, y, w: right - x, h: bottom - y };
}

/**
 * What a fill of the drawing's coverage does under `op`: the coverage `draw`
 * leaves, in an a8 surface over `box`, painted in the colour through
 * `drawImage` — one composite over the box, as a fill's mask is.
 */
async function reference(op, box, draw) {
  const coverage = new Surface(app, { width: box.w, height: box.h, format: 'a8' });
  coverage.render((sctx) => {
    sctx.translate(-box.x, -box.y);
    draw(sctx, { op: 'source-over', style: '#fff' });
  });
  const image = await paint((ctx) => {
    ctx.globalCompositeOperation = op;
    ctx.fillStyle = COLOUR;
    ctx.drawImage(coverage, box.x, box.y);
  });
  coverage.destroy();
  return image;
}

/** where two readbacks differ, for a message: the count and the first */
function difference(a, b, width = W) {
  let n = 0;
  let first = null;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2] && a[i + 3] === b[i + 3]) {
      continue;
    }
    n++;
    if (!first) {
      const p = i / 4;
      first = {
        x: p % width,
        y: Math.floor(p / width),
        got: [...a.slice(i, i + 4)],
        want: [...b.slice(i, i + 4)]
      };
    }
  }
  return n ? `${n} pixels differ, the first ${JSON.stringify(first)}` : null;
}

function assertSame(got, want, label, width) {
  const off = difference(got, want, width);
  assert.equal(off, null, `${label}: ${off}`);
}

/** the background's straight RGBA */
const BG = [0xcc, 0x99, 0x66, 0xff];

/** pixels `keep(x, y)` picks where `image` is not the background */
function changed(image, keep = () => true) {
  let n = 0;
  for (let i = 0; i < image.length; i += 4) {
    const p = i / 4;
    if (!keep(p % W, Math.floor(p / W))) continue;
    if (BG.some((v, c) => image[i + c] !== v)) n++;
  }
  return n;
}

/** straight RGBA as the premultiplied levels it was read back from */
function premultiplied(image) {
  const out = new Uint8ClampedArray(image.length);
  for (let i = 0; i < image.length; i += 4) {
    const a = image[i + 3];
    for (let c = 0; c < 3; c++) out[i + c] = Math.round((image[i + c] * a) / 255);
    out[i + 3] = a;
  }
  return out;
}

/** the part of `image` `keep` picks, everything else the background */
function only(image, keep) {
  const out = new Uint8ClampedArray(image);
  for (let i = 0; i < out.length; i += 4) {
    const p = i / 4;
    if (!keep(p % W, Math.floor(p / W))) out.set(BG, i);
  }
  return out;
}

const shaped = () => font.shape(TEXT, SIZE);

const layoutOf = (text = TEXT) =>
  app.fonts.layout([{ text, family: 'Fixture', size: SIZE }], { family: 'Fixture', size: SIZE });

/** where `layout.draw(ctx, x, y)` puts each run, as it computes it */
const layoutRuns = (layout, x, y) =>
  layout.lines.flatMap((line) =>
    line.runs.map((r) => ({ run: r.run, x: x + line.x + r.x, y: y + line.baseline }))
  );

/** a style as a source picture: a solid of a colour, a gradient as itself */
const sourceOf = (ctx, style) =>
  typeof style === 'string' ? ctx.createSolidPicture(...cssColor(style)) : style;

// The three ways text reaches a 2d context, each drawing TEXT under `op` in
// `style` — a colour, or a gradient made on the context — and where its
// glyphs go. `fillText` and `TextLayout.draw` take the context's op;
// `drawGlyphs` is handed the one it names.
const layout = () => layoutOf();
const layoutTop = () => BASELINE - layout().lines[0].baseline;
const ENTRY_POINTS = {
  fillText: {
    draw(ctx, { op, style }) {
      ctx.globalCompositeOperation = op;
      ctx.fillStyle = style;
      ctx.font = `${SIZE}px Fixture`;
      ctx.fillText(TEXT, X, BASELINE);
    },
    positioned: () => [{ run: shaped(), x: X, y: BASELINE }]
  },
  'TextLayout.draw': {
    draw(ctx, { op, style }) {
      ctx.globalCompositeOperation = op;
      ctx.fillStyle = style;
      layout().draw(ctx, X, layoutTop());
    },
    positioned: () => layoutRuns(layout(), X, layoutTop())
  },
  drawGlyphs: {
    draw(ctx, { op, style }) {
      ctx.drawGlyphs(ctx.Render.PictOp[PICTOP[op]], sourceOf(ctx, style), [
        { run: shaped(), x: X, y: BASELINE }
      ]);
    },
    positioned: () => [{ run: shaped(), x: X, y: BASELINE }]
  }
};

/** a gradient from `a` to `b` across the canvas */
const gradientOf = (ctx, a, b) => {
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  return g;
};

// an ellipse: no rectangle, so the clip is a mask
const CLIP = { cx: W / 2, cy: 36, rx: 50, ry: 14 };
const ellipseClip = (ctx) => {
  ctx.beginPath();
  ctx.ellipse(CLIP.cx, CLIP.cy, CLIP.rx, CLIP.ry, 0, 0, Math.PI * 2);
  ctx.clip();
  assert.equal(ctx._clipRect(), null, 'an ellipse is not a rectangle');
};
/** outside the ellipse's box, with the pixel of slack its mask has */
const outsideClipBox = (x, y) =>
  x < CLIP.cx - CLIP.rx - 1 ||
  x >= CLIP.cx + CLIP.rx + 1 ||
  y < CLIP.cy - CLIP.ry - 1 ||
  y >= CLIP.cy + CLIP.ry + 1;
/** a pixel whose every point is well inside the ellipse: its mask is whole */
const deepInsideClip = (x, y) => {
  const d = (px, py) => ((px - CLIP.cx) / CLIP.rx) ** 2 + ((py - CLIP.cy) / CLIP.ry) ** 2;
  return [x - 1, x + 2].every((px) => [y - 1, y + 2].every((py) => d(px, py) < 1));
};
/** a pixel with no point inside the ellipse, nor within a pixel of it */
const wellOutsideClip = (x, y) => {
  const d = (px, py) =>
    ((px - CLIP.cx) / (CLIP.rx + 2)) ** 2 + ((py - CLIP.cy) / (CLIP.ry + 2)) ** 2;
  return [x, x + 1].every((px) => [y, y + 1].every((py) => d(px, py) > 1));
};

for (const [name, entry] of Object.entries(ENTRY_POINTS)) {
  describe(`${name} under globalCompositeOperation`, () => {
    test('every op composites the glyphs as a fill of their coverage does', async () => {
      const box = boxOf(entry.positioned());
      for (const op of OPS) {
        const got = await paint((ctx) => entry.draw(ctx, { op, style: COLOUR }));
        const want = await reference(op, box, entry.draw);
        assert.ok(changed(want) > 0 || op === 'destination-over', `${op}: the reference draws`);
        assertSame(got, want, `${name}, ${op}`);
      }
    });

    test('an op that clears clears the box round the glyphs, and nothing past it', async () => {
      const box = boxOf(entry.positioned());
      const inBox = (x, y) => x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
      for (const op of CLEARING) {
        const image = await paint((ctx) => entry.draw(ctx, { op, style: COLOUR }));
        const outside = changed(image, (x, y) => !inBox(x, y));
        assert.equal(outside, 0, `${op}: nothing outside the box changes`);
        // the box's corners hold no ink: cleared, as a fill's are
        for (const [x, y] of [
          [box.x, box.y],
          [box.x + box.w - 1, box.y + box.h - 1]
        ]) {
          const i = (y * W + x) * 4;
          assert.equal(image[i + 3], 0, `${op}: (${x}, ${y}) is inside the box and cleared`);
        }
      }
    });

    test('a rectangular clip keeps every op inside it', async () => {
      const TOP = 30;
      for (const op of OPS) {
        const whole = await paint((ctx) => entry.draw(ctx, { op, style: COLOUR }));
        const clipped = await paint((ctx) => {
          ctx.beginPath();
          ctx.rect(0, TOP, W, H - TOP);
          ctx.clip();
          entry.draw(ctx, { op, style: COLOUR });
        });
        assertSame(clipped, only(whole, (x, y) => y >= TOP), `${name}, ${op} under a rectangle`);
      }
    });

    test('a path clip keeps every op to its box, and draws inside it what no clip draws', async () => {
      for (const op of OPS) {
        const whole = await paint((ctx) => entry.draw(ctx, { op, style: COLOUR }));
        const clipped = await paint((ctx) => {
          ellipseClip(ctx);
          entry.draw(ctx, { op, style: COLOUR });
        });
        const label = `${name}, ${op} under a path`;
        const outside = changed(clipped, outsideClipBox);
        assert.equal(outside, 0, `${label}: nothing outside the clip's box changes`);
        if (!CLEARING.includes(op)) {
          assert.equal(changed(clipped, wellOutsideClip), 0, `${label}: nor outside the clip`);
        }
        const inside = (image) => only(image, deepInsideClip);
        assertSame(inside(clipped), inside(whole), `${label}, inside it`);
      }
    });

    test('a faded gradient takes each op as the faded colour does', async () => {
      // the colour's alpha is folded into its source, a gradient's goes into
      // the mask: two routes, the same drawing, give or take a rounding —
      // compared premultiplied, as the pixels are stored, since a level off
      // at a faint edge is many levels of straight colour
      for (const op of OPS) {
        const colour = await paint((ctx) => {
          ctx.globalAlpha = 0.5;
          entry.draw(ctx, { op, style: COLOUR });
        });
        const gradient = await paint((ctx) => {
          ctx.globalAlpha = 0.5;
          entry.draw(ctx, { op, style: gradientOf(ctx, COLOUR, COLOUR) });
        });
        const a = premultiplied(colour);
        const b = premultiplied(gradient);
        let worst = { off: 0 };
        for (let i = 0; i < a.length; i++) {
          const off = Math.abs(a[i] - b[i]);
          if (off > worst.off) {
            worst = { off, x: (i >> 2) % W, y: Math.floor((i >> 2) / W), a: a[i], b: b[i] };
          }
        }
        assert.ok(worst.off <= 1, `${name}, ${op} at 0.5: worst ${JSON.stringify(worst)}`);
      }
    });
  });
}

test('drawGlyphs: under an op that clears, a glyph keeps its ink where the next one overlaps it', async () => {
  // two H's 12 px apart, each wider than that: the second's box lies over
  // the first's right stem, which a composite per glyph box cleared
  const H_ID = font.glyphIdFor('H'.codePointAt(0));
  const run = { font, size: SIZE, glyphs: [0, 1].map(() => ({ id: H_ID, ax: 12, dx: 0, dy: 0 })) };
  const positioned = [{ run, x: X, y: BASELINE }];
  const draw = (ctx, { op, style }) =>
    ctx.drawGlyphs(ctx.Render.PictOp[PICTOP[op]], sourceOf(ctx, style), positioned);
  const box = boxOf(positioned);
  for (const op of CLEARING) {
    const got = await paint((ctx) => draw(ctx, { op, style: COLOUR }));
    assertSame(got, await reference(op, box, draw), `overlapping glyphs, ${op}`);
  }
});

test('fillText: a shadowed label under destination-out erases with its letters, as with its shadow', async () => {
  const label = (ctx, { shadow = true, colour = COLOUR } = {}) => {
    if (shadow) {
      ctx.shadowColor = '#000';
      ctx.shadowOffsetX = 5;
      ctx.shadowOffsetY = 3;
    }
    ctx.fillStyle = colour;
    ctx.font = `${SIZE}px Fixture`;
    ctx.fillText(TEXT, X, BASELINE);
  };
  // where the letters and the shadow each cover a pixel wholly
  const letters = await paint((ctx) => label(ctx, { shadow: false }));
  const shadow = await paint((ctx) => label(ctx, { colour: 'rgba(0, 0, 0, 0)' }));
  const whole = (image, rgba) => {
    const out = [];
    for (let i = 0; i < image.length; i += 4) {
      if (rgba.every((v, c) => image[i + c] === v)) out.push(i);
    }
    return out;
  };
  const inLetters = whole(letters, [0x33, 0x66, 0x99, 0xff]);
  const inShadow = whole(shadow, [0, 0, 0, 0xff]);
  assert.ok(inLetters.length > 100 && inShadow.length > 100, 'both cover pixels wholly');

  const erased = await paint((ctx) => {
    ctx.globalCompositeOperation = 'destination-out';
    label(ctx);
  });
  for (const [what, pixels] of [
    ['the letters', inLetters],
    ['the shadow', inShadow]
  ]) {
    const kept = pixels.filter((i) => erased[i + 3] !== 0);
    assert.equal(kept.length, 0, `${what} erase: ${kept.length} of ${pixels.length} pixels kept`);
  }
  const far = (x, y) => x > 130 || y < 10;
  assert.equal(changed(erased, far), 0, 'and nothing far from them changes');
});

test('TextLayout.draw: a line the clip hides still widens the box an op clears', async () => {
  // A wide first line and narrow ones under it, clipped to the last: the
  // layout skips lines the clip hides, but under `copy` the box round all of
  // them is what clears, and the first line is what makes that box wide.
  const TALL = 400;
  const TOP = 8;
  const paragraph = layoutOf('HHHH\nH\nH\nH\nH\nH\nH');
  const last = paragraph.lines[paragraph.lines.length - 1];
  assert.ok(last.y > 200, 'the last line is far below the first');
  const shown = Math.floor(TOP + last.y);
  const clip = (ctx) => {
    ctx.beginPath();
    ctx.rect(0, shown, W, TALL - shown);
    ctx.clip();
    ctx.globalCompositeOperation = 'copy';
    ctx.fillStyle = COLOUR;
  };
  const drawn = await paint(
    (ctx) => {
      clip(ctx);
      paragraph.draw(ctx, X, TOP);
    },
    { height: TALL }
  );
  const all = await paint(
    (ctx) => {
      clip(ctx);
      ctx.drawGlyphs(
        ctx.Render.PictOp.Src,
        ctx.createSolidPicture(...cssColor(COLOUR)),
        layoutRuns(paragraph, X, TOP)
      );
    },
    { height: TALL }
  );
  assertSame(drawn, all, 'the layout clears what drawGlyphs of every line clears', W);
});

/** the Render requests `body` sends, with their arguments */
function recordRender(names, body) {
  const R = app.display.Render;
  const calls = [];
  const saved = names.map((n) => R[n]);
  names.forEach((n, i) => {
    R[n] = (...a) => {
      calls.push({ name: n, args: a });
      return saved[i].apply(R, a);
    };
  });
  try {
    body();
  } finally {
    names.forEach((n, i) => {
      R[n] = saved[i];
    });
  }
  return calls;
}

test('an op that leaves the destination where there is no ink is still one CompositeGlyphs', async () => {
  for (const op of OPS.filter((o) => !CLEARING.includes(o))) {
    let calls;
    await paint((ctx) => {
      calls = recordRender(['CompositeGlyphs', 'Composite', 'FillRectangles'], () =>
        ENTRY_POINTS.fillText.draw(ctx, { op, style: COLOUR })
      );
    });
    assert.deepEqual(
      calls.map((c) => c.name),
      ['CompositeGlyphs'],
      `${op}: the glyphs, and no mask`
    );
  }
});

test('through the mask, the work is the text box, not the surface', async () => {
  // an op that clears, and a path clip with any op: what used to be four
  // surface-sized passes is bounded by the box the drawing owns
  const box = boxOf(ENTRY_POINTS.fillText.positioned());
  for (const [what, setup] of [
    ['copy', (ctx) => (ctx.globalCompositeOperation = 'copy')],
    ['a path clip', ellipseClip]
  ]) {
    let calls;
    await paint((ctx) => {
      setup(ctx);
      calls = recordRender(['Composite', 'FillRectangles'], () =>
        ENTRY_POINTS.fillText.draw(ctx, { op: ctx.globalCompositeOperation, style: COLOUR })
      );
    });
    const areas = calls.map(({ name, args }) =>
      name === 'Composite' ? args[10] * args[11] : args[3][2] * args[3][3]
    );
    assert.ok(areas.length >= 2, `${what}: a mask and a composite`);
    assert.ok(
      areas.every((a) => a <= box.w * box.h),
      `${what}: every pass within the ${box.w}x${box.h} box, got ${areas}`
    );
  }
});

test('drawTraps: an op that clears takes the box round the trapezoids, on either route', async () => {
  const traps = trapezoidize([[20.25, 10, 120.5, 14, 100, 52.75, 30, 40]], 0, 0, []);
  const draw = (ctx, op) =>
    ctx.drawTraps(ctx.Render.PictOp[PICTOP[op]], sourceOf(ctx, COLOUR), traps);
  // the trapezoids' extent, with the pixel of slack
  const box = { x: 19, y: 9, w: 122 - 19, h: 54 - 9 };
  const inBox = (x, y) => x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
  for (const op of OPS) {
    const direct = await paint((ctx) => draw(ctx, op));
    const masked = await paint((ctx) => {
      // a path round the whole surface: no rectangle, and the mask is whole
      ctx.beginPath();
      ctx.moveTo(-10, -10);
      ctx.lineTo(W * 3, -10);
      ctx.lineTo(-10, H * 3);
      ctx.closePath();
      ctx.clip();
      draw(ctx, op);
    });
    assertSame(masked, direct, `drawTraps, ${op}: the mask route draws what the direct one does`);
    const outside = changed(direct, (x, y) => !inBox(x, y));
    assert.equal(outside, 0, `${op}: nothing outside the box changes`);
    if (CLEARING.includes(op)) {
      assert.equal(direct[(box.y * W + box.x) * 4 + 3], 0, `${op}: the box's corner is cleared`);
    }
  }
});
