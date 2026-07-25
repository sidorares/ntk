import { readFileSync } from 'node:fs';

import { createClient } from '../lib/index.js';

const model = JSON.parse(readFileSync(new URL('./teapot.json', import.meta.url)));

let width = 300;
let height = 300;
let scale = 0.1;
let rotx = 0;
let roty = 0;
let lightangle = 0;

function makeList(gl, callback) {
  gl.GenLists(1, (err, list) => {
    gl.NewList(list, gl.COMPILE);
    gl.Begin(gl.TRIANGLES);
    for (let i = 0; i < model.indices.length; i += 3) {
      for (let t = i; t < i + 3; t++) {
        const tr = model.indices[t];
        gl.Normal3f(
          model.vertexNormals[tr * 3],
          model.vertexNormals[tr * 3 + 1],
          model.vertexNormals[tr * 3 + 2]
        );
        gl.Vertex3f(
          model.vertexPositions[tr * 3],
          model.vertexPositions[tr * 3 + 1],
          model.vertexPositions[tr * 3 + 2]
        );
      }
    }
    gl.End();
    gl.EndList();
    callback(list);
  });
}

function draw(gl, list) {
  const pos = [5.0, Math.sin(lightangle) * 100, Math.cos(lightangle) * 100.0, 0.0];

  gl.Lightfv(gl.LIGHT0, gl.POSITION, pos);
  gl.Enable(gl.CULL_FACE);
  gl.Enable(gl.LIGHTING);
  gl.Enable(gl.LIGHT0);
  gl.Enable(gl.DEPTH_TEST);
  gl.Enable(gl.NORMALIZE);
  gl.ShadeModel(gl.SMOOTH);

  gl.Enable(gl.BLEND);
  gl.BlendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.Viewport(0, 0, width, height);
  gl.MatrixMode(gl.PROJECTION);
  gl.LoadIdentity();
  if (width < height) gl.Frustum(-1.0, 1.0, -height / width, height / width, -35.0, 20);
  else gl.Frustum(-width / height, width / height, -1, 1, -35.0, 20);
  gl.MatrixMode(gl.MODELVIEW);
  gl.LoadIdentity();

  gl.ClearColor(0.3, 0.3, 0.3, 0.0);
  gl.Clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  gl.Scalef(scale, scale, scale);
  gl.Color3f(1, 0, 0);
  gl.Rotatef(rotx, 0, 1, 0);
  gl.Rotatef(-roty, 1, 0, 0);
  gl.CallList(list);
  gl.SwapBuffers();
}

const app = await createClient();
const wnd = app.createWindow({ title: 'teapot', x: 100, y: 100, width, height });
wnd.map();
const gl = wnd.getContext('opengl');
gl.Enable(gl.POINT_SMOOTH);
makeList(gl, (list) => {
  draw(gl, list);
  setInterval(() => {
    lightangle += 0.1;
    draw(gl, list);
  }, 50);
  wnd
    .on('resize', (ev) => {
      width = ev.width;
      height = ev.height;
      draw(gl, list);
    })
    .on('mousemove', (ev) => {
      rotx = ev.x;
      roty = ev.y;
      draw(gl, list);
    })
    .on('mousedown', (ev) => {
      if (ev.keycode === 4) scale *= 0.9;
      else scale /= 0.9;
      draw(gl, list);
    });
});
