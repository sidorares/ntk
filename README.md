ntk
===

node.js desktop UI toolkit

A set of wrappers around low level [node-x11](https://github.com/sidorares/node-x11) module to simplify X Window UI progamming - windows creation, event handling, 2d/3d graphics etc.

# Installation

```
npm install ntk
```

## Basic usage

```js
require('ntk').createClient( (err, app) => {
  var mainWnd = app.createWindow({ width: 500, height: 300, title: 'Hello' });
  mainWnd.on('mousedown', (ev) => { mainWnd.setTitle('click: ' + [ev.x, ev.y].join(',')); });
  mainWnd.map();
});
```

## 2d graphics

Each window ( or pixmap ) can be used to create 2d and 3d canvas. 2d canvas implements HTML [context2d api](https://html.spec.whatwg.org/multipage/scripting.html#2dcontext) ( some features not yet supported ) via [XRender extension](http://www.x.org/releases/X11R7.7/doc/renderproto/renderproto.txt), and most operations are performed on the X Server side ( image composition, scaling, blur, text composition, gradients etc ). Initial font rendering is performed by ntk using [freetype2](https://github.com/ericfreese/node-freetype2) module and fonts names mapped to file names using [font-manager](https://github.com/devongovett/font-manager) module.

```js
var ntk = require('ntk');

ntk.createClient( (err, app) => {
  var wnd = app.createWindow({ width: 800, height: 600});
  var ctx = wnd.getContext('2d');

  wnd.on('mousemove', (ev) => {
    var gradient = ctx.createRadialGradient(0, 0, 10, ev.x, ev.y, 500);
    gradient.addColorStop(0, "red");
    gradient.addColorStop(0.5, "green");
    gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, ctx.width, ctx.height);
  });

  wnd.map();
});
```

`ctx.drawImage()` also accepts [node-canvas](https://github.com/Automattic/node-canvas) as a source, for images with lot's of drawing calls it might be more efficient to perform all drawing locally and transfer pixels to server when ready:

```js
var ntk = require('ntk');
var Canvas = require('canvas');

var canvas = new Canvas(800, 800);
var canvasCtx = canvas.getContext('2d');

function drawSomething(ctx) {
  // ...
}

ntk.createClient( (err, app) => {
  var wnd = app.createWindow({ width: 800, height: 800});

  var ctx = wnd.getContext('2d');

  setInterval(function() {
    drawSomething(canvasCtx);
    ctx.drawImage(canvas);
  }, 20);

  wnd.map();
});
```

## 3d graphics

At the moment only indirect GLX is supported with most of OpenGL 1.4 api implemented

```js
var ntk = require('ntk');

var width = 300;
var height = 300;
var angle = 0;

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
    gl.BindTexture(gl.TEXTURE_2D, textures[0]);
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
      draw(gl);
    });
  });
});

```

## High level widgets / layout management etc

Likely to be implemented outside as part of [react-x11](https://github.com/sidorares/react-x11)
