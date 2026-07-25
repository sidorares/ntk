import { createClient } from '../lib/index.js';

const app = await createClient();
const wnd = app.createWindow({ width: 800, height: 600 });
const ctx = wnd.getContext('2d');

let text = 'This is Test test';

wnd.on('expose', (ev) => {
  ctx.fillStyle = 'white';
  ctx.fillRect(ev.x, ev.y, ev.width, ev.height);
  ctx.font = "50px 'Times New Roman'";
  const w = ctx.measureText(text).width;
  ctx.fillStyle = ctx
    .createLinearGradient(0, 0, w, 100)
    .addColorStop(0, 'red')
    .addColorStop(1, 'blue');
  ctx.fillText(text, 100, 100);
});

wnd.on('keydown', (ev) => {
  if (ev.codepoint === 8) text = text.slice(0, -1);
  else if (ev.codepoint) text += String.fromCodePoint(ev.codepoint);
  wnd.emit('expose', { x: 0, y: 0, width: wnd.width, height: wnd.height });
});

wnd.map();
