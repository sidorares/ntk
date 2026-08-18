// Drop shadows (ntk#272): shadowColor / shadowBlur / shadowOffsetX / Y.
//
// Left/right change the blur, up/down the offset. The point of making it
// interactive: a text shadow's coverage is cached by (text, font, blur), so
// sliding the *offset* redraws with no new server-side work at all, while
// sliding the blur builds one coverage surface per distinct value.
//
// usage: node shadows.js
import { createClient } from '../lib/index.js';

const BG = '#eef1f6';
const CARD = '#ffffff';
const INK = '#1b2130';
const MUTED = '#6b7688';
const ACCENT = '#2f6feb';
const WARM = '#e8853a';
const SHADOW = 'rgba(20, 26, 40, 0.55)';

const app = await createClient();
const wnd = app.createWindow({
  title: 'ntk shadows — left/right blur, up/down offset',
  width: 820,
  height: 430
});
wnd.map();
const ctx = wnd.getContext('2d');

let blur = 14;
let offset = 6;

function draw() {
  const { width, height } = wnd;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, height);

  // a font specimen: the case the feature came from
  ctx.save();
  ctx.shadowColor = SHADOW;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = offset;
  ctx.shadowOffsetY = offset;
  ctx.font = '64px sans-serif';
  ctx.fillStyle = ACCENT;
  ctx.fillText('Specimen', 40, 96);
  ctx.restore();

  ctx.font = '13px sans-serif';
  ctx.fillStyle = MUTED;
  ctx.fillText(
    `shadowBlur ${blur} (sigma ${blur / 2})   shadowOffsetX/Y ${offset}`,
    42,
    126
  );

  // the same shape at four blurs, so the scale is visible at a glance
  [0, 6, 14, 30].forEach((b, i) => {
    const x = 40 + i * 195;
    ctx.save();
    ctx.shadowColor = SHADOW;
    ctx.shadowBlur = b;
    ctx.shadowOffsetX = 4;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = CARD;
    ctx.beginPath();
    ctx.roundRect(x, 165, 170, 84, 12);
    ctx.fill();
    ctx.restore();

    ctx.font = '17px sans-serif';
    ctx.fillStyle = INK;
    ctx.fillText(`shadowBlur ${b}`, x + 20, 206);
    ctx.font = '13px sans-serif';
    ctx.fillStyle = MUTED;
    ctx.fillText(`sigma ${b / 2}`, x + 20, 226);
  });

  // and it follows any drawing, not just boxes and text
  ctx.save();
  ctx.shadowColor = SHADOW;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = offset;
  ctx.shadowOffsetY = offset;
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(60, 390);
  ctx.lineTo(140, 310);
  ctx.lineTo(220, 370);
  ctx.lineTo(300, 305);
  ctx.stroke();

  ctx.fillStyle = WARM;
  ctx.beginPath();
  ctx.arc(390, 350, 40, 0, Math.PI * 2);
  ctx.fill();

  ctx.font = '30px sans-serif';
  ctx.fillStyle = INK;
  ctx.fillText('strokes, arcs, text', 460, 362);
  ctx.restore();
}

// arrows type no character, so they arrive as keysyms rather than codepoints
const LEFT = 0xff51;
const UP = 0xff52;
const RIGHT = 0xff53;
const DOWN = 0xff54;
const ESCAPE = 0xff1b;

wnd.on('expose', draw);
wnd.on('keydown', (ev) => {
  const typed = String.fromCodePoint(ev.codepoint ?? 0).toLowerCase();
  if (ev.baseKeysym === LEFT) blur = Math.max(0, blur - 2);
  else if (ev.baseKeysym === RIGHT) blur = Math.min(60, blur + 2);
  else if (ev.baseKeysym === UP) offset = Math.max(-40, offset - 2);
  else if (ev.baseKeysym === DOWN) offset = Math.min(40, offset + 2);
  else if (typed === 'q' || ev.baseKeysym === ESCAPE) return app.close();
  else return;
  draw();
});
wnd.on('close', () => app.close());
