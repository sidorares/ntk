// Which rasterizer draws a mask — ntk's or the server's — decided by where a
// drawing lands. The two antialias differently, so a long stroke whose cap
// had just left the surface was three triangles fewer, went to the other
// rasterizer, and came out up to ten levels different along its whole
// length: a pan's copy of it one way, a repaint the other. Found by
// react-x11-components' damage differential, on a `<Flow>` edge.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import xserver from "x11/lib/xserver/index.js";

import { createClient, StaticFontSource } from "../lib/index.js";
import { crossingPoints, PENTAGRAM, xBars } from "./helpers/self-crossing.js";

const W = 480;
const H = 320;

// a graph edge: a long, gentle curve from the surface's left edge to well
// past its right one, as `<Flow>` routes it
const CURVE = [
  2.4446, 79.2892, 3.2241, 83.387, 5.5242, 87.3386, 9.2876, 91.1494, 14.4569,
  94.8251, 20.9747, 98.3711, 28.7837, 101.793, 37.8264, 105.0962, 48.0455,
  108.2864, 59.3835, 111.3689, 71.7832, 114.3493, 85.187, 117.2332, 99.5377,
  120.0261, 114.7778, 122.7334, 130.85, 125.3607, 147.6969, 127.9136, 165.2611,
  130.3974, 183.4852, 132.8178, 202.3118, 135.1803, 221.6835, 137.4904, 241.543,
  139.7535, 261.8329, 141.9753, 282.4958, 144.1612, 303.4743, 146.3168, 324.711,
  148.4475, 346.1486, 150.559, 367.7296, 152.6566, 389.3967, 154.7459, 411.0925,
  156.8325, 432.7596, 158.9219, 454.3406, 161.0195, 475.7782, 163.1309,
  497.0149, 165.2617, 517.9934, 167.4172, 538.6563, 169.6031, 558.9462,
  171.8249, 578.8057, 174.0881, 598.1775, 176.3981, 617.0041, 178.7606,
  635.2282, 181.181, 652.7923, 183.6649, 669.6392, 186.2177, 685.7114, 188.845,
  700.9515, 191.5524, 715.3022, 194.3452, 728.7061, 197.2291, 741.1057,
  200.2096, 752.4438, 203.2921, 762.6628, 206.4822, 771.7055, 209.7855,
  779.5145, 213.2073, 784.6992, 216.0281,
];

let app;
// every drawing to the server's trapezoids, and every drawing to ntk's
// rasterizer, whatever its size
let serverRouted;
let localRouted;

before(async () => {
  const server = xserver.createServer({ width: 600, height: 400 });
  const connect = (options) => {
    const [serverEnd, clientEnd] = xserver.createStreamPair();
    server.addClientStream(serverEnd);
    return createClient({
      stream: clientEnd,
      fontSource: new StaticFontSource(),
      ...options,
    });
  };
  app = await connect();
  serverRouted = await connect({ rasterizer: null });
  localRouted = await connect({
    rasterPolicy: { maxArea: Infinity, maxBytes: Infinity },
  });
});

after(async () => {
  for (const a of [app, serverRouted, localRouted]) if (a) await a.close();
});

/** The curve stroked `dx` along, the way an edge is: round joins and caps. */
async function stroked(dx, dy = 0) {
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, W, H);
  ctx.beginPath();
  for (let i = 0; i < CURVE.length; i += 2) {
    if (i === 0) ctx.moveTo(CURVE[i] + dx, CURVE[i + 1] + dy);
    else ctx.lineTo(CURVE[i] + dx, CURVE[i + 1] + dy);
  }
  ctx.strokeStyle = "#7f8c8d";
  ctx.lineWidth = 2.55;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
  const { data } = await ctx.getImageData(0, 0, W, H);
  pixmap.destroy?.();
  return data;
}

test("a stroke moved off the surface's edge is drawn as it was, moved", async () => {
  const at = await stroked(0);
  for (const [dx, dy] of [
    [-2, 0],
    [-4, 0],
    [-5, 0],
    [-7, 0],
    [-9, 0],
    [-5, -15],
  ]) {
    const moved = await stroked(dx, dy);
    let apart = 0;
    let worst = 0;
    // away from the edges the shift uncovers
    for (let y = 20; y < H - 20; y++) {
      for (let x = 20; x < W - 20; x++) {
        const i = (y * W + x) * 4;
        const j = ((y + dy) * W + (x + dx)) * 4;
        const d = Math.max(
          Math.abs(at[i] - moved[j]),
          Math.abs(at[i + 1] - moved[j + 1]),
          Math.abs(at[i + 2] - moved[j + 2]),
        );
        if (d) apart++;
        if (d > worst) worst = d;
      }
    }
    assert.equal(
      apart,
      0,
      `moved ${dx},${dy}: ${apart} pixels apart, by up to ${worst}`,
    );
  }
});

// A fill that crosses itself. The server's route trapezoidizes it
// (lib/trapezoid.js), which cut slabs only at vertex heights: two edges
// crossing between them made a trapezoid with its sides crossed. MDN's
// pentagram at 3x lost its arms and filled the gap between its legs, and an
// "×" of two bars was 3,350 pixels wrong — at sizes where the drawing goes
// to the server, while small enough to be rasterized here it was right.

/** `trace` filled by `rule` in white on black, `w` by `h` */
async function filled(a, w, h, trace, rule) {
  const pixmap = a.createPixmap({ width: w, height: h, depth: 24 });
  const ctx = pixmap.getContext("2d");
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "white";
  ctx.beginPath();
  trace(ctx);
  ctx.fill(rule);
  const { data } = await ctx.getImageData(0, 0, w, h);
  pixmap.destroy?.();
  return data;
}

function polygons(ctx, polys) {
  for (const p of polys) {
    ctx.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
    ctx.closePath();
  }
}

test("a fill that crosses itself is the same through the server's trapezoids", async () => {
  const bars = xBars(110, 110, 190, 24);
  const shapes = {
    pentagram: {
      size: 304,
      trace: (ctx) => {
        ctx.scale(3, 3);
        polygons(ctx, [PENTAGRAM]);
      },
      crossings: crossingPoints([PENTAGRAM.map((v) => v * 3)]),
    },
    "×": {
      size: 220,
      trace: (ctx) => polygons(ctx, bars),
      crossings: crossingPoints(bars),
    },
  };
  for (const [name, { size, trace, crossings }] of Object.entries(shapes)) {
    for (const rule of ["nonzero", "evenodd"]) {
      const server = await filled(serverRouted, size, size, trace, rule);
      const local = await filled(localRouted, size, size, trace, rule);
      if (name === "pentagram" && rule === "nonzero") {
        const at = (x, y) => server[(y * size + x) * 4];
        assert.equal(at(36, 114), 255, "the left arm is filled");
        assert.equal(at(150, 255), 0, "between the legs is not");
      }
      // The two antialias differently, by a few levels. Where a crossing
      // puts winding 0 and 2 in one pixel ntk's signed areas cancel or
      // clamp, so those pixels are left out; everywhere else they agree.
      let apart = 0;
      let first = null;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          if (Math.abs(server[i] - local[i]) <= 32) continue;
          const c = (p) => Math.hypot(x + 0.5 - p[0], y + 0.5 - p[1]) < 2;
          if (crossings.some(c)) continue;
          apart++;
          first ??= `${x},${y}: ${server[i]} vs ${local[i]}`;
        }
      }
      assert.equal(apart, 0, `${name} ${rule}: ${apart} pixels apart, first ${first}`);
    }
  }
});
