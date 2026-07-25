import texture from 'baboon-image';

import { createClient } from '../lib/index.js';

let width = 300;
let height = 300;
let angle = 0;

function resize(gl) {
  gl.Viewport(0, 0, width, height);
  gl.MatrixMode(gl.PROJECTION);
  gl.LoadIdentity();
  if (width < height) gl.Frustum(-1.0, 1.0, -height / width, height / width, -35.0, 20);
  else gl.Frustum(-width / height, width / height, -1.0, 1.0, -35.0, 20);
}

function draw(gl) {
  gl.MatrixMode(gl.MODELVIEW);

  gl.ClearColor(0.3, 0.3, 0.3, 0.0);
  gl.Clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  gl.LoadIdentity();
  gl.Rotatef(-90 + (360 * angle) / width, 0, 0, 1);
  gl.Begin(gl.TRIANGLE_STRIP);
  gl.TexCoord2f(0.0, 0.0);
  gl.Vertex3f(-1, -1, 0);
  gl.TexCoord2f(1.0, 0.0);
  gl.Vertex3f(1, -1, 0);
  gl.TexCoord2f(0.0, 1.0);
  gl.Vertex3f(-1, 1, 0);
  gl.TexCoord2f(1.0, 1.0);
  gl.Vertex3f(1, 1, 0);
  gl.End();
  gl.SwapBuffers();
}

const app = await createClient();
const wnd = app.createWindow({ width, height });
wnd.map();
const gl = wnd.getContext('opengl');
gl.Enable(gl.TEXTURE_2D);
gl.GenTextures(1, (err, textures) => {
  gl.BindTexture(gl.TEXTURE_2D, textures[0]);
  gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.TexImage2D(gl.TEXTURE_2D, 0, gl.RGB, 512, 512, 0, gl.RGB, gl.UNSIGNED_BYTE, texture.data);
  draw(gl);

  wnd
    .on('resize', (ev) => {
      width = ev.width;
      height = ev.height;
      resize(gl);
      draw(gl);
    })
    .on('mousemove', (ev) => {
      angle = ev.x;
      draw(gl);
    });
});
