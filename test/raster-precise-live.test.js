// The two routes a mask can take — rasterized here and uploaded, or sent as
// trapezoids for the server to rasterize — must come out the same to the
// byte, so that the same pixels drawn by different routes in different
// passes never disagree (issue #462). PreciseRasterizer rasterizes as the
// RENDER spec's Precise mode defines and pixman implements; this asks the
// real server.
//
// Runs against the X server $DISPLAY names, and skips without one. CI's is
// Xvfb; XQuartz, Xorg and Xwayland rasterize with the same pixman code. A
// server that does not would fail here, and would show the seams this
// prevents.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createClient, PreciseRasterizer } from '../lib/index.js';
import { snapFixed16 } from '../lib/precise.js';
import { trapezoidize } from '../lib/trapezoid.js';
import { withTimeout } from './helpers/async.js';

let app = null;
let skip = false;

before(async () => {
  if (!process.env.DISPLAY) {
    skip = 'no DISPLAY set';
    return;
  }
  try {
    app = await withTimeout(createClient(), 5000, 'connecting to X server', (late) => late.close());
  } catch (err) {
    skip = `cannot connect to X server: ${err.message}`;
  }
});

after(async () => {
  if (app) await app.close();
});

let seed = 462;
const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;

function triangleSoup(W, H) {
  const tris = [];
  if (rnd() < 0.5) {
    for (let k = 0; k < 16; k++) {
      const cx = rnd() * W;
      const cy = rnd() * H;
      const s = 2 + rnd() * 50;
      for (let j = 0; j < 3; j++) tris.push(cx + (rnd() - 0.5) * s, cy + (rnd() - 0.5) * s);
    }
    return tris;
  }
  // a wandering polyline extruded into quads that overlap at the joins
  let x = rnd() * W;
  let y = rnd() * H;
  let a = rnd() * 6.28;
  const hw = 0.4 + rnd() * 3;
  for (let k = 0; k < 40; k++) {
    a += (rnd() - 0.5) * 0.8;
    const len = 2 + rnd() * 12;
    const nx = x + Math.cos(a) * len;
    const ny = y + Math.sin(a) * len;
    const px = -Math.sin(a) * hw;
    const py = Math.cos(a) * hw;
    tris.push(x + px, y + py, nx + px, ny + py, nx - px, ny - py);
    tris.push(x + px, y + py, nx - px, ny - py, x - px, y - py);
    x = nx;
    y = ny;
  }
  return tris;
}

function polygons(W, H) {
  const polys = [];
  for (let p = 0, n = 1 + Math.floor(rnd() * 3); p < n; p++) {
    const cx = rnd() * W;
    const cy = rnd() * H;
    const r = 4 + rnd() * 60;
    const k = 3 + Math.floor(rnd() * 30);
    const pts = [];
    for (let i = 0; i < k; i++) {
      // convex-ish rings, which trapezoidize renders exactly whatever their
      // overlaps: edges that cross inside a slab are another matter
      const t = (i / k) * Math.PI * 2;
      const rr = r * (0.85 + 0.15 * rnd());
      pts.push(cx + Math.cos(t) * rr, cy + Math.sin(t) * rr);
    }
    polys.push(pts);
  }
  return polys;
}

test('precise: Triangles and AddTraps rasterize here as the server does, to the byte', async (t) => {
  if (skip) return t.skip(skip);
  const W = 160;
  const H = 120;
  const X = app.X;
  const R = app.display.Render;
  const pix = X.AllocID();
  X.CreatePixmap(pix, app.display.screen[0].root, 8, W, H);
  const pic = X.AllocID();
  R.CreatePicture(pic, pix, R.a8);
  const solid = X.AllocID();
  R.CreateSolidFill(solid, 0, 0, 0, 1);
  const read = () =>
    new Promise((resolve, reject) =>
      X.GetImage(2, pix, 0, 0, W, H, 0xffffffff, (err, img) => (err ? reject(err) : resolve(img.data)))
    );
  const precise = new PreciseRasterizer();
  try {
    for (let c = 0; c < 80; c++) {
      R.FillRectangles(R.PictOp.Src, pic, [0, 0, 0, 0], [0, 0, W, H]);
      let job;
      if (c % 2 === 0) {
        const triangles = triangleSoup(W, H).map(snapFixed16);
        R.Triangles(R.PictOp.Add, solid, 0, 0, pic, R.a8, triangles);
        job = { triangles };
      } else {
        const polys = polygons(W, H);
        const rule = rnd() < 0.5 ? 'evenodd' : 'nonzero';
        R.AddTraps(pic, 0, 0, trapezoidize(polys, 0, 0, [], rule).map(snapFixed16));
        job = { polys, rule };
      }
      const server = await read();
      // over the whole pixmap, and over a box of it at an offset, as the 2d
      // context rasterizes a drawing over its own box
      const bx = Math.floor(rnd() * 40);
      const by = Math.floor(rnd() * 40);
      for (const box of [
        { x: 0, y: 0, w: W, h: H },
        { x: bx, y: by, w: W - bx - 11, h: H - by - 5 }
      ]) {
        const local = precise.rasterize({ ...job, width: box.w, height: box.h, dx: -box.x, dy: -box.y });
        for (let y = 0; y < box.h; y++) {
          for (let x = 0; x < box.w; x++) {
            const want = server[(y + box.y) * W + x + box.x];
            if (local[y * box.w + x] !== want) {
              assert.fail(
                `drawing ${c} (${job.triangles ? 'triangles' : job.rule}), box at ${box.x},${box.y}: ` +
                  `pixel ${x},${y} is ${local[y * box.w + x]} here, ${want} on the server`
              );
            }
          }
        }
      }
    }
  } finally {
    R.FreePicture(solid);
    R.FreePicture(pic);
    X.FreePixmap(pix);
  }
});

const W = 200;
const H = 140;

/**
 * Draw with every mask routed to the 'server', or rasterized 'local'ly, or
 * where the 'default' policy sends it. `data` is the pixels, `local` how
 * many masks were rasterized here.
 */
async function drawn(route, draw) {
  const keep = { rasterizer: app.rasterizer, policy: app.options.rasterPolicy };
  let local = 0;
  if (route === 'server') {
    app.rasterizer = null;
  } else {
    if (route === 'local') app.options.rasterPolicy = { maxArea: Infinity, maxBytes: Infinity };
    const inner = keep.rasterizer;
    app.rasterizer = { rasterize: (job) => (local++, inner.rasterize(job)) };
  }
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  try {
    const ctx = pixmap.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = ctx.strokeStyle = 'black';
    draw(ctx);
    return { data: (await ctx.getImageData(0, 0, W, H)).data, local };
  } finally {
    pixmap.destroy();
    app.rasterizer = keep.rasterizer;
    app.options.rasterPolicy = keep.policy;
  }
}

function apart(a, b) {
  let n = 0;
  let worst = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (d) n++;
    if (d > worst) worst = d;
  }
  return n ? `${n} pixels apart, by up to ${worst}` : 'identical';
}

const DRAWINGS = {
  'a round-capped curve': (ctx) => {
    ctx.lineWidth = 2.55;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(10.3, 120.7);
    ctx.bezierCurveTo(60, -20, 140, 180, 190.6, 15.2);
    ctx.stroke();
  },
  'a mitred polyline at half alpha': (ctx) => {
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 3.3;
    ctx.beginPath();
    ctx.moveTo(15.5, 20.25);
    for (let i = 1; i < 12; i++) ctx.lineTo(15.5 + i * 15.1, 20.25 + (i % 2) * 70.6 + i * 3.3);
    ctx.stroke();
  },
  'a dashed circle with round caps': (ctx) => {
    ctx.lineWidth = 1.7;
    ctx.lineCap = 'round';
    ctx.setLineDash([7.5, 4.25]);
    ctx.beginPath();
    ctx.arc(100.4, 70.6, 55.3, 0, Math.PI * 2);
    ctx.stroke();
  },
  'a rounded card': (ctx) => {
    ctx.beginPath();
    ctx.roundRect(12.3, 9.6, 171.4, 118.9, 14.5);
    ctx.fill();
  },
  'an even-odd ring': (ctx) => {
    ctx.beginPath();
    ctx.arc(100.2, 70.1, 60.4, 0, Math.PI * 2);
    ctx.arc(100.2, 70.1, 31.7, 0, Math.PI * 2);
    ctx.fill('evenodd');
  },
  'a fill inside a rounded clip': (ctx) => {
    ctx.beginPath();
    ctx.roundRect(20.5, 15.25, 150.3, 100.6, 22.4);
    ctx.clip();
    ctx.beginPath();
    ctx.arc(160.3, 110.8, 90.2, 0, Math.PI * 2);
    ctx.fill();
  }
};

for (const [name, draw] of Object.entries(DRAWINGS)) {
  test(`precise: ${name} is drawn the same by either route`, async (t) => {
    if (skip) return t.skip(skip);
    const server = await drawn('server', draw);
    const local = await drawn('local', draw);
    assert.ok(local.local > 0, 'the local route was taken');
    assert.equal(apart(server.data, local.data), 'identical');
  });
}

// a graph edge as `<Flow>` routes it, from react-x11-components
const EDGE = [
  2.4446, 79.2892, 9.2876, 91.1494, 20.9747, 98.3711, 37.8264, 105.0962, 59.3835, 111.3689, 85.187,
  117.2332, 114.7778, 122.7334, 147.6969, 127.9136, 183.4852, 132.8178, 221.6835, 137.4904, 261.8329,
  141.9753, 303.4743, 146.3168, 346.1486, 150.559, 389.3967, 154.7459, 432.7596, 158.9219, 475.7782,
  163.1309
];

function edge(ctx, from, to) {
  ctx.lineWidth = 2.55;
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = from; i < to; i += 2) {
    if (i === from) ctx.moveTo(EDGE[i], EDGE[i + 1] - 40);
    else ctx.lineTo(EDGE[i], EDGE[i + 1] - 40);
  }
  ctx.stroke();
}

test('precise: a repaint and a pass over part of an edge agree inside the pass (issue #462)', async (t) => {
  if (skip) return t.skip(skip);
  // A repaint strokes the whole edge, a large drawing that goes to the
  // server; a pass over a clip strokes the run of it the clip reaches, a
  // small one rasterized here. Inside the clip the two must be one.
  const clip = { x: 70, y: 50, w: 70, h: 50 };
  const whole = await drawn('default', (ctx) => edge(ctx, 0, EDGE.length));
  const pass = await drawn('default', (ctx) => {
    ctx.beginPath();
    ctx.rect(clip.x, clip.y, clip.w, clip.h);
    ctx.clip();
    edge(ctx, 6, 24);
  });
  assert.equal(whole.local, 0, 'the whole edge goes to the server');
  assert.ok(pass.local > 0, 'the run is rasterized here');
  for (let y = clip.y; y < clip.y + clip.h; y++) {
    for (let x = clip.x; x < clip.x + clip.w; x++) {
      const i = (y * W + x) * 4;
      assert.equal(pass.data[i], whole.data[i], `pixel ${x},${y}`);
    }
  }
});

test('precise: a stroke drawn straight to the window matches it drawn through the mask', async (t) => {
  if (skip) return t.skip(skip);
  // With no clip, no round cap or join, full alpha and Over, a stroke skips
  // the mask and is rasterized by the server onto the window; under a clip
  // the same stroke goes through the mask, which a small one fills here
  const check = (ctx) => {
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(20.3, 40.6);
    ctx.lineTo(31.7, 52.1);
    ctx.lineTo(55.2, 22.9);
    ctx.stroke();
  };
  const direct = await drawn('default', check);
  const masked = await drawn('default', (ctx) => {
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();
    check(ctx);
  });
  assert.equal(direct.local, 0, 'the stroke went straight to the window');
  assert.ok(masked.local > 0, 'and through a mask rasterized here');
  assert.equal(apart(direct.data, masked.data), 'identical');
});
