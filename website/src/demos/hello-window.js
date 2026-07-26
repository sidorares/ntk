export default {
  id: 'hello-window',
  title: 'Hello window',
  description:
    'Create and map a window with a title, then draw text with the canvas-like 2d context.',
  code: `const { createClient } = require('ntk');

async function main() {
  const app = await createClient();
  const wnd = app.createWindow({
    x: 60, y: 40, width: 480, height: 300,
    title: 'hello from ntk'
  });
  const ctx = wnd.getContext('2d');

  // 'expose' fires whenever the window needs painting (first map, resize)
  wnd.on('expose', () => {
    ctx.fillStyle = '#f2f5f8';
    ctx.fillRect(0, 0, wnd.width, wnd.height);

    ctx.fillStyle = '#1c4e80';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText('Hello from ntk', 32, 96);

    ctx.fillStyle = '#445';
    ctx.font = '15px sans-serif';
    ctx.fillText('This window lives on a JavaScript X server', 32, 138);
    ctx.fillText('running right here in your browser.', 32, 160);

    ctx.strokeStyle = '#ffb703';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(32, 112);
    ctx.lineTo(258, 112);
    ctx.stroke();
  });

  wnd.map();
  console.log('window mapped, id ' + wnd.id);
}

main().catch(console.error);
`,
};
