// requestAnimationFrame demo: a bouncing ball driven by the window's frame
// clock. Locally this runs at ~60fps; over a slow (e.g. ssh-forwarded)
// connection it self-throttles to one frame per server round-trip instead
// of queueing a trail of stale frames. The title shows the measured
// latency (wnd.frameLatency) and achieved frame rate.
import { createClient } from '../lib/index.js';

const app = await createClient();
const wnd = app.createWindow({ title: 'animation', width: 400, height: 300 });
const ctx = wnd.getContext('2d');
wnd.map();

const ball = { x: 60, y: 60, dx: 3.2, dy: 2.1, r: 14 };
let frames = 0;
let lastNow = performance.now();

setInterval(() => {
  const latency = wnd.frameLatency == null ? '?' : wnd.frameLatency.toFixed(1);
  wnd.setTitle(`animation — ${frames} fps, latency ${latency} ms`);
  frames = 0;
}, 1000).unref();

function frame(now) {
  // scale movement by elapsed time so speed survives frame-rate changes
  const dt = Math.min((now - lastNow) / 16, 8);
  lastNow = now;
  frames++;

  ball.x += ball.dx * dt;
  ball.y += ball.dy * dt;
  if (ball.x < ball.r || ball.x > wnd.width - ball.r) ball.dx *= -1;
  if (ball.y < ball.r || ball.y > wnd.height - ball.r) ball.dy *= -1;
  ball.x = Math.min(Math.max(ball.x, ball.r), wnd.width - ball.r);
  ball.y = Math.min(Math.max(ball.y, ball.r), wnd.height - ball.r);

  ctx.fillStyle = '#f0f0f8';
  ctx.fillRect(0, 0, wnd.width, wnd.height);
  ctx.fillStyle = '#d04030';
  ctx.beginPath();
  ctx.moveTo(ball.x + ball.r, ball.y);
  // approximate a circle with a polygon (canvas arc() is not implemented yet)
  for (let a = 0; a <= 20; a++) {
    const t = (a / 20) * Math.PI * 2;
    ctx.lineTo(ball.x + Math.cos(t) * ball.r, ball.y + Math.sin(t) * ball.r);
  }
  ctx.fill();

  wnd.requestAnimationFrame(frame);
}

wnd.requestAnimationFrame(frame);
