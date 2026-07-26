// A tour of the canvas 2d API: paths (arcs, beziers, rounded rects),
// transforms, save/restore, clipping, Path2D (including SVG path data),
// fill rules, globalAlpha, gradients, strokes and text.
import { createClient, Path2D } from '../lib/index.js';

const app = await createClient();
const wnd = app.createWindow({ title: 'ntk canvas demo', width: 640, height: 480 });
const ctx = wnd.getContext('2d');

function draw() {
  const w = wnd.width;
  const h = wnd.height;
  ctx.fillStyle = '#f4f4f4';
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = '#222';
  ctx.font = '15px sans-serif';

  // --- arcs and ellipses ------------------------------------------------
  ctx.fillText('arc / ellipse', 20, 30);
  ctx.fillStyle = '#e5383b';
  ctx.beginPath();
  ctx.arc(60, 80, 30, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0077b6';
  ctx.beginPath();
  ctx.ellipse(140, 80, 20, 35, Math.PI / 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(60, 80, 30, Math.PI * 0.25, Math.PI * 1.25); // open arc stroke
  ctx.stroke();

  // --- bezier / quadratic curves -----------------------------------------
  ctx.fillStyle = '#222';
  ctx.fillText('curves', 220, 30);
  ctx.strokeStyle = '#2d6a4f';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(220, 110);
  ctx.bezierCurveTo(250, 20, 300, 20, 330, 110);
  ctx.quadraticCurveTo(350, 40, 380, 110);
  ctx.stroke();

  // --- roundRect + gradients ----------------------------------------------
  ctx.fillStyle = '#222';
  ctx.fillText('roundRect + gradient', 430, 30);
  const gradient = ctx.createLinearGradient(430, 40, 610, 120);
  gradient.addColorStop(0, '#ffba08');
  gradient.addColorStop(1, '#d00000');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.roundRect(430, 40, 180, 80, 16);
  ctx.fill();

  // --- transforms + save/restore ------------------------------------------
  ctx.fillStyle = '#222';
  ctx.fillText('transforms', 20, 160);
  for (let i = 0; i < 6; i++) {
    ctx.save();
    ctx.translate(90, 230);
    ctx.rotate((i / 6) * Math.PI);
    ctx.scale(1, 0.35);
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = ['#e5383b', '#0077b6', '#2d6a4f'][i % 3];
    ctx.beginPath();
    ctx.ellipse(0, 0, 60, 60, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // --- Path2D + fill rules --------------------------------------------------
  ctx.fillStyle = '#222';
  ctx.fillText('Path2D + evenodd', 220, 160);
  const star = new Path2D(
    'M 300 170 L 318 226 L 262 191 L 338 191 L 282 226 Z' // self-intersecting star
  );
  ctx.fillStyle = '#7b2cbf';
  ctx.fill(star, 'evenodd');
  const ring = new Path2D();
  ring.arc(390, 200, 32, 0, Math.PI * 2);
  ring.arc(390, 200, 16, 0, Math.PI * 2);
  ctx.fillStyle = '#ff6d00';
  ctx.fill(ring, 'evenodd');

  // --- clipping ---------------------------------------------------------------
  ctx.fillStyle = '#222';
  ctx.fillText('clip', 470, 160);
  ctx.save();
  ctx.beginPath();
  ctx.arc(520, 220, 40, 0, Math.PI * 2);
  ctx.clip();
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = i % 2 ? '#001d3d' : '#ffc300';
    ctx.fillRect(470, 172 + i * 12, 110, 12); // stripes clipped to the circle
  }
  ctx.restore();

  // --- strokes: joins, caps, dashes of width ------------------------------------
  ctx.fillStyle = '#222';
  ctx.fillText('strokes', 20, 310);
  const zig = new Path2D();
  zig.moveTo(30, 380);
  zig.lineTo(70, 330);
  zig.lineTo(110, 380);
  zig.lineTo(150, 330);
  ctx.lineJoin = 'miter';
  ctx.lineCap = 'butt';
  ctx.strokeStyle = '#003049';
  ctx.lineWidth = 10;
  ctx.stroke(zig);
  ctx.strokeStyle = '#c1121f';
  ctx.lineWidth = 2;
  ctx.stroke(zig);

  // --- alpha compositing over an image-like backdrop ------------------------------
  ctx.fillStyle = '#222';
  ctx.fillText('globalAlpha', 220, 310);
  ctx.fillStyle = '#013a63';
  ctx.fillRect(220, 330, 120, 60);
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = '#ff477e';
  ctx.beginPath();
  ctx.arc(280, 360, 35, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // --- transformed text anchor ------------------------------------------------------
  ctx.fillStyle = '#222';
  ctx.fillText('text', 430, 310);
  ctx.save();
  ctx.translate(430, 340);
  ctx.font = '28px serif';
  ctx.fillStyle = '#5f0f40';
  ctx.fillText('shaped text', 0, 30);
  ctx.restore();

  // footer: hit testing demo hint
  ctx.font = '13px sans-serif';
  ctx.fillStyle = '#666';
  ctx.fillText('click inside the orange ring — isPointInPath() reports hits', 20, h - 16);
}

const ringHit = new Path2D();
ringHit.arc(390, 200, 32, 0, Math.PI * 2);
ringHit.arc(390, 200, 16, 0, Math.PI * 2);

wnd.on('mousedown', (ev) => {
  const hit = ctx.isPointInPath(ringHit, ev.x, ev.y, 'evenodd');
  console.log(`click at ${ev.x},${ev.y} — inside ring: ${hit}`);
});

wnd.on('resize', draw);
wnd.map();
draw();
