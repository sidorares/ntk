// ntk end-to-end against node-x11's pure-JS X server (RENDER included since
// x11 3.1.0): fully hermetic — no $DISPLAY, no fontconfig. An ntk client
// connects over an in-process stream pair and every assertion reads pixels
// back through GetImage.
//
// Tolerances are deliberately loose where antialiasing/filtering is
// involved: the JS rasterizer is not (and does not try to be) pixel-exact
// with Xorg — see test/smoke*.test.js for the real-server runs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, Image, StaticFontSource } from '../lib/index.js';

const { createServer, createStreamPair } = xserver;

const require = createRequire(import.meta.url);
const fontDir = join(dirname(require.resolve('katex/package.json')), 'dist', 'fonts');

let server = null;
let app = null;

before(async () => {
  server = createServer({ width: 320, height: 240 });
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);

  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), { family: 'Test Main' });
  fontSource.alias('sans-serif', 'Test Main');

  app = await createClient({ stream: clientEnd, fontSource });
});

after(async () => {
  if (app) await app.close();
});

const readPixels = (ctx, w, h) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, w, h, (err, data) => (err ? reject(err) : resolve(data)))
  );

// BGRA readback -> [r, g, b]
const px = (image, w, x, y) => {
  const i = (y * w + x) * 4;
  return [image.data[i + 2], image.data[i + 1], image.data[i]];
};

const near = (got, want, tol, what) =>
  assert.ok(Math.abs(got - want) <= tol, `${what}: expected ~${want}±${tol}, got ${got}`);

function freshWindow(width = 160, height = 120) {
  const wnd = app.createWindow({ width, height });
  wnd.map();
  const ctx = wnd.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, width, height);
  return { wnd, ctx };
}

test('handshake: RENDER formats resolve and QueryVersion replies 0.11', async () => {
  const Render = app.display.Render;
  const ids = [Render.rgba32, Render.rgb24, Render.a8, Render.mono1];
  for (const id of ids) assert.ok(id, 'format id derived from QueryPictFormats');
  assert.equal(new Set(ids).size, 4, 'format ids are distinct');
  const [major, minor] = await new Promise((resolve, reject) =>
    Render.QueryVersion(0, 11, (err, res) => (err ? reject(err) : resolve(res)))
  );
  assert.equal(major, 0);
  assert.equal(minor, 11);
});

test('fillRect: solid colors land exactly', async () => {
  const { wnd, ctx } = freshWindow();

  ctx.fillStyle = 'red';
  ctx.fillRect(10, 10, 40, 30);
  ctx.fillStyle = '#0080ff';
  ctx.fillRect(80, 40, 20, 20);

  const image = await readPixels(ctx, 160, 120);
  assert.deepEqual(px(image, 160, 20, 20), [255, 0, 0], 'inside red rect');
  assert.deepEqual(px(image, 160, 49, 39), [255, 0, 0], 'red rect bottom-right corner');
  assert.deepEqual(px(image, 160, 90, 50), [0, 128, 255], 'inside blue rect');
  assert.deepEqual(px(image, 160, 5, 5), [255, 255, 255], 'background untouched');
  assert.deepEqual(px(image, 160, 51, 20), [255, 255, 255], 'right of red rect');
  wnd.destroy();
});

test('path fill: triangle interior exact, sloped edge antialiased', async () => {
  const { wnd, ctx } = freshWindow();

  // right triangle: vertical edge x=20, horizontal edge y=20, hypotenuse
  // from (100,20) to (20,100)
  ctx.fillStyle = 'black';
  ctx.beginPath();
  ctx.moveTo(20, 20);
  ctx.lineTo(100, 20);
  ctx.lineTo(20, 100);
  ctx.closePath();
  ctx.fill();

  const image = await readPixels(ctx, 160, 120);
  assert.deepEqual(px(image, 160, 40, 40), [0, 0, 0], 'interior is exactly black');
  assert.deepEqual(px(image, 160, 25, 90), [0, 0, 0], 'near the lower corner');
  assert.deepEqual(px(image, 160, 110, 30), [255, 255, 255], 'outside stays white');
  // (59,60) straddles the hypotenuse (x + y = 120): expect partial coverage
  const [er, eg, eb] = px(image, 160, 59, 60);
  assert.ok(er > 30 && er < 225, `edge pixel is a blend, got ${er}`);
  assert.equal(er, eg, 'edge blend is neutral gray');
  assert.equal(eg, eb, 'edge blend is neutral gray');
  wnd.destroy();
});

test('linear gradient: endpoints and midpoint interpolate, pad beyond stops', async () => {
  const { wnd, ctx } = freshWindow(200, 60);

  const gradient = ctx.createLinearGradient(20, 0, 180, 0);
  gradient.addColorStop(0, 'black');
  gradient.addColorStop(1, 'white');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 200, 60);

  const image = await readPixels(ctx, 200, 60);
  const level = (x) => px(image, 200, x, 30)[0];
  near(level(21), 0, 12, 'start stop');
  near(level(100), 128, 14, 'midpoint');
  near(level(178), 255, 12, 'end stop');
  // pad behavior: outside the stop range clamps to the edge colors
  near(level(2), 0, 6, 'before first stop clamps to black');
  near(level(197), 255, 6, 'after last stop clamps to white');
  // monotonic left-to-right ramp
  assert.ok(level(60) < level(100) && level(100) < level(140), 'ramp is monotonic');
  wnd.destroy();
});

test('fillText: glyphs ink the baseline region and advance', async () => {
  const { wnd, ctx } = freshWindow(200, 60);

  ctx.font = '24px sans-serif';
  ctx.fillStyle = 'black';
  ctx.fillText('Hello', 10, 40);
  const width = ctx.measureText('Hello').width;
  assert.ok(width > 30, `measured advance ${width}`);

  const image = await readPixels(ctx, 200, 60);
  const darkIn = (x0, x1, y0, y1) => {
    let n = 0;
    for (let y = Math.floor(y0); y < y1; y++) {
      for (let x = Math.floor(x0); x < x1; x++) {
        if (px(image, 200, x, y)[0] < 128) n++;
      }
    }
    return n;
  };
  // ink lives between ascender top and baseline, within the advance
  assert.ok(darkIn(10, 10 + Math.ceil(width), 16, 41) > 40, 'glyph ink present');
  // the last letter inked pixels well past the first ones (text advanced)
  assert.ok(darkIn(10 + width * 0.6, 10 + width, 16, 41) > 5, 'ink near the end of the run');
  assert.equal(darkIn(10, 200, 0, 10), 0, 'no ink far above the ascender');
  assert.equal(darkIn(120, 200, 0, 60), 0, 'no ink past the advance');
  wnd.destroy();
});

test('drawImage: half-transparent pixels blend over the background', async () => {
  const { wnd, ctx } = freshWindow(64, 64);

  // 8x8 red at alpha 128 (non-premultiplied RGBA input)
  const data = Buffer.alloc(8 * 8 * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 3] = 128;
  }
  const img = new Image({ width: 8, height: 8, data });
  ctx.drawImage(img, 4, 4);

  const image = await readPixels(ctx, 64, 64);
  const [r, g, b] = px(image, 64, 8, 8);
  // premultiplied upload + Over onto white: r = 128 + 127 = 255, g/b = 127.
  // If PutImage had dropped the alpha byte this would be pure white (src
  // treated as fully transparent) or pure red (treated as opaque).
  near(r, 255, 6, 'red channel');
  near(g, 127, 8, 'green channel blended');
  near(b, 127, 8, 'blue channel blended');
  assert.deepEqual(px(image, 64, 20, 20), [255, 255, 255], 'outside the image');
  img.destroy();
  wnd.destroy();
});

test('drawImage: server-side scaling with the picture transform', async () => {
  const { wnd, ctx } = freshWindow(64, 64);

  // 2x2 checker: red/blue over blue/red, scaled x16
  const data = Buffer.alloc(2 * 2 * 4);
  const set = (i, r, g, b) => {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  };
  set(0, 255, 0, 0);
  set(1, 0, 0, 255);
  set(2, 0, 0, 255);
  set(3, 255, 0, 0);
  const img = new Image({ width: 2, height: 2, data });
  ctx.drawImage(img, 0, 0, 32, 32);

  // sample inside each quadrant, away from the outer edges (repeat None
  // means bilinear taps outside the 2x2 source read transparent black)
  const image = await readPixels(ctx, 64, 64);
  const tl = px(image, 64, 8, 8);
  const tr = px(image, 64, 23, 8);
  assert.ok(tl[0] > 200 && tl[2] < 60, `top-left is red, got ${tl}`);
  assert.ok(tr[2] > 200 && tr[0] < 60, `top-right is blue, got ${tr}`);
  // bilinear filtering blends the center seam
  const c = px(image, 64, 16, 16);
  assert.ok(c[0] > 40 && c[0] < 215 && c[2] > 40 && c[2] < 215, `center blends, got ${c}`);
  img.destroy();
  wnd.destroy();
});

test("composite ops: 'source-over' blends, 'copy' replaces", async () => {
  const { wnd, ctx } = freshWindow(64, 64);

  ctx.fillStyle = 'rgba(0, 0, 255, 0.5)';
  ctx.fillRect(2, 2, 20, 20); // source-over onto white

  ctx.globalCompositeOperation = 'copy';
  ctx.fillRect(30, 2, 20, 20); // Src: replaces, no blend with white
  ctx.globalCompositeOperation = 'source-over';

  const image = await readPixels(ctx, 64, 64);
  const over = px(image, 64, 10, 10);
  const copy = px(image, 64, 40, 10);
  near(over[0], 127, 10, 'source-over red channel keeps half the white');
  near(copy[0], 0, 10, 'copy red channel discards the destination');
  assert.ok(over[2] > 200, 'source-over blue channel high');
  assert.ok(copy[2] > 120, 'copy blue channel present');
  assert.ok(over[0] - copy[0] > 80, 'the two ops differ');
  wnd.destroy();
});

test('clip + globalAlpha through the a8 mask pipeline', async () => {
  const { wnd, ctx } = freshWindow(64, 64);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, 32, 64);
  ctx.clip();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = 'red';
  ctx.fillRect(0, 0, 64, 64);
  ctx.restore();

  const image = await readPixels(ctx, 64, 64);
  const inside = px(image, 64, 16, 32);
  assert.ok(inside[0] > 200, 'red high inside the clip');
  near(inside[1], 127, 12, 'half-alpha blend toward white inside the clip');
  assert.deepEqual(px(image, 64, 48, 32), [255, 255, 255], 'outside the clip untouched');
  wnd.destroy();
});

test('line dash API: normalization, validation and save/restore', async () => {
  const { wnd, ctx } = freshWindow(32, 32);

  assert.deepEqual(ctx.getLineDash(), [], 'default is solid');
  assert.equal(ctx.lineDashOffset, 0, 'default offset');

  ctx.setLineDash([4, 2, 1]);
  assert.deepEqual(ctx.getLineDash(), [4, 2, 1, 4, 2, 1], 'odd-length list doubles');
  const copy = ctx.getLineDash();
  copy.push(99);
  assert.deepEqual(ctx.getLineDash(), [4, 2, 1, 4, 2, 1], 'getLineDash returns a copy');

  ctx.setLineDash([5, -1]);
  assert.deepEqual(ctx.getLineDash(), [4, 2, 1, 4, 2, 1], 'negative value invalidates the call');
  ctx.setLineDash([5, NaN]);
  assert.deepEqual(ctx.getLineDash(), [4, 2, 1, 4, 2, 1], 'non-finite value invalidates the call');

  ctx.lineDashOffset = 3;
  ctx.lineDashOffset = NaN;
  assert.equal(ctx.lineDashOffset, 3, 'non-finite offset assignment ignored');

  ctx.save();
  ctx.setLineDash([10, 10]);
  ctx.lineDashOffset = 7;
  ctx.restore();
  assert.deepEqual(ctx.getLineDash(), [4, 2, 1, 4, 2, 1], 'restore() brings the dash list back');
  assert.equal(ctx.lineDashOffset, 3, 'restore() brings the offset back');

  ctx.setLineDash([]);
  assert.deepEqual(ctx.getLineDash(), [], 'empty list resets to solid');
  wnd.destroy();
});

test('stroke: dashed line alternates on/gap and lineDashOffset shifts it', async () => {
  const { wnd, ctx } = freshWindow();

  ctx.strokeStyle = 'black';
  ctx.lineWidth = 4;
  ctx.setLineDash([10, 10]);

  // pattern anchored at x=10: on [10,20), gap [20,30), on [30,40), ...
  ctx.beginPath();
  ctx.moveTo(10, 20);
  ctx.lineTo(150, 20);
  ctx.stroke();

  // offset 10 starts inside the gap: gap [10,20), on [20,30), ...
  ctx.lineDashOffset = 10;
  ctx.beginPath();
  ctx.moveTo(10, 60);
  ctx.lineTo(150, 60);
  ctx.stroke();

  const image = await readPixels(ctx, 160, 120);
  const ink = (x, y) => px(image, 160, x, y)[0] < 100;
  for (const x of [14, 34, 54]) assert.ok(ink(x, 20), `dash ink at x=${x}`);
  for (const x of [24, 44, 64]) assert.ok(!ink(x, 20), `gap at x=${x}`);
  // offset by 10: the pattern is inverted
  for (const x of [14, 34, 54]) assert.ok(!ink(x, 60), `offset line gap at x=${x}`);
  for (const x of [24, 44, 64]) assert.ok(ink(x, 60), `offset line ink at x=${x}`);
  // gaps do not leak outside the stroke width
  assert.ok(!ink(14, 30), 'no ink between the two lines');
  wnd.destroy();
});

test("stroke: lineCap 'round' inks beyond the endpoint where butt does not", async () => {
  const { wnd, ctx } = freshWindow();

  ctx.strokeStyle = 'black';
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(30, 30);
  ctx.lineTo(80, 30);
  ctx.stroke();

  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(30, 80);
  ctx.lineTo(80, 80);
  ctx.stroke();

  const image = await readPixels(ctx, 160, 120);
  const ink = (x, y) => px(image, 160, x, y)[0] < 100;
  // (82, 32): ~3.5px diagonally past the endpoint, well inside the r=5 cap
  assert.ok(ink(82, 32), 'round cap ink at ~45 degrees past the endpoint');
  assert.ok(ink(83, 30), 'round cap ink straight past the endpoint');
  assert.ok(!ink(86, 30), 'no ink beyond the cap radius');
  assert.ok(ink(79, 30), 'stroke body inked');
  // butt cap: same probes past the endpoint stay white
  assert.ok(!ink(82, 82), 'butt cap has no ink past the endpoint');
  assert.ok(!ink(83, 80), 'butt cap ends at the endpoint');
  assert.ok(ink(79, 80), 'butt stroke body inked');
  wnd.destroy();
});

test("stroke: lineJoin 'round' fills the outer corner arc, unlike bevel/miter", async () => {
  const probe = async (join) => {
    const { wnd, ctx } = freshWindow();
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 20;
    ctx.lineJoin = join;
    ctx.beginPath();
    ctx.moveTo(30, 80);
    ctx.lineTo(80, 80);
    ctx.lineTo(80, 105);
    ctx.stroke();
    const image = await readPixels(ctx, 160, 120);
    wnd.destroy();
    const ink = (x, y) => px(image, 160, x, y)[0] < 100;
    return {
      body: ink(60, 80) && ink(80, 95),
      // (86, 74): inside the r=10 arc at the outer corner, but outside the
      // bevel chord (from (80,70) to (90,80)) — where round and bevel differ
      arc: ink(86, 74),
      // (89, 71): inside the square miter tip, outside the arc
      tip: ink(89, 71)
    };
  };

  const round = await probe('round');
  assert.ok(round.body, 'round: stroke body inked');
  assert.ok(round.arc, 'round: arc region at the outer corner is inked');
  assert.ok(!round.tip, 'round: square miter tip stays empty');

  const bevel = await probe('bevel');
  assert.ok(bevel.body, 'bevel: stroke body inked');
  assert.ok(!bevel.arc, 'bevel: arc region beyond the chord stays empty');

  const miter = await probe('miter');
  assert.ok(miter.arc && miter.tip, 'miter: fills the full square corner');
});

test('stroke: dash pattern continues around a closed rect with no seam cap', async () => {
  const { wnd, ctx } = freshWindow();

  ctx.strokeStyle = 'black';
  ctx.lineWidth = 4;
  ctx.setLineDash([8, 8]);
  // perimeter 256 is a whole number of patterns; offset 4 makes the last
  // dash straddle the seam: it runs up the left edge from (20, 24), around
  // the (20, 20) corner and along the top edge to (24, 20)
  ctx.lineDashOffset = 4;
  ctx.beginPath();
  ctx.rect(20, 20, 64, 64);
  ctx.stroke();

  const image = await readPixels(ctx, 160, 120);
  const ink = (x, y) => px(image, 160, x, y)[0] < 100;
  // top edge: on [20,24), gap [24,32), on [32,40), gap [40,48), ...
  assert.ok(!ink(26, 20), 'first gap on the top edge');
  assert.ok(ink(34, 20), 'first full dash on the top edge');
  assert.ok(!ink(42, 20), 'second gap on the top edge');
  assert.ok(ink(50, 20), 'second full dash on the top edge');
  // the merged seam-straddling run covers both sides of the corner
  assert.ok(ink(20, 22), 'seam corner covered on the left edge');
  assert.ok(ink(22, 20), 'seam corner covered on the top edge');
  assert.ok(!ink(52, 52), 'interior of the rect untouched');
  wnd.destroy();
});

test('stroke: round caps with globalAlpha < 1 do not double-darken the overlap', async () => {
  const { wnd, ctx } = freshWindow();

  ctx.strokeStyle = 'black';
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(30, 60);
  ctx.lineTo(90, 60);
  ctx.stroke();

  const image = await readPixels(ctx, 160, 120);
  // the cap disk overlaps the stroke body around (85..90, 60); coverage is
  // accumulated in a clamped a8 mask, so the result is a single 50% blend
  const body = px(image, 160, 60, 60)[0];
  const overlap = px(image, 160, 87, 60)[0];
  near(body, 127, 12, 'stroke body at 50% alpha');
  near(overlap, 127, 12, 'cap/body overlap stays at 50% alpha');
  wnd.destroy();
});

test('protocol: FillRectangles Src/In on an a8 picture, verified via GetImage', async () => {
  const X = app.X;
  const Render = app.display.Render;

  const pid = X.AllocID();
  X.CreatePixmap(pid, app.display.screen[0].root, 8, 16, 16);
  const picId = X.AllocID();
  Render.CreatePicture(picId, pid, Render.a8);

  // Src fills coverage 0.5 everywhere, then In scales the left half by 0.5
  Render.FillRectangles(Render.PictOp.Src, picId, [0, 0, 0, 0.5], [0, 0, 16, 16]);
  Render.FillRectangles(Render.PictOp.In, picId, [0, 0, 0, 0.5], [0, 0, 8, 16]);

  // depth-8 GetImage packs one byte per pixel, rows padded to 4 bytes
  // (width 16 is already aligned)
  const img = await new Promise((resolve, reject) =>
    X.GetImage(2, pid, 0, 0, 16, 16, 0xffffffff, (err, res) => (err ? reject(err) : resolve(res)))
  );
  const alphaAt = (x, y) => img.data[y * 16 + x];
  near(alphaAt(12, 8), 128, 2, 'Src wrote coverage 0.5');
  near(alphaAt(3, 8), 64, 2, 'In multiplied coverage down to 0.25');

  Render.FreePicture(picId);
  X.FreePixmap(pid);
  X.ReleaseID(picId);
  X.ReleaseID(pid);
});

test('protocol: AddTraps accumulates antialiased coverage', async () => {
  const X = app.X;
  const Render = app.display.Render;

  const pid = X.AllocID();
  X.CreatePixmap(pid, app.display.screen[0].root, 8, 8, 8);
  const picId = X.AllocID();
  Render.CreatePicture(picId, pid, Render.a8);
  Render.FillRectangles(Render.PictOp.Src, picId, [0, 0, 0, 0], [0, 0, 8, 8]);

  // half-pixel-tall full-width span: expect ~50% coverage on row 2, and two
  // adds on the same span must accumulate to ~100%
  const span = [0, 8, 2, 0, 8, 2.5]; // top l/r/y, bottom l/r/y
  Render.AddTraps(picId, 0, 0, span);
  const one = await new Promise((resolve, reject) =>
    X.GetImage(2, pid, 0, 0, 8, 8, 0xffffffff, (err, res) => (err ? reject(err) : resolve(res)))
  );
  // depth-8 GetImage: one byte per pixel, rows padded to 4 (8 is aligned)
  const alphaAt = (img, x, y) => img.data[y * 8 + x];
  near(alphaAt(one, 4, 2), 128, 6, 'half-covered row');
  assert.equal(alphaAt(one, 4, 3), 0, 'row below untouched');

  Render.AddTraps(picId, 0, 0, span);
  Render.AddTraps(picId, 0, 0, span);
  const three = await new Promise((resolve, reject) =>
    X.GetImage(2, pid, 0, 0, 8, 8, 0xffffffff, (err, res) => (err ? reject(err) : resolve(res)))
  );
  near(alphaAt(three, 4, 2), 255, 8, 'ADD accumulation clamps at full coverage');

  Render.FreePicture(picId);
  X.FreePixmap(pid);
  X.ReleaseID(picId);
  X.ReleaseID(pid);
});
