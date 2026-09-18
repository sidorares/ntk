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
