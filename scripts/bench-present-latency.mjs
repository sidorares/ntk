// How long does a repaint take to reach the display, when it is triggered
// part-way through a frame rather than at one? (issue #223)
//
//   node scripts/bench-present-latency.mjs [samples] [--quiet]     # default 60
//
// A present with Option.Copy leaves the server owning the backing pixmap
// until it executes the copy at a vertical blank, so a repaint raised in
// between — a click during a scroll, a keystroke while something moves —
// waits for the completion before its pixels can go out. That wait is up to
// one refresh period, and this measures it against the fence clock, which
// does not wait but also cannot say when the pixels landed.
//
// The measurement is end to end: from the moment the repaint is made, to the
// server reporting that the frame carrying it was executed on the display.
// Each present's serial is matched to the CompleteNotify that reports it, so
// nothing is inferred from timers. The fence-clocked window selects for
// completions too — it just does not pace on them — so both arms are
// measured the same way.
//
// Needs a real X server ($DISPLAY). Under a Wayland compositor, run it on a
// window you can see: a compositor answers an occluded window about once a
// second, and the numbers then describe the throttle rather than the clock.
//
// Read the difference, not either column: both arms pay for the wait for a
// vertical blank and only one of them pays the extra wait, so the absolute
// numbers carry a period's worth of offset that is not the thing being
// measured. And read it from enough samples — the spread between runs is
// around 1.5 ms at 60 samples, so a single short run cannot resolve a
// difference of that size, and an early draft of this bench reported a
// penalty 2.5x the reproducible one from 26 samples.
import { performance } from 'node:perf_hooks';

import { createClient } from '../lib/index.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const SAMPLES = Math.max(20, Number(args[0]) || 60);
const QUIET = process.argv.includes('--quiet');

if (!process.env.DISPLAY) {
  console.error('bench-present-latency: needs $DISPLAY (try: xvfb-run -a node scripts/bench-present-latency.mjs)');
  process.exit(1);
}

const percentile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

async function measure(label, args) {
  const app = await createClient();
  const wnd = app.createWindow({ width: 400, height: 300, ...args });
  wnd.map();
  const ctx = wnd.getContext('2d');
  await wnd.enablePresent();
  const present = wnd._presentExt;
  if (!present) {
    console.log(`${label.padEnd(18)} no Present extension on this server`);
    await app.close();
    return;
  }
  // A fence-clocked window asks for no completions of its own, so give it
  // an event context here — it reports the same landings, it just isn't
  // waiting on them.
  if (!wnd._presentEid) {
    present.SelectInput(app.X.AllocID(), wnd.id, present.EventMask.CompleteNotify);
  }
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Something has to be animating, or there is no frame in flight to be
  // caught in the middle of and both clocks answer immediately.
  let tick = 0;
  const spin = () => {
    tick++;
    ctx.fillStyle = tick % 2 ? '#202030' : '#202032';
    ctx.fillRect(0, 0, 400, 40);
    wnd.requestAnimationFrame(spin);
  };
  wnd.requestAnimationFrame(spin);

  const waiting = new Map(); // present serial -> when the repaint was made
  let raisedAt = null;
  const sendPixmap = present.Pixmap.bind(present);
  present.Pixmap = (win, pixmap, opts) => {
    if (raisedAt !== null) {
      waiting.set(opts.serial, raisedAt);
      raisedAt = null;
    }
    return sendPixmap(win, pixmap, opts);
  };

  const samples = [];
  wnd.on('event', (ev) => {
    // CompleteNotify for a PresentPixmap: evtype 1, kind 0
    if (ev.type !== 35 || ev.evtype !== 1 || ev.kind !== 0) return;
    const at = waiting.get(ev.serial);
    if (at === undefined) return;
    waiting.delete(ev.serial);
    samples.push(performance.now() - at);
  });

  for (let i = 0; i < SAMPLES; i++) {
    // varying the gap walks the repaint across the frame's phase, which is
    // the whole point: a repaint that lands on a frame boundary waits for
    // nothing on either clock
    await new Promise((resolve) => setTimeout(resolve, 7 + (i % 5)));
    raisedAt = performance.now();
    ctx.fillStyle = '#e0b040';
    ctx.fillRect(100, 100, 60, 60);
  }
  await new Promise((resolve) => setTimeout(resolve, 300));

  samples.sort((a, b) => a - b);
  if (!samples.length) {
    console.log(`${label.padEnd(18)} no frames landed — is the window visible?`);
  } else {
    const ms = (v) => v.toFixed(2).padStart(6);
    console.log(
      `${label.padEnd(18)} n=${String(samples.length).padStart(3)}  ` +
        `median ${ms(percentile(samples, 0.5))}  p90 ${ms(percentile(samples, 0.9))}  ` +
        `max ${ms(samples.at(-1))}   ` +
        `clock=${wnd.frameClock} refresh=${wnd.refreshInterval?.toFixed(1) ?? 'n/a'} dropped=${wnd.droppedFrames}`
    );
  }
  if (wnd.refreshInterval) vblankPeriod = wnd.refreshInterval.toFixed(1);
  wnd.destroy();
  await app.close();
  return samples;
}

if (!QUIET) {
  console.log(
    '\nrepaint raised mid-frame -> reported on the display, in ms\n' +
      'the gap between the two is what a second backing pixmap would buy back (#223)\n'
  );
}
let vblankPeriod = null;
const vblank = await measure('vblank clock', {});
const fence = await measure('fence clock', { frameClock: 'fence' });

if (!QUIET && vblank?.length && fence?.length) {
  const delta = percentile(vblank, 0.5) - percentile(fence, 0.5);
  console.log(
    `\npenalty at the median: ${delta.toFixed(2)} ms` +
      ` — against a ${vblankPeriod ?? '?'} ms refresh period. Runs vary by around 1.5 ms;\n` +
      'take a difference smaller than that as no difference.\n'
  );
}
