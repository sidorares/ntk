// KaTeX formula rendering + the vector text path.
//
// Formulas are laid out with layoutTex (KaTeX tree -> batched glyph
// composition). The headline below zooms continuously: fractional,
// never-repeating sizes route to the trapezoid path (issue #45), so no
// glyph bitmaps are uploaded or cached for the animation.
import { createClient, layoutTex } from '../lib/index.js';

const app = await createClient();
const wnd = app.createWindow({ width: 720, height: 420, title: 'ntk tex' });
const ctx = wnd.getContext('2d');

const formulas = [
  '\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}',
  '\\sum_{i=0}^{n} i = \\frac{n(n+1)}{2}',
  'e^{i\\pi} + 1 = 0',
  'A = \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
  '\\varphi = \\frac{1+\\sqrt{5}}{2}'
];
let current = 0;

let t = 0;
function draw() {
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, wnd.width, wnd.height);

  const box = layoutTex(formulas[current], { size: 36, displayMode: true, color: '#222' });
  box.draw(ctx, (wnd.width - box.width) / 2, 60);

  // continuously animated fractional size -> vector (trapezoid) rendering
  const size = 170 + 40 * Math.sin(t / 30);
  ctx.font = `${size}px serif`;
  ctx.fillStyle = '#1b4b91';
  ctx.textAlign = 'center';
  ctx.fillText('Aa', wnd.width / 2, 340);
  ctx.textAlign = 'start';
}

wnd.on('expose', draw);
wnd.on('mousedown', () => {
  current = (current + 1) % formulas.length; // click: next formula
  draw();
});
setInterval(() => {
  t++;
  draw();
}, 1000 / 30);

wnd.map();
console.log('click the window to cycle formulas');
