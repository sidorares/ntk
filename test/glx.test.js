// Indirect GLX: visual discovery, GLX-visual windows, and the context tag.
// Hermetic — node-x11's in-process pure-JS X server with its GLX emulator
// (browser/glx) registered as an extension, so GL commands that reach the
// server show up as calls on a RecordingBackend. No $DISPLAY, no GL.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, describe, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, StaticFontSource } from '../lib/index.js';

const require = createRequire(import.meta.url);
const { createGlxExtension, RecordingBackend } = require('x11/browser/glx');
const { createServer, createStreamPair } = xserver;

let app = null;
let backend = null;
let xErrors = [];
let requests = [];

// requests ntk sends, decoded from the client stream: the JS X server keeps
// no visual/depth of its own for a window, so the CreateWindow header is
// checked on the wire
function decodeRequests(chunks) {
  const out = [];
  for (const chunk of chunks) {
    let offset = 0;
    while (offset + 4 <= chunk.length) {
      const words = chunk.readUInt16LE(offset + 2);
      if (words === 0) break; // BigRequests form: not used by these tests
      const end = offset + words * 4;
      if (end > chunk.length) break;
      out.push({ opcode: chunk[offset], body: chunk.subarray(offset, end) });
      offset = end;
    }
  }
  return out;
}

const createWindowRequests = () =>
  decodeRequests(requests)
    .filter((r) => r.opcode === 1)
    .map(({ body }) => ({
      depth: body[1],
      window: body.readUInt32LE(4),
      class: body.readUInt16LE(22),
      visual: body.readUInt32LE(24),
      valueMask: body.readUInt32LE(28)
    }));

// CreateWindow value-list bits (x11 protocol)
const VALUE_BORDER_PIXEL = 0x8;
const VALUE_COLORMAP = 0x2000;

// drain the connection: everything queued has been processed by the server
const settle = () =>
  new Promise((resolve) =>
    app.X.GetInputFocus(() => setImmediate(() => app.X.GetInputFocus(() => resolve())))
  );

before(async () => {
  const server = createServer({ width: 320, height: 240 });
  backend = new RecordingBackend();
  const surfaces = new Map();
  server.registerExtension(
    'GLX',
    createGlxExtension({
      backend,
      getDrawableSurface: (xid) => surfaces.get(xid) || null
    })
  );
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);
  app = await createClient({
    stream: clientEnd,
    fontSource: new StaticFontSource(),
    onXError: (err) => xErrors.push(err)
  });

  // record requests from here on (the connection setup is already past)
  const write = clientEnd.write.bind(clientEnd);
  clientEnd.write = (chunk, ...rest) => {
    requests.push(Buffer.from(chunk));
    return write(chunk, ...rest);
  };
});

after(async () => {
  if (app) await app.close();
});

describe('GLX config discovery', () => {
  test('chooseGLXConfig finds a depth-buffered visual without shelling out', async () => {
    const config = await app.chooseGLXConfig();
    const screen = app.display.screen[0];
    assert.equal(config.visual, screen.root_visual, "the server's GL-capable visual");
    assert.equal(config.depth, screen.root_depth, 'X depth for that visual, ready for CreateWindow');
    assert.ok(config.depthSize >= 16, `depth buffer requested by default, got ${config.depthSize}`);
    assert.equal(config.doubleBuffer, true);
    assert.equal(config.screen, 0);
  });

  test('an impossible spec fails with a message naming the constraints', async () => {
    await assert.rejects(
      () => app.chooseGLXConfig({ SAMPLES: 16, DEPTH_SIZE: 64 }),
      /SAMPLES=16.*DEPTH_SIZE=64|DEPTH_SIZE=64.*SAMPLES=16/s
    );
  });

  test('an unknown attribute name is reported, not silently ignored', async () => {
    await assert.rejects(() => app.chooseGLXConfig({ DEPTH_SIZEE: 24 }), /unknown GLX attribute/);
  });
});

describe('GLX windows', () => {
  test('createWindow carries the chosen visual, depth and a colormap', async () => {
    const config = await app.chooseGLXConfig();
    requests = [];
    const wnd = app.createWindow({
      width: 64,
      height: 48,
      visual: config.visual,
      depth: config.depth
    });
    await settle();

    const created = createWindowRequests().find((r) => r.window === wnd.id);
    assert.ok(created, 'CreateWindow for the new window');
    assert.equal(created.visual, config.visual, 'visual reaches the server (was hardcoded 0)');
    assert.equal(created.depth, config.depth, 'depth reaches the server (was hardcoded 0)');
    assert.ok(created.valueMask & VALUE_COLORMAP, 'a colormap for that visual is created and attached');
    assert.ok(created.valueMask & VALUE_BORDER_PIXEL, 'border pixel set: inheriting one is a BadMatch');
    assert.equal(xErrors.length, 0, `no X errors: ${xErrors.map((e) => e.message).join(', ')}`);
    wnd.destroy();
  });

  test('windows without a visual are unchanged (CopyFromParent)', async () => {
    requests = [];
    const wnd = app.createWindow({ width: 32, height: 32 });
    await settle();

    const created = createWindowRequests().find((r) => r.window === wnd.id);
    assert.equal(created.visual, 0, 'CopyFromParent');
    assert.equal(created.depth, 0);
    assert.equal(created.class, 0);
    assert.ok(!(created.valueMask & VALUE_COLORMAP), 'no colormap of its own');
    wnd.destroy();
  });
});

describe("getContext('opengl')", () => {
  test("renders with MakeCurrent's context tag, not the context XID", async () => {
    const config = await app.chooseGLXConfig();
    const wnd = app.createWindow({
      width: 64,
      height: 48,
      visual: config.visual,
      depth: config.depth
    });
    const gl = wnd.getContext('opengl', config);

    // drawing before the context is current is allowed: the calls queue
    gl.ClearColor(0.2, 0.4, 0.6, 1);
    gl.Clear(gl.COLOR_BUFFER_BIT);
    gl.Begin(gl.TRIANGLES);
    gl.Vertex3f(-1, -1, 0);
    gl.Vertex3f(1, -1, 0);
    gl.Vertex3f(0, 1, 0);
    gl.End();
    gl.Render(); // flush the pipeline

    await gl.ready;
    await settle();

    assert.ok(gl.contextTag > 0, 'MakeCurrent replied with a context tag');
    assert.notEqual(gl.contextTag, gl.contextId, 'the tag is not the context XID');
    assert.equal(xErrors.length, 0, `no GLXBadContextTag: ${xErrors.map((e) => e.message).join(', ')}`);

    const names = backend.calls.map((c) => c[0]);
    assert.deepEqual(
      names.filter((n) => n !== 'resize'),
      ['clearColor', 'clear', 'begin', 'vertex', 'vertex', 'vertex', 'end'],
      'the whole command stream reached the server'
    );
    const [, ...rgba] = backend.calls.find((c) => c[0] === 'clearColor');
    // float32 on the wire
    rgba.forEach((c, i) =>
      assert.ok(Math.abs(c - [0.2, 0.4, 0.6, 1][i]) < 1e-6, `clear colour component ${i}`)
    );

    gl.destroy();
    wnd.destroy();
  });

  test('calls made after the context is current go straight out', async () => {
    const config = await app.chooseGLXConfig();
    const wnd = app.createWindow({
      width: 32,
      height: 32,
      visual: config.visual,
      depth: config.depth
    });
    const gl = wnd.getContext('opengl', config);
    await gl.ready;

    backend.calls.length = 0;
    gl.MatrixMode(gl.MODELVIEW);
    gl.LoadIdentity();
    gl.Render();
    await settle();

    assert.deepEqual(
      backend.calls.map((c) => c[0]),
      ['matrixMode', 'loadIdentity']
    );
    assert.equal(xErrors.length, 0, `no X errors: ${xErrors.map((e) => e.message).join(', ')}`);
    gl.destroy();
    wnd.destroy();
  });

  test('display lists compile and replay server-side', async () => {
    const config = await app.chooseGLXConfig();
    const wnd = app.createWindow({
      width: 32,
      height: 32,
      visual: config.visual,
      depth: config.depth
    });
    const gl = wnd.getContext('opengl', config);
    await gl.ready;

    backend.calls.length = 0;
    gl.NewList(1, gl.COMPILE);
    gl.Begin(gl.TRIANGLES);
    gl.Vertex3f(0, 0, 0);
    gl.End();
    gl.EndList();
    gl.CallList(1);
    gl.Render();
    await settle();

    // the geometry is sent once; the second draw is a single CallList
    assert.deepEqual(
      backend.calls.map((c) => c[0]),
      ['begin', 'vertex', 'end'],
      'the list body runs once, on CallList — not on compile'
    );
    assert.equal(xErrors.length, 0, `no X errors: ${xErrors.map((e) => e.message).join(', ')}`);
    gl.destroy();
    wnd.destroy();
  });
});
