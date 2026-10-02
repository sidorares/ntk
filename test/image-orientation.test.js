// A JPEG's EXIF Orientation, applied by decodeImage (no X server needed).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

import { decodeImage, exifOrientation, loadImage } from '../lib/image.js';
import * as ntk from '../lib/index.js';

// 48x32 in six 16x16 blocks of six colours: no two of the eight orientations
// leave it looking the same, and every block edge falls on an MCU edge, so
// two decoders agree on the colours inside one
const COLORS = [
  [255, 0, 0],
  [0, 200, 0],
  [0, 0, 255],
  [255, 255, 0],
  [0, 255, 255],
  [255, 0, 255]
];
const W = 48;
const H = 32;

function blocksJpeg() {
  const raw = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) raw.set([...COLORS[(y >> 4) * 3 + (x >> 4)], 255], (y * W + x) * 4);
  }
  return jpeg.encode({ width: W, height: H, data: raw }, 95).data;
}

const BASE = blocksJpeg();

function segment(marker, payload) {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/**
 * An APP1 Exif segment whose IFD0 holds `entries` ([tag, type, count, value]),
 * written in `order`: 'II' little-endian, 'MM' big.
 */
function exifSegment(entries, order = 'II') {
  const little = order === 'II';
  const tiff = Buffer.alloc(8 + 2 + entries.length * 12 + 4);
  const u16 = (v, at) => (little ? tiff.writeUInt16LE(v, at) : tiff.writeUInt16BE(v, at));
  const u32 = (v, at) => (little ? tiff.writeUInt32LE(v, at) : tiff.writeUInt32BE(v, at));
  tiff.write(order, 0, 'latin1');
  u16(42, 2);
  u32(8, 4);
  u16(entries.length, 8);
  entries.forEach(([tag, type, count, value], i) => {
    const at = 10 + i * 12;
    u16(tag, at);
    u16(type, at + 2);
    u32(count, at + 4);
    // a SHORT sits in the first two bytes of the value field
    if (type === 3) u16(value, at + 8);
    else u32(value, at + 8);
  });
  return segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]));
}

const orientationSegment = (orientation, order) => exifSegment([[0x0112, 3, 1, orientation]], order);

/** `jpegBytes` with `segments` inserted after the SOI, or after its JFIF APP0 when `afterApp0` */
function withSegments(jpegBytes, segments, { afterApp0 = false } = {}) {
  let at = 2;
  if (afterApp0) {
    assert.equal(jpegBytes[3], 0xe0, 'the fixture starts with a JFIF APP0');
    at = 4 + jpegBytes.readUInt16BE(4);
  }
  return Buffer.concat([jpegBytes.subarray(0, at), ...segments, jpegBytes.subarray(at)]);
}

const oriented = (orientation, order = 'II') => withSegments(BASE, [orientationSegment(orientation, order)]);

// What each orientation means, as EXIF 2.3 defines it: which visual side of
// the image the stored 0th row and 0th column are. Written from the spec's
// wording rather than from the implementation's index arithmetic, so the two
// are separate derivations.
const SIDES = {
  1: { row: 'top', column: 'left' },
  2: { row: 'top', column: 'right' },
  3: { row: 'bottom', column: 'right' },
  4: { row: 'bottom', column: 'left' },
  5: { row: 'left', column: 'top' },
  6: { row: 'right', column: 'top' },
  7: { row: 'right', column: 'bottom' },
  8: { row: 'left', column: 'bottom' }
};

/** The stored pixels as they look, placed by SIDES one pixel at a time. */
function displayed({ width: w, height: h, data }, orientation) {
  const { row, column } = SIDES[orientation];
  const turned = row === 'left' || row === 'right';
  const dw = turned ? h : w;
  const dh = turned ? w : h;
  const out = Buffer.alloc(w * h * 4);
  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      // the stored row index runs away from the side the 0th row is on, and
      // the column index away from the side the 0th column is on
      let x;
      let y;
      if (turned) {
        x = row === 'left' ? sy : dw - 1 - sy;
        y = column === 'top' ? sx : dh - 1 - sx;
      } else {
        y = row === 'top' ? sy : dh - 1 - sy;
        x = column === 'left' ? sx : dw - 1 - sx;
      }
      data.copy(out, (y * dw + x) * 4, (sy * w + sx) * 4, (sy * w + sx) * 4 + 4);
    }
  }
  return { width: dw, height: dh, data: out };
}

test('exifOrientation: reads all eight values, little- and big-endian', () => {
  assert.equal(ntk.exifOrientation, exifOrientation, 'the package entry exports it');
  for (const order of ['II', 'MM']) {
    for (let o = 1; o <= 8; o++) assert.equal(exifOrientation(oriented(o, order)), o, `${order} ${o}`);
  }
});

test('exifOrientation: finds the tag past other segments, entries and fill bytes', () => {
  const xmp = segment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>', 'latin1'));
  // a camera's IFD0: Make and Model before the tag, XResolution after it
  const camera = exifSegment(
    [
      [0x010f, 2, 4, 0],
      [0x0110, 2, 4, 0],
      [0x0112, 3, 1, 6],
      [0x011a, 5, 1, 0]
    ],
    'MM'
  );
  assert.equal(exifOrientation(withSegments(BASE, [orientationSegment(8)], { afterApp0: true })), 8, 'after JFIF');
  assert.equal(exifOrientation(withSegments(BASE, [xmp, orientationSegment(5)])), 5, 'after an XMP APP1');
  assert.equal(exifOrientation(withSegments(BASE, [camera])), 6, 'among other tags');
  const filled = withSegments(BASE, [Buffer.from([0xff, 0xff]), orientationSegment(3)]);
  assert.equal(exifOrientation(filled), 3, 'after fill bytes');
  // the first Exif segment is the one that counts
  assert.equal(exifOrientation(withSegments(BASE, [orientationSegment(2), orientationSegment(7)])), 2);
});

test('exifOrientation: 1 for anything that does not hold a valid tag, and never throws', () => {
  const png = new PNG({ width: 1, height: 1 });
  const cases = {
    'no Exif': BASE,
    'a PNG': PNG.sync.write(png),
    'an empty buffer': Buffer.alloc(0),
    'value 0': oriented(0),
    'value 9': oriented(9),
    'stored as a LONG': withSegments(BASE, [exifSegment([[0x0112, 4, 1, 6]])]),
    'two values': withSegments(BASE, [exifSegment([[0x0112, 3, 2, 6]])]),
    'no Orientation tag': withSegments(BASE, [exifSegment([[0x010f, 2, 4, 0]])]),
    'an IFD offset past the segment': (() => {
      const seg = orientationSegment(6);
      seg.writeUInt32LE(0x7fffffff, 4 + 6 + 4);
      return withSegments(BASE, [seg]);
    })(),
    'a byte order that is neither': (() => {
      const seg = orientationSegment(6);
      seg.write('XX', 4 + 6, 'latin1');
      return withSegments(BASE, [seg]);
    })(),
    'a segment longer than the file': oriented(6).subarray(0, 20),
    'a header and nothing else': Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00])
  };
  for (const [name, bytes] of Object.entries(cases)) assert.equal(exifOrientation(bytes), 1, name);
  // an Exif segment after the scan has begun is pixels, not metadata
  const sos = BASE.indexOf(Buffer.from([0xff, 0xda]));
  const late = Buffer.concat([BASE.subarray(0, sos), segment(0xda, Buffer.alloc(0)), orientationSegment(6)]);
  assert.equal(exifOrientation(late), 1, 'after SOS');
});

test('decodeImage: each EXIF orientation turns the stored pixels the way the spec defines', () => {
  const stored = decodeImage(BASE);
  assert.equal(stored.width, W);
  for (const order of ['II', 'MM']) {
    for (let o = 1; o <= 8; o++) {
      const img = decodeImage(oriented(o, order));
      const want = displayed(stored, o);
      assert.deepEqual([img.width, img.height], [want.width, want.height], `${order} ${o}: size`);
      // the scan is the same bytes in every fixture, so the pixels are a
      // permutation of the stored ones, exactly
      assert.ok(img.data.equals(want.data), `${order} ${o}: pixels`);
      assert.ok(Buffer.isBuffer(img.data), `${order} ${o}: data is a Buffer`);
    }
  }
});

test("decodeImage: imageOrientation 'none' keeps the stored pixels", async () => {
  const stored = decodeImage(BASE);
  for (let o = 1; o <= 8; o++) {
    const img = decodeImage(oriented(o), { imageOrientation: 'none' });
    assert.deepEqual([img.width, img.height], [W, H]);
    assert.ok(img.data.equals(stored.data), `${o}`);
  }
  const loaded = await loadImage(oriented(6), { imageOrientation: 'none' });
  assert.deepEqual([loaded.width, loaded.height], [W, H]);
  const turned = await loadImage(oriented(6));
  assert.deepEqual([turned.width, turned.height], [H, W]);
  assert.throws(() => decodeImage(BASE, { imageOrientation: 'flipY' }), /'from-image' or 'none', not "flipY"/);
});

// Bun's own decoder (libjpeg-turbo, with `autoOrient` on by default) is an
// implementation of the same rule written by someone else; an app that runs
// under both runtimes sees the two side by side.
const BUN_DECODE = `
const jpegs = JSON.parse(await Bun.stdin.text());
const pngs = [];
for (const b64 of jpegs) {
  const png = await new Bun.Image(Buffer.from(b64, 'base64')).png({ compressionLevel: 0 }).bytes();
  pngs.push(Buffer.from(png).toString('base64'));
}
process.stdout.write(JSON.stringify(pngs));
`;

function bunImage() {
  const probe = spawnSync('bun', ['-e', 'process.stdout.write(typeof Bun.Image)'], { encoding: 'utf8' });
  if (probe.error) return 'bun is not on PATH';
  if (probe.stdout !== 'function') return `this bun (${probe.stdout || probe.stderr}) has no Bun.Image`;
  return null;
}

const noBun = bunImage();

test('decodeImage: every orientation comes out as Bun.Image decodes it', { skip: noBun ?? false }, () => {
  const fixtures = [];
  for (const order of ['II', 'MM']) {
    for (let o = 1; o <= 8; o++) fixtures.push({ name: `${order} ${o}`, bytes: oriented(o, order) });
  }
  const run = spawnSync('bun', ['-e', BUN_DECODE], {
    input: JSON.stringify(fixtures.map((f) => f.bytes.toString('base64'))),
    encoding: 'utf8',
    maxBuffer: 64 << 20
  });
  assert.equal(run.status, 0, run.stderr);
  const pngs = JSON.parse(run.stdout);
  fixtures.forEach(({ name, bytes }, i) => {
    const theirs = PNG.sync.read(Buffer.from(pngs[i], 'base64'));
    const ours = decodeImage(bytes);
    assert.deepEqual([ours.width, ours.height], [theirs.width, theirs.height], `${name}: size`);
    // two decoders of one lossy file: the same colours to within rounding (a
    // unit, on Bun 1.4), which no misplaced block could be: every two of the
    // six colours differ by 200 or more in some channel
    let worst = 0;
    for (let j = 0; j < ours.data.length; j++) worst = Math.max(worst, Math.abs(ours.data[j] - theirs.data[j]));
    assert.ok(worst <= 4, `${name}: a channel differs by ${worst}`);
  });
});
