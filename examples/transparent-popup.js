// Rounded transparent popup using a 32-bit ARGB visual and the compositor's
// alpha blending.  Needs a running compositor (picom, kwin, mutter, …);
// without one transparent regions render black.  XQuartz has no 32-bit
// visuals, so this is Linux-only.
//
//   node examples/transparent-popup.js

import { createClient } from '../lib/index.js';

const app = await createClient();
const argb = app.findArgbVisual();
if (!argb) {
  console.error('no 32-bit TrueColor visual — compositor + depth-32 support required');
  process.exit(1);
}

const W = 320;
const H = 180;
const R = 16;

const win = app.createWindow({
  ...argb,
  overrideRedirect: true,
  backgroundPixel: 0,
  width: W,
  height: H,
  x: 200,
  y: 200,
});

const ctx = win.getContext('2d');

win.on('draw', () => {
  // clear to fully transparent
  ctx.clearRect(0, 0, W, H);

  // --- drop shadow (offset, blurred via stacked translucent rounds) ---
  for (let i = 6; i > 0; i--) {
    ctx.fillStyle = `rgba(0, 0, 0, ${0.02})`;
    ctx.beginPath();
    ctx.roundRect(i, i + 2, W - 1, H - 1, R + i);
    ctx.fill();
  }

  // --- popup body: rounded rectangle with slight transparency ---
  ctx.fillStyle = 'rgba(32, 32, 36, 0.92)';
  ctx.beginPath();
  ctx.roundRect(0, 0, W, H, R);
  ctx.fill();

  // --- 1 px border for definition ---
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(0.5, 0.5, W - 1, H - 1, R - 0.5);
  ctx.stroke();

  // --- title text ---
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.font = '15px sans-serif';
  ctx.fillText('Transparent popup', 20, 36);

  // --- body text ---
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.font = '13px sans-serif';
  ctx.fillText('ARGB visual · compositor alpha blending', 20, 64);
  ctx.fillText('No Shape extension — antialiased edges', 20, 84);

  // --- colour swatches showing alpha blending ---
  const swatches = [
    'rgba(239, 68, 68, 0.8)',
    'rgba(34, 197, 94, 0.8)',
    'rgba(59, 130, 246, 0.8)',
    'rgba(250, 204, 21, 0.8)',
  ];
  swatches.forEach((colour, i) => {
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.roundRect(20 + i * 52, 110, 40, 40, 8);
    ctx.fill();
  });
});

win.on('mousedown', () => {
  app.close();
});

win.map();
console.log('transparent popup mapped — click it to close');
