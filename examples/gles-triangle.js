// Direct rendering: a GLSL-shaded triangle drawn on the GPU and handed to the
// X server as a buffer, with no pixels and no GL commands on the socket.
//
//   node examples/gles-triangle.js
//
// Needs the optional x11-dri addon (`npm install x11-dri`) and a server with
// a direct path: DRI3 plus a DRM render node on Linux (Xorg with glamor,
// Xwayland), or Apple-DRI on macOS (XQuartz, from the logged-in GUI
// session). Where any of that is missing it says which, and the same drawing
// has to be written against the fixed-function pipeline instead
// (examples/glclock.js). Compare the two: this one has shaders, and its
// per-frame cost is one request on Linux and none at all on macOS.
import { createClient } from '../lib/index.js';

const app = await createClient({ glPolicy: 'auto' });

const caps = await app.glCapabilities();
if (!caps.direct) {
  console.log(`No direct rendering here — ${caps.reason.code}\n\n${caps.reason.message}`);
  if (caps.reason.hint) console.log(`\n${caps.reason.hint}`);
  await app.close();
  process.exit(0);
}

const config = await app.chooseGLConfig({ DEPTH_SIZE: 24 });
const wnd = app.createWindow({
  width: 480,
  height: 360,
  visual: config.visual,
  depth: config.depth,
  // GL draws the window itself: there is no 2d backing pixmap to blit
  backingStore: false,
  title: 'ntk — direct GL'
});
wnd.on('close', async () => {
  gl.destroy();
  await app.close();
  process.exit(0);
});
// A present to a window that is not viewable yet goes nowhere, and a GL window
// has no backing store to redraw itself from — so frames start on expose.
wnd.on('expose', () => wnd.requestAnimationFrame(draw));
wnd.map();

const gl = wnd.getContext('opengl', config);
console.log(`${gl.backend} rendering (${caps.flavor}) on ${caps.device ?? 'the window surface'}: ${gl.renderer}`);

try {
  await gl.ready;
} catch (err) {
  console.log(`${err.code}: ${err.message}`);
  await app.close();
  process.exit(1);
}

const VERTEX = `
attribute vec2 position;
attribute vec3 color;
uniform float uAngle;
varying vec3 vColor;
void main() {
  float c = cos(uAngle), s = sin(uAngle);
  gl_Position = vec4(mat2(c, -s, s, c) * position, 0.0, 1.0);
  vColor = color;
}`;

const FRAGMENT = `
precision mediump float;
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }`;

function compile(type, source, what) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`${what}: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

const program = gl.createProgram();
gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX, 'vertex shader'));
gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT, 'fragment shader'));
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
  throw new Error(`link: ${gl.getProgramInfoLog(program)}`);
}
gl.useProgram(program);

// position (x, y) and colour (r, g, b) interleaved, uploaded once
const vertices = new Float32Array([
  0.0, 0.75, 1, 0.15, 0.3,
  -0.75, -0.6, 0.15, 0.7, 1,
  0.75, -0.6, 0.9, 0.85, 0.2
]);
const buffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

const stride = 5 * Float32Array.BYTES_PER_ELEMENT;
const position = gl.getAttribLocation(program, 'position');
gl.enableVertexAttribArray(position);
gl.vertexAttribPointer(position, 2, gl.FLOAT, false, stride, 0);
const color = gl.getAttribLocation(program, 'color');
gl.enableVertexAttribArray(color);
gl.vertexAttribPointer(color, 3, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
const uAngle = gl.getUniformLocation(program, 'uAngle');

const started = Date.now();
let frames = 0;

// A frame that cannot go out — every buffer with the server (Linux), or the
// surface not attached / the pacing gate closed (macOS) — is not drawn.
// Rather than spin, stop, and pick up again when the gate reopens.
gl.onFrameAvailable = () => wnd.requestAnimationFrame(draw);
// The expose that started the loop can land while canRender() was still
// false and before this handler was installed — kick it once now that
// everything is wired; a redundant frame is absorbed by the guard in draw().
wnd.requestAnimationFrame(draw);

function draw() {
  if (!gl.canRender()) return;
  gl.makeCurrent(); // binds the surface, and follows a resize
  gl.viewport(0, 0, wnd.width, wnd.height);
  gl.clearColor(0.05, 0.06, 0.12, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.uniform1f(uAngle, (Date.now() - started) / 900);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.SwapBuffers();

  if (++frames % 120 === 0) {
    const fps = (frames * 1000) / (Date.now() - started);
    console.log(`${frames} frames, ${fps.toFixed(1)} fps`);
  }
  wnd.requestAnimationFrame(draw);
}
