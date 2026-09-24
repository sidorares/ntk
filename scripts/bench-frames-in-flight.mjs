// How many frames should the fence clock let the server owe? (issue #369)
//
//   node scripts/bench-frames-in-flight.mjs [--depth=1,2] [--runs=3] [--seconds=3] [--hz=120]
//
// A card dragged under a pointer, one frame drawn per coalesced move — the
// workload the issue measured with react-x11's <Flow>. The motion is fed into
// the window's event stream rather than produced by a device, so its rate is
// exact and the real pointer is left alone.
//
// Each `maxFramesInFlight` in --depth is run in turn, alternating, so drift in
// the server lands on all of them alike. Per run: frames a second, the spread
// of the intervals between them, and how long a fence took to be answered.
// The window is given most of a second to settle first, which is also what
// takes it off a made-up vblank (docs/window.md "When no display is behind
// Present") — the fence clock with CopyArea blits is the case being measured,
// and the `clock` column says whether that is what ran.
//
// Needs a real X server ($DISPLAY). Frame rates reproduce within a few fps
// from run to run on XQuartz; one run in several may come out fast at one
// frame in flight, where XQuartz happened to answer its fences quickly
// throughout, so read the runs rather than any single one.
import { performance } from 'node:perf_hooks';

import { createClient } from '../lib/index.js';

const opt = (name, fallback) => {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : fallback;
};
const DEPTHS = opt('depth', '1,2').split(',').map(Number);
const RUNS = Number(opt('runs', 3));
const SECONDS = Number(opt('seconds', 3));
const HZ = Number(opt('hz', 120));
const SETTLE_MS = 800;

if (!process.env.DISPLAY) {
  console.error('bench-frames-in-flight: needs $DISPLAY (try: xvfb-run -a node scripts/bench-frames-in-flight.mjs)');
  process.exit(1);
}

const W = 800;
const H = 600;
const BG = '#1e2228';
const percentile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const ms = (v) => (v === undefined ? '    -' : v.toFixed(2).padStart(5));

function drawCard(ctx, c) {
  ctx.fillStyle = '#2d333b';
  ctx.beginPath();
  ctx.roundRect(c.x, c.y, c.w, c.h, 8);
  ctx.fill();
  ctx.strokeStyle = '#539bf5';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#adbac7';
  ctx.font = '13px sans-serif';
  ctx.fillText('Node', c.x + 12, c.y + 22);
  ctx.fillStyle = '#768390';
  ctx.font = '11px sans-serif';
  ctx.fillText('input: value', c.x + 12, c.y + 44);
  ctx.fillText('output: result', c.x + 12, c.y + 62);
  ctx.fillStyle = '#57ab5a';
  ctx.fillRect(c.x - 4, c.y + 40, 8, 8);
  ctx.fillRect(c.x + c.w - 4, c.y + 58, 8, 8);
}

async function run(depth) {
  const app = await createClient();
  const wnd = app.createWindow({
    width: W,
    height: H,
    x: 40,
    y: 40,
    overrideRedirect: true,
    maxFramesInFlight: depth
  });
  const ctx = wnd.getContext('2d');
  wnd.map();
  await new Promise((resolve) => {
    wnd.once('expose', resolve);
    setTimeout(resolve, 1000);
  });

  // every fence the window sends, timed from request to reply
  const fences = [];
  let measuring = false;
  const X = app.X;
  const getInputFocus = X.GetInputFocus.bind(X);
  X.GetInputFocus = (cb) => {
    const sent = performance.now();
    return getInputFocus((...args) => {
      if (measuring) fences.push(performance.now() - sent);
      cb(...args);
    });
  };

  const frames = [];
  let last = null;
  wnd.on('mousemove', (ev) => {
    if (measuring) frames.push(performance.now());
    if (last) {
      ctx.fillStyle = BG;
      ctx.fillRect(last.x - 6, last.y - 3, last.w + 12, last.h + 6);
    }
    last = { x: ev.x, y: ev.y, w: 170, h: 80 };
    drawCard(ctx, last);
  });
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // a pointer at HZ, tracing a Lissajous figure across the window
  const drag = (duration) =>
    new Promise((resolve) => {
      const start = performance.now();
      let n = 0;
      const step = () => {
        const now = performance.now();
        if (now - start >= duration) return resolve();
        const t = (now - start) / 1000;
        const x = Math.round(W / 2 - 85 + Math.cos(t * 2.1) * 250);
        const y = Math.round(H / 2 - 40 + Math.sin(t * 3.3) * 180);
        wnd.emit('event', { type: 6, x, y, rootx: x, rooty: y, keycode: 0, buttons: 256, time: Math.round(now) });
        n++;
        setTimeout(step, Math.max(0, start + (n * 1000) / HZ - performance.now()));
      };
      step();
    });

  await drag(SETTLE_MS);
  measuring = true;
  const start = performance.now();
  await drag(SECONDS * 1000);
  const elapsed = performance.now() - start;
  measuring = false;

  const intervals = frames.slice(1).map((at, i) => at - frames[i]);
  intervals.sort((a, b) => a - b);
  fences.sort((a, b) => a - b);
  const result = {
    fps: (frames.length / elapsed) * 1000,
    interval: [percentile(intervals, 0.5), percentile(intervals, 0.95)],
    fence: [percentile(fences, 0.5), percentile(fences, 0.95)],
    clock: wnd.frameClock,
    frameInterval: wnd.frameInterval
  };
  wnd.destroy();
  await app.close();
  return result;
}

console.log(
  `\na card dragged under a ${HZ} Hz pointer, ${SECONDS} s per run — ` +
    'frame interval and fence reply in ms, p50 / p95\n'
);
for (let r = 0; r < RUNS; r++) {
  for (const depth of DEPTHS) {
    const res = await run(depth);
    console.log(
      `maxFramesInFlight ${depth}  ${res.fps.toFixed(1).padStart(6)} fps   ` +
        `interval ${ms(res.interval[0])} / ${ms(res.interval[1])}   ` +
        `fence ${ms(res.fence[0])} / ${ms(res.fence[1])}   ` +
        `clock=${res.clock} frameInterval=${res.frameInterval.toFixed(2)}`
    );
    // a server that resets when its last client leaves (Xvfb without
    // -noreset) drops a connection that arrives while it does
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}
console.log('');
