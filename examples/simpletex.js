var ntk = require('../lib');

var width = 300;
var height = 300;
var angle = 0;
var angley = 0;

function resize(gl) {
  gl.Viewport(0, 0, width, height);
  gl.MatrixMode(gl.PROJECTION);
  gl.LoadIdentity();
  if (width < height)
    gl.Frustum(-1.0, 1.0, -height/width, height/width, -35.0, 20);
  else
    gl.Frustum(-width/height, width/height, -1.0, 1.0, -35.0, 20);
}

function draw(gl) {
    gl.MatrixMode(gl.MODELVIEW);

    gl.ClearColor(0.3,0.3,0.3,0.0);
    gl.Clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.LoadIdentity();
    gl.Rotatef(-90 + 360*angle/width, 0, 0, 1);
    // gl.Rotatef(angley, 0, 1, 0);
    gl.Begin(gl.TRIANGLE_STRIP);
      gl.TexCoord2f(0.0,0.0);
      gl.Vertex3f(-1, -1, 0);

      gl.TexCoord2f(1.0, 0.0);
      gl.Vertex3f(1, -1, 0);

      gl.TexCoord2f(0.0, 1.0);
      gl.Vertex3f(-1, 1, 0);

      gl.TexCoord2f(1.0,1.0);
      gl.Vertex3f(1, 1, 0);
    gl.End();
    gl.SwapBuffers();
}

var lena = require('lena');

ntk.createClient(function(err, app) {

  var wnd = app.createWindow({width: width, height: height});
  wnd.map();
  var visual = parseInt(require('child_process').execSync('glxinfo -i -b').toString());
  var gl = wnd.getContext('opengl', visual);
  gl.Enable(gl.TEXTURE_2D);
  gl.GenTextures(1, function(err, textures) {
    //gl.BindTexture(gl.TEXTURE_2D, textures[0]);
    gl.BindTexture(gl.TEXTURE_2D, 1);
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.TexImage2D(gl.TEXTURE_2D, 0, gl.RGB, 512, 512, 0, gl.RGB, gl.UNSIGNED_BYTE, lena.data);
    draw(gl);

    wnd.on('resize', function(ev) {
       width = ev.width;
       height = ev.height;
       resize(gl);
       draw(gl);
    }).on('mousemove', function(ev) {
      angle = ev.x;
      angley = ev.y;
      draw(gl);
    });
  });
});
