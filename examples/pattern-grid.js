// A pannable graph pane on a tiled background grid (ntk#263): drag to pan.
//
// The grid is a 24x24 tile drawn once into a Surface and repeated by the
// server — one Composite per frame, whatever the pane size. Panning moves
// the pattern rather than redrawing it: the tile's transform takes the scroll
// offset, so the grid stays glued to the nodes on top of it.
//
// usage: node pattern-grid.js [dot|line|cross]
import { createClient, Surface } from '../lib/index.js';

const KIND = process.argv[2] || 'dot';
const PITCH = 24;
const BG = '#12151c';
const GRID = '#2c3444';

const app = await createClient();
const wnd = app.createWindow({ title: 'ntk pattern grid — drag to pan', width: 720, height: 480 });
wnd.map();
const ctx = wnd.getContext('2d');

/** the grid cell, drawn once: everything but the ink stays transparent */
const tile = new Surface(app, { width: PITCH, height: PITCH });
tile.render((c) => {
  c.fillStyle = GRID;
  if (KIND === 'line') {
    c.fillRect(0, 0, PITCH, 1);
    c.fillRect(0, 0, 1, PITCH);
  } else if (KIND === 'cross') {
    c.fillRect(PITCH / 2 - 3, PITCH / 2, 7, 1);
    c.fillRect(PITCH / 2, PITCH / 2 - 3, 1, 7);
  } else {
    c.fillRect(0, 0, 2, 2);
  }
});
const grid = ctx.createPattern(tile, 'repeat');

const nodes = [
  { x: 60, y: 60, w: 140, h: 64, label: 'source' },
  { x: 300, y: 140, w: 140, h: 64, label: 'transform' },
  { x: 120, y: 280, w: 140, h: 64, label: 'sink' },
];

let panX = 0;
let panY = 0;

function draw() {
  const { width, height } = wnd;

  // background: one fill, one request — the pattern carries the pan, so the
  // grid scrolls with the nodes without any of it being redrawn
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, height);
  grid.setTransform([1, 0, 0, 1, panX, panY]);
  ctx.fillStyle = grid;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.translate(panX, panY);
  ctx.strokeStyle = '#4c9aff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(nodes[0].x + nodes[0].w, nodes[0].y + nodes[0].h / 2);
  ctx.lineTo(nodes[1].x, nodes[1].y + nodes[1].h / 2);
  ctx.moveTo(nodes[1].x, nodes[1].y + nodes[1].h / 2);
  ctx.lineTo(nodes[2].x + nodes[2].w, nodes[2].y + nodes[2].h / 2);
  ctx.stroke();

  ctx.font = '14px sans-serif';
  for (const node of nodes) {
    ctx.fillStyle = '#1e2534';
    ctx.beginPath();
    ctx.roundRect(node.x, node.y, node.w, node.h, 8);
    ctx.fill();
    ctx.strokeStyle = '#4c9aff';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#dde3ee';
    ctx.fillText(node.label, node.x + 16, node.y + node.h / 2 + 5);
  }
  ctx.restore();
}

let dragging = null;
wnd.on('mousedown', (ev) => {
  dragging = { x: ev.x - panX, y: ev.y - panY };
});
wnd.on('mouseup', () => {
  dragging = null;
});
wnd.on('mousemove', (ev) => {
  if (!dragging) return;
  panX = ev.x - dragging.x;
  panY = ev.y - dragging.y;
  draw();
});
wnd.on('expose', draw);
wnd.on('resize', draw);
