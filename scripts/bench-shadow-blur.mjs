// Benchmark for the reduced-scale blur (issue #338): bakes the coverage
// surfaces a real UI's first frame asks for — the ones react-x11's
// `examples/configurator` draws, as tabulated in the issue — at full
// resolution and shrunk first, and reports both.
//
//   node scripts/bench-shadow-blur.mjs [repeats] [--js]
//
// Runs against $DISPLAY by default, which is the measurement that matters:
// the whole cost is server-side, and it is worst where RENDER is software
// (XQuartz, Xvfb, any remote display). `--js` uses node-x11's in-process JS
// X server instead — hermetic, and it prices the same requests in one
// process. Each bake is fenced with a round trip, so the wall time is the
// server's, not the socket's.
//
// The model next to it is `2 * taps * w * h` multiply-accumulates: two
// separable passes, every tap of a `2 * ceil(3σ) + 1` kernel, per pixel.
// That is the number the shrink divides by `scale³` — `scale` off the taps,
// `scale²` off the area.
import { performance } from 'node:perf_hooks';

import { blurCoverage, blurScale, createClient, StaticFontSource, Surface } from '../lib/index.js';
import { shadowReach } from '../lib/shadow.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const REPEATS = Math.max(1, Number(args[0]) || 5);

// the coverage surfaces one first paint of the configurator builds, biggest
// first — `width x height` of the padded a8 surface, and the sigma the blur
// runs at (issue #338)
const SHADOWS = [
  { width: 552, height: 396, sigma: 21 },
  { width: 1294, height: 165, sigma: 12 },
  { width: 462, height: 306, sigma: 6 },
  { width: 495, height: 133, sigma: 11 },
  { width: 564, height: 81, sigma: 11 },
  { width: 196, height: 154, sigma: 11 }
];

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

const { app, target } = await connect();
const root = app.display.screen[0].root;
/** a round trip, so the time measured is the server's work and not the wire */
const fence = () => new Promise((resolve) => app.X.GetGeometry(root, resolve));

/** the shape whose shadow this is: a rounded rect inset by the blur's reach,
 * which is what a `box-shadow` casts */
function coverage({ width, height, sigma }) {
  const pad = shadowReach(sigma);
  const surface = new Surface(app, { width, height, format: 'a8' });
  surface.render((ctx) => {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(pad, pad, width - 2 * pad, height - 2 * pad, 8);
    ctx.fill();
  });
  return surface;
}

const macs = ({ width, height, sigma }, scale) => {
  const taps = 2 * shadowReach(sigma / scale) + 1;
  return (2 * taps * Math.ceil(width / scale) * Math.ceil(height / scale)) / 1e6;
};

async function time(shadow, scale) {
  let best = Infinity;
  for (let i = 0; i < REPEATS; i++) {
    const shape = coverage(shadow);
    await fence();
    const t0 = performance.now();
    const out = blurCoverage(shape, shadow.sigma, { scale });
    await fence();
    best = Math.min(best, performance.now() - t0);
    out.destroy();
  }
  return best;
}

console.log(`ntk shadow blur — ${target}, best of ${REPEATS}\n`);
console.log('surface        sigma  scale     exact       scaled    saved   MAC exact -> scaled');
let exactTotal = 0;
let scaledTotal = 0;
for (const shadow of SHADOWS) {
  const scale = blurScale(shadow.sigma);
  const exact = await time(shadow, 1);
  const scaled = scale === 1 ? exact : await time(shadow, undefined);
  exactTotal += exact;
  scaledTotal += scaled;
  console.log(
    `${`${shadow.width}x${shadow.height}`.padEnd(13)} ${String(shadow.sigma).padStart(4)}  ` +
      `${scale === 1 ? '   -' : `  ${scale}x`}  ${exact.toFixed(1).padStart(8)}ms ` +
      `${scaled.toFixed(1).padStart(8)}ms ${`${(100 - (100 * scaled) / exact).toFixed(0)}%`.padStart(7)}   ` +
      `${macs(shadow, 1).toFixed(1)}M -> ${macs(shadow, scale).toFixed(1)}M`
  );
}
console.log(
  `\nfirst paint: ${exactTotal.toFixed(1)}ms -> ${scaledTotal.toFixed(1)}ms ` +
    `(${(100 - (100 * scaledTotal) / exactTotal).toFixed(0)}% off ${SHADOWS.length} shadows)`
);

await app.close();
