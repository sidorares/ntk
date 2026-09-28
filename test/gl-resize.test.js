// A direct context across a change of generation: a resize, and the linear
// retry after the server refuses a buffer.
//
// Both replace the surface the context is drawing into, and both used to do
// it by destroying that surface while it was current. EGL tolerates that for
// the EGL surface — it defers the delete — but not for the GBM surface under
// it, and on NVIDIA's driver every swap after it failed with
// EGL_BAD_SURFACE: a `<glarea>` laid out after its window was made (every
// one) drew its first frame and never another, with nothing reported. The
// retry had the other half of the bug: the context kept the surface it had
// cached, which the chain had just destroyed.
//
// Hermetic: node-x11's pure-JS X server for the window, a stubbed capability
// answer, and a stand-in for x11-dri whose GPU behaves the way NVIDIA's did —
// no display, no GPU. What a real driver does is test/gl-direct-live.test.js.
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { GLError, setDriAddon } from '../lib/gl.js';
import { createClient, StaticFontSource } from '../lib/index.js';

const { createServer, createStreamPair } = xserver;

let app = null;

/** x11-dri's shape, with a GPU that remembers a surface destroyed while current. */
function fakeAddon() {
  const GBM_USE = { SCANOUT: 1, RENDERING: 2, LINEAR: 4 };
  const log = [];
  class Gpu {
    constructor() {
      this.current = null;
      // the driver's state after a current surface lost its GBM surface
      this.poisoned = false;
    }
    makeCurrent(surface) {
      if (surface?.destroyed) throw new Error('makeCurrent: this surface is destroyed');
      log.push(`current ${surface ? surface.name : 'none'}`);
      this.current = surface;
    }
    createSurface(width, height, use) {
      const gpu = this;
      let next = 1;
      const surface = {
        name: `${width}x${height}${use & GBM_USE.LINEAR ? 'L' : ''}`,
        linear: Boolean(use & GBM_USE.LINEAR),
        destroyed: false,
        swap() {
          if (surface.destroyed) throw new Error('swapBuffers: this surface is destroyed');
          if (gpu.poisoned) throw new Error('eglSwapBuffers failed (0x300d)');
          const key = next++;
          return { key, isNew: true, fd: 100 + key, width, height, stride: width * 4 };
        },
        release() {},
        destroy() {
          if (gpu.current === surface) gpu.poisoned = true;
          surface.destroyed = true;
          log.push(`destroy ${surface.name}`);
        }
      };
      log.push(`create ${surface.name}`);
      return surface;
    }
  }
  const noop = () => {};
  return {
    log,
    Gpu,
    GBM_USE,
    FORMAT: { XRGB8888: 1, ARGB8888: 2 },
    GL: { RENDERER: 0x1f01 },
    gl: { viewport: noop, clearColor: noop, clear: noop, getString: () => 'fake', COLOR_BUFFER_BIT: 0x4000 }
  };
}

/**
 * The capability answer for a dri3 connection, with DRI3 and Present
 * stand-ins: imports succeed — but for the first `refuse` of them, which the
 * server turns down the way one on another DRM device does — and a present is
 * accepted and forgotten.
 */
function asDri3({ refuse = 0 } = {}) {
  const presented = [];
  let imports = 0;
  app.options.glPolicy = 'auto';
  app._glCapsResolved = {
    direct: true,
    indirect: true,
    flavor: 'dri3',
    device: null,
    reason: null,
    DRI3: {
      PixmapFromBuffer(pixmap, drawable, buffer, cb) {
        const refused = imports++ < refuse;
        // a real pixmap under the id, so the chain's FreePixmap names one
        if (!refused) app.X.CreatePixmap(pixmap, drawable, 24, buffer.width, buffer.height);
        setImmediate(() => cb(refused ? new Error('BadAlloc') : null));
      }
    },
    Present: {
      majorOpcode: 200,
      EventMask: { NoEvent: 0, CompleteNotify: 2, IdleNotify: 4 },
      events: { CompleteNotify: 1, IdleNotify: 2 },
      SelectInput() {},
      Pixmap(window, pixmap, opts) {
        presented.push(opts.serial);
      }
    }
  };
  return presented;
}

before(async () => {
  const server = createServer({ width: 320, height: 240 });
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);
  app = await createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
});

after(async () => {
  if (app) await app.close();
});

afterEach(() => {
  setDriAddon(undefined);
  app._glCapsResolved = undefined;
  app._glGpus = undefined;
  app._glCurrent = null;
  app._glCurrentSurface = null;
});

function frame(gl, wnd) {
  gl.makeCurrent();
  gl.viewport(0, 0, wnd.width, wnd.height);
  gl.clear(gl.COLOR_BUFFER_BIT);
  return gl.SwapBuffers();
}

describe('a direct context across a new generation', () => {
  test('keeps drawing after its window is resized', async () => {
    const addon = fakeAddon();
    setDriAddon(addon);
    const presented = asDri3();
    // made before layout gave it a size, as a <glarea> is
    const wnd = app.createWindow({ width: 1, height: 1, backingStore: false });
    const gl = wnd.getContext('opengl');
    assert.equal(gl.backend, 'direct');
    await gl.ready;

    wnd.width = 300;
    wnd.height = 200;
    assert.equal(frame(gl, wnd), true, 'the first frame at the new size goes out');
    await new Promise((resolve) => setImmediate(resolve)); // the import's round trip
    assert.equal(gl.error, null);
    assert.deepEqual(presented, [1]);

    const at = addon.log.indexOf('destroy 1x1');
    assert.ok(at > 0, 'the old generation went');
    assert.equal(addon.log[at - 1], 'current none', 'unbound before it went');
    assert.ok(addon.log.indexOf('create 300x200') < at, 'the new one was made first');
    gl.destroy();
  });

  test('a failure after ready is onError’s, with the coded error', async () => {
    const addon = fakeAddon();
    setDriAddon(addon);
    asDri3();
    const wnd = app.createWindow({ width: 64, height: 64, backingStore: false });
    const gl = wnd.getContext('opengl');
    await gl.ready;
    const errors = [];
    gl.onError = (err) => errors.push(err);
    // the driver loses the context under us
    gl.gpu.poisoned = true;
    assert.equal(frame(gl, wnd), false);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, GLError.CONTEXT_FAILED);
    assert.equal(gl.error, errors[0]);
    assert.equal(frame(gl, wnd), false, 'and it draws nothing more');
    assert.equal(errors.length, 1, 'said once');
    gl.destroy();
  });

  test('after the server refuses a buffer, draws into the linear retry', async () => {
    const addon = fakeAddon();
    setDriAddon(addon);
    const presented = asDri3({ refuse: 1 });
    const wnd = app.createWindow({ width: 64, height: 64, backingStore: false });
    const gl = wnd.getContext('opengl');
    await gl.ready;
    assert.ok(addon.log.includes('create 64x64L'), 'the chain went linear');
    assert.equal(frame(gl, wnd), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gl.error, null);
    assert.equal(gl.gpu.current.name, '64x64L', 'the retry is what is current');
    assert.deepEqual(presented, [1]);
    gl.destroy();
  });
});
