// usage: node fill-styles.js "DejaVu Sans" "Hello"
import { createClient } from '../lib/index.js';

const app = await createClient();
const wnd = app.createWindow({}).map();
const pixmap = wnd.createPixmap({ width: 1800, height: 1800 });
const ctx = pixmap.getContext('2d');
const wndCtx = wnd.getContext('2d');

const conical = ctx.createConicalGradient(100, 100, 45);
conical.addColorStop(0, [1, 0, 0, 1]);
conical.addColorStop(0.5, [1, 1, 0, 1]);
conical.addColorStop(1, [1, 0, 0, 1]);

const linear = ctx.createLinearGradient(0, 0, 100, 500);
linear.addColorStop(0, [1, 0, 0, 0.1]);
linear.addColorStop(0.5, [0, 1, 0, 0.5]);
linear.addColorStop(1, [0, 0, 1, 0.5]);

const family = process.argv[2] || 'sans-serif';
const message = process.argv[3] || 'ntk';

wnd.on('mousemove', (ev) => {
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 1000, 1000);
  ctx.fillStyle = 'black';
  ctx.font = `bold italic 40pt "${family}"`;
  ctx.fillText(message, ev.x - 2, ev.y);
  wndCtx.drawImage(ctx, 0, 0);
});
