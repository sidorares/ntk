// The direct backend, end to end, against a real server: a GLSL-shaded
// triangle drawn on the GPU, presented through DRI3 + Present, and read back
// off the window with GetImage.
//
// Skipped wherever the path is unavailable — no DISPLAY, no x11-dri, no DRM
// render node, or a server without DRI3 (Xvfb and Xephyr have none, so this
// never runs on CI). That is the same shape as the rest of the X-dependent
// suite, and the reason the hermetic decisions live in gl-policy.test.js: the
// parts that can be checked everywhere are checked everywhere.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createClient } from '../lib/index.js';
import { withTimeout } from './helpers/async.js';

let app = null;
let skip = false;
let keepalive = null;

const VERTEX = `
attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }`;

const FRAGMENT = `
precision mediump float;
uniform vec3 uColor;
void main() { gl_FragColor = vec4(uColor, 1.0); }`;

function buildProgram(gl) {
  const compile = (type, source, what) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    assert.ok(gl.getShaderParameter(shader, gl.COMPILE_STATUS), `${what}: ${gl.getShaderInfoLog(shader)}`);
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX, 'vertex shader'));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT, 'fragment shader'));
  gl.linkProgram(program);
  assert.ok(gl.getProgramParameter(program, gl.LINK_STATUS), `link: ${gl.getProgramInfoLog(program)}`);
  return program;
}

/**
 * Map a window and wait until the server will actually show what is presented
 * to it.
 *
 * A Present to a window that is not yet viewable is discarded — there is
 * nowhere to put it — so a frame drawn immediately after `map()` never
 * appears. Every GL app has to draw on expose for this reason; these tests do
 * it explicitly so the assertion is about the pixels and not about the timing.
 * The listener goes on before `map()`, both because adding it is what selects
 * Exposure and because the expose can arrive first otherwise.
 */
function mapAndWait(wnd, timeout = 1000) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      // the expose says the window is viewable; give the compositor the tick
      // it needs to agree
      setTimeout(resolve, 50);
    };
    const timer = setTimeout(done, timeout); // a server that exposes nothing
    wnd.once('expose', done);
    wnd.map();
  });
}

/** the window's pixels as [r, g, b] at (x, y) */
function reader(image, width) {
  return (x, y) => {
    const offset = (y * width + x) * 4;
    return [image.data[offset + 2], image.data[offset + 1], image.data[offset]];
  };
}

const close = (a, b, tolerance = 6) => Math.abs(a - b) <= tolerance;
const near = (got, want) => got.every((c, i) => close(c, want[i]));

before(async () => {
  if (!process.env.DISPLAY) {
    skip = 'no DISPLAY set';
    return;
  }
  keepalive = setInterval(() => {}, 1000);
  try {
    app = await withTimeout(
      createClient({ glPolicy: 'auto' }),
      5000,
      'connecting to X server',
      (late) => late.close()
    );
  } catch (err) {
    skip = `cannot connect to X server: ${err.message}`;
    return;
  }
  const caps = await app.glCapabilities();
  if (!caps.direct) skip = `no direct rendering here: ${caps.reason.code} — ${caps.reason.message}`;
  // this file exercises the dri3 flavor (swapchain, DRI3 imports, Present
  // pacing); the appledri one has its own — test/gl-appledri-live.test.js
  else if (caps.flavor !== 'dri3') skip = `direct here is ${caps.flavor}, not DRI3`;
});

after(async () => {
  clearInterval(keepalive);
  await app?.close();
});

test('a shader-drawn frame reaches the window', async (t) => {
  if (skip) return t.skip(skip);
  const width = 160;
  const height = 120;

  const config = await app.chooseGLConfig({ DEPTH_SIZE: 24 });
  assert.equal(config.backend, 'direct');
  assert.equal(config.doubleBuffer, true);

  const wnd = app.createWindow({
    width,
    height,
    visual: config.visual,
    depth: config.depth,
    backingStore: false
  });
  await mapAndWait(wnd);

  const gl = wnd.getContext('opengl', config);
  assert.equal(gl.backend, 'direct', 'the auto policy picked the direct backend');

  // resolves once the server has taken a buffer — the whole path proven, and
  // answerable before a single frame is drawn
  await withTimeout(gl.ready, 5000, 'direct GL context becoming ready');

  const program = buildProgram(gl);
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  // a triangle covering the bottom-left half in green, on a blue clear
  gl.makeCurrent();
  gl.viewport(0, 0, width, height);
  gl.clearColor(0, 0, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.uniform3f(gl.getUniformLocation(program, 'uColor'), 0, 1, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  assert.equal(gl.SwapBuffers(), true, 'the frame was presented');

  await new Promise((resolve) => setTimeout(resolve, 250));
  const image = await withTimeout(
    new Promise((resolve, reject) =>
      app.X.GetImage(2, wnd.id, 0, 0, width, height, 0xffffffff, (err, img) =>
        err ? reject(err) : resolve(img)
      )
    ),
    5000,
    'reading the window back'
  );

  const at = reader(image, width);
  assert.ok(near(at(4, height - 4), [0, 255, 0]), `bottom-left should be the triangle, got ${at(4, height - 4)}`);
  assert.ok(near(at(width - 4, 4), [0, 0, 255]), `top-right should be the clear colour, got ${at(width - 4, 4)}`);

  gl.destroy();
  wnd.destroy();
});

test('a buffer is handed to the server once, not once per frame', async (t) => {
  if (skip) return t.skip(skip);
  const config = await app.chooseGLConfig();
  const wnd = app.createWindow({
    width: 64,
    height: 64,
    visual: config.visual,
    depth: config.depth,
    backingStore: false
  });
  await mapAndWait(wnd);
  const gl = wnd.getContext('gles', config);
  await withTimeout(gl.ready, 5000, 'direct GL context becoming ready');

  // This is the property the whole design turns on: pixels never cross the
  // socket, and after the swap chain has filled, a frame is one Present
  // request. Counted at the protocol seam rather than trusted.
  const { DRI3 } = await app.glCapabilities();
  const realImport = DRI3.PixmapFromBuffer;
  let imports = 0;
  DRI3.PixmapFromBuffer = (...args) => {
    imports++;
    return realImport.apply(DRI3, args);
  };

  try {
    let drawn = 0;
    for (let i = 0; i < 40; i++) {
      if (gl.canRender()) {
        gl.makeCurrent();
        gl.clearColor(i / 40, 0.2, 0.4, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (gl.SwapBuffers()) drawn++;
      }
      // let IdleNotify come back and free a buffer
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
    assert.ok(drawn >= 10, `expected the loop to present repeatedly, got ${drawn} frames`);
    assert.ok(
      imports <= 4,
      `a full swap chain is a handful of buffers; ${imports} imports across ${drawn} frames means one per frame`
    );
  } finally {
    DRI3.PixmapFromBuffer = realImport;
    gl.destroy();
    wnd.destroy();
  }
});

test('a resize retires the old buffers and draws at the new size', async (t) => {
  if (skip) return t.skip(skip);
  const config = await app.chooseGLConfig();
  const wnd = app.createWindow({
    width: 120,
    height: 90,
    visual: config.visual,
    depth: config.depth,
    backingStore: false
  });
  await mapAndWait(wnd);
  const gl = wnd.getContext('gles', config);
  await withTimeout(gl.ready, 5000, 'direct GL context becoming ready');

  gl.makeCurrent();
  gl.clearColor(0, 0, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.SwapBuffers();

  wnd.resize(200, 150);
  await new Promise((resolve) => setTimeout(resolve, 150));

  gl.makeCurrent();
  gl.viewport(0, 0, wnd.width, wnd.height);
  gl.clearColor(1, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  assert.equal(gl.SwapBuffers(), true);
  await new Promise((resolve) => setTimeout(resolve, 250));

  const image = await withTimeout(
    new Promise((resolve, reject) =>
      app.X.GetImage(2, wnd.id, 0, 0, 200, 150, 0xffffffff, (err, img) => (err ? reject(err) : resolve(img)))
    ),
    5000,
    'reading the resized window back'
  );
  const at = reader(image, 200);
  assert.ok(near(at(190, 140), [255, 0, 0]), `the new area should be painted, got ${at(190, 140)}`);

  gl.destroy();
  wnd.destroy();
});
