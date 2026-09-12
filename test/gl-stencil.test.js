// Stencil buffers, and what a request for one means on each backend.
//
// A framebuffer with no stencil buffer passes every stencil test, which makes
// a missing one the quietest failure GL has: stencil-based drawing — the
// stencil-then-cover polygon fill a map renderer is built on — does not fail
// there, it fills its whole cover quad. The CGL context on macOS/XQuartz used
// to be created with a depth size and nothing else, so every window on that
// flavor was in exactly that state, while the Cocoa backend's GL surfaces
// carry DEPTH24_STENCIL8. The request now travels, 8 bits unless the config
// names a size; the dri3 flavor, which has nothing to ask with, answers 0
// out loud instead.
//
// Hermetic: node-x11's pure-JS X server with its GLX emulator for the
// indirect half, a stubbed capability answer and a recording stand-in for
// x11-dri's `apple.Context` for the direct one — no display, no GPU. What a
// real XQuartz does with the request is test/gl-appledri-live.test.js.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { after, afterEach, before, describe, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { DEFAULT_STENCIL_SIZE, directStencilSize, requestedStencil, setDriAddon } from '../lib/gl.js';
import { createClient, StaticFontSource } from '../lib/index.js';

const require = createRequire(import.meta.url);
const { createGlxExtension, RecordingBackend } = require('x11/browser/glx');
const { createServer, createStreamPair } = xserver;

let app = null;

// the options every CGL context was created with — the pixel format is built
// from exactly these, so on this side of the addon they are the whole question
const created = [];
class RecordingAppleContext {
  constructor(options) {
    created.push(options);
  }
  attach() {}
  makeCurrent() {}
  flush() {}
  update() {}
  destroy() {}
}
const darwinAddon = { apple: { clientId: () => 0x1234, Context: RecordingAppleContext }, gl: {} };

// what the console said while `fn` ran, so the warning can be asserted on the
// way a caller actually meets it
async function captured(fn) {
  const said = [];
  const warn = console.warn;
  console.warn = (...args) => said.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.warn = warn;
  }
  return said;
}

// the direct backend's answer, stubbed onto a real App; the Apple-DRI half is
// just enough for a CGL context to construct against an unmapped window,
// which starts no surface round trip
function asDirect(flavor) {
  app.options.glPolicy = 'auto';
  app._glCapsResolved = {
    direct: true,
    indirect: true,
    flavor,
    device: null,
    reason: null,
    AppleDRI: { NotifyKind: { Changed: 0, Destroyed: 1 } },
    appleClientId: 0x1234
  };
  app._warnedDirectStencil = false;
}

function asIndirect() {
  app.options.glPolicy = 'indirect';
  app._glCapsResolved = undefined;
}

/** a CGL context on a fresh unmapped window, and the options CGL was asked with */
function cglContext(config) {
  setDriAddon(darwinAddon);
  created.length = 0;
  const wnd = app.createWindow({ width: 32, height: 32 });
  const gl = wnd.getContext('opengl', config);
  assert.equal(gl.flavor, 'appledri');
  assert.equal(created.length, 1, 'one CGL context per window');
  return { gl, wnd, options: created[0] };
}

before(async () => {
  const server = createServer({ width: 320, height: 240 });
  server.registerExtension(
    'GLX',
    createGlxExtension({ backend: new RecordingBackend(), getDrawableSurface: () => null })
  );
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);
  app = await createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
});

after(async () => {
  if (app) await app.close();
});

afterEach(() => setDriAddon(undefined)); // back to the real loader

describe('requestedStencil', () => {
  test('reads the config spelling before the GLX one, as the depth size is read', () => {
    assert.equal(requestedStencil({ STENCIL_SIZE: 8 }), 8);
    assert.equal(requestedStencil({ stencilSize: 4, STENCIL_SIZE: 8 }), 4);
    assert.equal(requestedStencil({ STENCIL_SIZE: 0 }), 0, 'an explicit 0 asks for no stencil buffer');
    assert.equal(requestedStencil({ DEPTH_SIZE: 24 }), undefined, 'naming none is not asking for none');
    assert.equal(requestedStencil({ STENCIL_SIZE: null }), undefined, "GLX's don't-care");
    assert.equal(requestedStencil(), undefined);
  });
});

describe('directStencilSize', () => {
  test('appledri passes the request on, and has a stencil buffer by default', () => {
    assert.equal(DEFAULT_STENCIL_SIZE, 8, "the Cocoa backend's surfaces are DEPTH24_STENCIL8");
    assert.equal(directStencilSize('appledri', undefined), 8);
    assert.equal(directStencilSize('appledri', 0), 0);
    assert.equal(directStencilSize('appledri', 16), 16);
  });

  test('dri3 has nothing to ask with, so it answers 0 whatever was asked', () => {
    assert.equal(directStencilSize('dri3', undefined), 0);
    assert.equal(directStencilSize('dri3', 8), 0);
  });
});

describe('the CGL context asks for the stencil the config names', () => {
  test('naming none gets 8 bits — it used to get a pixel format without any', async () => {
    asDirect('appledri');
    const config = await app.chooseGLConfig({ DEPTH_SIZE: 24 });
    assert.equal(config.stencilSize, 8);
    const { gl, wnd, options } = cglContext(config);
    assert.equal(options.stencilSize, 8);
    assert.equal(options.depthSize, 24, 'the depth size travels as it always has');
    assert.equal(gl.stencilSize, 8, 'and the context says what it asked for');
    gl.destroy();
    wnd.destroy();
  });

  test('STENCIL_SIZE travels from the spec, through the config, to CGL', async () => {
    asDirect('appledri');
    const config = await app.chooseGLConfig({ STENCIL_SIZE: 0 });
    assert.equal(config.stencilSize, 0, 'an explicit 0 is honoured, not replaced by the default');
    const { gl, wnd, options } = cglContext(config);
    assert.equal(options.stencilSize, 0);
    assert.equal(gl.stencilSize, 0);
    gl.destroy();
    wnd.destroy();
  });

  // getContext is the other door a spec comes in through: a hand-written
  // GLX-style object reaches the context without passing chooseGLConfig
  test('a hand-written config is read the same way', () => {
    asDirect('appledri');
    const { gl, wnd, options } = cglContext({ DEPTH_SIZE: 24, STENCIL_SIZE: 4 });
    assert.equal(options.stencilSize, 4);
    assert.equal(options.depthSize, 24);
    assert.equal(gl.stencilSize, 4);
    gl.destroy();
    wnd.destroy();
  });

  test('the request is passed on, so appledri says nothing about it', async () => {
    asDirect('appledri');
    const said = await captured(() => app.chooseGLConfig({ STENCIL_SIZE: 8 }));
    assert.deepEqual(said, []);
  });
});

describe('the dri3 flavor answers with 0, out loud', () => {
  test('a spec that asks for stencil gets a config that reports what it got', async () => {
    asDirect('dri3');
    const said = await captured(async () => {
      const config = await app.chooseGLConfig({ STENCIL_SIZE: 8 });
      assert.equal(config.stencilSize, 0);
    });
    assert.equal(said.length, 1);
    assert.match(said[0], /STENCIL_SIZE=8/);
    assert.match(said[0], /dri3/, 'names the flavor that cannot do it');
    assert.match(said[0], /passes everywhere/, 'names the failure it would otherwise be');
    assert.match(said[0], /stencilSize: 0/, 'names the field to branch on');
    assert.match(said[0], /docs\/context-gles\.md#stencil/);
  });

  test('once per connection, not once per window', async () => {
    asDirect('dri3');
    const first = await captured(() => app.chooseGLConfig({ STENCIL_SIZE: 8 }));
    const second = await captured(() => app.chooseGLConfig({ STENCIL_SIZE: 1 }));
    assert.equal(first.length, 1);
    assert.deepEqual(second, [], 'the second window would only repeat it');
  });

  test('a spec that never asked is not warned at, and still reports stencilSize', async () => {
    asDirect('dri3');
    const said = await captured(async () => {
      const config = await app.chooseGLConfig({ DEPTH_SIZE: 24 });
      assert.equal(config.stencilSize, 0);
    });
    assert.deepEqual(said, []);
  });
});

describe('the indirect backend answers with what the fbconfig has', () => {
  test('stencilSize is on the answer, as samples is', async () => {
    asIndirect();
    const config = await app.chooseGLConfig({ STENCIL_SIZE: 8 });
    assert.equal(config.backend, 'indirect');
    assert.equal(config.stencilSize, 8, 'the one fbconfig this server publishes has 8 stencil bits');
  });

  test('a pinned visual reports it unknown, which is not the same claim as none', async () => {
    asIndirect();
    const config = await app.chooseGLXConfig({ visual: app.display.screen[0].root_visual });
    assert.equal(config.stencilSize, null);
    assert.equal(config.samples, null);
  });
});

test('the remedy the warning points at is a heading that exists', () => {
  const docs = readFileSync(new URL('../docs/context-gles.md', import.meta.url), 'utf8');
  assert.ok(/^## Stencil$/m.test(docs), 'docs/context-gles.md#stencil');
});
