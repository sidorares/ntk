// Draw with the mouse; what you draw becomes the window's icon.
//
// A proof of concept for ntk#118 item 5 (`setIcon` / `_NET_WM_ICON`). The
// property writer is four lines — `wnd.setProperty(name, buf, {type:
// 'CARDINAL', format: 32})` already exists. What is actually open is the
// pixel format, and this example exists to make that concrete: it walks a
// drawing from an XRender surface to an EWMH icon and has to cross three
// separate conversions on the way.
//
//   1. byte order   GetImage hands back bytes in the *server's*
//                   image_byte_order; property CARD32s are read in the
//                   *connection's* byte order. Two different fields.
//   2. channel order which byte is red depends on the source. Off a window
//                   it is the visual's masks. Off a picture whose format we
//                   chose it is fixed by RENDER — see below.
//   3. alpha        XRender is premultiplied. EWMH is not.
//
// The trick this example leans on for (2): rather than reading the window
// (depth 24 here — its fourth byte is padding, not alpha), it composites the
// pad into a depth-32 pixmap through a picture *we* created with
// Render.rgba32. PictStandardARGB32 pins A=24 R=16 G=8 B=0 inside the
// CARD32 regardless of the visual, so only conversions (1) and (3) are left.
//
//   node examples/wm-icon.js            draw with the mouse
//   node examples/wm-icon.js --selftest draw a fixed pattern, verify, exit
//
// Keys: c clears the pad, s saves the published icon to /tmp as a PNG.

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

// ---------------------------------------------------------------------------
// the icon scratch surface: depth 32, so alpha is real, and rgba32 so the
// channel positions inside each CARD32 are fixed by RENDER rather than by
// whatever visual the window happens to have
// ---------------------------------------------------------------------------
const iconPixmap = new Pixmap(app, { depth: 32, width: ICON, height: ICON });
const iconPicture = new Picture(app, { drawable: iconPixmap, format: Render.rgba32 });

// A round alpha mask, built here and uploaded once. Antialiased on purpose:
// the partial alphas around the rim are what make the premultiply conversion
// observable — get it wrong and the edge pixels come out too dark.
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

// ---------------------------------------------------------------------------
// XRender surface -> EWMH _NET_WM_ICON property bytes
// ---------------------------------------------------------------------------
/**
 * Pack a depth-32 GetImage reply into the `width, height, pixel...` CARD32
 * run `_NET_WM_ICON` wants. This is the function a real `setIcon()` would
 * own, and the reason item 5 is a decision rather than a patch.
 */
function toIconProperty(img, width, height, display) {
  const src = img.data;
  const out = Buffer.allocUnsafe(8 + width * height * 4);

  // (1) two different byte orders, and they are genuinely different fields:
  // image_byte_order is the server's pixel order, byte_order is what this
  // connection agreed to speak and therefore how the server will read the
  // property back.
  const readPixel = display.image_byte_order
    ? (o) => src.readUInt32BE(o)
    : (o) => src.readUInt32LE(o);
  const writeWord = display.byte_order
    ? (v, o) => out.writeUInt32BE(v, o)
    : (v, o) => out.writeUInt32LE(v, o);

  writeWord(width, 0);
  writeWord(height, 4);

  for (let i = 0; i < width * height; i++) {
    const px = readPixel(i * 4);
    // (2) fixed by Render.rgba32 (PictStandardARGB32), not by the visual
    const a = (px >>> 24) & 0xff;
    let r = (px >>> 16) & 0xff;
    let g = (px >>> 8) & 0xff;
    let b = px & 0xff;
    // (3) XRender stores c*a; EWMH wants c. Fully transparent pixels carry
    // no colour to recover, and clamping matters because a rounded-up
    // premultiplied channel can exceed its own alpha.
    if (a === 0) {
      r = g = b = 0;
    } else if (a < 255) {
      r = Math.min(255, Math.round((r * 255) / a));
      g = Math.min(255, Math.round((g * 255) / a));
      b = Math.min(255, Math.round((b * 255) / a));
    }
    writeWord((((a << 24) | (r << 16) | (g << 8) | b) >>> 0), 8 + i * 4);
  }
  return out;
}

/** scale the pad into the icon surface, read it back, publish it */
async function publishIcon() {
  const src = ctx.picture; // the window's backing picture (depth 24 here)

  // start from fully transparent so the mask's rim leaves real partial alpha
  Render.FillRectangles(Render.PictOp.Src, iconPicture.id, [0, 0, 0, 0], [0, 0, ICON, ICON]);

  // dest pixel (i, j) samples (PAD_X + i*PAD/ICON, PAD_Y + j*PAD/ICON)
  Render.SetPictureTransform(src.id, [PAD / ICON, 0, PAD_X, 0, PAD / ICON, PAD_Y, 0, 0, 1]);
  src.setFilter('bilinear');
  Render.Composite(
    Render.PictOp.Src,
    src.id,
    maskPicture.id,
    iconPicture.id,
    0, 0, // src
    0, 0, // mask
    0, 0, // dst
    ICON, ICON
  );
  Render.SetPictureTransform(src.id, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  src.setFilter('nearest');

  const img = await new Promise((res, rej) =>
    X.GetImage(2, iconPixmap.id, 0, 0, ICON, ICON, 0xffffffff, (e, i) => (e ? rej(e) : res(i)))
  );
  const data = toIconProperty(img, ICON, ICON, app.display);

  // 128x128 is 65544 bytes of property data. Sizes from 256x256 up would
  // overrun the classic 262140-byte request cap, but node-x11 turns on
  // BIG-REQUESTS during handshake unless you pass `disableBigRequests`, so
  // max_request_length here is 16 MB and even a full icon set fits in one go.
  await wnd.setProperty('_NET_WM_ICON', data, { type: 'CARDINAL', format: 32 });
  return data;
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

// ---------------------------------------------------------------------------
// verification: read the property back off the server and decode it the way
// a window manager would, so the conversion is checked rather than assumed
// ---------------------------------------------------------------------------
async function readBackIcon() {
  const prop = await wnd.getProperty('_NET_WM_ICON');
  if (!prop) return null;
  const buf = prop.data;
  const read = app.display.byte_order
    ? (o) => buf.readUInt32BE(o)
    : (o) => buf.readUInt32LE(o);
  const w = read(0);
  const h = read(4);
  const rgba = Buffer.alloc(w * h * 4); // straight RGBA, what a decoder wants
  for (let i = 0; i < w * h; i++) {
    const px = read(8 + i * 4);
    rgba[i * 4] = (px >>> 16) & 0xff;
    rgba[i * 4 + 1] = (px >>> 8) & 0xff;
    rgba[i * 4 + 2] = px & 0xff;
    rgba[i * 4 + 3] = (px >>> 24) & 0xff;
  }
  return { width: w, height: h, data: rgba, words: buf.length / 4 };
}

async function savePublishedIcon(path) {
  const { PNG } = await import('pngjs');
  const icon = await readBackIcon();
  if (!icon) {
    console.log('no _NET_WM_ICON set yet');
    return null;
  }
  const png = new PNG({ width: icon.width, height: icon.height });
  icon.data.copy(png.data);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, PNG.sync.write(png));
  console.log(`wrote ${path} (${icon.width}x${icon.height}, ${icon.words} CARD32s)`);
  return icon;
}

// ---------------------------------------------------------------------------
paint();
console.log(`window 0x${wnd.id.toString(16)} — image_byte_order=${app.display.image_byte_order} ` +
  `connection byte_order=${app.display.byte_order} window depth=${wnd.depth || app.display.screen[0].root_depth}`);

if (selftest) {
  // a fixed pattern instead of the mouse: three strokes, one per primary, so
  // the read-back can be checked against known colours
  strokes.push([[PAD_X + 40, PAD_Y + 60], [PAD_X + 216, PAD_Y + 60]]);
  strokes.push([[PAD_X + 40, PAD_Y + 128], [PAD_X + 216, PAD_Y + 196]]);
  strokes.push([[PAD_X + 128, PAD_Y + 40], [PAD_X + 128, PAD_Y + 216]]);
  paint();
  await new Promise((r) => setTimeout(r, 250)); // let the strokes land
  await publishIcon();
  const icon = await savePublishedIcon('/tmp/ntk-wm-icon.png');

  // spot checks against what was drawn
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

  // The premultiply check, and the only one that would notice conversion (3)
  // being skipped. Find a rim pixel with partial alpha and compare it to the
  // opaque pixel 8px further in along the same radius: un-premultiplied they
  // are the same colour, premultiplied the rim is scaled down by its alpha.
  const c = (ICON - 1) / 2;
  let rim = null;
  let inner = null;
  for (let y = 0; y < ICON && !rim; y++) {
    for (let x = 0; x < ICON; x++) {
      const p = at(x, y);
      if (p[3] < 60 || p[3] > 200) continue;
      const len = Math.hypot(x - c, y - c) || 1;
      const ix = Math.round(x - ((x - c) / len) * 8);
      const iy = Math.round(y - ((y - c) / len) * 8);
      const q = at(ix, iy);
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
