// XVideo against a real X server: a frame put through a port lands in a
// VideoTarget's redirected pixmap converted, comes out of it into a Surface,
// and shows nowhere on the way.
//
// Only a server with an image adaptor can say any of that. Xvfb and XQuartz
// answer the extension and then "no adaptors present", and there the test
// checks the other half of the contract — that `openVideoPort` declines with
// `null` rather than throwing. Skipped where there is no DISPLAY.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createClient } from '../lib/index.js';
import { Surface } from '../lib/surface.js';
import { openVideoPort } from '../lib/xv.js';
import { withTimeout } from './helpers/async.js';

let app = null;
let skip = false;

before(async () => {
  if (!process.env.DISPLAY) {
    skip = 'no DISPLAY set';
    return;
  }
  try {
    app = await withTimeout(createClient(), 5000, 'connecting to X server', (late) => late.close());
  } catch (err) {
    skip = `cannot connect to X server: ${err.message}`;
  }
});

after(async () => {
  await app?.close();
});

const call = (fn, ...args) =>
  new Promise((resolve, reject) => fn(...args, (err, value) => (err ? reject(err) : resolve(value))));

/** a mapped window to parent targets on: a redirected child of an unmapped
 *  one has no pixmap */
async function mappedWindow() {
  const wnd = app.createWindow({ x: 0, y: 0, width: 64, height: 64, overrideRedirect: true });
  const mapped = new Promise((resolve) => wnd.once('map', resolve));
  wnd.map();
  await withTimeout(mapped, 3000, 'waiting for MapNotify');
  return wnd;
}

/** the BGRA pixel at x, y of a depth-32 surface, read straight off the server */
async function pixelOf(surface, x, y) {
  const img = await call(app.X.GetImage.bind(app.X), 2, surface.pixmap.id, x, y, 1, 1, 0xffffffff);
  return [...img.data.subarray(0, 4)];
}

/** a solid YCbCr frame, `[y, …chroma]` in the format's own planes */
function solid(format, width, height, Y, Cb, Cr) {
  const cw = Math.ceil(width / 2);
  const ch = Math.ceil(height / 2);
  if (format === 'NV12') {
    const uv = Buffer.alloc(cw * 2 * ch);
    for (let i = 0; i < uv.length; i += 2) {
      uv[i] = Cb;
      uv[i + 1] = Cr;
    }
    return [Buffer.alloc(width * height, Y), uv];
  }
  if (format === 'I420') {
    return [Buffer.alloc(width * height, Y), Buffer.alloc(cw * ch, Cb), Buffer.alloc(cw * ch, Cr)];
  }
  throw new Error(format);
}

const near = (actual, expected, tolerance, what) =>
  assert.ok(
    actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance),
    `${what}: ${JSON.stringify(actual)} is not within ${tolerance} of ${JSON.stringify(expected)}`
  );

test('a server without an image adaptor is declined with null', async (t) => {
  if (skip) return t.skip(skip);
  const port = await openVideoPort(app);
  if (port) {
    port.close();
    return t.skip('this server has an image adaptor; the frame tests below cover it');
  }
  assert.equal(port, null);
});

test('a frame put into a target comes out of it converted, and shows nowhere', async (t) => {
  if (skip) return t.skip(skip);
  const port = await openVideoPort(app);
  if (!port) return t.skip('no Xv image adaptor on this server');
  if (!port.targets) {
    port.close();
    return t.skip('no Composite: a target needs one');
  }
  t.after(() => port.close());
  const wnd = await mappedWindow();
  t.after(() => wnd.destroy?.());

  // Odd on both axes, so the port's layout rounds up and the copy into it
  // has to keep to the frame's own rows and columns.
  const W = 63;
  const H = 35;
  for (const [format, colorSpace, [Y, Cb, Cr], bgr] of [
    // BT.601 video-range red, and BT.709's: both decode to (255, 0, 0)
    ['NV12', 'bt601', [81, 90, 240], [0, 0, 255]],
    ['I420', 'bt709', [63, 102, 240], [0, 0, 255]],
    // mid grey has no chroma to get wrong but the range: 126 is sRGB 128
    ['NV12', 'bt709', [126, 128, 128], [128, 128, 128]]
  ]) {
    if (!port.formats.includes(format) || !port.colorSpaces.includes(colorSpace)) continue;
    await port.prepare(format, W, H);
    const target = port.createTarget(wnd, { width: W, height: H });
    const surface = new Surface(app, { width: W, height: H });
    try {
      const planes = solid(format, W, H, Y, Cb, Cr);
      assert.equal(target.put({ format, width: W, height: H, planes, colorSpace }), true, `${format} put`);
      // entirely outside its parent: nothing of it on screen, and nowhere
      // the pointer can be
      const at = await call(app.X.GetGeometry.bind(app.X), target.id);
      assert.ok(at.xPos + at.width <= 0 && at.yPos + at.height <= 0, `target at ${at.xPos},${at.yPos}`);
      target.copyTo(surface);
      near(await pixelOf(surface, 31, 17), [...bgr, 255], 3, `${format} ${colorSpace} centre`);
      near(await pixelOf(surface, W - 1, H - 1), [...bgr, 255], 3, `${format} ${colorSpace} last pixel`);
    } finally {
      target.destroy();
      surface.destroy();
    }
  }
});

test('frames go through shared memory once a segment is warm, and recycle', async (t) => {
  if (skip) return t.skip(skip);
  const port = await openVideoPort(app);
  if (!port?.targets) {
    port?.close();
    return t.skip('no Xv image adaptor with Composite on this server');
  }
  t.after(() => port.close());
  if (!app.shm.ready) return t.skip('MIT-SHM does not attach here');
  const wnd = await mappedWindow();
  t.after(() => wnd.destroy?.());

  const W = 640;
  const H = 360;
  await port.prepare('NV12', W, H);
  const target = port.createTarget(wnd, { width: W, height: H });
  const surface = new Surface(app, { width: W, height: H });
  t.after(() => {
    target.destroy();
    surface.destroy();
  });
  const sent = [];
  const realShm = port.Xv.ShmPutImage;
  port.Xv.ShmPutImage = (...args) => {
    sent.push('shm');
    return realShm(...args);
  };
  const realCore = port.Xv.PutImage;
  port.Xv.PutImage = (...args) => {
    sent.push('core');
    return realCore(...args);
  };
  // the first frame of a size goes down the socket while a segment warms
  for (let i = 0; i < 6; i++) {
    const shade = 40 + i * 30;
    assert.ok(target.put({ format: 'NV12', width: W, height: H, planes: solid('NV12', W, H, shade, 128, 128) }));
    target.copyTo(surface);
    const [b, g, r] = await pixelOf(surface, 100, 100);
    const expected = Math.round(((shade - 16) * 255) / 219);
    near([b, g, r], [expected, expected, expected], 3, `frame ${i}`);
  }
  assert.equal(sent[0], 'core', 'the first frame cannot wait for a segment');
  assert.ok(sent.slice(2).every((s) => s === 'shm'), `then shared memory: ${sent.join(',')}`);
});

test('a target under a window that is not mapped takes no frame, and goes with its window', async (t) => {
  if (skip) return t.skip(skip);
  const port = await openVideoPort(app);
  if (!port?.targets) {
    port?.close();
    return t.skip('no Xv image adaptor with Composite on this server');
  }
  t.after(() => port.close());
  await port.prepare('NV12', 16, 16);
  const wnd = app.createWindow({ x: 0, y: 0, width: 32, height: 32, overrideRedirect: true });
  const target = port.createTarget(wnd, { width: 16, height: 16 });
  const frame = { format: 'NV12', width: 16, height: 16, planes: solid('NV12', 16, 16, 81, 90, 240) };
  assert.equal(target.viewable, false, 'never mapped: no pixmap to hold a frame');
  assert.equal(target.put(frame), false);

  const mapped = new Promise((resolve) => wnd.once('map', resolve));
  wnd.map();
  await withTimeout(mapped, 3000, 'waiting for MapNotify');
  assert.equal(target.viewable, true);
  assert.equal(target.put(frame), true);

  // the server takes the child, its picture and the port's hold on it with
  // the parent; the target sends nothing for any of them afterwards
  const errors = [];
  const onError = (err) => errors.push(err);
  app.X.on('error', onError);
  t.after(() => app.X.off('error', onError));
  wnd.destroy();
  target.destroy();
  await call(app.X.GetInputFocus.bind(app.X));
  assert.equal(target.viewable, false);
  assert.deepEqual(errors, [], 'no BadPicture, BadWindow or BadDrawable');
});
