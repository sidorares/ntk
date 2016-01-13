var Picture  = require('./picture.js');
var FontFace = require('./fontface.js');
var GlyphSet = require('./glyphset.js');
var Pixmap   = require('./pixmap.js');

var DEFAULT_FONT = '20px sans-serif';
var _fonts = {};

module.exports = function(window, callback) {
  return new RenderingContext2d(window);
}

function RenderingContext2d(window) {
  var X = window.X;
  this.X = X;

  // TODO lazily create via getter
  if (!window._gc) {
    window._gc = X.AllocID();
    X.CreateGC(window._gc, window.id);
  }

  this.window = window;
  this.Render = this.window.app.display.Render;
  var format;
  // TODO: support a8
  if (window.depth === 32)
    format = this.Render.rgba32;
  else
    format = this.Render.rgb24;

  this.picture = new Picture(window.app, { drawable: window, format: format, polyEdge: 1, polyMode: 1 });


  this.fillMask = null;
  this.fillMaskDrawable = null;
  this.clipMask = null;
  this.clipMaskDrawable = null;

  this.fillStyle   = 'white';
  this.strokeStyle = 'black';
  this.lineWidth = 1;
};

var RC = RenderingContext2d.prototype;

// TODO: remove, add drawImage
RC.putImageData = function(data, x, y) {
  // todo: use constants
  this.X.PutImage(2, this.window.id, this.window._gc, data.width, data.height, x, y, 0, 24, data.data);
};

// TODO: use WeakMap
var _solidPix = new WeakMap();
RC.createSolidPicture = function(r, g, b, a) {
  var key = [r, g, b, a].join('|');
  if (_solidPix[key]) {
    return _solidPix[key];
  }
  // TODO: use window.createPixmap
  var pixmap = new Pixmap(this.window.app, {depth: 32, width: 1, height: 1});
  var pictSolidPix = this.window.X.AllocID();
  this.Render.CreatePicture(pictSolidPix, pixmap.id, this.Render.rgba32, {repeat: 1});
  this.Render.FillRectangles(1, pictSolidPix, [r, g, b, a], [0, 0, 100, 100]);
  var p = new Picture(this.window.app, { id: pictSolidPix });
  _solidPix[key] = p;
  return p;
};

RC.setBackground = function(pic) {
  this._background = pic;
};

RC.__defineGetter__('_backgound', function() {
  if (this._backgroundPicture)
    return this._backgroundPicture;
  else {
    this._backgroundPicture = this.createSolidPicture(1, 1, 1, 1);
    return this._backgroundPicture;
  }
});

RC.__defineSetter__('fillStyle', function(value) {
  if (typeof value === 'string' || Array.isArray(value) ) {
    var c = parseColor(value);
    this._backgroundPicture = this.createSolidPicture(c[0], c[1], c[2], c[3]);
    return this._backgroundPicture;
  } else if (value.constructor === Picture || value.constructor === CanvasGradient) {
    this._backgroundPicture = value;
    return this._backgroundPicture;
  } else {
    throw new Error('Unknown fill style');
  }
});

RC.__defineSetter__('strokeStyle', function(value) {
  if (typeof value === 'string' || Array.isArray(value) ) {
    var c;
    if (Array.isArray(value))
      c = value;
    else
      c = parseColor(value);
    this._strokePicture = this.createSolidPicture(c[0], c[1], c[2], c[3]);
    return this._strokePicture;
  } else if (value.constructor === Picture || value.constructor === CanvasGradient) {
    this._strokePicture = value;
    return this._strokePicture;
  } else {
    throw new Error('Unknown stroke style');
  }
});


// html context2d compatibility: canvas.getContext('2d').canvas == canvas
RC.__defineGetter__('canvas', function(){
  return this.window;
});

RC.__defineGetter__('width', function(){
  return this.window.width;
});

RC.__defineGetter__('height', function(){
  return this.window.height;
});

RC.clearRect = function(x, y, w, h) {
  this.Render.FillRectangles(this.Render.PictOp.Src, this.picture.id, [1, 1, 1, 1], [x, y, w, h])
};

RC.fillRect = function(x, y, w, h) {
  var mask = 0;
  if (this.clipMask)
    mask = this.clipMask.id;
  // ext.Composite = function(op, src, mask, dst, srcX, srcY, maskX, maskY, dstX, dstY, width, height)
  this.Render.Composite(this.Render.PictOp.Over, this._backgroundPicture.id, mask, this.picture.id, x, y, x, y, x, y, w, h);
}

RC.fillText = function(text, x, y) {
  var Render = this.Render;
  text = text || '';
  if (!this._glyphSet)
    this.font = DEFAULT_FONT;
  var ff = this._glyphSet.fontface;
  var glyphs = String.fromCharCode.apply(null, text.split('').map( function(c) { return ff.charcode2glyph[c.charCodeAt(0)] }));
  Render.CompositeGlyphs32(3, this._backgroundPicture.id, this.picture.id, 0, this._glyphSet.id, 0, 0, [ [x, y, glyphs ] ] );
};

RC.measureText = function(text) {
  var w = 0;
  var h = 0;
  var ch, g;
  var ff = this._glyphSet.fontface;
  for (var i=0; i < text.length; ++i)
  {
    ch = text.charCodeAt(i);
    g = ff.charcode2glyphObj[ch];
    if (!g) {
      //console.log('Unknown character!', [text[i]], ch);
      //w += 10;
      //
      continue;
      //g = ff.charcode2glyphObj['n'.charCodeAt(0)];
    }
    w += g.offX;
    if (g.height > h)
      h = g.height;
  }
  //console.log('measureText', text, w, h)
  return {
    width: w,
    height: h
  };
}

RC.beginPath = function() {
  this._currentPoly = null;
  this._currentPath = [];
}

RC.moveTo = function(x, y) {
  //console.log('moveTo', [x, y])
  if (this._currentPoly)
    this._currentPath.push(this._currentPoly)
  this._currentPoly = [{x: x, y: y}];
}

RC.lineTo = function(x, y) {
  //if (x < 0) x = 0;
  //if (y < 0) y = 0;
  //console.log('lineTo', [x, y])
  if (this._currentPoly) {
    var pt = this._currentPoly[this._currentPoly.length - 1];
    var d = Math.abs(pt.x - x) + Math.abs(pt.y - y);
    if (d > 0.5)
      this._currentPoly.push({x: x, y: y});
  } else {
    throw new Error('lineTo called before moveTo()');
  }
}

// TODO: this is my heuristic. Do some more research
function bcurveStep(x0, y0, x1, y1, x2, y2, x, y) {
  var minX = Math.min(x, x0, x1, x2);
  var maxX = Math.max(x, x0, x1, x2);
  var minY = Math.min(y, y0, y1, y2);
  var maxY = Math.max(y, y0, y1, y2);
  var dt = 1/Math.max(maxX - minX, maxY - minY);
  if (dt > 0.2)
    dt = 0.2;
  return dt;
}

RC.bezierCurveTo = function(x1, y1, x2, y2, x, y) {
  var lastPt = this._currentPoly[this._currentPoly.length - 1];
  var cubic = require('bezier').prepare(4);
  var x = [lastPt.x, x1, x2, x];
  var y = [lastPt.y, y1, y2, y];
  var step = bcurveStep(x[0], y[0], x[1], y[1], x[2], y[2], x[3], y[3]);
  for (var t = 0; t < 1; t += step) {
    this.lineTo(cubic(x, t), cubic(y, t))
  }
}

RC.closePath = function() {
  if (this._currentPoly)
    this._currentPath.push(this._currentPoly)
  this._currentPoly = null;
}

RC.scale = function(s) {
  var m = [
    s, 0, 0,
    0, s, 0,
    0, 0, 1
  ];
  this.Render.SetPictureTransform(this.picture.id, m)
}

// from https://github.com/jahting/pnltri.js/blob/master/test/TestHelpers.js#L132
function	xCoord_of_segment_at_Y( inSegment, inCrossYPt ) {
  if ( inSegment.vTo.y == inSegment.vFrom.y )		return inCrossYPt.x;
  return xCoord = inSegment.vFrom.x + (inSegment.vTo.x - inSegment.vFrom.x) *
    ( inCrossYPt.y - inSegment.vFrom.y ) / ( inSegment.vTo.y - inSegment.vFrom.y );
}

RC._rasterizePath = function(picture) {
  var PNLTRI = require('PNLTRI');
  var max_width = 65535;
  var path = this._currentPath;

  //console.log('_rasterizePath', path);
  var trapezoider = new PNLTRI.Trapezoider( new PNLTRI.PolygonData(path) );
  trapezoider.trapezoide_polygon();
  var traps = trapezoider.queryStructure.trapArray;
  var trapSegments = [];
  traps.forEach(function(inTrapezoid) {
    var high = [-max_width, max_width, inTrapezoid.vHigh.y];
    var low = [-max_width, max_width, inTrapezoid.vLow.y];
    if (inTrapezoid.lseg) {
      high[0] = xCoord_of_segment_at_Y( inTrapezoid.lseg, inTrapezoid.vHigh );
      low[0] = xCoord_of_segment_at_Y( inTrapezoid.lseg, inTrapezoid.vLow );
    }
    if (inTrapezoid.rseg) {
      high[1] = xCoord_of_segment_at_Y( inTrapezoid.rseg, inTrapezoid.vHigh );
      low[1] = xCoord_of_segment_at_Y( inTrapezoid.rseg, inTrapezoid.vLow );
    }
    if (inTrapezoid.depth == 1 && high[1] != max_width && low[1] != max_width && high[0] != -max_width && low[1] != -max_width) {
      trapSegments = trapSegments.concat(low);
      trapSegments = trapSegments.concat(high);
    }
  });
  this.Render.AddTraps(picture.id, 0, 0, trapSegments);
  return;

  /*
     triangulate: note that XRender does not stich edges properly, this code going yp be removed
  var pts = [];
  path.forEach(function(p) {
    pts = pts.concat(p)
  });
  var myTriangulator = new PNLTRI.Triangulator();
  var triangList = myTriangulator.triangulate_polygon( path );
  var t = [];
  triangList.forEach(function(tri) {
    for(var i=0; i < 3; ++i) {
      t.push(pts[tri[i]].x);
      t.push(pts[tri[i]].y);
    }
  });
  this.Render.Triangles(this.Render.PictOp.Over, this._backgroundPicture.id, 0, 0, this.picture.id, 0, t);
  */
}

RC.stroke = function() {
  this.closePath();

  var t = [];
  var stroke = require('extrude-polyline')({
    thickness: this.lineWidth,
    //cap: 'square',
    //join: 'bevel',
    miterLimit: 10
  });

  for (var p=0; p < this._currentPath.length; ++p) {
    //var polyline = [ [25, 25], [15, 60] ]
    var polyline = this._currentPath[p].map( (pt) => [pt.x, pt.y] )
    var mesh = stroke.build(polyline);
    mesh.cells.forEach(function(tri) {
      for(var i=0; i < 3; ++i) {
        t.push(mesh.positions[tri[i]][0]);
        t.push(mesh.positions[tri[i]][1]);
      }
    });
  }
  // TODO: mask
  //this.Render.Triangles(this.Render.PictOp.Over, this._strokePicture.id, 0, 0, this.picture.id, 0, t);
  this.Render.Triangles(this.Render.PictOp.Over, this._strokePicture.id, 0, 0, this.picture.id, this.Render.a8, t);
}

RC.clip = function() {
  if (!this.clipMask) {
    this.clipMaskDrawable = new Pixmap(this.window.app, {depth: 8, width: this.width, height: this.height});
    this.clipMask = new Picture(this.window.app, { drawable: this.clipMaskDrawable, format: this.Render.a8});
  }
  this.Render.FillRectangles(1, this.clipMask.id, [0, 0, 0, 0], [0, 0, this.width, this.height]);
  this._rasterizePath(this.clipMask);
}

RC.fill = function() {

  this.closePath();

  // TODO: perf: use shape bounding box instead of compositing over whole width x height canvas

  if (!this.fillMask) {
    this.fillMaskDrawable = new Pixmap(this.window.app, {depth: 8, width: this.width, height: this.height});
    this.fillMask = new Picture(this.window.app, { drawable: this.fillMaskDrawable, format: this.Render.a8});
  }
  // TODO: apply global alpha here?
  this.Render.FillRectangles(1, this.fillMask.id, [0, 0, 0, 0], [0, 0, this.width, this.height]);
  this._rasterizePath(this.fillMask);

  // TODO apply transformation to background position?

  // intersect with clipping area
  if (this.clipMask)
    this.Render.Composite(this.Render.PictOp.In, this.clipMask.id, 0, this.fillMask.id, 0, 0, 0, 0, 0, 0, this.width, this.height);
  // draw background using resulting image as mask
  this.Render.Composite(this.Render.PictOp.Over, this._backgroundPicture.id, this.fillMask.id, this.picture.id, 0, 0, 0, 0, 0, 0, this.width, this.height);
}

var baselines = ['alphabetic', 'top', 'bottom', 'middle', 'ideographic', 'hanging'];
var parseFontStyle = require('canvas-fontstyle');

RC._uploadGlyphSet = function(face, size, hdpi, vdpi) {
  var gs = face.upload(size, hdpi, vdpi);
  gs.fontface = face;
  return gs;
};

RC._setFace = function(face, size) {
  var glyphSet = this._uploadGlyphSet(face, size, 96, 96)
  this._glyphSet = glyphSet;
};

RC._setFont = function(weight, style, size, unit, family) {
  var fc = require('./fontconfig.js');
  var pattern = {
    family: family,
    style: style,
    weight: weight
  };
  var match = fc.listFontsSync(pattern);

  var face = new FontFace(this.window.app);
  face.loadFont(match.path);
  if (!_fonts[family])
    _fonts[family] = {};
  _fonts[family][weight + '-' + style]  = face;
  this._setFace(face, size);
};

RC.addFont = function(font) {
  this._fonts = this._fonts || {};
  if (this._fonts[font.name]) return;
  this._fonts[font.name] = font;
};

RC.__defineSetter__('font', function(val) {
  if (!val) return;
  if ('string' == typeof val) {
    var font;
    if (font = parseFontStyle(val)) {
      this._lastFontString = val;
      if (_fonts && _fonts[font.family]) {
        var fontObj = _fonts[font.family];
        var type = font.weight + '-' + font.style;
        var fontFace = fontObj[type];
        if (fontFace)
          return this._setFace(fontFace, font.size);
      }
      this._setFont(
          font.weight
        , font.style
        , font.size
        , font.unit
        , font.family);
    }
  }
});

RC.loadFont = function(name, size, hdpi, vdpi) {
  var face = new FontFace(this.window.app);
  face.loadFont(name);
  var gs = face.upload(size, hdpi, vdpi);
  gs.fontface = face;
  return gs;
};

RC.setFont = function(glyphSet) {
  this._glyphSet = glyphSet;
};

RC.__defineGetter__('font', function(){
  return this._lastFontString || DEFAULT_FONT;
});

function CanvasGradient(type, ctx, p0, p1, p2, p3, p4, p5) {
  this.type = type;
  this.stops = [];
  this.ctx = ctx;
  this._id = null;

  this.x0 = p0;
  this.y0 = p1;
  if (type == 'linear' || type == 'radial') {
    this.x1 = p2;
    this.y1 = p3;
    this.r0 = p4;
    this.r1 = p5;
  } else {
    this.angle = p2;
  }
  // TODO: check if ChangePictureAttrubute works on gradients ( set repeat edge pixels flag )
};

//var gradientsCache = new WeakMap();
CanvasGradient.prototype.__defineGetter__('id', function() {
  if (this._id !== null)
    return this._id;

  var Render = this.ctx.Render;
  var X = this.ctx.X;

  //var key = [this.x0, this.y0, this.x1, this.y1, this.r0, this.r1,  this.angle, this.stops].join(',');
  //if (gradientsCache[key])
  //  return gradientsCache[key].id;

  this._id = X.AllocID();
  switch (this.type) {
  case 'linear':
    Render.LinearGradient(this._id, [this.x0, this.y0], [this.x1, this.y1], this.stops);
    break;
  case 'radial':
    Render.RadialGradient(this._id, [this.x0, this.y0], [this.x1, this.y1], this.r0, this.r1, this.stops);
    break;
  case 'conical':
    Render.ConicalGradient(this._id, [this.x0, this.y0], this.angle, this.stops);
    break;
  default:
    throw new Error('unknown gradient type');
  }
  // wrap with picture so FreePicture is invoked on gc via weakref
  this._picture = new Picture(this.ctx.window.app, { id: this._id });
  //gradientsCache[key] = this;
  return this._id;
});

function parseColor(str) {
  if (Array.isArray(str))
    return str;
  var parseColor_ = require('parse-color');
  var c = parseColor_(str);
  return [c.rgba[0]/255, c.rgba[1]/255, c.rgba[2]/255, c.rgba[3]];
}

CanvasGradient.prototype.addColorStop = function(offset, color) {
  var colorArr = parseColor(color);
  this.stops.push([offset, colorArr]);
  return this;
}

RC.createLinearGradient = function(x0, y0, x1, y1) {
  return new CanvasGradient('linear', this, x0, y0, x1, y1);
};

RC.createRadialGradient = function(x0, y0, r0, x1, y1, r1) {
  return new CanvasGradient('radial', this, x0, y0, x1, y1, r0, r1);
};

RC.createConicalGradient = function(x0, y0, angle) {
  return new CanvasGradient('conical', this, x0, y0, angle);
};

RC.createImageData = function(w, h) {
  return {
    width: w,
    height: h,
    data: new Buffer(w*h*4)
  };
};

RC.getImageData = function(x, y, w, h, cb) {
  // X.GetImage( format, drawable, x, y, w, h, planeMask )
  console.log("GetImage(2", [this.window.id, x, y, w, h, 0xffffffff]);
  //var win = this.window.app.root().id;
  var win = this.window.id;
  this.X.GetImage(2, win, x, y, w, h, 0xffffffff, function(err, data) {
    cb(err, data);
  });
};

// void ctx.drawImage(image, dx, dy);
// void ctx.drawImage(image, dx, dy, dWidth, dHeight);
// void ctx.drawImage(image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight);
// image: drawable, node-canvas Canvas, node-canvas Image
RC.drawImage = function(image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight) {
  //image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight
  //if (typeof dHeight == 'undefined' && )

  sWidth = image.width;
  sHeight = image.height;
  sx = 0;
  sy = 0;

  // TODO: allow to draw Canvas.Image, Window, Pixmap, Picture
  if (image.constructor == RenderingContext2d) {
    // TODO: if need to scale, set transform
    // TODO: respect globalAlpha ( use solid transparent mask )
    // TODO: respect global compositing blend mode
    this.Render.Composite(this.Render.PictOp.Over, image.picture.id, 0, this.picture.id, 0, 0, 0, 0, 0, 0, this.width, this.height);
  } else if (image && image.context && typeof image.context.getImageData == 'function') {
    // node-canvas Canvas ( or any ctx with ctx.canvas.getImageData returning pixels)
    var imageData = image.context.getImageData(sx, sy, sWidth, sHeight);
    var data = new Buffer(imageData.data.length);
    for (var i=0; i < data.length; i+=4) {
      data[i+2] = imageData.data[i];
      data[i+1] = imageData.data[i+1];
      data[i] = imageData.data[i+2];
      data[i+3] = imageData.data[i+3]; // multiply source alpha by context globalAlpha?
                                       // or maybe just blend using corresponding operation + composite with transparent rectangle
    }

    var pixmap  = new Pixmap(this.window.app, {depth: 32, width: sWidth, height: sHeight});
    var picture = new Picture(this.window.app, { drawable: pixmap, format: this.Render.rgba32});
    pixmap._gc = this.X.AllocID();
    this.X.CreateGC(pixmap._gc, pixmap.id);
    this.X.PutImage(2, pixmap.id, pixmap._gc, sWidth, sHeight, sx, sy, 0, 32, data);

    // TODO: figure out scale factor if sWidth !== dWith or sHeight !== dHeight
    //this.Render.SetPictureFilter(picture.id, 'best');
    var s = 1;
    var m = [
      s, 0, 0,
      0, s, 0,
      0, 0, 1
    ];
    //this.Render.SetPictureTransform(picture.id, m);

    // TODO: respect globalCompositeOperation and globalAlpha
    // examples http://blogs.adobe.com/webplatform/2014/02/24/using-blend-modes-in-html-canvas/
    var mask = 0;
    if (this.clipMask)
      mask = this.clipMask.id
    this.Render.Composite(3, picture.id, mask, this.picture.id, 0, 0, 0, 0, 0, 0, this.width, this.height);
  }
};

RC.arc = function() {
  //console.log('canvas2d.arc() not implemented!!!');
  //console.log(arguments);
};

RC.restore = function() {
  //console.log('canvas2d.restore() not implemented!!!');
};

RC.save = function() {
  //console.log('canvas2d.save() not implemented!!!');
};

RC.translate = function(x, y) {
  //console.log('canvas2d.translate() not implemented!!!');
};

// register context
require('./drawable').prototype.renderingContextFactory['2d'] = module.exports;
