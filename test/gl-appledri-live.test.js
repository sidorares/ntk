// The Apple-DRI flavor of the direct backend, end to end, against a real
// XQuartz: a GLSL-shaded triangle drawn by the GPU straight into the
// window's exported surface, presented with a CGL flush, and verified with
// gl.readPixels.
//
// readPixels rather than GetImage on purpose: the GL surface is composited
// by the WindowServer *above* the X framebuffer, so X-side reads of the
// window show stale contents by design (docs/context-gles.md#macos). The
// wire encoding this path speaks is checked hermetically in
// test/appledri.test.js; this file is the half that needs the real thing,
// and it skips everywhere the real thing is missing — any non-mac, any
// non-XQuartz server, an SSH session — the same shape as
// test/gl-direct-live.test.js for the dri3 flavor.
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

/** one pixel out of the current framebuffer as [r, g, b] (readPixels is bottom-up) */
function pixelAt(gl, x, y) {
  const px = new Uint8Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return [px[0], px[1], px[2]];
}

const close = (a, b, tolerance = 6) => Math.abs(a - b) <= tolerance;
const near = (got, want) => got.every((c, i) => close(c, want[i]));

function mapAndWait(wnd, timeout = 1000) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      setTimeout(resolve, 50);
    };
    const timer = setTimeout(done, timeout);
    wnd.once('expose', done);
    wnd.map();
  });
}

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
  else if (caps.flavor !== 'appledri') skip = `direct here is ${caps.flavor}, not Apple-DRI`;
});

after(async () => {
  clearInterval(keepalive);
  await app?.close();
});

test('a shader-drawn frame renders into the exported surface', async (t) => {
  if (skip) return t.skip(skip);
  const width = 160;
  const height = 120;

  const config = await app.chooseGLConfig({ DEPTH_SIZE: 24 });
  assert.equal(config.backend, 'direct');
  assert.equal(config.flavor, 'appledri');

  const wnd = app.createWindow({
    width,
    height,
    visual: config.visual,
    depth: config.depth,
    backingStore: false
  });

  // gl.* works before the surface exists — the CGL context is synchronous —
  // but nothing can be presented until the mapped window's surface attaches
  const gl = wnd.getContext('opengl', config);
  assert.equal(gl.backend, 'direct');
  assert.equal(gl.flavor, 'appledri');
  assert.equal(gl.canRender(), false, 'no surface before the window is mapped');
  assert.equal(gl.SwapBuffers(), false, 'nothing to present into yet');

  await mapAndWait(wnd);
  await withTimeout(gl.ready, 5000, 'Apple-DRI surface attach');
  assert.equal(gl.canRender(), true);
  assert.ok(gl.renderer, 'a real renderer string once attached');

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

  // verified in the framebuffer before the flush — X-side GetImage cannot
  // see a WindowServer-composited surface, readPixels can (bottom-up: low y
  // is the bottom of the window, where the triangle is)
  assert.ok(near(pixelAt(gl, 4, 4), [0, 255, 0]), `bottom-left should be the triangle, got ${pixelAt(gl, 4, 4)}`);
  assert.ok(
    near(pixelAt(gl, width - 4, height - 4), [0, 0, 255]),
    `top-right should be the clear colour, got ${pixelAt(gl, width - 4, height - 4)}`
  );

  assert.equal(gl.SwapBuffers(), true, 'the frame was presented');

  gl.destroy();
  wnd.destroy();
});

test('the swap paces the loop: the gate closes on flush and reopens on its own', async (t) => {
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
  const gl = wnd.getContext('opengl', config);
  await withTimeout(gl.ready, 5000, 'Apple-DRI surface attach');

  gl.makeCurrent();
  gl.clearColor(0.2, 0.2, 0.2, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  assert.equal(gl.SwapBuffers(), true);
  // no backpressure comes from the server on this path, so this gate is what
  // keeps frameLoop-style callers at display rate instead of spinning
  assert.equal(gl.canRender(), false, 'throttled right after a swap');
  assert.equal(gl.SwapBuffers(), false, 'a second immediate swap is refused');

  await withTimeout(
    new Promise((resolve) => {
      gl.onFrameAvailable = resolve;
    }),
    2000,
    'the pacing gate reopening'
  );
  assert.equal(gl.canRender(), true);

  gl.destroy();
  wnd.destroy();
});

test('losing the surface on unmap re-attaches on the next map', async (t) => {
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
  const gl = wnd.getContext('opengl', config);
  await withTimeout(gl.ready, 5000, 'Apple-DRI surface attach');

  // unmapping destroys the physical Quartz window, and the server says so
  // with SurfaceNotify(destroyed) — no mask ever selected it
  wnd.unmap();
  await withTimeout(
    new Promise((resolve) => {
      const check = () => (gl.canRender() ? setTimeout(check, 10) : resolve());
      check();
    }),
    2000,
    'the surface-destroyed notify closing the gate'
  );

  // mapping again re-exports and re-attaches without a new context
  const reattached = new Promise((resolve) => {
    gl.onFrameAvailable = resolve;
  });
  wnd.map();
  await withTimeout(reattached, 5000, 'the re-attach after remap');
  assert.equal(gl.canRender(), true);

  gl.makeCurrent();
  gl.viewport(0, 0, 64, 64);
  gl.clearColor(0, 1, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  assert.ok(near(pixelAt(gl, 32, 32), [0, 255, 0]), 'drawing works on the fresh surface');
  assert.equal(gl.SwapBuffers(), true, 'and presenting does too');

  gl.destroy();
  wnd.destroy();
});

test('a resize is picked up by makeCurrent and drawn at the new size', async (t) => {
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
  const gl = wnd.getContext('opengl', config);
  await withTimeout(gl.ready, 5000, 'Apple-DRI surface attach');

  gl.makeCurrent();
  gl.clearColor(0, 0, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.SwapBuffers();

  wnd.resize(200, 150);
  await new Promise((resolve) => setTimeout(resolve, 150));

  // the surface tracks the window server-side; makeCurrent tells the context
  gl.makeCurrent();
  gl.viewport(0, 0, 200, 150);
  gl.clearColor(1, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const corner = pixelAt(gl, 196, 146);
  assert.ok(near(corner, [255, 0, 0]), `the far corner exists at the new size and is red, got ${corner}`);

  gl.destroy();
  wnd.destroy();
});

test('the window has a stencil buffer, proved by a stencil test that fails', async (t) => {
  if (skip) return t.skip(skip);
  const width = 64;
  const height = 64;
  // the default framebuffer's stencil attachment and the query for its size
  // (desktop GL 3.0+, which is what the addon's core profile speaks here)
  const GL_STENCIL = 0x1802;
  const GL_FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE = 0x8217;

  const config = await app.chooseGLConfig({ DEPTH_SIZE: 24 });
  assert.equal(config.stencilSize, 8, 'a stencil buffer by default, as the Cocoa backend has');
  const wnd = app.createWindow({
    width,
    height,
    visual: config.visual,
    depth: config.depth,
    backingStore: false
  });
  await mapAndWait(wnd);
  const gl = wnd.getContext('opengl', config);
  await withTimeout(gl.ready, 5000, 'Apple-DRI surface attach');
  assert.equal(gl.stencilSize, 8);

  const program = buildProgram(gl);
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  const position = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const uColor = gl.getUniformLocation(program, 'uColor');
  const band = (x0, x1) => {
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([x0, -1, x1, -1, x0, 1, x1, 1]), gl.STREAM_DRAW);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  gl.makeCurrent();
  gl.viewport(0, 0, width, height);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const bits = gl.getFramebufferAttachmentParameter(
    gl.FRAMEBUFFER,
    GL_STENCIL,
    GL_FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE
  );
  assert.ok(bits >= 8, `the window's framebuffer reports ${bits} stencil bits`);

  // A framebuffer with no stencil buffer passes every stencil test, so
  // "write 1, then draw where it is 1" draws the same with or without one.
  // Only a real buffer can make a test fail: NOTEQUAL 0 over a stencil just
  // cleared to 0 must draw nothing at all.
  gl.clearColor(0, 0, 1, 1);
  gl.clearStencil(0);
  gl.stencilMask(0xff);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
  gl.enable(gl.STENCIL_TEST);
  gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
  gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
  gl.uniform3f(uColor, 0, 1, 0);
  band(-1, 1);
  const centre = pixelAt(gl, width / 2, height / 2);
  assert.ok(near(centre, [0, 0, 255]), `a NOTEQUAL 0 draw over a cleared stencil must draw nothing, got ${centre}`);

  // and the half that uses it: 1s written into the left half only, with
  // colour writes off, then red wherever the stencil holds 1
  gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
  gl.colorMask(false, false, false, false);
  gl.stencilFunc(gl.ALWAYS, 1, 0xff);
  gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
  band(-1, 0);
  gl.colorMask(true, true, true, true);
  gl.stencilFunc(gl.EQUAL, 1, 0xff);
  gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
  gl.uniform3f(uColor, 1, 0, 0);
  band(-1, 1);
  gl.disable(gl.STENCIL_TEST);
  const left = pixelAt(gl, 8, height / 2);
  const right = pixelAt(gl, width - 8, height / 2);
  assert.ok(near(left, [255, 0, 0]), `drawn where the stencil holds 1, got ${left}`);
  assert.ok(near(right, [0, 0, 255]), `and nowhere else, got ${right}`);

  gl.destroy();
  wnd.destroy();
});
