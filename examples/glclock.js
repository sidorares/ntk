var ntk = require('../lib');

var width = 300;
var height = 300;
var angle = 0;

function draw(gl) {
    gl.Enable(gl.BLEND);
    gl.BlendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.Viewport(0, 0, width, height);
    gl.MatrixMode(gl.PROJECTION);
    gl.LoadIdentity();
    if (width < height)
      gl.Frustum(-1.0, 1.0, -height/width, height/width, -35.0, 20);
    else
      gl.Frustum(-width/height, width/height, -1, 1, -35.0, 20);
    gl.MatrixMode(gl.MODELVIEW);
    gl.LoadIdentity();

    gl.ClearColor(0.3,0.3,0.3,0.0);
    gl.Clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.Color3f(1, 0, 0);
    for (var i=0; i < 12; ++i) {
    gl.Rotatef(30, 0, 0, 1);
    gl.Begin(gl.QUADS);
       gl.Vertex3f(-0.01, 0.8, 0);
       gl.Vertex3f(-0.01, 1.0, 0);
       gl.Vertex3f(0.01, 1.0, 0);
       gl.Vertex3f(0.01, 0.8, 0);
    gl.End();
    }
    gl.LoadIdentity();
    gl.Color4f(0, 0, 1, 0.3);
    for (var i=0; i < 60; ++i) {
    gl.Rotatef(6, 0, 0, 1);
    gl.PointSize(8);
    gl.Begin(gl.POINTS);
       gl.Vertex3f(0, 0.99, 0);
    gl.End();
    gl.Begin(gl.QUADS);
       gl.Vertex3f(-0.003, 0.85, 0);
       gl.Vertex3f(-0.003, 1.0, 0);
       gl.Vertex3f(0.003, 1.0, 0);
       gl.Vertex3f(0.003, 0.85, 0);
    gl.End();
    }

    var t = new Date();
    gl.LoadIdentity();
    gl.Color4f(1, 1, 1, 0.5);
    gl.Rotatef(-(t.getSeconds()*6000+6*t.getMilliseconds())/1000, 0, 0, 1);
    gl.Begin(gl.TRIANGLES);
      gl.Vertex3f(-0.02, -0.1, 0);
      gl.Vertex3f(0, 0.9, 0);
      gl.Vertex3f(0.02, -0.1, 0);
    gl.End();

    gl.LoadIdentity();
    gl.Color4f(0.5, 0.5, 0.1, 0.5);
    gl.Rotatef(-t.getMinutes()*6 -t.getSeconds()/10 - t.getMilliseconds()/10000, 0, 0, 1);
    gl.Begin(gl.TRIANGLES);
      gl.Vertex3f(-0.05, -0.1, 0);
      gl.Vertex3f(0, 0.8, 0);
      gl.Vertex3f(0.05, -0.1, 0);
    gl.End();

    gl.LoadIdentity();
    gl.Color4f(0, 0, 0, 0.5);
    gl.Rotatef(-(t.getHours()*30 + t.getMinutes()/2), 0, 0, 1);
    gl.Begin(gl.TRIANGLES);
      gl.Vertex3f(-0.08, -0.1, 0);
      gl.Vertex3f(0, 0.6, 0);
      gl.Vertex3f(0.08, -0.1, 0);
    gl.End();

}

ntk.createClient(function(err, app) {

  var wnd = app.createWindow({title: "GL clock", x: 100, y: 100, width: 300, height: 300});
  wnd.map();
  var gl = wnd.getContext('opengl');

  gl.Enable(gl.POINT_SMOOTH);

  function drawAndFinish() {
    draw(gl);
    gl.SwapBuffers();
    gl.Finish(drawAndFinish);
  }
  drawAndFinish();

  wnd.on('resize', function(ev) {
     width = ev.width;
     height = ev.height;
     draw(gl);
     gl.SwapBuffers();
  });
});
