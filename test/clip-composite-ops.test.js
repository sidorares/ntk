// Nothing outside the clip changes, whatever globalCompositeOperation is.
//
// `copy`, `source-in`, `destination-in`, `source-out` and `destination-atop`
// write where a drawing's mask is zero: RENDER composites `src IN mask OP
// dst`, so through a mask of zero `copy` writes zero. With the clip folded
// into that mask they cleared every pixel of the drawing's box the clip left
// out — a `fillRect` or a transformed `drawImage` under a rectangle, and
// every drawing under a path. The canvas spec never changes a pixel outside
// the clip, and a rectangle cut out of the box, or a server-side picture
// clip, was what the other routes already did.
//
// The reference is the same drawing with no clip. Inside a rectangle the
// clipped drawing is that, to the byte, and outside it the background. Under
// a path each pixel is the background taken towards that by as much as the
// clip covers it, within a level — the coverage measured by filling the clip
// path in white over black.
//
// Hermetic: node-x11's in-process pure-JS X server + the fixture font.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, Image, StaticFontSource, Surface } from '../lib/index.js';

const VF = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'MonelogicsSubset[wght].ttf');

const W = 80;
const H = 60;
const BACKGROUND = '#cc9966';
const COLOUR = '#336699';
// the ops whose result is not the destination where the mask is zero
const CLEARING = ['copy', 'source-in', 'destination-in', 'source-out', 'destination-atop'];

let server = null;
let app = null;
const errors = [];

before(async () => {
  server = xserver.createServer({ width: 320, height: 240 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(VF), { family: 'Fixture' });
  app = await createClient({
    stream: clientEnd,
    fontSource,
    onXError: (err) => errors.push(err)
  });
});

after(async () => {
  assert.deepEqual(errors, [], 'no request the server refused');
  if (app) await app.close();
});

/** `draw` on a canvas of the background, read back as straight RGBA */
async function paint(draw, { depth = 24, width = W, height = H } = {}) {
  const pixmap = app.createPixmap({ width, height, depth });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, width, height);
  draw(ctx);
  const image = await ctx.getImageData(0, 0, width, height);
  ctx.destroy();
  pixmap.destroy();
  return image.data;
}

/** where two readbacks differ, for a message: the count and the first */
function difference(a, b, keep = () => true) {
  let n = 0;
  let first = null;
  for (let i = 0; i < a.length; i += 4) {
    const p = i / 4;
    const x = p % W;
    const y = Math.floor(p / W);
    if (!keep(x, y)) continue;
    if ([0, 1, 2, 3].every((c) => a[i + c] === b[i + c])) continue;
    n++;
    first ??= { x, y, got: [...a.slice(i, i + 4)], want: [...b.slice(i, i + 4)] };
  }
  return n ? `${n} pixels differ, the first ${JSON.stringify(first)}` : null;
}

function assertSame(got, want, label, keep) {
  const off = difference(got, want, keep);
  assert.equal(off, null, `${label}: ${off}`);
}

/** `image`'s pixels where `keep` says, `other`'s everywhere else */
function only(image, other, keep) {
  const out = new Uint8ClampedArray(other);
  for (let i = 0; i < out.length; i += 4) {
    const p = i / 4;
    if (keep(p % W, Math.floor(p / W))) out.set(image.slice(i, i + 4), i);
  }
  return out;
}

// what the drawings draw from, made once
let image16 = null;
const image = () => {
  if (image16) return image16;
  // an opaque half and a translucent one, so the ops that read the
  // source's alpha have something to read
  const data = Buffer.alloc(16 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      data.set(x < 8 ? [0, 0, 255, 255] : [0, 200, 0, 128], (y * 16 + x) * 4);
    }
  }
  return (image16 = new Image({ width: 16, height: 16, data }));
};
let disc = null;
const coverage = () => {
  if (disc) return disc;
  disc = new Surface(app, { width: 30, height: 24, format: 'a8' });
  disc.render((ctx) => {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(15, 12, 14, 10, 0, 0, Math.PI * 2);
    ctx.fill();
  });
  return disc;
};
const gradient = (ctx) => {
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, COLOUR);
  g.addColorStop(1, '#993366');
  return g;
};

// Every way a drawing reaches the surface, each drawn with whatever op the
// context has. `passes` is how many composites a pixel can take: a shadow
// is drawn, and clipped, before the drawing that casts it.
const ROUTES = {
  fillRect: (ctx) => {
    ctx.fillStyle = COLOUR;
    ctx.fillRect(10, 8, 40, 30);
  },
  'fillRect off the pixel grid': (ctx) => {
    ctx.fillStyle = COLOUR;
    ctx.translate(0.5, 0);
    ctx.fillRect(10, 8, 40, 30);
  },
  'fillRect under globalAlpha': (ctx) => {
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = COLOUR;
    ctx.fillRect(10, 8, 40, 30);
  },
  fillRects: (ctx) => {
    ctx.fillStyle = COLOUR;
    ctx.fillRects([
      [10, 8, 15, 30],
      [30, 8, 20, 30]
    ]);
  },
  fill: (ctx) => {
    ctx.fillStyle = COLOUR;
    ctx.beginPath();
    ctx.arc(30, 26, 20, 0, Math.PI * 2);
    ctx.fill();
  },
  stroke: (ctx) => {
    ctx.strokeStyle = COLOUR;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(4, 50);
    ctx.lineTo(76, 6);
    ctx.stroke();
  },
  fillText: (ctx) => {
    ctx.fillStyle = COLOUR;
    ctx.font = '28px Fixture';
    ctx.fillText('HH', 8, 40);
  },
  drawImage: (ctx) => ctx.drawImage(image(), 16, 10),
  'drawImage scaled': (ctx) => ctx.drawImage(image(), 10, 8, 50, 40),
  'drawImage translated': (ctx) => {
    ctx.translate(16, 10);
    ctx.drawImage(image(), 0, 0);
  },
  'drawImage turned': (ctx) => {
    ctx.translate(40, 30);
    ctx.rotate(0.5);
    ctx.drawImage(image(), -20, -12, 40, 24);
  },
  // drawn from a copy of the part of the crop the clip lets show
  'drawImage of a crop, turned': (ctx) => {
    ctx.translate(40, 30);
    ctx.rotate(0.5);
    ctx.drawImage(image(), 4, 0, 10, 16, -25, -16, 50, 32);
  },
  'drawImage of coverage': (ctx) => {
    ctx.fillStyle = COLOUR;
    ctx.drawImage(coverage(), 14, 12);
  },
  'drawImage of coverage in a faded gradient': (ctx) => {
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = gradient(ctx);
    ctx.drawImage(coverage(), 14, 12);
  },
  'drawImage of coverage, turned': (ctx) => {
    ctx.fillStyle = COLOUR;
    ctx.translate(40, 30);
    ctx.rotate(0.5);
    ctx.drawImage(coverage(), -15, -12);
  },
  'fillRect with a shadow': Object.assign(
    (ctx) => {
      ctx.shadowColor = '#000';
      ctx.shadowOffsetX = 6;
      ctx.shadowOffsetY = 5;
      ctx.fillStyle = COLOUR;
      ctx.fillRect(10, 8, 30, 24);
    },
    { passes: 2 }
  )
};

test('copy under a rectangle leaves what is outside it, drawn translated or not', async () => {
  // the two routes that cleared outside the clip: a transformed drawImage
  // and a fillRect, each next to the form of it that did not
  const blue = new Image({
    width: 10,
    height: 10,
    data: Buffer.alloc(10 * 10 * 4).fill(Buffer.from([0, 0, 255, 255]))
  });
  const S = 80;
  const at = (data, x, y) => [...data.slice((y * S + x) * 4, (y * S + x) * 4 + 3)];
  for (const [what, draw] of [
    ['drawImage translated', (ctx) => (ctx.translate(10, 10), ctx.drawImage(blue, 0, 0))],
    ['drawImage', (ctx) => ctx.drawImage(blue, 10, 10)],
    ['fillRect', (ctx) => ((ctx.fillStyle = 'blue'), ctx.fillRect(10, 10, 10, 10))],
    [
      'fillRect translated',
      (ctx) => ((ctx.fillStyle = 'blue'), ctx.translate(10, 10), ctx.fillRect(0, 0, 10, 10))
    ]
  ]) {
    const pixmap = app.createPixmap({ width: S, height: S, depth: 24 });
    const ctx = pixmap.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, S, S);
    ctx.beginPath();
    ctx.rect(10, 10, 5, 5);
    ctx.clip();
    ctx.globalCompositeOperation = 'copy';
    draw(ctx);
    const data = (await ctx.getImageData(0, 0, S, S)).data;
    assert.deepEqual(at(data, 12, 12), [0, 0, 255], `${what}: inside the clip, the source`);
    assert.deepEqual(at(data, 18, 18), [255, 255, 255], `${what}: outside it, as it was`);
    pixmap.destroy();
  }
});

describe('under a rectangle', () => {
  const RECT = { x: 24, y: 18, w: 30, h: 20 };
  const inRect = (x, y) => x >= RECT.x && x < RECT.x + RECT.w && y >= RECT.y && y < RECT.y + RECT.h;
  const clip = (ctx) => {
    ctx.beginPath();
    ctx.rect(RECT.x, RECT.y, RECT.w, RECT.h);
    ctx.clip();
  };

  for (const [name, draw] of Object.entries(ROUTES)) {
    test(`${name}: an op that clears draws inside it what no clip draws, and nothing outside`, async () => {
      const background = await paint(() => {});
      let drew = 0;
      for (const op of CLEARING) {
        const whole = await paint((ctx) => {
          ctx.globalCompositeOperation = op;
          draw(ctx);
        });
        // an opaque source under `destination-in` leaves an opaque canvas
        // as it was, so it is the ops together that have to draw
        if (difference(whole, background, inRect)) drew++;
        const clipped = await paint((ctx) => {
          clip(ctx);
          ctx.globalCompositeOperation = op;
          draw(ctx);
        });
        assertSame(clipped, only(whole, background, inRect), `${name}, ${op}`);
      }
      assert.ok(drew >= 3, `${name}: the ops draw inside the clip, ${drew} of them`);
    });
  }

  test('a rectangle with an edge between pixels is a path, and the same holds', async () => {
    const background = await paint(() => {});
    for (const op of CLEARING) {
      const clipped = await paint((ctx) => {
        ctx.beginPath();
        ctx.rect(24.5, 18, 30, 20);
        ctx.clip();
        assert.equal(ctx._clipRect(), null, 'not a rectangle the server can take');
        ctx.globalCompositeOperation = op;
        ROUTES.fillRect(ctx);
      });
      const outside = (x, y) => x < 24 || x > 54 || y < 18 || y >= 38;
      assertSame(clipped, background, `${op}: outside the clip`, outside);
    }
  });
});

describe('under a path', () => {
  // an ellipse turned off the axes: an antialiased edge all the way round
  const CLIP = { cx: 40, cy: 30, rx: 30, ry: 18, turn: 0.3 };
  const clip = (ctx) => {
    ctx.beginPath();
    ctx.ellipse(CLIP.cx, CLIP.cy, CLIP.rx, CLIP.ry, CLIP.turn, 0, Math.PI * 2);
    ctx.clip();
  };

  let covered = null;
  /** how much of each pixel the clip covers, 0..1 */
  async function clipCoverage() {
    if (covered) return covered;
    const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
    const ctx = pixmap.getContext('2d');
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'white';
    clip(ctx);
    ctx.fillRect(0, 0, W, H);
    const data = (await ctx.getImageData(0, 0, W, H)).data;
    pixmap.destroy();
    covered = new Float64Array(W * H);
    for (let p = 0; p < W * H; p++) covered[p] = data[p * 4] / 255;
    const edge = covered.filter((c) => c > 0 && c < 1).length;
    assert.ok(edge > 50, `an antialiased edge to test: ${edge} pixels`);
    return covered;
  }

  for (const [name, draw] of Object.entries(ROUTES)) {
    test(`${name}: every op takes each pixel as far as the clip covers it`, async () => {
      const c = await clipCoverage();
      const background = await paint(() => {});
      for (const op of CLEARING) {
        const whole = await paint((ctx) => {
          ctx.globalCompositeOperation = op;
          draw(ctx);
        });
        const clipped = await paint((ctx) => {
          clip(ctx);
          ctx.globalCompositeOperation = op;
          draw(ctx);
        });
        const label = `${name}, ${op}`;
        const outside = (x, y) => c[y * W + x] === 0;
        const inside = (x, y) => c[y * W + x] === 1;
        assertSame(clipped, background, `${label}: where the clip covers nothing`, outside);
        assertSame(clipped, whole, `${label}: where it covers all`, inside);
        if (draw.passes > 1) continue; // each pass blends with the last one's
        let worst = { off: 0 };
        for (let p = 0; p < W * H; p++) {
          for (let k = 0; k < 3; k++) {
            const i = p * 4 + k;
            const want = background[i] * (1 - c[p]) + whole[i] * c[p];
            const off = Math.abs(clipped[i] - want);
            if (off > worst.off) {
              worst = { off, x: p % W, y: Math.floor(p / W), got: clipped[i], want, c: c[p] };
            }
          }
        }
        assert.ok(worst.off <= 1, `${label}: the edge blends, worst ${JSON.stringify(worst)}`);
      }
    });
  }

  test('an op that clears still clears the box round the drawing, inside the clip', async () => {
    // a depth-32 canvas, where a cleared pixel is transparent and not dark
    const c = await clipCoverage();
    const data = await paint(
      (ctx) => {
        clip(ctx);
        ctx.globalCompositeOperation = 'copy';
        ROUTES.fill(ctx); // a disc at (30, 26), radius 20: its box is 9..51 x 5..47
      },
      { depth: 32 }
    );
    const at = (x, y) => [...data.slice((y * W + x) * 4, (y * W + x) * 4 + 4)];
    // inside the clip and the disc's box, outside the disc: cleared
    assert.equal(c[42 * W + 46], 1, '(46, 42) is inside the clip');
    assert.equal(at(46, 42)[3], 0, 'in the box, off the disc: cleared');
    assert.deepEqual(at(30, 26), [0x33, 0x66, 0x99, 255], 'the disc');
    // in the box, and in the clip's, but outside the clip: kept
    assert.equal(c[12 * W + 12], 0, '(12, 12) is outside the clip');
    assert.deepEqual(at(12, 12), [0xcc, 0x99, 0x66, 255], 'in the box, off the clip: kept');
  });

  test('a coverage surface takes a path clip after an op that clears, too', async () => {
    // the target is a8: the copy of the box is a8 as well
    const surface = new Surface(app, { width: W, height: H, format: 'a8' });
    const fill = (ctx, op) => {
      ctx.globalCompositeOperation = op;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.fillRect(0, 0, W, H);
    };
    surface.render((ctx) => {
      fill(ctx, 'source-over'); // a half everywhere
      clip(ctx);
      ctx.globalCompositeOperation = 'copy';
      ROUTES.fill(ctx); // the disc of the test above, in coverage
    });
    // painted in black over white: a level of red is a level of coverage
    const data = await paint((ctx) => {
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'black';
      ctx.drawImage(surface, 0, 0);
    });
    surface.destroy();
    const level = (x, y) => 255 - data[(y * W + x) * 4];
    assert.equal(level(30, 26), 255, 'the disc');
    assert.equal(level(46, 42), 0, 'in its box, off it, in the clip: cleared');
    const kept = level(12, 12);
    assert.ok(Math.abs(kept - 128) <= 1, `in its box, off the clip: the half it had, ${kept}`);
  });

  test('the work is the drawing’s box cut to the clip’s, and the copy is freed', async () => {
    const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
    const ctx = pixmap.getContext('2d');
    clip(ctx);
    ctx.globalCompositeOperation = 'copy';
    ctx.fillStyle = COLOUR;
    // a fill far wider than the clip: everything past the clip's box is
    // nothing the composite should touch
    ctx.fillRect(0, 0, W, H);
    await ctx.getImageData(0, 0, 1, 1); // the clip mask is made by now
    const extents = ctx._clipExtents();
    const kinds = () => {
      const n = { pixmap: 0, picture: 0 };
      for (const r of server.resources.values()) if (r.type in n) n[r.type]++;
      return n;
    };
    const held = kinds();
    const R = ctx.Render;
    const composite = R.Composite;
    const boxes = [];
    R.Composite = function (op, src, mask, dst, sx, sy, mx, my, dx, dy, w, h) {
      boxes.push({ dst, x: dx, y: dy, w, h });
      return composite.apply(this, arguments);
    };
    try {
      for (let i = 0; i < 3; i++) ctx.fillRect(0, 0, W, H);
    } finally {
      R.Composite = composite;
    }
    await ctx.getImageData(0, 0, 1, 1);
    const onSurface = boxes.filter((b) => b.dst === ctx._picture.id);
    assert.equal(onSurface.length, 3 * 2, 'two composites onto the surface per fill');
    for (const b of boxes) {
      const box = b.dst === ctx._picture.id ? b : { ...b, x: b.x + extents.x, y: b.y + extents.y };
      assert.ok(
        box.x >= extents.x &&
          box.y >= extents.y &&
          box.x + box.w <= extents.x + extents.w &&
          box.y + box.h <= extents.y + extents.h,
        `${JSON.stringify(b)} within the clip's box ${JSON.stringify(extents)}`
      );
    }
    assert.deepEqual(kinds(), held, 'every scratch copy freed again');
    ctx.destroy();
    pixmap.destroy();
  });
});
