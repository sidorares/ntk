export default {
  id: 'pointer-paint',
  title: 'Pointer paint',
  description:
    'mousedown/mousemove/mouseup handling: click and drag inside the screen to paint.',
  code: `const { createClient } = require('ntk');

async function main() {
  const app = await createClient();
  const wnd = app.createWindow({
    x: 0, y: 0, width: 640, height: 480,
    title: 'pointer paint'
  });
  const ctx = wnd.getContext('2d');

  const colors = ['#d0342c', '#1c4e80', '#2e8540', '#b8860b', '#7d3c98'];
  let colorNo = 0;
  let painting = false;
  let last = null;

  wnd.on('expose', () => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, wnd.width, wnd.height);
    ctx.fillStyle = '#888';
    ctx.font = '14px sans-serif';
    ctx.fillText('drag to paint, release to change color', 16, 26);
  });

  function stroke(x, y) {
    ctx.strokeStyle = colors[colorNo];
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.fillStyle = colors[colorNo];
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    last = { x, y };
  }

  wnd.on('mousedown', (ev) => {
    painting = true;
    last = { x: ev.x, y: ev.y };
    stroke(ev.x, ev.y);
  });

  wnd.on('mouseup', () => {
    painting = false;
    colorNo = (colorNo + 1) % colors.length;
  });

  // mousemove is coalesced per frame; ev.coalesced holds the full trail
  wnd.on('mousemove', (ev) => {
    if (!painting) return;
    for (const p of ev.coalesced || [ev]) stroke(p.x, p.y);
  });

  wnd.map();
}

main().catch(console.error);
`,
};
