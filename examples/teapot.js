var ntk = require('../lib');

var width = 300;
var height = 300;
var angle = 0;

var model = require('./teapot.json');

function makeList(gl, callback)
{
    gl.GenLists(1, function(err, list) {
        listId = list;
        gl.NewList(list, gl.COMPILE);
        gl.Begin(gl.TRIANGLES);
        for (var i=0; i < model.indices.length; i+=3) {
            for (var t=i; t < i+3; t++) {
              tr = model.indices[t];
              var x = model.vertexPositions[tr*3 + 0];
              var y = model.vertexPositions[tr*3 + 1];
              var z = model.vertexPositions[tr*3 + 2];
              gl.Vertex3f(x, y, z);
              var x = model.vertexNormals[tr*3 + 0];
              var y = model.vertexNormals[tr*3 + 1];
              var z = model.vertexNormals[tr*3 + 2];
              gl.Normal3f(x, y, z);
            }
        }
        gl.End();
        gl.Begin(gl.LINES);
        for (var i=0; i < model.indices.length; i+=3) {
            for (var t=i; t < i+3; t++) {
              tr = model.indices[t];
              var x = model.vertexPositions[tr*3 + 0];
              var y = model.vertexPositions[tr*3 + 1];
              var z = model.vertexPositions[tr*3 + 2];
              gl.Vertex3f(x, y, z);
              var nx = model.vertexNormals[tr*3 + 0];
              var ny = model.vertexNormals[tr*3 + 1];
              var nz = model.vertexNormals[tr*3 + 2];
              console.log(nx, ny, nz);
              gl.Vertex3f(x+nx, y+ny, z+nz);
            }
        }
        gl.End();
        gl.EndList();
        callback(list);
    });
}

var scale = 0.1;
var rotx = 0;
var roty = 0;
var lightangle = 0;

function draw(gl, list) {
   //var pos = [5.0, 100, 100.0, 0.0]
   var pos = [5.0, Math.sin(lightangle)*100, Math.cos(lightangle)*100.0, 0.0]
   var red = [ 0.8, 0.1, 0.0, 1.0 ];
   var green = [ 0.0, 0.8, 0.2, 1.0 ];
   var blue = [ 0.2, 0.2, 1.0, 1.0 ];

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
    if (width < height)
      gl.Frustum(-1.0, 1.0, -height/width, height/width, -35.0, 20);
    else
      gl.Frustum(-width/height, width/height, -1, 1, -35.0, 20);
    gl.MatrixMode(gl.MODELVIEW);
    gl.LoadIdentity();

    gl.ClearColor(0.3,0.3,0.3,0.0);
    gl.Clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.Scalef(scale, scale, scale);
    gl.Color3f(1, 0, 0);
    gl.Rotatef(rotx, 0, 1, 0);
    gl.Rotatef(-roty, 1, 0, 0);
    gl.CallList(list)
}

ntk.createClient(function(err, app) {
  var wnd = app.createWindow({title: "Close me!", x: 100, y: 100, width: 300, height: 300});
  wnd.map();
  wnd.getContext('opengl', function(err, gl) {
    //gl.Enable(gl.POINT_SMOOTH);
    makeList(gl, function(list) {

    draw(gl, list);
    gl.SwapBuffers();


    setInterval(function() {
        lightangle += 0.1;
        draw(gl, list); gl.SwapBuffers();
    }, 500);


    wnd.on('resize', function(ev) {
       width = ev.width;
       height = ev.height;
       draw(gl, list);
       gl.SwapBuffers();
    }).on('mousemove', function(ev) {
       rotx = ev.x;
       roty = ev.y;
       draw(gl, list);
       gl.SwapBuffers();

    }).on('mousedown', function(ev) {
        if (ev.keycode == 4)
            scale *= 0.9;
        else
            scale /= 0.9;
        draw(gl, list);
        gl.SwapBuffers();
    }).on('mouseup', function(ev) {
        //draw(gl, list);
    }).on('keydown', function(ev) {
       console.log('Key down');
    }).on('keyup', function(ev) {
        console.log('Key up');
    });

    });

  });
});
