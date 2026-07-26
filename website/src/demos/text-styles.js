export default {
  id: 'text-styles',
  title: 'Text styles',
  description:
    'Sizes, weights and families: text is shaped in pure JS and cached server-side as XRender glyphs. The playground bundles DejaVu Sans/Serif/Mono.',
  code: `const { createClient } = require('ntk');

async function main() {
  const app = await createClient();
  const wnd = app.createWindow({
    x: 30, y: 20, width: 580, height: 430,
    title: 'text styles'
  });
  const ctx = wnd.getContext('2d');

  wnd.on('expose', () => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, wnd.width, wnd.height);
    ctx.fillStyle = '#222';

    // sizes
    let y = 48;
    for (const size of [12, 16, 22, 30]) {
      ctx.font = size + 'px sans-serif';
      ctx.fillText(size + 'px — the quick brown fox', 28, y);
      y += size + 14;
    }

    // weights and styles (DejaVu Sans regular/bold/oblique are bundled)
    ctx.font = '18px sans-serif';
    ctx.fillText('normal', 28, 240);
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText('bold', 128, 240);
    ctx.font = 'italic 18px sans-serif';
    ctx.fillText('italic', 208, 240);
    ctx.font = 'bold italic 18px sans-serif';
    ctx.fillText('bold italic', 298, 240);

    // families
    ctx.font = '18px sans-serif';
    ctx.fillText('sans-serif — DejaVu Sans', 28, 290);
    ctx.font = '18px serif';
    ctx.fillText('serif — DejaVu Serif', 28, 320);
    ctx.font = '16px monospace';
    ctx.fillText('monospace — DejaVu Sans Mono', 28, 350);

    // gradient-filled headline: glyphs are just another XRender mask
    const g = ctx.createLinearGradient(28, 380, 460, 410);
    g.addColorStop(0, '#d00000');
    g.addColorStop(0.5, '#ffba08');
    g.addColorStop(1, '#1982c4');
    ctx.fillStyle = g;
    ctx.font = 'bold 34px sans-serif';
    ctx.fillText('gradient text', 28, 408);
  });

  wnd.map();
}

main().catch(console.error);
`,
};
