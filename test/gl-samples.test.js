// Multisampling, and what happens to a request for it that a backend cannot
// meet (issue #341). `chooseGLConfig` speaks GLX's vocabulary on both
// backends, so `SAMPLES`/`SAMPLE_BUFFERS` has to mean something on both —
// and where it cannot mean 4x MSAA it has to say so rather than drop the
// attribute and leave the app to find aliased edges in a screenshot.
//
// Hermetic: node-x11's pure-JS X server with its GLX emulator for the
// indirect half, and a stubbed capability answer for the direct one, so this
// runs with no display and no GPU.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { after, before, describe, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { DIRECT_SAMPLES, requestedSamples } from '../lib/gl.js';
import { GLXError } from '../lib/glx.js';
import { createClient, StaticFontSource } from '../lib/index.js';

const require = createRequire(import.meta.url);
const { createGlxExtension, RecordingBackend } = require('x11/browser/glx');
const { createServer, createStreamPair } = xserver;

let app = null;

// what the console said while `fn` ran, so the downgrade warning can be
// asserted on the way a caller actually meets it
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

// the direct backend's answer, stubbed onto a real App: the capability probe
// is what these tests are not about
function asDirect(flavor = 'dri3') {
  app.options.glPolicy = 'auto';
  app._glCapsResolved = { direct: true, indirect: true, flavor, device: null, reason: null };
  app._warnedDirectSamples = false;
}

function asIndirect() {
  app.options.glPolicy = 'indirect';
  app._glCapsResolved = undefined;
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

describe('requestedSamples', () => {
  test('reads the count, the bare sample buffer, and the absence of both', () => {
    assert.equal(requestedSamples({ SAMPLES: 4 }), 4);
    assert.equal(requestedSamples({ SAMPLE_BUFFERS: 1, SAMPLES: 8 }), 8);
    // "multisample, width up to the driver" still counts as having asked
    assert.equal(requestedSamples({ SAMPLE_BUFFERS: 1 }), 1);
    assert.equal(requestedSamples({ DEPTH_SIZE: 24 }), 0);
    assert.equal(requestedSamples({ SAMPLES: 0, SAMPLE_BUFFERS: 0 }), 0);
    assert.equal(requestedSamples(), 0);
    // a config handed back from chooseGLConfig carries neither attribute
    assert.equal(requestedSamples({ backend: 'direct', samples: 0 }), 0);
  });
});

describe('the indirect backend answers with what the fbconfig has', () => {
  before(() => asIndirect());

  test('a config says its sample count, so nothing has to assume', async () => {
    const config = await app.chooseGLConfig();
    assert.equal(config.backend, 'indirect');
    assert.equal(config.samples, 0, 'this server publishes one fbconfig, and it has no sample buffers');
  });

  test('a multisample request it cannot meet fails, and names the constraint', async () => {
    // The GLX 1.2 fallback used to ignore SAMPLES — GetVisualConfigs does not
    // carry it among its fixed properties — so a spec asking for 4x came back
    // as an ordinary visual and the request evaporated on the way through.
    const said = await captured(() =>
      assert.rejects(() => app.chooseGLConfig({ SAMPLES: 4 }), (err) => {
        assert.equal(err.code, GLXError.NO_CONFIG);
        assert.match(err.message, /SAMPLES=4/);
        return true;
      })
    );
    assert.deepEqual(said, [], 'the indirect backend has nothing to warn about — it throws');
  });
});

describe('the direct backend answers with zero, out loud', () => {
  test('a spec that asks for samples gets a config that reports what it got', async () => {
    asDirect();
    const config = await app.chooseGLConfig({ SAMPLES: 4 });
    assert.equal(config.backend, 'direct');
    assert.equal(config.samples, DIRECT_SAMPLES);
    assert.equal(config.samples, 0, 'no direct flavor can allocate a multisampled window buffer yet');
    assert.equal(config.depthSize, 16, 'the attributes it does honour are unaffected');
  });

  test('and says so on the console, with what to do instead', async () => {
    asDirect('appledri');
    const said = await captured(() => app.chooseGLConfig({ SAMPLES: 4 }));
    assert.equal(said.length, 1);
    assert.match(said[0], /SAMPLES=4/);
    assert.match(said[0], /appledri/, 'names the flavor that cannot do it');
    assert.match(said[0], /samples: 0/, 'names the field to branch on');
    assert.match(said[0], /docs\/context-gles\.md#multisampling/);
  });

  test('once per connection, not once per window', async () => {
    asDirect();
    const first = await captured(() => app.chooseGLConfig({ SAMPLE_BUFFERS: 1 }));
    const second = await captured(() => app.chooseGLConfig({ SAMPLES: 4 }));
    assert.equal(first.length, 1, 'a bare SAMPLE_BUFFERS is a multisample request too');
    assert.deepEqual(second, [], 'the second window would only repeat it');
  });

  test('a spec that never asked is not warned at, and still reports samples', async () => {
    asDirect();
    const said = await captured(async () => {
      const config = await app.chooseGLConfig({ DEPTH_SIZE: 24 });
      assert.equal(config.samples, 0);
      assert.equal(config.depthSize, 24);
    });
    assert.deepEqual(said, []);
  });
});

test('the remedy the warning points at is a heading that exists', () => {
  const docs = readFileSync(new URL('../docs/context-gles.md', import.meta.url), 'utf8');
  assert.ok(/^## Multisampling$/m.test(docs), 'docs/context-gles.md#multisampling');
});
