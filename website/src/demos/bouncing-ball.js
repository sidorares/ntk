export default {
  id: 'bouncing-ball',
  title: 'Bouncing ball',
  description:
    'Animation with requestAnimationFrame: frames are paced by server round-trips, and the ball is shaded with a radial gradient.',
  code: `const { createClient } = require('ntk');

async function main() {
  const app = await createClient();
  const wnd = app.createWindow({
    x: 50, y: 40, width: 520, height: 380,
    title: 'bouncing ball'
  });
  const ctx = wnd.getContext('2d');
  wnd.map();

  const ball = { x: 90, y: 70, dx: 3.4, dy: 2.3, r: 26 };
  let lastNow = null;

  function frame(now) {
    // scale movement by elapsed time so speed survives frame-rate changes
    const dt = lastNow == null ? 1 : Math.min((now - lastNow) / 16, 8);
    lastNow = now;

    ball.x += ball.dx * dt;
    ball.y += ball.dy * dt;
    if (ball.x < ball.r || ball.x > wnd.width - ball.r) ball.dx *= -1;
    if (ball.y < ball.r || ball.y > wnd.height - ball.r) ball.dy *= -1;
    ball.x = Math.min(Math.max(ball.x, ball.r), wnd.width - ball.r);
    ball.y = Math.min(Math.max(ball.y, ball.r), wnd.height - ball.r);

    ctx.fillStyle = '#101820';
    ctx.fillRect(0, 0, wnd.width, wnd.height);

    // radial gradient shading, composited server-side
    const g = ctx.createRadialGradient(
      ball.x - ball.r / 3, ball.y - ball.r / 3, ball.r / 6,
      ball.x, ball.y, ball.r
    );
    g.addColorStop(0, '#ffe08a');
    g.addColorStop(0.7, '#ffb703');
    g.addColorStop(1, '#b45309');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
    ctx.fill();

    wnd.requestAnimationFrame(frame);
  }

  wnd.requestAnimationFrame(frame);
}

main().catch(console.error);
`,
};
