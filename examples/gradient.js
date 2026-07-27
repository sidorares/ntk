import { createClient } from '../lib/index.js';

let width = 300;
let height = 300;

function draw(gl) {
  gl.Viewport(0, 0, width, height);
  gl.MatrixMode(gl.PROJECTION);
  gl.LoadIdentity();
  gl.Frustum(-1.0, 1.0, -1, 1, -35.0, 20);
  gl.MatrixMode(gl.MODELVIEW);
  gl.LoadIdentity();

  gl.ClearColor(0.3, 0.3, 0.3, 0.0);
  gl.Clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.Begin(gl.QUADS);
  gl.Color3f(1, 0, 0);
  gl.Vertex3f(-1, -1, 0);
  gl.Vertex3f(1, -1, 0);
  gl.Color3f(1, 1, 0);
  gl.Vertex3f(1, 1, 0);
  gl.Vertex3f(-1, 1, 0);
  gl.End();
}

const app = await createClient();
// a GLX drawable must use a visual the context was created for, so the
// visual is chosen before the window exists
const glx = await app.chooseGLXConfig({ DEPTH_SIZE: 24 });
const wnd = app.createWindow({
  title: 'simple opengl gradient',
  x: 100,
  y: 100,
  width,
  height,
  visual: glx.visual,
  depth: glx.depth
});
wnd.map();
const gl = wnd.getContext('opengl', glx);
gl.Enable(gl.POINT_SMOOTH);
wnd.on('resize', (ev) => {
  width = ev.width;
  height = ev.height;
  draw(gl);
  gl.SwapBuffers();
});
