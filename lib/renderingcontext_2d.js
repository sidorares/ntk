var Picture  = require('./picture.js');
var FontFace = require('./fontface.js');
var GlyphSet = require('./glyphset.js');
var Pixmap   = require('./pixmap.js');

var _fonts = {};

module.exports = function(window, callback) {
  return new RenderingContext2d(window);
}

function RenderingContext2d(window) {
  var X = window.X;
  this.X = X;

  // TODO lazy create via getter
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

  this.picture = new Picture(window.app, { drawable: window, format: format, polyEdge: 1, polyMode: 1 });
  // TODO: create clip mask
};

var RC = RenderingContext2d.prototype;

// TODO: remove, add drawImage
RC.putImageData = function(data, x, y) {
  // todo: use constants
  this.X.PutImage(2, this.window.id, this.window._gc, data.width, data.height, x, y, 0, 24, data.data);
};

RC.setFilter = function(name, params) {
  this.Render.SetPictureFilter(this.picture.id, name, params);
};

var _solidPix = {};
RC.createSolidPicture = function(r, g, b, a) {
  var key = [r, g, b, a].join('|');
  if (_solidPix[key]) {
    return _solidPix[key];
  }
  //console.log('createSolidPicture', r, g, b, a);

  var pixmap = new Pixmap(this.window.app, {depth: 32, width: 1, height: 1});
  var pictSolidPix = this.window.X.AllocID();
  this.Render.CreatePicture(pictSolidPix, pixmap.id, this.Render.rgba32, {repeat: 1});
  //this.Render.FillRectangles(1, pictSolidPix, [0x0, 0x0, 0x0, 0xf1ff0], [0, 0, 100, 100]);
  this.Render.FillRectangles(1, pictSolidPix, [r, g, b, a], [0, 0, 100, 100]);
  console.log('this.Render.FillRectangles', 1, pictSolidPix, [Math.floor(r*65535), Math.floor(g*65535), Math.floor(b*65535), Math.floor(a*65535)], [0, 0, 100, 100]);
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
    var c;
    if (Array.isArray(value))
      c = value;
    else
      c = parseColor(value);
    this._backgroundPicture = this.createSolidPicture(c[0], c[1], c[2], c[3]);
    return this._backgroundPicture;
  } else if (value.constructor === Picture || value.constructor === CanvasGradient) {
    this._backgroundPicture = value;
    return this._backgroundPicture;
  } else {
    throw new Error('Unknown fill style');
  }
});

// html context2d compatibility: canvas.getContext('2d').canvas == canvas
RC.__defineGetter__('canvas', function(){
  return this.window;
});

RC.fillRect = function(x, y, w, h, r, g, b, a) {
  this.Render.FillRectangles(1, this.picture.id, [Math.floor(r*65535), Math.floor(g*65535), Math.floor(b*65535), Math.floor(a*65535)], [x, y, w, h])
};

RC.fillText = function(text, x, y) {
  var Render = this.Render;
  text = text || '';
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
      //continue;
      g = ff.charcode2glyphObj['n'.charCodeAt(0)];
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

RC.scale = function(s) {
  var m = [
    s, 0, 0,
    0, s, 0,
    0, 0, 1
  ];
  this.Render.SetPictureTransform(this.picture.id, m)
}

RC.fillPath = function(pts) {

}

// https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage
RC.draw = function(ctxOther) {
  var Render = this.Render;
  //ext.Composite = function(op, src, mask, dst, srcX, srcY, maskX, maskY, dstX, dstY, width, height)
  //console.log('COMPOSITE', ctxOther.picture.id, this.picture.id);
  Render.Composite(3, ctxOther.picture.id, 0, this.picture.id, 0, 0, 0, 0, 0, 0, 1000, 1000);
}

// code taken from https://github.com/Automattic/node-canvas/blob/master/lib/context2d.js
var cache = {};
var baselines = ['alphabetic', 'top', 'bottom', 'middle', 'ideographic', 'hanging'];

/**
 * Font RegExp helpers.
 */

var weights = 'normal|bold|bolder|lighter|[1-9]00'
  , styles = 'normal|italic|oblique'
  , units = 'px|pt|pc|in|cm|mm|%'
  , string = '\'([^\']+)\'|"([^"]+)"|[\\w-]+';

/**
 * Font parser RegExp;
 */

var fontre = new RegExp('^ *'
  + '(?:(' + weights + ') *)?'
  + '(?:(' + styles + ') *)?'
  + '([\\d\\.]+)(' + units + ') *'
  + '((?:' + string + ')( *, *(?:' + string + '))*)'
  );

/**
 * Parse font `str`.
 *
 * @param {String} str
 * @return {Object}
 * @api private
 */

var parseFont = exports.parseFont = function(str){
  var font = {}
    , captures = fontre.exec(str);

  // Invalid
  if (!captures) {
    console.log('INVALID FONT STRING!', str);
    return;
  }

  // Cached
  if (cache[str]) return cache[str];

  // Populate font object
  font.weight = captures[1] || 'normal';
  font.style = captures[2] || 'normal';
  font.size = parseFloat(captures[3]);
  font.unit = captures[4];
  font.family = captures[5].replace(/["']/g, '').split(',')[0].trim();

  // TODO: dpi
  // TODO: remaining unit conversion
  switch (font.unit) {
    case 'pt':
      font.size /= .75;
      break;
    case 'in':
      font.size *= 96;
      break;
    case 'mm':
      font.size *= 96.0 / 25.4;
      break;
    case 'cm':
      font.size *= 96.0 / 2.54;
      break;
  }

  return cache[str] = font;
};

RC._uploadGlyphSet = function(face, size, hdpi, vdpi) {
  var gs = face.upload(size, hdpi, vdpi);
  gs.fontface = face;
  return gs;
};

RC._setFontFace = function(face, size) {
  var glyphSet = this._uploadGlyphSet(face, size, 96, 96)
  this._glyphSet = glyphSet;
};

RC._setFont = function(weight, style, size, unit, family) {
  var fc = require('./fontconfig.js');
  var pattern = {
    family: family
  };
  if (style !== 'normal')
    pattern.style = style;
  if (weight != 'normal')
    pattern.weight = weight;

  var match = fc.listFontsSync(pattern);

  var face = new FontFace(this.window.app);
  face.loadFont(match.path);
  if (!_fonts[family])
    _fonts[family] = {};
  _fonts[family][weight + '-' + style]  = face;
  this._setFontFace(face, size);
};

RC.addFont = function(font) {
  this._fonts = this._fonts || {};
  if (this._fonts[font.name]) return;
  this._fonts[font.name] = font;
};

/**
 * Set font.
 *
 * @see exports.parseFont()
 * @api public
 */

RC.__defineSetter__('font', function(val) {
  if (!val) return;
  if ('string' == typeof val) {
    var font;
    if (font = parseFont(val)) {
      this.lastFontString = val;

      var fonts = _fonts;
      if (fonts && fonts[font.family]) {
        var fontObj = fonts[font.family];
        var type = font.weight + '-' + font.style;

        var fontFace = fontObj[type];
        this._setFontFace(fontFace, font.size);
      } else {
        this._setFont(
            font.weight
          , font.style
          , font.size
          , font.unit
          , font.family);
      }
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

/**
 * Get the current font.
 *
 * @api public
 */

RC.__defineGetter__('font', function(){
  return this.lastFontString || '10px sans-serif';
});
// ^^ end cut from https://github.com/Automattic/node-canvas/blob/master/lib/context2d.js

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
  // new Picture(window.app, { drawable: window, format: format, polyEdge: 1, polyMode: 1 });
  // TODO: weak release when gradient is GCd
};

var gradientsCache = new WeakMap();
CanvasGradient.prototype.__defineGetter__('id', function() {
  if (this._id !== null)
    return this._id;

  var Render = this.ctx.Render;
  var X = this.ctx.X;

  var key = [this.x0, this.y0, this.x1, this.y1, this.r0, this.r1,  this.angle, this.stops].join(',');
  if (gradientsCache[key])
    return gradientsCache[key].id;

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
    throw new Error('uncnown gradient type');
  }
  // wrap with picture so FreePicture is invoked on gc via weakref
  this._picture = new Picture(this.ctx.window.app, { id: this._id });
  gradientsCache[key] = this;
  return this._id;
});

function parseColor(str) {
  var parseColor_ = require('parse-color');
  var c = parseColor_(str);
  //console.log(c);
  //console.log([c.rgba[0]/255, c.rgba[1]/255, c.rgba[2]/255, c.rgba[3]]);
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

RC.createRadialGradient = function(x0, y0, x1, y1, r0, r1) {
  return new CanvasGradient('radial', this, x0, y0, x1, y1, r0, r1);
};

RC.createConicalGradient = function(x0, y0, angle) {
  return new CanvasGradient('conical', this, x0, y0, angle);
};

// register context
require('./drawable').prototype.renderingContextFactory['2d'] = module.exports;
