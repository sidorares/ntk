// Draw with the mouse; what you draw becomes the window's icon.
//
//   node examples/wm-icon.js            draw with the mouse
//   node examples/wm-icon.js --selftest draw a fixed pattern, verify, exit
//
// Keys: c clears the pad, s saves the published icon to /tmp as a PNG.
//
// The interesting part is how little there is of it. `_NET_WM_ICON` wants
// straight (non-premultiplied) ARGB packed into CARD32s, and this walks a
// drawing all the way there without converting anything by hand:
//
//   composite the pad into a depth-32 pixmap -> getImageData() -> setIcon()
//
// `getImageData` hands back straight RGBA and `setIcon` takes straight RGBA,
// so all three conversions between an XRender surface and an EWMH icon —
// the server's image_byte_order, the visual's channel masks, and
// premultiplied versus straight alpha — happen inside ntk. When this example
// was first written the two APIs disagreed and it carried thirty lines of
// bit-twiddling in their place.

import { createClient, Pixmap, Picture } from '../lib/index.js';

const ICON = 128; // the _NET_WM_ICON size we publish
const PAD = 256; // on-screen drawing pad, square
const PAD_X = 40;
const PAD_Y = 96;

const selftest = process.argv.includes('--selftest');

const app = await createClient();
const X = app.X;
const Render = app.display.Render;

const wnd = app.createWindow({
  title: 'ntk — draw your own icon',
  width: 480,
  height: 400
});
const ctx = wnd.getContext('2d');

// The icon scratch surface. Depth 32 so alpha is real — the window itself is
// depth 24 here, and a depth-24 drawable's fourth byte is padding rather than
// opacity — and its context reads back as straight RGBA, which is exactly
// what setIcon takes.
const iconPixmap = new Pixmap(app, { depth: 32, width: ICON, height: ICON });
const iconCtx = iconPixmap.getContext('2d');

// A round alpha mask, built here and uploaded once. Antialiased on purpose:
// the partial alphas around the rim are what would look wrong if anything in
// the chain forgot to un-premultiply, so they are worth having.
const maskPixmap = new Pixmap(app, { depth: 8, width: ICON, height: ICON });
const maskPicture = new Picture(app, { drawable: maskPixmap, format: Render.a8 });
{
  const mask = Buffer.alloc(ICON * ICON);
  const c = (ICON - 1) / 2;
  // inset from the edge: a disc inscribed exactly in the pad would have its
  // antialiased rim land on the pad's own boundary, where the bilinear
  // downscale is already blending the paper with the window behind it
  const r = ICON / 2 - 6;
  for (let y = 0; y < ICON; y++) {
    for (let x = 0; x < ICON; x++) {
      let hits = 0; // 4x4 supersample of the disc
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const dx = x + (sx + 0.5) / 4 - 0.5 - c;
          const dy = y + (sy + 0.5) / 4 - 0.5 - c;
          if (dx * dx + dy * dy <= r * r) hits++;
        }
      }
      mask[y * ICON + x] = Math.round((hits / 16) * 255);
    }
  }
  const gc8 = X.AllocID();
  X.CreateGC(gc8, maskPixmap.id);
  X.PutImage(2, maskPixmap.id, gc8, ICON, ICON, 0, 0, 0, 8, mask);
}

/** scale the pad into the icon surface and publish it */
async function publishIcon() {
  const src = ctx.picture; // the window's backing picture

  // start from fully transparent so the mask's rim leaves real partial alpha
  Render.FillRectangles(Render.PictOp.Src, iconCtx.picture.id, [0, 0, 0, 0], [0, 0, ICON, ICON]);

  // dest pixel (i, j) samples (PAD_X + i*PAD/ICON, PAD_Y + j*PAD/ICON)
  Render.SetPictureTransform(src.id, [PAD / ICON, 0, PAD_X, 0, PAD / ICON, PAD_Y, 0, 0, 1]);
  src.setFilter('bilinear');
  Render.Composite(
    Render.PictOp.Src,
    src.id,
    maskPicture.id,
    iconCtx.picture.id,
    0, 0, // src
    0, 0, // mask
    0, 0, // dst
    ICON, ICON
  );
  Render.SetPictureTransform(src.id, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  src.setFilter('nearest');

  await wnd.setIcon(await iconCtx.getImageData(0, 0, ICON, ICON));
}

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------
const strokes = [];
let current = null;

function paint() {
  ctx.fillStyle = '#1d2021';
  ctx.fillRect(0, 0, wnd.width, wnd.height);

  ctx.fillStyle = '#ebdbb2';
  ctx.font = '16px sans-serif';
  ctx.fillText('draw in the square — it becomes this window’s icon', 40, 40);
  ctx.fillStyle = '#928374';
  ctx.font = '13px sans-serif';
  ctx.fillText('c clear    s save the published icon as a png', 40, 62);

  ctx.fillStyle = '#fbf1c7';
  ctx.fillRect(PAD_X, PAD_Y, PAD, PAD);

  ctx.save();
  ctx.beginPath();
  ctx.rect(PAD_X, PAD_Y, PAD, PAD);
  ctx.clip();
  ctx.strokeStyle = '#cc241d';
  ctx.lineWidth = 9;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    if (s.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(s[0][0], s[0][1]);
    for (let i = 1; i < s.length; i++) ctx.lineTo(s[i][0], s[i][1]);
    ctx.stroke();
  }
  ctx.restore();

  // Where the icon gets cropped. Drawn a few pixels *outside* the crop on
  // purpose: the mask alpha is already 0 out here, so the guide shows the
  // boundary without ending up sampled into the icon itself.
  ctx.strokeStyle = '#928374';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(PAD_X + PAD / 2, PAD_Y + PAD / 2, PAD / 2 - 6, 0, Math.PI * 2);
  ctx.stroke();
}

const inPad = (ev) =>
  ev.x >= PAD_X && ev.x < PAD_X + PAD && ev.y >= PAD_Y && ev.y < PAD_Y + PAD;

let pending = null;
function scheduleIcon() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    publishIcon().catch((err) => console.error('icon publish failed:', err.message));
  }, 80);
}

wnd.on('draw', paint);
wnd.on('expose', paint);

wnd.on('mousedown', (ev) => {
  if (!inPad(ev)) return;
  current = [[ev.x, ev.y]];
  strokes.push(current);
});
wnd.on('mousemove', (ev) => {
  if (!current) return;
  // motion is coalesced per frame; ev.coalesced is the whole trail including
  // ev itself, so fast strokes keep their shape instead of going polygonal
  for (const p of ev.coalesced ?? [ev]) current.push([p.x, p.y]);
  paint();
  scheduleIcon();
});
wnd.on('mouseup', () => {
  if (!current) return;
  current = null;
  scheduleIcon();
});

wnd.on('keydown', async (ev) => {
  const key = String.fromCodePoint(ev.codepoint ?? 0).toLowerCase();
  if (key === 'c') {
    strokes.length = 0;
    paint();
    scheduleIcon();
  } else if (key === 's') {
    await savePublishedIcon('/tmp/ntk-wm-icon.png');
  }
});

/**
 * Read the icon back off the server — the same call a window manager makes —
 * and write it out, so the round trip is checked rather than assumed.
 */
async function savePublishedIcon(path) {
  const icons = await wnd.getIcon();
  if (!icons) {
    console.log('no _NET_WM_ICON set yet');
    return null;
  }
  const { PNG } = await import('pngjs');
  const { writeFileSync } = await import('node:fs');
  const icon = icons[0];
  const png = new PNG({ width: icon.width, height: icon.height });
  png.data.set(icon.data);
  writeFileSync(path, PNG.sync.write(png));
  console.log(`wrote ${path} (${icon.width}x${icon.height})`);
  return icon;
}

// ---------------------------------------------------------------------------
paint();
console.log(
  `window 0x${wnd.id.toString(16)} — image_byte_order=${app.display.image_byte_order} ` +
    `connection byte_order=${app.display.byte_order} ` +
    `window depth=${wnd.depth || app.display.screen[0].root_depth}`
);

if (selftest) {
  // a fixed pattern instead of the mouse: three strokes, so the read-back can
  // be checked against known colours
  strokes.push([[PAD_X + 40, PAD_Y + 60], [PAD_X + 216, PAD_Y + 60]]);
  strokes.push([[PAD_X + 40, PAD_Y + 128], [PAD_X + 216, PAD_Y + 196]]);
  strokes.push([[PAD_X + 128, PAD_Y + 40], [PAD_X + 128, PAD_Y + 216]]);
  paint();
  await new Promise((r) => setTimeout(r, 250)); // let the strokes land
  await publishIcon();
  const icon = await savePublishedIcon('/tmp/ntk-wm-icon.png');

  const at = (x, y) => {
    const o = (y * icon.width + x) * 4;
    return [icon.data[o], icon.data[o + 1], icon.data[o + 2], icon.data[o + 3]];
  };
  const near = (got, want, tol = 12) => want.every((v, i) => Math.abs(got[i] - v) <= tol);

  const centre = at(64, 64); // on the red cross
  const paper = at(20, 100); // pad background, clear of every stroke
  const corner = at(2, 2); // outside the disc
  console.log('centre (expect ~204,36,29,255):', centre);
  console.log('paper  (expect ~251,241,199,255):', paper);
  console.log('corner (expect 0,0,0,0):', corner);

  // The premultiply check, and the only one that would notice the alpha
  // conversion being skipped. Find a rim pixel with partial alpha and compare
  // it to the opaque pixel 8px further in along the same radius: straight
  // they are the same colour, premultiplied the rim is scaled by its alpha.
  const c = (ICON - 1) / 2;
  let rim = null;
  let inner = null;
  for (let y = 0; y < ICON && !rim; y++) {
    for (let x = 0; x < ICON; x++) {
      const p = at(x, y);
      if (p[3] < 60 || p[3] > 200) continue;
      const len = Math.hypot(x - c, y - c) || 1;
      const q = at(Math.round(x - ((x - c) / len) * 8), Math.round(y - ((y - c) / len) * 8));
      if (q[3] !== 255) continue;
      rim = p;
      inner = q;
      break;
    }
  }
  console.log('rim    (partial alpha):', rim, ' 8px inward (opaque):', inner);
  const premultipliedWouldBe = rim && [
    Math.round((inner[0] * rim[3]) / 255),
    Math.round((inner[1] * rim[3]) / 255),
    Math.round((inner[2] * rim[3]) / 255)
  ];
  if (rim) {
    console.log(`  straight (what EWMH wants) ~ ${inner.slice(0, 3)}`);
    console.log(`  premultiplied would be     ~ ${premultipliedWouldBe}`);
  }

  const ok =
    near(centre, [204, 36, 29, 255]) &&
    near(paper, [251, 241, 199, 255]) &&
    near(corner, [0, 0, 0, 0]) &&
    !!rim &&
    near(rim.slice(0, 3), inner.slice(0, 3), 30) &&
    !near(rim.slice(0, 3), premultipliedWouldBe, 30);
  console.log(ok ? '\nSELFTEST PASS' : '\nSELFTEST FAIL');
  await app.close();
  process.exit(ok ? 0 : 1);
}
