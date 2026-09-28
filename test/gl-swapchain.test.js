// Which layout a generation of GPU buffers is made in, and the one retry that
// answers a refusal. Hermetic — GBM, EGL and the X server are stubs here, so
// this runs with no display, no GPU and no x11-dri installed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { DEFAULT_GL_POLICY, GLError } from '../lib/gl.js';
import { GLSwapchain } from '../lib/glswapchain.js';

// x11-dri's flags; the values are its own, and only the mask matters here
const GBM_USE = { SCANOUT: 1, RENDERING: 2, LINEAR: 4 };
const LINEAR = GBM_USE.RENDERING | GBM_USE.LINEAR;
// what NVIDIA's driver answers a render-only GBM surface: EGL_BAD_MATCH
const REFUSED = 'eglCreateWindowSurface on gbm_surface failed (0x3003)';

/** A GPU that hands back a surface for the layouts `takes` says yes to. */
function fakeGpu(takes) {
  const calls = [];
  return {
    calls,
    createSurface(width, height, use) {
      calls.push({ width, height, use });
      if (!takes(use)) throw new Error(REFUSED);
      return { width, height, use, destroy() {}, release() {} };
    }
  };
}

function chainOn(gpu, policy = {}) {
  return new GLSwapchain({
    window: { id: 3, X: { AllocID: () => 7, flush() {}, FreePixmap() {} } },
    gpu,
    dri: { GBM_USE },
    DRI3: {},
    Present: { EventMask: { CompleteNotify: 1, IdleNotify: 2 }, SelectInput() {} },
    depth: 24,
    policy: { ...DEFAULT_GL_POLICY, mode: 'auto', ...policy }
  });
}

describe('buffer layout', () => {
  test('a generation is made in the GPU’s own layout', () => {
    const gpu = fakeGpu(() => true);
    const chain = chainOn(gpu);
    const surface = chain.surfaceFor(800, 600);
    assert.deepEqual(gpu.calls, [{ width: 800, height: 600, use: undefined }]);
    assert.equal(surface.width, 800);
    assert.equal(chain.generation.linear, false);
  });

  test('a driver that will not draw into it gets one linear retry', () => {
    const gpu = fakeGpu((use) => use === LINEAR);
    const chain = chainOn(gpu);
    const surface = chain.surfaceFor(800, 600);
    assert.deepEqual(
      gpu.calls.map((call) => call.use),
      [undefined, LINEAR]
    );
    assert.equal(surface.use, LINEAR);
    assert.equal(chain.generation.linear, true);
  });

  test('the next size is asked for linear straight away', () => {
    const gpu = fakeGpu((use) => use === LINEAR);
    const chain = chainOn(gpu);
    chain.surfaceFor(800, 600);
    gpu.calls.length = 0;
    chain.surfaceFor(400, 300);
    assert.deepEqual(gpu.calls, [{ width: 400, height: 300, use: LINEAR }]);
  });

  test('linearFallback: false keeps the refusal, naming the layout it tried', () => {
    const gpu = fakeGpu((use) => use === LINEAR);
    const chain = chainOn(gpu, { linearFallback: false });
    assert.throws(
      () => chain.surfaceFor(800, 600),
      (err) => {
        assert.equal(err.code, GLError.CONTEXT_FAILED);
        assert.match(err.message, /800x600 GPU surface \(tiled\)/);
        assert.match(err.message, /0x3003/);
        assert.match(err.hint, /linearFallback/);
        assert.equal(err.cause.message, REFUSED);
        return true;
      }
    );
    assert.equal(gpu.calls.length, 1, 'the policy said not to retry');
  });

  test('a refusal of both names both, and points at the next thing to try', () => {
    const gpu = fakeGpu(() => false);
    const chain = chainOn(gpu);
    assert.throws(
      () => chain.surfaceFor(800, 600),
      (err) => {
        assert.equal(err.code, GLError.CONTEXT_FAILED);
        assert.match(err.message, /\(tiled or linear\)/);
        assert.match(err.message, /; linear: /);
        assert.match(err.hint, /devicePath/);
        assert.match(err.hint, /'indirect'/);
        return true;
      }
    );
    assert.equal(gpu.calls.length, 2);
  });

  test('the docs anchor the surface errors point at exists', () => {
    // nothing else in CI checks a doc anchor referenced from a string literal
    const docs = readFileSync(new URL('../docs/context-gles.md', import.meta.url), 'utf8');
    assert.ok(/^## Buffer layout$/m.test(docs), 'docs/context-gles.md#buffer-layout');
  });
});

/**
 * A GPU that keeps track of which surface is current, the way EGL does, and
 * records every surface destroyed while it was: the driver hazard behind the
 * rule. On NVIDIA the next surface made current after one such destroy swaps
 * nothing but EGL_BAD_SURFACE.
 */
function currencyGpu() {
  const log = [];
  const gpu = {
    log,
    current: null,
    destroyedWhileCurrent: [],
    makeCurrent(surface) {
      log.push(`current ${surface ? surface.name : 'none'}`);
      gpu.current = surface;
    },
    createSurface(width, height) {
      const surface = {
        name: `${width}x${height}`,
        width,
        height,
        destroy() {
          log.push(`destroy ${surface.name}`);
          if (gpu.current === surface) gpu.destroyedWhileCurrent.push(surface.name);
        },
        release() {},
        swap: () => ({ key: 1, isNew: false })
      };
      log.push(`create ${surface.name}`);
      return surface;
    }
  };
  return gpu;
}

/** A chain on a window that belongs to an app, whose currency slots the
 *  context writes as it binds — `bind` is what `RenderingContextGLES#_bind`
 *  does with the surface it is handed. */
function boundChain(gpu) {
  const app = { _glCurrent: null, _glCurrentSurface: null };
  const chain = new GLSwapchain({
    window: { id: 3, app, X: { AllocID: () => 7, flush() {}, FreePixmap() {} } },
    gpu,
    dri: { GBM_USE },
    DRI3: {},
    Present: { EventMask: { CompleteNotify: 1, IdleNotify: 2 }, SelectInput() {} },
    depth: 24,
    policy: { ...DEFAULT_GL_POLICY, mode: 'auto' }
  });
  const context = {};
  const bind = (width, height) => {
    const surface = chain.surfaceFor(width, height);
    gpu.makeCurrent(surface);
    app._glCurrent = context;
    app._glCurrentSurface = surface;
    return surface;
  };
  return { app, chain, bind, context };
}

describe('a surface is never destroyed while it is current', () => {
  test('a resize makes the new generation, then lets the current one go unbound', () => {
    const gpu = currencyGpu();
    const { app, bind } = boundChain(gpu);
    bind(1, 1);
    gpu.log.length = 0;
    bind(878, 578);
    assert.deepEqual(gpu.log, [
      'create 878x578', // the new one first: a refused size leaves the old in place
      'current none',
      'destroy 1x1',
      'current 878x578'
    ]);
    assert.deepEqual(gpu.destroyedWhileCurrent, []);
    assert.equal(app._glCurrentSurface.name, '878x578');
  });

  test('a surface that is not current is let go without touching the currency', () => {
    const gpu = currencyGpu();
    const { app, chain, bind } = boundChain(gpu);
    bind(100, 100);
    // another window's surface is current now
    const other = { name: 'other' };
    gpu.makeCurrent(other);
    app._glCurrentSurface = other;
    const marker = {};
    app._glCurrent = marker;
    gpu.log.length = 0;
    chain.surfaceFor(200, 200);
    assert.deepEqual(gpu.log, ['create 200x200', 'destroy 100x100']);
    assert.equal(app._glCurrent, marker, 'the other context stays current');
    assert.equal(gpu.current, other);
  });

  test('destroying the chain unbinds its current surface first', () => {
    const gpu = currencyGpu();
    const { app, chain, bind } = boundChain(gpu);
    bind(64, 64);
    chain.destroy();
    assert.deepEqual(gpu.destroyedWhileCurrent, []);
    assert.equal(app._glCurrent, null, 'the next GL call binds afresh');
    assert.equal(app._glCurrentSurface, null);
  });
});

describe('a failure after validation', () => {
  test('is reported through onError, once, where ready has no way left to say it', () => {
    const gpu = currencyGpu();
    const { chain, bind } = boundChain(gpu);
    const surface = bind(32, 32);
    const validated = [];
    const errors = [];
    chain.onValidated = (err) => validated.push(err);
    chain.onError = (err) => errors.push(err);
    chain.validate(); // a buffer that is not new validates the chain at once
    assert.deepEqual(validated, [null]);
    surface.swap = () => {
      throw new Error('eglSwapBuffers failed (0x300d)');
    };
    assert.equal(chain.swap(), false);
    assert.equal(chain.swap(), false);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, GLError.CONTEXT_FAILED);
    assert.match(errors[0].message, /0x300d/);
    assert.deepEqual(validated, [null], 'ready settled once, and stays settled');
    assert.equal(chain.canRender(), false);
  });

  test('before validation is ready’s rejection alone', () => {
    const gpu = currencyGpu();
    const { chain, bind } = boundChain(gpu);
    const surface = bind(32, 32);
    surface.swap = () => {
      throw new Error('eglSwapBuffers failed (0x3001)');
    };
    const validated = [];
    const errors = [];
    chain.onValidated = (err) => validated.push(err);
    chain.onError = (err) => errors.push(err);
    chain.validate();
    assert.equal(validated.length, 1);
    assert.match(validated[0].message, /0x3001/);
    assert.deepEqual(errors, []);
  });
});
