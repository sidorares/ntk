export default {
  id: 'gradient',
  title: 'Gradients',
  description:
    'Linear and radial gradients rendered server-side by XRender, plus a pointer-driven one.',
  code: `const { createClient } = require('ntk');

async function main() {
  const app = await createClient();
  const wnd = app.createWindow({
    x: 30, y: 20, width: 560, height: 420,
    title: 'gradients'
  });
  const ctx = wnd.getContext('2d');

  function draw() {
    ctx.fillStyle = '#101820';
    ctx.fillRect(0, 0, wnd.width, wnd.height);

    // linear gradient bar
    const linear = ctx.createLinearGradient(24, 0, 536, 0);
    linear.addColorStop(0, '#ff595e');
    linear.addColorStop(0.25, '#ffca3a');
    linear.addColorStop(0.5, '#8ac926');
    linear.addColorStop(0.75, '#1982c4');
    linear.addColorStop(1, '#6a4c93');
    ctx.fillStyle = linear;
    ctx.fillRect(24, 24, 512, 72);

    // radial highlight
    const radial = ctx.createRadialGradient(160, 240, 8, 160, 240, 110);
    radial.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
    radial.addColorStop(0.3, '#1982c4');
    radial.addColorStop(1, 'rgba(16, 24, 32, 0)');
    ctx.fillStyle = radial;
    ctx.fillRect(30, 120, 260, 240);

    ctx.fillStyle = '#e8ecf0';
    ctx.font = '14px sans-serif';
    ctx.fillText('gradients are composited by the X server (XRender),', 320, 200);
    ctx.fillText('not rasterized by the client —', 320, 222);
    ctx.fillText('move the pointer over the window', 320, 244);
  }

  wnd.on('expose', draw);

  // a gradient that follows the pointer, like the README sample
  wnd.on('mousemove', (ev) => {
    const g = ctx.createRadialGradient(ev.x, ev.y, 4, ev.x, ev.y, 90);
    g.addColorStop(0, 'rgba(255, 183, 3, 0.9)');
    g.addColorStop(1, 'rgba(255, 183, 3, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(ev.x - 90, ev.y - 90, 180, 180);
  });

  wnd.map();
}

main().catch(console.error);
`,
};
