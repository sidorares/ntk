// Text honours `globalAlpha`, as every fill and stroke does. `fillText`,
// `drawGlyphs` and so every `TextLayout.draw` used to composite their glyphs
// at full opacity whatever it was set to: CompositeGlyphs has no mask slot
// to carry an alpha in, and nothing put one anywhere else. A react-x11
// element faded with `opacity: .5` drew its text at full strength.
//
// What "honours" means here is exact, not "looks lighter". A drawing at
// alpha `a` lands on the pixels the same drawing at full opacity does, at
// `a` of the strength: each pixel is the background plus `a` times the
// opaque drawing's difference from it, antialiased edges included, since a
// glyph's coverage scales the source the same way the alpha does. So each
// test draws the same text twice, opaque and faded, and compares them pixel
// by pixel. Red over white is the case a reader checks by eye (#ff8080),
// and it saturates: a fold that scaled only a premultiplied colour's alpha
// comes out right there by accident. The mid colours over a mid background
// are there to catch that slip.
//
// Hermetic: node-x11's in-process pure-JS X server + the fixture font.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';
import { cssColor, cssColorStraight } from '../lib/color.js';
import { trapezoidize } from '../lib/trapezoid.js';

const VF = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'MonelogicsSubset[wght].ttf'
);

const W = 160;
const H = 64;
// stems several pixels wide at this size, so some pixels are wholly inside
// a glyph and read the text colour itself
const SIZE = 40;
const TEXT = 'HHHH';
const BASELINE = 48;

let app = null;
let font = null;

before(async () => {
  const server = xserver.createServer({ width: 320, height: 160 });
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

/** the 8-bit straight RGB a colour string paints as on a depth-24 target */
const rgb = (color) =>
  cssColorStraight(color)
    .slice(0, 3)
    .map((v) => Math.round(v * 255));

/**
 * Paint `draw` over a `background` canvas and read the pixels back. `alpha`
 * is set before `draw` runs, so it applies to whatever `draw` sets up.
 */
async function paint(background, alpha, draw) {
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = alpha;
  draw(ctx);
  const image = await ctx.getImageData(0, 0, W, H);
  pixmap.destroy();
  return image.data;
}

/** pixels where `image` differs from a flat `background` */
function inked(image, background, keep = () => true) {
  const [r, g, b] = rgb(background);
  let n = 0;
  for (let i = 0; i < image.length; i += 4) {
    const x = (i / 4) % W;
    const y = Math.floor(i / 4 / W);
    if (!keep(x, y)) continue;
    if (image[i] !== r || image[i + 1] !== g || image[i + 2] !== b) n++;
  }
  return n;
}

/** the Render requests `body` sends, by name */
function countRender(names, body) {
  const R = app.display.Render;
  const counts = Object.fromEntries(names.map((n) => [n, 0]));
  const saved = names.map((n) => R[n]);
  names.forEach((n, i) => {
    R[n] = (...a) => {
      counts[n]++;
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
  return counts;
}

/**
 * Assert `faded` is `opaque` drawn at `alpha` over `background`: every
 * channel of every pixel within `tolerance` of bg + alpha·(opaque − bg).
 * The tolerance is rounding — each of the two drawings rounds to 8 bits on
 * its own, and a mask path rounds the coverage once more — and nothing else.
 */
function assertFaded(faded, opaque, background, alpha, label, tolerance = 2) {
  const bg = rgb(background);
  assert.ok(inked(opaque, background) > 50, `${label}: the opaque drawing inks something`);
  let worst = null;
  for (let i = 0; i < opaque.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const want = bg[c] + alpha * (opaque[i + c] - bg[c]);
      const off = Math.abs(faded[i + c] - want);
      if (!worst || off > worst.off) {
        const p = i / 4;
        const [x, y] = [p % W, Math.floor(p / W)];
        worst = { off, x, y, channel: 'rgb'[c], got: faded[i + c], want };
      }
    }
  }
  assert.ok(
    worst.off <= tolerance,
    `${label}: every pixel is the opaque drawing at ${alpha}, worst ${JSON.stringify(worst)}`
  );
}

/** pixels the opaque drawing covers wholly: they read the colour itself */
function solidPixels(opaque, color) {
  const [r, g, b] = rgb(color);
  const out = [];
  for (let i = 0; i < opaque.length; i += 4) {
    if (opaque[i] === r && opaque[i + 1] === g && opaque[i + 2] === b) out.push(i);
  }
  return out;
}

// The three ways text reaches a 2d context. Each draws TEXT in what
// `style(ctx)` gives: a colour string, or a CanvasGradient made on `ctx`.
const ENTRY_POINTS = {
  fillText(ctx, style) {
    ctx.font = `${SIZE}px Fixture`;
    ctx.fillStyle = style(ctx);
    ctx.fillText(TEXT, 8, BASELINE);
  },
  'TextLayout.draw'(ctx, style) {
    const s = style(ctx);
    // a colour goes on the span; a gradient is the context's fillStyle,
    // which a span without a colour paints with
    if (typeof s !== 'string') ctx.fillStyle = s;
    const layout = layoutOf(typeof s === 'string' ? s : undefined);
    layout.draw(ctx, 8, BASELINE - layout.lines[0].baseline);
  },
  drawGlyphs(ctx, style) {
    ctx.drawGlyphs(ctx.Render.PictOp.Over, sourceOf(ctx, style), [
      { run: font.shape(TEXT, SIZE), x: 8, y: BASELINE }
    ]);
  }
};

/** a style as a source picture: a solid of a colour, a gradient as itself */
const sourceOf = (ctx, style) => {
  const s = style(ctx);
  return typeof s === 'string' ? ctx.createSolidPicture(...cssColor(s)) : s;
};

const layoutOf = (color) =>
  app.fonts.layout([{ text: TEXT, family: 'Fixture', size: SIZE, color }], {
    family: 'Fixture',
    size: SIZE
  });

const colour = (c) => () => c;

/** what a drawing sends: its composites, and the glyphs they draw */
const DRAWING = ['CompositeGlyphs', 'Composite', 'FillRectangles', 'AddGlyphs', 'AddTraps'];

/** red through blue across the canvas, so every glyph samples its own part */
const gradient = (ctx) => {
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, '#ff0000');
  g.addColorStop(1, '#0000ff');
  return g;
};

for (const [name, draw] of Object.entries(ENTRY_POINTS)) {
  describe(`${name} at globalAlpha`, () => {
    test('0.5: red over white reads #ff8080 where a glyph covers the pixel', async () => {
      const opaque = await paint('white', 1, (ctx) => draw(ctx, colour('#ff0000')));
      const faded = await paint('white', 0.5, (ctx) => draw(ctx, colour('#ff0000')));
      const covered = solidPixels(opaque, '#ff0000');
      assert.ok(covered.length > 20, `some pixels are wholly inside a glyph (${covered.length})`);
      for (const i of covered) {
        const [r, g, b] = faded.slice(i, i + 3);
        const near80 = (v) => Math.abs(v - 0x80) <= 1;
        assert.ok(r === 255 && near80(g) && near80(b), `#ff8080, got ${[r, g, b]}`);
      }
      assertFaded(faded, opaque, 'white', 0.5, name);
    });

    test('a colour that does not saturate is scaled whole, premultiplied', async () => {
      for (const alpha of [0.5, 0.25]) {
        const opaque = await paint('#cc9966', 1, (ctx) => draw(ctx, colour('#336699')));
        const faded = await paint('#cc9966', alpha, (ctx) => draw(ctx, colour('#336699')));
        assertFaded(faded, opaque, '#cc9966', alpha, `${name} at ${alpha}`);
      }
    });

    test('0: nothing is drawn, and nothing is sent', async () => {
      let counts;
      const image = await paint('white', 0, (ctx) => {
        ctx.shadowColor = '#000'; // and no shadow either
        ctx.shadowOffsetX = ctx.shadowOffsetY = 4;
        counts = countRender(DRAWING, () => {
          draw(ctx, colour('#ff0000'));
          draw(ctx, gradient);
        });
      });
      assert.deepEqual(counts, Object.fromEntries(DRAWING.map((n) => [n, 0])));
      assert.equal(inked(image, 'white'), 0, 'and no pixel changes');
    });

    test('0.5 in a colour: the alpha goes in the source, and no mask is made', async () => {
      // what a faded paragraph costs is what an opaque one does: the glyph
      // composite, with no surface-sized mask beside it
      let counts;
      await paint('white', 0.5, (ctx) => {
        counts = countRender(DRAWING, () => draw(ctx, colour('#336699')));
      });
      assert.equal(counts.CompositeGlyphs, 1, 'one glyph composite');
      assert.equal(counts.Composite + counts.FillRectangles, 0, 'and nothing else');
    });

    test('0.5: a gradient source is half as strong', async () => {
      const opaque = await paint('white', 1, (ctx) => draw(ctx, gradient));
      const faded = await paint('white', 0.5, (ctx) => draw(ctx, gradient));
      assertFaded(faded, opaque, 'white', 0.5, name);
    });

    // Under a clip the glyphs take one of two routes — the server's own clip
    // rectangle, or the a8 mask a path clip needs — and the alpha takes one
    // of two more: folded into a solid's colour, or into the mask a
    // gradient has to go through. All four meet here.
    const CLIP_TOP = 30;
    const clips = {
      rectangular(ctx) {
        ctx.beginPath();
        ctx.rect(0, CLIP_TOP, W, H - CLIP_TOP);
        ctx.clip();
        return (x, y) => y < CLIP_TOP;
      },
      path(ctx) {
        ctx.beginPath();
        ctx.ellipse(W / 2, 40, 50, 14, 0, 0, Math.PI * 2);
        ctx.clip();
        assert.equal(ctx._clipRect(), null, 'an ellipse is not a rectangle');
        // outside the box around it: no pixel there is the ellipse's
        return (x, y) => y < 25 || y > 55 || x < W / 2 - 51 || x > W / 2 + 51;
      }
    };
    for (const [clip, set] of Object.entries(clips)) {
      for (const [source, style] of [
        ['a colour', colour('#336699')],
        ['a gradient', gradient]
      ]) {
        test(`0.5 under a ${clip} clip, painting ${source}`, async () => {
          let outside = null;
          const clipped = (ctx) => {
            outside = set(ctx);
            draw(ctx, style);
          };
          const whole = await paint('#cc9966', 1, (ctx) => draw(ctx, style));
          const opaque = await paint('#cc9966', 1, clipped);
          const faded = await paint('#cc9966', 0.5, clipped);
          const label = `${name}, ${clip} clip, ${source}`;
          assert.ok(inked(whole, '#cc9966', outside) > 20, `${label}: the clip cuts text away`);
          assert.equal(inked(faded, '#cc9966', outside), 0, `${label}: none is drawn there`);
          assertFaded(faded, opaque, '#cc9966', 0.5, label, 3);
        });
      }
    }

    test('0.5: the shadow fades with the text', async () => {
      // transparent text: only the shadow paints, so the whole picture is it
      const shadowed = (ctx) => {
        ctx.shadowColor = '#336699';
        ctx.shadowBlur = 2;
        ctx.shadowOffsetX = 3;
        ctx.shadowOffsetY = 2;
        draw(ctx, colour('rgba(0, 0, 0, 0)'));
      };
      const opaque = await paint('#cc9966', 1, shadowed);
      const faded = await paint('#cc9966', 0.5, shadowed);
      assertFaded(faded, opaque, '#cc9966', 0.5, `${name}'s shadow`);
    });
  });
}

test('a picture the caller made fades through the mask, having no colour to fold', async () => {
  // a solid ntk made knows its colour; one made any other way is just a
  // picture, which is what a host's own solidPicture hands back
  const draw = (ctx) => {
    const pixmap = app.createPixmap({ width: 1, height: 1, depth: 32 });
    const R = app.display.Render;
    const pid = app.X.AllocID();
    R.CreatePicture(pid, pixmap.id, R.rgba32, { repeat: 1 });
    R.FillRectangles(R.PictOp.Src, pid, cssColor('#336699'), [0, 0, 1, 1]);
    ctx.drawGlyphs(R.PictOp.Over, { id: pid }, [
      { run: font.shape(TEXT, SIZE), x: 8, y: BASELINE }
    ]);
    R.FreePicture(pid);
    pixmap.destroy();
  };
  const opaque = await paint('#cc9966', 1, draw);
  const faded = await paint('#cc9966', 0.5, draw);
  assertFaded(faded, opaque, '#cc9966', 0.5, 'a picture of the caller’s', 3);
});

test('drawTraps fades as the glyphs drawn beside it do', async () => {
  const traps = trapezoidize([[20.25, 10, 120.5, 14, 100, 52.75, 30, 40]], 0, 0, []);
  for (const style of [colour('#336699'), gradient]) {
    const draw = (ctx) => ctx.drawTraps(ctx.Render.PictOp.Over, sourceOf(ctx, style), traps);
    const opaque = await paint('#cc9966', 1, draw);
    const faded = await paint('#cc9966', 0.5, draw);
    assertFaded(faded, opaque, '#cc9966', 0.5, 'drawTraps', 3);
    const none = await paint('#cc9966', 0, draw);
    assert.equal(inked(none, '#cc9966'), 0, 'and at 0 draws nothing');
  }
});
