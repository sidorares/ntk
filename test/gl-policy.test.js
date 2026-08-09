// glPolicy: which GL backend a connection uses, and why it cannot use the
// other one. Hermetic — the decision is made from the policy, the connection
// and a probe of the optional addon, all of which are stubbed here, so this
// runs with no display, no GPU and no x11-dri installed.
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import Drawable from '../lib/drawable.js';
import {
  DEFAULT_GL_POLICY,
  GLError,
  GL_MODES,
  backendFor,
  canPassDescriptors,
  glCapabilities,
  probeDirect,
  resolveGLPolicy,
  setDriAddon,
  wantsDirect
} from '../lib/gl.js';
import { GLXError } from '../lib/glx.js';

// registers both GL contexts on Drawable; the direct one wraps the 'opengl'
// factory, which is what the dispatch tests below exercise
import '../lib/renderingcontext_opengl.js';
import '../lib/renderingcontext_gles.js';

const withEnv = (value, fn) => {
  const had = Object.hasOwn(process.env, 'NTK_GL_POLICY');
  const previous = process.env.NTK_GL_POLICY;
  if (value === undefined) delete process.env.NTK_GL_POLICY;
  else process.env.NTK_GL_POLICY = value;
  try {
    return fn();
  } finally {
    if (had) process.env.NTK_GL_POLICY = previous;
    else delete process.env.NTK_GL_POLICY;
  }
};

// an addon that reports everything present, with one render node
const workingAddon = {
  probe: () => ({ platform: 'linux', gbm: true, egl: true, gles: true, udmabuf: true }),
  listRenderNodes: () => ['/dev/dri/renderD128']
};

// a connection that can pass descriptors and has the extensions
function fakeApp({
  local = true,
  fdCapable = true,
  exts = { dri3: { fdCapable: true, major: 1, minor: 4 }, present: { major: 1, minor: 2 } },
  glx = {},
  options = {}
} = {}) {
  const app = {
    options,
    display: {
      isLocalSocket: local,
      GLX: glx,
      client: { stream: fdCapable ? { _fdCapable: true, sendFds: () => {} } : {} }
    }
  };
  app.X = {
    require: (name, cb) =>
      queueMicrotask(() => (exts[name] ? cb(null, exts[name]) : cb(new Error(`unknown extension: ${name}`))))
  };
  Object.defineProperty(app, 'glPolicy', { get: () => resolveGLPolicy(app.options) });
  return app;
}

afterEach(() => setDriAddon(undefined)); // back to the real loader

describe('resolveGLPolicy', () => {
  test('defaults to indirect, so an app that never asked keeps the old backend', () => {
    withEnv(undefined, () => {
      assert.equal(resolveGLPolicy({}).mode, 'indirect');
      assert.equal(DEFAULT_GL_POLICY.mode, 'indirect');
    });
  });

  test('a string is sugar for { mode }', () => {
    withEnv(undefined, () => {
      assert.deepEqual(resolveGLPolicy({ glPolicy: 'auto' }), { ...DEFAULT_GL_POLICY, mode: 'auto' });
    });
  });

  test('an object sets the direct backend knobs', () => {
    withEnv(undefined, () => {
      const policy = resolveGLPolicy({ glPolicy: { mode: 'direct', maxInFlight: 3 } });
      assert.equal(policy.mode, 'direct');
      assert.equal(policy.maxInFlight, 3);
      assert.equal(policy.linearFallback, true); // untouched knobs keep defaults
    });
  });

  test('NTK_GL_POLICY wins, so one build can be run both ways', () => {
    withEnv('direct', () => {
      assert.equal(resolveGLPolicy({ glPolicy: 'indirect' }).mode, 'direct');
    });
  });

  test('a bad policy is a rejected createClient, not a later crash', async () => {
    const { createClient } = await import('../lib/index.js');
    // validated in the connect path's synchronous part on purpose: thrown
    // from a connection callback instead, it would be an uncaught exception
    await assert.rejects(() => createClient({ glPolicy: 'gpu-please' }), /not a GL policy mode/);
    await assert.rejects(
      () => withEnv('nonsense', () => createClient()),
      /NTK_GL_POLICY.*not a GL policy mode/s
    );
  });

  test('a mode that is not one names the ones that are', () => {
    withEnv(undefined, () => {
      assert.throws(() => resolveGLPolicy({ glPolicy: 'gpu' }), (err) => {
        for (const mode of GL_MODES) assert.match(err.message, new RegExp(mode));
        return true;
      });
    });
    withEnv('yes-please', () => {
      assert.throws(() => resolveGLPolicy({}), /NTK_GL_POLICY/);
    });
  });

  test('only auto and direct ever want the direct backend', () => {
    withEnv(undefined, () => {
      assert.deepEqual(
        GL_MODES.filter((mode) => wantsDirect(resolveGLPolicy({ glPolicy: mode }))),
        ['auto', 'direct']
      );
    });
  });
});

describe('probeDirect', () => {
  test('a missing addon is an install instruction, not a stack trace', () => {
    setDriAddon(null);
    const probe = probeDirect(DEFAULT_GL_POLICY);
    assert.equal(probe.ok, false);
    assert.equal(probe.code, GLError.NO_ADDON);
    assert.match(probe.hint, /npm install x11-dri/);
  });

  test('missing GPU libraries report which ones, and say Linux-only off Linux', () => {
    setDriAddon({
      probe: () => ({ platform: 'darwin', gbm: 'no libgbm on this platform', egl: true, gles: true }),
      listRenderNodes: () => []
    });
    const probe = probeDirect(DEFAULT_GL_POLICY);
    assert.equal(probe.code, GLError.NO_DRIVER);
    assert.match(probe.message, /no libgbm/);
    assert.match(probe.hint, /Linux-only/);
  });

  test('no render node is a permissions/container answer', () => {
    setDriAddon({ ...workingAddon, listRenderNodes: () => [] });
    const probe = probeDirect(DEFAULT_GL_POLICY);
    assert.equal(probe.code, GLError.NO_DEVICE);
    assert.match(probe.hint, /--device \/dev\/dri|render.*group/s);
  });

  test('a working addon reports the device it would draw on', () => {
    setDriAddon(workingAddon);
    const probe = probeDirect(DEFAULT_GL_POLICY);
    assert.equal(probe.ok, true);
    assert.equal(probe.device, '/dev/dri/renderD128');
  });

  test('devicePath in the policy overrides the search', () => {
    setDriAddon(workingAddon);
    const probe = probeDirect({ ...DEFAULT_GL_POLICY, devicePath: '/dev/dri/renderD129' });
    assert.equal(probe.device, '/dev/dri/renderD129');
  });

  test('an addon whose probe throws is an unavailable backend, not a crash', () => {
    setDriAddon({
      probe: () => {
        throw new Error('boom');
      }
    });
    assert.equal(probeDirect(DEFAULT_GL_POLICY).code, GLError.NO_DRIVER);
  });
});

describe('canPassDescriptors', () => {
  test('needs a local socket that can carry an fd', () => {
    assert.equal(canPassDescriptors(fakeApp().display), true);
    assert.equal(canPassDescriptors(fakeApp({ local: false }).display), false);
    assert.equal(canPassDescriptors(fakeApp({ fdCapable: false }).display), false);
    assert.equal(canPassDescriptors(undefined), false);
  });
});

describe('glCapabilities', () => {
  test('everything present: direct is available, and names the device', async () => {
    setDriAddon(workingAddon);
    const caps = await glCapabilities(fakeApp({ options: { glPolicy: 'auto' } }));
    assert.equal(caps.direct, true);
    assert.equal(caps.device, '/dev/dri/renderD128');
    assert.equal(caps.reason, null);
  });

  test("policy 'off' answers before anything is probed", async () => {
    setDriAddon(workingAddon);
    const caps = await glCapabilities(fakeApp({ options: { glPolicy: 'off' } }));
    assert.equal(caps.direct, false);
    assert.equal(caps.reason.code, GLError.DISABLED);
  });

  test('a remote display is refused without asking the server', async () => {
    setDriAddon(workingAddon);
    let asked = false;
    const app = fakeApp({ local: false, options: { glPolicy: 'auto' } });
    app.X.require = () => {
      asked = true;
    };
    const caps = await glCapabilities(app);
    assert.equal(caps.reason.code, GLError.REMOTE_DISPLAY);
    assert.equal(asked, false, 'a connection that cannot pass an fd needs no round trip');
  });

  test('a server without DRI3 says so, and says which servers have it', async () => {
    setDriAddon(workingAddon);
    const caps = await glCapabilities(fakeApp({ exts: { present: {} }, options: { glPolicy: 'auto' } }));
    assert.equal(caps.reason.code, GLError.NO_DRI3);
    assert.match(caps.reason.message, /DRI3/);
    assert.match(caps.reason.hint, /Xvfb|Xephyr|XQuartz/);
  });

  test('indirect availability is reported independently of direct', async () => {
    setDriAddon(null);
    const caps = await glCapabilities(fakeApp({ glx: null, options: { glPolicy: 'auto' } }));
    assert.equal(caps.direct, false);
    assert.equal(caps.indirect, false);
  });

  test('asked once, cached after', async () => {
    setDriAddon(workingAddon);
    const app = fakeApp({ options: { glPolicy: 'auto' } });
    let requires = 0;
    const inner = app.X.require;
    app.X.require = (...args) => {
      requires++;
      return inner(...args);
    };
    await glCapabilities(app);
    await glCapabilities(app);
    assert.equal(requires, 2, 'dri3 and present, once each');
  });
});

describe('backendFor', () => {
  const withCaps = (mode, resolved) => {
    const app = fakeApp({ options: { glPolicy: mode } });
    app._glCapsResolved = resolved;
    return backendFor(app);
  };

  test('the default policy is the indirect backend, decided without a probe', () => {
    withEnv(undefined, () => assert.equal(withCaps('indirect', null), 'indirect'));
  });

  test("'off' is off", () => {
    withEnv(undefined, () => assert.equal(withCaps('off', null), 'off'));
  });

  test('auto takes direct when it is there and indirect when it is not', () => {
    withEnv(undefined, () => {
      assert.equal(withCaps('auto', { direct: true }), 'direct');
      assert.equal(withCaps('auto', { direct: false }), 'indirect');
    });
  });

  test("'direct' does not silently fall back — that is what auto is for", () => {
    withEnv(undefined, () => assert.equal(withCaps('direct', { direct: false }), 'off'));
  });

  test('an unanswered probe is "not known yet", not "no"', () => {
    // the distinction matters: 'not known yet' must not resolve to indirect
    // under glPolicy 'direct', which getContext turns into an error instead
    withEnv(undefined, () => {
      assert.equal(withCaps('auto', undefined), null);
      assert.equal(withCaps('direct', undefined), null);
    });
  });
});

describe("getContext('opengl') dispatch", () => {
  // a window whose app is a stub: enough of one for the factory to decide
  const fakeWindow = (mode, resolved) => {
    const app = fakeApp({ options: { glPolicy: mode } });
    app._glCapsResolved = resolved;
    return { app, X: {}, depth: 24, width: 8, height: 8 };
  };

  const dispatch = (window) => Drawable.renderingContextFactory['opengl'](window, {});

  test('the default policy reaches the indirect context, untouched', () => {
    withEnv(undefined, () => {
      const window = fakeWindow('indirect', null);
      // the indirect context throws without GLX on the display, which is
      // proof enough that it — and not the direct one — was reached
      assert.throws(() => dispatch({ ...window, display: { GLX: null } }), {
        code: GLXError.NO_EXTENSION
      });
    });
  });

  test("'direct' with an unanswered probe is an error, never a silent indirect", () => {
    withEnv(undefined, () => {
      assert.throws(() => dispatch(fakeWindow('direct', undefined)), (err) => {
        assert.equal(err.code, GLError.CONTEXT_FAILED);
        assert.match(err.message, /has not answered/);
        return true;
      });
    });
  });

  test("'off' throws with the reason the capabilities gave", () => {
    withEnv(undefined, () => {
      const reason = Object.assign(new Error('nope'), { code: GLError.NO_DEVICE });
      assert.throws(() => dispatch(fakeWindow('direct', { direct: false, reason })), {
        code: GLError.NO_DEVICE
      });
    });
  });
});
