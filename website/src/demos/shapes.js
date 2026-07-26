export default {
  id: 'shapes',
  title: 'Paths & shapes',
  description:
    'Arcs, beziers, roundRect, transforms and Path2D with SVG path data — filled and stroked.',
  code: `const { createClient, Path2D } = require('ntk');

async function main() {
  const app = await createClient();
  const wnd = app.createWindow({
    x: 20, y: 20, width: 600, height: 440,
    title: 'paths & shapes'
  });
  const ctx = wnd.getContext('2d');

  wnd.on('expose', () => {
    ctx.fillStyle = '#f4f4f4';
    ctx.fillRect(0, 0, wnd.width, wnd.height);

    ctx.fillStyle = '#222';
    ctx.font = '14px sans-serif';

    // arcs and ellipses
    ctx.fillText('arc / ellipse', 24, 30);
    ctx.fillStyle = '#e5383b';
    ctx.beginPath();
    ctx.arc(64, 84, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0077b6';
    ctx.beginPath();
    ctx.ellipse(148, 84, 20, 36, Math.PI / 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(64, 84, 30, Math.PI * 0.25, Math.PI * 1.25);
    ctx.stroke();

    // bezier / quadratic curves
    ctx.fillStyle = '#222';
    ctx.fillText('curves', 230, 30);
    ctx.strokeStyle = '#2d6a4f';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(230, 115);
    ctx.bezierCurveTo(260, 25, 310, 25, 340, 115);
    ctx.quadraticCurveTo(360, 45, 390, 115);
    ctx.stroke();

    // roundRect + gradient fill
    ctx.fillStyle = '#222';
    ctx.fillText('roundRect + gradient', 430, 30);
    const gradient = ctx.createLinearGradient(430, 44, 580, 124);
    gradient.addColorStop(0, '#ffba08');
    gradient.addColorStop(1, '#d00000');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(430, 44, 150, 80, 16);
    ctx.fill();

    // transforms + save/restore + globalAlpha
    ctx.fillStyle = '#222';
    ctx.fillText('transforms', 24, 170);
    for (let i = 0; i < 6; i++) {
      ctx.save();
      ctx.translate(100, 260);
      ctx.rotate((i / 6) * Math.PI);
      ctx.scale(1, 0.35);
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = ['#e5383b', '#0077b6', '#2d6a4f'][i % 3];
      ctx.beginPath();
      ctx.ellipse(0, 0, 64, 64, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Path2D from SVG path data + even-odd fill rule
    ctx.fillStyle = '#222';
    ctx.fillText('Path2D + evenodd', 230, 170);
    const star = new Path2D(
      'M 300 190 L 322 260 L 252 216 L 348 216 L 278 260 Z'
    );
    ctx.fillStyle = '#7b2cbf';
    ctx.fill(star, 'evenodd');
    ctx.strokeStyle = '#3c096c';
    ctx.lineWidth = 2;
    ctx.stroke(star);

    // clipping
    ctx.fillStyle = '#222';
    ctx.fillText('clip', 430, 170);
    ctx.save();
    ctx.beginPath();
    ctx.arc(500, 250, 56, 0, Math.PI * 2);
    ctx.clip();
    for (let i = 0; i < 10; i++) {
      ctx.fillStyle = i % 2 ? '#1982c4' : '#8ac926';
      ctx.fillRect(430, 190 + i * 14, 150, 14);
    }
    ctx.restore();
  });

  wnd.map();
}

main().catch(console.error);
`,
};
