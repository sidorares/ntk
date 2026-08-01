// _NET_WM_ICON: setIcon/getIcon, and the packing underneath them.
//
// Hermetic — node-x11's in-process pure-JS X server, no $DISPLAY needed.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, Image, ImageData, StaticFontSource } from '../lib/index.js';
import { packIcons, unpackIcons } from '../lib/imagedata.js';

// --- packing ---------------------------------------------------------------

const lsb = { byte_order: 0 };
const msb = { byte_order: 1 };

/** a w*h image whose pixels are a recognisable function of their index */
function ramp(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = i & 0xff;
    data[i * 4 + 1] = (i * 3) & 0xff;
    data[i * 4 + 2] = (i * 7) & 0xff;
    data[i * 4 + 3] = 255 - (i & 0x7f);
  }
  return { width: w, height: h, data };
}

describe('packIcons', () => {
  test('lays out width, height, then ARGB pixels', () => {
    const img = { width: 1, height: 1, data: new Uint8ClampedArray([0x11, 0x22, 0x33, 0x44]) };
    const buf = packIcons([img], lsb);
    assert.equal(buf.length, 12);
    assert.equal(buf.readUInt32LE(0), 1);
    assert.equal(buf.readUInt32LE(4), 1);
    // A=0x44 R=0x11 G=0x22 B=0x33
    assert.equal(buf.readUInt32LE(8) >>> 0, 0x44112233);
  });

  test('several images concatenate, each with its own header', () => {
    const buf = packIcons([ramp(2, 2), ramp(4, 1)], lsb);
    assert.equal(buf.length, (2 + 4) * 4 + (2 + 4) * 4);
    assert.equal(buf.readUInt32LE(0), 2);
    assert.equal(buf.readUInt32LE(4), 2);
    assert.equal(buf.readUInt32LE(24), 4, 'second image width follows the first image');
    assert.equal(buf.readUInt32LE(28), 1);
  });

  test('alpha is straight, not premultiplied', () => {
    // a fully saturated red at half alpha stays 0xff in the red byte
    const img = { width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 128]) };
    const px = packIcons([img], lsb).readUInt32LE(8) >>> 0;
    assert.equal((px >>> 24) & 0xff, 128);
    assert.equal((px >>> 16) & 0xff, 255, 'premultiplying would have made this 128');
  });

  test('the connection byte order decides, and really is used', () => {
    const img = { width: 1, height: 1, data: new Uint8ClampedArray([0x11, 0x22, 0x33, 0x44]) };
    assert.deepEqual([...packIcons([img], lsb).subarray(8)], [0x33, 0x22, 0x11, 0x44]);
    assert.deepEqual([...packIcons([img], msb).subarray(8)], [0x44, 0x11, 0x22, 0x33]);
  });

  test('a wrong-sized data buffer is rejected, naming which image', () => {
    assert.throws(
      () => packIcons([ramp(2, 2), { width: 4, height: 4, data: new Uint8ClampedArray(8) }], lsb),
      /icon 1: data must be 64 RGBA bytes/
    );
  });

  test('a bad size is rejected', () => {
    assert.throws(() => packIcons([{ width: 0, height: 4, data: new Uint8ClampedArray(0) }], lsb),
      /icon 0: width and height must be positive/);
  });
});

describe('unpackIcons', () => {
  for (const [name, display] of [['LSBFirst', lsb], ['MSBFirst', msb]]) {
    test(`${name}: round-trips every image and pixel`, () => {
      const images = [ramp(3, 5), ramp(8, 8)];
      const back = unpackIcons(packIcons(images, display), display);
      assert.equal(back.length, 2);
      back.forEach((got, i) => {
        assert.equal(got.width, images[i].width);
        assert.equal(got.height, images[i].height);
        assert.deepEqual([...got.data], [...images[i].data]);
      });
      assert.ok(back[0] instanceof ImageData);
    });
  }

  test('a truncated run yields what parsed rather than throwing', () => {
    // a window manager reads this off other people's windows
    const buf = packIcons([ramp(2, 2), ramp(4, 4)], lsb);
    const cut = buf.subarray(0, 24 + 8 + 16); // all of the first, part of the second
    const back = unpackIcons(cut, lsb);
    assert.equal(back.length, 1);
    assert.equal(back[0].width, 2);
  });

  test('an absurd claimed size stops the scan instead of allocating', () => {
    const buf = Buffer.alloc(16);
    buf.writeUInt32LE(0xfffffff, 0); // width
    buf.writeUInt32LE(0xfffffff, 4);
    assert.deepEqual(unpackIcons(buf, lsb), []);
  });

  test('a zero dimension stops the scan', () => {
    const buf = Buffer.alloc(16);
    assert.deepEqual(unpackIcons(buf, lsb), []);
  });

  test('trailing bytes too short for a header are ignored', () => {
    const buf = Buffer.concat([packIcons([ramp(2, 2)], lsb), Buffer.alloc(5)]);
    assert.equal(unpackIcons(buf, lsb).length, 1);
  });
});

// --- against the in-process X server ----------------------------------------

let app = null;

before(async () => {
  const server = xserver.createServer({ width: 200, height: 200 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  app = await createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
});

after(async () => {
  if (app) await app.close();
});

describe('setIcon / getIcon', () => {
  test('a single image round-trips through the server', async () => {
    const wnd = app.createWindow({ width: 40, height: 40 });
    const icon = ramp(8, 8);
    await wnd.setIcon(icon);

    const back = await wnd.getIcon();
    assert.equal(back.length, 1);
    assert.equal(back[0].width, 8);
    assert.deepEqual([...back[0].data], [...icon.data]);
    wnd.destroy();
  });

  test('the property is CARDINAL/32 and the right length', async () => {
    const wnd = app.createWindow({ width: 40, height: 40 });
    await wnd.setIcon(ramp(16, 16));

    const prop = await wnd.getProperty('_NET_WM_ICON');
    assert.equal(prop.type, app.X.atoms.CARDINAL, 'window managers check the type');
    assert.equal(prop.data.length, (2 + 16 * 16) * 4);
    wnd.destroy();
  });

  test('several sizes are written as one property', async () => {
    const wnd = app.createWindow({ width: 40, height: 40 });
    await wnd.setIcon([ramp(16, 16), ramp(32, 32), ramp(48, 48)]);

    const back = await wnd.getIcon();
    assert.deepEqual(back.map((i) => i.width), [16, 32, 48]);
    wnd.destroy();
  });

  test('an ntk Image goes straight in', async () => {
    const wnd = app.createWindow({ width: 40, height: 40 });
    const { width, height, data } = ramp(4, 4);
    await wnd.setIcon(new Image({ width, height, data: Buffer.from(data) }));

    const back = await wnd.getIcon();
    assert.deepEqual([...back[0].data], [...data]);
    wnd.destroy();
  });

  test('an ImageData from getImageData goes straight in', async () => {
    // the composition the format alignment was for: draw, read, publish
    const wnd = app.createWindow({ width: 40, height: 40 });
    const ctx = app.createPixmap({ width: 8, height: 8, depth: 24 }).getContext('2d');
    ctx.fillStyle = 'rgb(10, 20, 30)';
    ctx.fillRect(0, 0, 8, 8);

    await wnd.setIcon(await ctx.getImageData(0, 0, 8, 8));

    const back = await wnd.getIcon();
    assert.deepEqual([...back[0].data.slice(0, 4)], [10, 20, 30, 255]);
    wnd.destroy();
  });

  test('setIcon(null) removes the property rather than blanking it', async () => {
    const wnd = app.createWindow({ width: 40, height: 40 });
    await wnd.setIcon(ramp(4, 4));
    assert.ok(await wnd.getIcon());

    await wnd.setIcon(null);
    assert.equal(await wnd.getProperty('_NET_WM_ICON'), null, 'reads back as type None');
    assert.equal(await wnd.getIcon(), null);
    wnd.destroy();
  });

  test('an empty array removes it too', async () => {
    const wnd = app.createWindow({ width: 40, height: 40 });
    await wnd.setIcon(ramp(4, 4));
    await wnd.setIcon([]);
    assert.equal(await wnd.getIcon(), null);
    wnd.destroy();
  });

  test('setting again replaces rather than appending', async () => {
    const wnd = app.createWindow({ width: 40, height: 40 });
    await wnd.setIcon([ramp(8, 8), ramp(16, 16)]);
    await wnd.setIcon(ramp(4, 4));

    const back = await wnd.getIcon();
    assert.deepEqual(back.map((i) => i.width), [4]);
    wnd.destroy();
  });

  test('getIcon is null on a window that never set one', async () => {
    const wnd = app.createWindow({ width: 40, height: 40 });
    assert.equal(await wnd.getIcon(), null);
    wnd.destroy();
  });

  test('createWindow({ icon }) writes it', async () => {
    const wnd = app.createWindow({ width: 40, height: 40, icon: ramp(8, 8) });
    // interning the atom defers the write, so give it a tick
    await new Promise((r) => setTimeout(r, 20));
    const back = await wnd.getIcon();
    assert.equal(back.length, 1);
    assert.equal(back[0].width, 8);
    wnd.destroy();
  });

  test('a bad image throws before anything reaches the server', async () => {
    const wnd = app.createWindow({ width: 40, height: 40 });
    await assert.rejects(
      () => wnd.setIcon({ width: 4, height: 4, data: new Uint8ClampedArray(8) }),
      /data must be 64 RGBA bytes/
    );
    assert.equal(await wnd.getProperty('_NET_WM_ICON'), null, 'nothing was written');
    wnd.destroy();
  });

  test('an icon too big for one request is split and still reads back whole', async () => {
    // node-x11 turns on BIG-REQUESTS during handshake, so the split only
    // happens on a connection that opted out — which is the configuration
    // this path exists for. 256x256 is 262152 bytes against a 262140 cap.
    const server = xserver.createServer({ width: 200, height: 200 });
    const [serverEnd, clientEnd] = xserver.createStreamPair();
    server.addClientStream(serverEnd);
    const small = await createClient({
      stream: clientEnd,
      fontSource: new StaticFontSource(),
      disableBigRequests: true
    });
    try {
      assert.ok(
        small.display.max_request_length <= 0xffff,
        `expected the classic cap, got ${small.display.max_request_length}`
      );
      const wnd = small.createWindow({ width: 40, height: 40 });
      const big = ramp(256, 256);
      assert.ok(
        (2 + 256 * 256) * 4 > small.display.max_request_length * 4 - 24,
        'this icon has to overrun a single request or the test proves nothing'
      );
      await wnd.setIcon(big);

      const back = await wnd.getIcon();
      assert.equal(back.length, 1, 'one image, not one per chunk');
      assert.equal(back[0].width, 256);
      assert.deepEqual([...back[0].data], [...big.data]);
      wnd.destroy();
    } finally {
      await small.close();
    }
  });
});
