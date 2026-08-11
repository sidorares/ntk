// Smooth scrolling: the same list scrolled by core wheel notches and by XI2
// scroll valuators, side by side, so the difference is visible rather than
// described. The left half stays on the core protocol, the right half has
// XI2 selected — scroll over each with a touchpad and the right one moves in
// fractions of a notch while the left one jumps a whole line at a time.
//
// The readout under each column is the last delta it was handed.
import { createClient } from '../lib/index.js';

const LINE = 22;
const ROWS = 60;

const app = await createClient();
const wnd = app.createWindow({ title: 'smooth-scroll', width: 620, height: 420 });
const ctx = wnd.getContext('2d');

// two child windows, so each column has its own event selection: XI2 is
// per window, and the point here is to have both at once
const left = wnd.createWindow({ x: 0, y: 0, width: 310, height: 420 });
const right = wnd.createWindow({ x: 310, y: 0, width: 310, height: 420, xi2: true });

const smooth = await right.selectXI2();
if (!smooth) {
  console.warn('this server has no XI2 — both columns will scroll in whole notches');
}

const columns = [
  { wnd: left, ctx: left.getContext('2d'), title: 'core (button 4/5)', offset: 0, last: null },
  { wnd: right, ctx: right.getContext('2d'), title: 'XI2 (scroll valuators)', offset: 0, last: null }
];

function draw(column) {
  const { ctx: c, wnd: w } = column;
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, w.width, w.height);

  const first = Math.floor(column.offset / LINE);
  const shift = column.offset - first * LINE;
  c.font = '13px sans-serif';
  for (let i = 0; i < Math.ceil(w.height / LINE) + 1; i++) {
    const row = ((first + i) % ROWS + ROWS) % ROWS;
    const y = i * LINE - shift;
    c.fillStyle = row % 2 ? '#f4f4f8' : '#ffffff';
    c.fillRect(0, y, w.width, LINE);
    c.fillStyle = '#303040';
    c.fillText(`row ${String(row).padStart(2, '0')} — the quick brown fox`, 12, y + 15);
  }

  // header and readout
  c.fillStyle = '#202030';
  c.fillRect(0, 0, w.width, 26);
  c.fillRect(0, w.height - 26, w.width, 26);
  c.fillStyle = '#ffffff';
  c.fillText(column.title, 10, 18);
  const d = column.last;
  c.fillText(
    d
      ? `Δy ${d.deltaY.toFixed(3)}  ${d.smooth ? 'smooth' : 'notch'}  (${d.source})`
      : 'scroll over me',
    10,
    w.height - 8
  );
}

for (const column of columns) {
  column.wnd.on('wheel', (ev) => {
    column.last = ev;
    // notches to pixels is the consumer's decision: one notch is one line here
    column.offset += ev.deltaY * LINE;
    draw(column);
  });
  column.wnd.on('expose', () => draw(column));
  column.wnd.map();
}

wnd.on('expose', () => {
  ctx.fillStyle = '#202030';
  ctx.fillRect(0, 0, wnd.width, wnd.height);
});
wnd.map();
