// PreciseRasterizer: the a8 masks an X server draws for Triangles and
// AddTraps, computed here (lib/precise.js). The goldens below are what a
// pixman server — XQuartz, which rasterizes as Xvfb, Xorg and Xwayland do —
// drew for each shape on a 16×12 a8 pixmap; rasterizing the same numbers
// here must give the same bytes. test/raster-precise-live.test.js checks the
// same against whatever server $DISPLAY names, on random geometry.
//
// Hermetic and pure: no X server.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PreciseRasterizer, defaultRasterizer } from '../lib/index.js';
import { fixed16, snapFixed16 } from '../lib/precise.js';

const W = 16;
const H = 12;

const SHAPES = {
  'a triangle': { triangles: [1.3, 0.7, 14.6, 3.2, 5.1, 11.4] },
  'a near-horizontal sliver': { triangles: [0.2, 5.01, 15.9, 5.3, 15.9, 5.31] },
  'past the top and left': { triangles: [-3.5, -2.25, 9.75, 1.5, 4.125, 14.9] },
  'past the right': { triangles: [10.5, 1, 20.25, 6, 9.9, 11] },
  'overlaps saturate': { triangles: [2, 2, 12, 2, 7, 10, 3, 3, 13, 4, 6, 11] },
  'a heptagon, nonzero': {
    polys: [
      [
        13.4, 6.2, 11.404496, 10.343707, 6.920639, 11.367118, 3.324865, 8.499584, 3.324865,
        3.900416, 6.920639, 1.032882, 11.404496, 2.056293
      ]
    ],
    rule: 'nonzero'
  },
  'a ring, evenodd': {
    polys: [
      [1.25, 0.5, 14.75, 0.5, 14.75, 11.5, 1.25, 11.5],
      [4.6, 3.4, 11.4, 3.4, 11.4, 8.6, 4.6, 8.6]
    ],
    rule: 'evenodd'
  }
};

// one 16-pixel row per line, hex
const GOLDEN = {
  'a triangle': [
    '00251200000000000000000000000000',
    '0069ffe1b18154230100000000000000',
    '0014fafffffffffff1c2926232060000',
    '0000b4ffffffffffffffffffffee3000',
    '00005affffffffffffffffffe5320000',
    '00000bf4ffffffffffffffd21d000000',
    '000000a2ffffffffffffb90d00000000',
    '00000048ffffffffff9a040000000000',
    '00000004e9fffffe7700000000000000',
    '0000000093fff7540000000000000000',
    '0000000039ea39000000000000000000',
    '00000000011f00000000000000000000',
  ].join(''),
  'a near-horizontal sliver': [
    '00000000000000000000000000000000',
    '00000000000000000000000000000000',
    '00000000000000000000000000000000',
    '00000000000000000000000000000000',
    '00000000000000000000000000000000',
    '00010000020100000500000205000009',
    '00000000000000000000000000000000',
    '00000000000000000000000000000000',
    '00000000000000000000000000000000',
    '00000000000000000000000000000000',
    '00000000000000000000000000000000',
    '00000000000000000000000000000000',
  ].join(''),
  'past the top and left': [
    'fffffffff5b56c240000000000000000',
    'ffffffffffffffffdb67000000000000',
    'ffffffffffffffffff55000000000000',
    'ffffffffffffffffe404000000000000',
    'ffffffffffffffff7c00000000000000',
    'f6fffffffffffff91900000000000000',
    '9affffffffffffa60000000000000000',
    '2afeffffffffff3b0000000000000000',
    '00b8ffffffffce000000000000000000',
    '0047ffffffff65000000000000000000',
    '0001d5ffffef09000000000000000000',
    '000065ffff8c00000000000000000000',
  ].join(''),
  'past the right': [
    '00000000000000000000000000000000',
    '00000000000000000000777c0d000000',
    '0000000000000000000097ffeb760a00',
    '00000000000000000000a6ffffffe86f',
    '00000000000000000000b5ffffffffff',
    '00000000000000000000c4ffffffffff',
    '00000000000000000000d4ffffffffff',
    '00000000000000000000e3ffffffffff',
    '00000000000000000000f2ffffffc74b',
    '00000000000000000003ffffbe420000',
    '00000000000000000011b63a00000000',
    '00000000000000000000000000000000',
  ].join(''),
  'overlaps saturate': [
    '00000000000000000000000000000000',
    '00000000000000000000000000000000',
    '0000b0ffffffffffffffffb000000000',
    '00001cffffffffffffffff440b000000',
    '000000deffffffffffffffff80000000',
    '00000018ffffffffffffff8000000000',
    '00000000e2ffffffffff800000000000',
    '000000004fffffffff80000000000000',
    '0000000005f6ffff8c00000000000000',
    '000000000090ffcf0000000000000000',
    '00000000002f80000000000000000000',
    '00000000000000000000000000000000',
  ].join(''),
  'a heptagon, nonzero': [
    '00000000000000000000000000000000',
    '000000000008a0d69b5f260000000000',
    '000000001ecdffffffffff9c00000000',
    '0000003feafffffffffffffa1f000000',
    '000000a5ffffffffffffffff95000000',
    '000000a5fffffffffffffffff6190000',
    '000000a5ffffffffffffffffff3d0000',
    '000000a5ffffffffffffffffc5000000',
    '00000081ffffffffffffffff4b000000',
    '000000006ffbffffffffffcf01000000',
    '000000000040eafff8c58c2e00000000',
    '0000000000001c3d0900000000000000',
  ].join(''),
  'a ring, evenodd': [
    '00688888888888888888888888886800',
    '00c3ffffffffffffffffffffffffc300',
    '00c3ffffffffffffffffffffffffc300',
    '00c3ffffc0666666666666c0ffffc300',
    '00c3ffff9600000000000096ffffc300',
    '00c3ffff9600000000000096ffffc300',
    '00c3ffff9600000000000096ffffc300',
    '00c3ffff9600000000000096ffffc300',
    '00c3ffffc0666666666666c0ffffc300',
    '00c3ffffffffffffffffffffffffc300',
    '00c3ffffffffffffffffffffffffc300',
    '005b7777777777777777777777775b00',
  ].join(''),
};

const rasterize = (job, box = { x: 0, y: 0, w: W, h: H }) =>
  Buffer.from(
    new PreciseRasterizer().rasterize({ ...job, width: box.w, height: box.h, dx: -box.x, dy: -box.y })
  );

for (const [name, job] of Object.entries(SHAPES)) {
  test(`precise: ${name} comes out as the server drew it`, () => {
    assert.equal(rasterize(job).toString('hex'), GOLDEN[name]);
  });
}

test('precise: a box of the grid is that part of the whole, to the byte', () => {
  // the 2d context rasterizes a drawing over its own box, at a whole-pixel
  // offset; a mask drawn over the whole surface must agree with it there
  for (const [name, job] of Object.entries(SHAPES)) {
    const whole = rasterize(job);
    for (const box of [
      { x: 3, y: 2, w: 9, h: 7 },
      { x: 0, y: 5, w: 16, h: 7 },
      { x: 7, y: 0, w: 5, h: 12 }
    ]) {
      const part = rasterize(job, box);
      for (let y = 0; y < box.h; y++) {
        for (let x = 0; x < box.w; x++) {
          assert.equal(
            part[y * box.w + x],
            whole[(y + box.y) * W + x + box.x],
            `${name}, box at ${box.x},${box.y}: pixel ${x},${y}`
          );
        }
      }
    }
  }
});

test('precise: moved by whole pixels, a shape is the same bytes moved', () => {
  const at = rasterize(SHAPES['a triangle']);
  const tris = SHAPES['a triangle'].triangles.map((v, i) => v + (i % 2 ? 300 : -500));
  const moved = rasterize({ triangles: tris }, { x: -500, y: 300, w: W, h: H });
  assert.deepEqual(moved, at);
});

test('precise: covered pixels are 255 and uncovered ones 0', () => {
  // an axis-aligned rectangle on pixel boundaries: every sample of a pixel
  // inside, none of one outside
  const mask = rasterize({ polys: [[2, 3, 10, 3, 10, 9, 2, 9]], rule: 'nonzero' });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inside = x >= 2 && x < 10 && y >= 3 && y < 9;
      assert.equal(mask[y * W + x], inside ? 255 : 0, `pixel ${x},${y}`);
    }
  }
});

test('precise: a sample on an edge counts once, for the shape on its left', () => {
  // an edge at x = 4.5 runs exactly through the ninth of pixel 4's 17
  // sample columns. Of a shape to its right it covers 8 columns, of a shape
  // to its left 9, so two shapes abutting there add up to the whole pixel —
  // the spec's "abutting edges must match precisely"
  const right = rasterize({ polys: [[4.5, 0, 12, 0, 12, 12, 4.5, 12]], rule: 'nonzero' });
  const left = rasterize({ polys: [[1, 0, 4.5, 0, 4.5, 12, 1, 12]], rule: 'nonzero' });
  assert.equal(right[5 * W + 4], 8 * 15);
  assert.equal(left[5 * W + 4], 9 * 15);
  assert.equal(right[5 * W + 5], 255);
  assert.equal(right[5 * W + 3], 0);
});

test('precise: an offset that is not whole pixels is declined to the server', () => {
  const r = new PreciseRasterizer();
  assert.equal(r.rasterize({ ...SHAPES['a triangle'], width: W, height: H, dx: 0.5, dy: 0 }), null);
});

test('precise: coordinates snap to the 16.16 grid the wire carries', () => {
  assert.equal(fixed16(1.5), 98304);
  assert.equal(fixed16(-1.5), -98304);
  // toward zero, as the wire truncates
  assert.equal(fixed16(-1 / 131072), 0);
  for (const v of [0.1, -7.3, 123.456789, 1e-9, -16383.99999]) {
    assert.equal(fixed16(snapFixed16(v)), fixed16(v), `${v}`);
    assert.equal(snapFixed16(v) * 65536, fixed16(v), `${v} is exact on the grid`);
  }
  // node-x11 converts with parseInt(v * 65536), which reads a tiny
  // product's exponent notation: 4e-11 was 4 units, where it is 0
  assert.equal(snapFixed16(4e-11 / 65536), 0);
  assert.equal(parseInt(snapFixed16(4e-11 / 65536) * 65536), 0);
});

test('precise: it is the default rasterizer', () => {
  assert.ok(defaultRasterizer() instanceof PreciseRasterizer);
});
