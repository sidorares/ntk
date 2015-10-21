var Picture  = require('./picture.js');
var FontFace = require('./fontface.js');
var GlyphSet = require('./glyphset.js');
var Pixmap   = require('./pixmap.js');

module.exports = function(window, callback) {
  return new RenderingContext2d(window);
}

function RenderingContext2d(window) {
  var X = window.X;
  this.X = X;
  if (!window._gc) {
    window._gc = X.AllocID();
    X.CreateGC(window._gc, window.id);
  }
  this.window = window;
  this.Render = this.window.app.display.Render;
  var format;
  if (window.depth === 32)
    format = this.Render.rgba32;
  else
    format = this.Render.rgb24;
  this.picture = new Picture(window.app, { drawable: window, format: format });
};

var RC = RenderingContext2d.prototype;

RC.putImageData = function(data, x, y) {
  // todo: use constants
  this.X.PutImage(2, this.window.id, this.window._gc, data.width, data.height, x, y, 0, 24, data.data);
};

RC.loadFont = function(name, size, hdpi, vdpi) {
  var face = new FontFace(this.window.app);
  face.loadFont(name);
  var gs = face.upload(size, hdpi, vdpi);
  gs.fontface = face;
  return gs;
};

RC.createSolidPicture = function(r, g, b, a) {


  var pixmap = new Pixmap(this.window.app, {depth: 32, width: 1, height: 1});
  var pictSolidPix = this.window.X.AllocID();
  this.Render.CreatePicture(pictSolidPix, pixmap.id, this.Render.rgba32, {repeat: 1});
  //this.Render.FillRectangles(1, pictSolidPix, [0x0, 0x0, 0x0, 0xf1ff0], [0, 0, 100, 100]);
  this.Render.FillRectangles(1, pictSolidPix, [Math.floor(r*65535), Math.floor(g*65535), Math.floor(b*65535), Math.floor(a*65535)], [0, 0, 100, 100]);
  return new Picture(this.window.app, { id: pictSolidPix });

  //var pictSolidPix = this.window.X.AllocID();
  //this.Render.CreateSolidFill(pictSolidPix, Math.floor(r*65535), Math.floor(g*65535), Math.floor(b*65535), Math.floor(a*65535));
  return new Picture(this.window.app, { id: pictSolidPix });
};

RC.setBackground = function(pic) {
  this._background = pic;
};

RC.setFont = function(glyphSet) {
  this._glyphSet = glyphSet;
};

RC.fillRect = function(x, y, w, h, r, g, b, a) {
  this.Render.FillRectangles(1, this.picture.id, [Math.floor(r*65535), Math.floor(g*65535), Math.floor(b*65535), Math.floor(a*65535)], [x, y, w, h])
};

RC.fillText = function(text, x, y) {
  var Render = this.Render;
  text = text || '';
  var ff = this._glyphSet.fontface;
  var glyphs = String.fromCharCode.apply(null, text.split('').map( function(c) { return ff.charcode2glyph[c.charCodeAt(0)] }));
  Render.CompositeGlyphs32(3, this._background.id, this.picture.id, 0, this._glyphSet.id, 260, 260, [ [x, y, glyphs ] ] );
};

RC.beginPath = function() {
  this._currentPoly = [];
  this._currentPath = [];
}

RC.moveTo = function(x, y) {
  if (this._currentPoly.length > 0)
    this._currentPath.push(this._currentPoly)
  this._currentPoly = [[x, y]];
}

RC.lineTo = function(x, y) {
  if (this._currentPoly.length > 0)
    this._currentPoly.push([x, y]);
  else {
    throw new Error('AAAA need to start poly with moveTo');
  }
}

RC.closePath = function() {
  if (this._currentPoly.length > 0)
    this._currentPath.push(this._currentPoly)
}

RC.fill = function() {
  var tris = RC._triangulate(this._currentPath);
  var triPoints = [];
  var triangles = tris[1];
  var vertices = tris[0];
  triangles.forEach(function(tri) {
    for(var v=0; v < 3; ++v) {
      triPoints.push(vertices[tri[v]][0]);
      triPoints.push(vertices[tri[v]][1]);
    }
  });
  console.log('tri points:', triPoints);
  this._fillTriangles(triPoints);
};

RC._triangulate = function(ptss) {
  var Render = this.Render;
  var index = 0;
  var positions = [];
  var loops = [];
  ptss.forEach(function(poly) {
    var loop = [];
    poly.forEach(function(pt) {
      loop.push(positions.length);
      positions.push([pt[0], pt[1]]);
    });
    loops.push(loop);
  })
  var tris = require('triangulate-polyline')(loops, positions);
  return [positions, tris];
}

RC._fillTriangles = function(tris) {
  // (op, src, srcX, srcY, dst, maskFormat, tris)
  var Render = this.Render;
  var srcX = 0;
  var srcY = 0
  Render.Triangles(3, this._background.id, srcX, srcY, this.picture.id, 0, tris);
};

// https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage
RC.draw = function(ctxOther) {
  var Render = this.Render;
  //ext.Composite = function(op, src, mask, dst, srcX, srcY, maskX, maskY, dstX, dstY, width, height)
  //console.log('COMPOSITE', ctxOther.picture.id, this.picture.id);
  Render.Composite(3, ctxOther.picture.id, 0, this.picture.id, 0, 0, 0, 0, 0, 0, 1000, 1000);
}

// register context
require('./drawable').prototype.renderingContextFactory['2d'] = module.exports;
