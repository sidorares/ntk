var util = require('util');
var ft2  = require('freetype2');
var fs   = require('fs');

var GlyphSet = require('./glyphset.js');

function FontFace(app, args)
{
  var X = app.X;
  this.X = X;
  this.app = app;
  var display = app.display;
  this.display = display;
  this.glyphset = null;
}

FontFace.prototype.loadFont = function(path) {
  var face = {};
  ft2.New_Memory_Face(fs.readFileSync(path), 0, face)
  this._face = face.face;
  this.charcode2glyph = [];
};

function padWidth(buf, width) {
  var height = buf.length / width;
  if (width %4 === 0)
    return buf;
  else {
    var stride = (width+3)&~3;
    var res = new Buffer(height*stride);
    res.fill(0);
    for (var y=0; y < height; ++y) {
      // memcpy(tmpbitmap+y*stride, bitmap->buffer+y*ginfo.width, ginfo.width);
      buf.copy(res, y*stride, y*width, y*width + width);
    }
    return res;
  }
}

FontFace.prototype.upload = function(size, hdpi, vdpi) {
  var face = this._face;
  var gindex = {};
  var charcode;

  var glyphs = [];
  //
  //  var glyphs = face.available_characters.map(function(ch) {
  //    return face.render(ch, size, 0, hdpi, vdpi);

  ft2.Set_Char_Size(face, 0, 40 * size, hdpi, vdpi);

  charcode = ft2.Get_First_Char(face, gindex);
  while (gindex.gindex !== 0) {
    charcode = ft2.Get_Next_Char(face, charcode, gindex);
    this.charcode2glyph[charcode] = gindex.gindex;
    ft2.Load_Glyph(face, gindex.gindex, ft2.LOAD_RENDER);

    var gi = face.glyph;
    var b = gi.bitmap.buffer;
    var bb = gi.bitmap;

    if (gindex.gindex == 3)
      debugger;

    var g = {
      id: gindex.gindex,
      charcode: charcode
    };
    if (b.length == 0) {
      g.empty = true;
      g.image = new Buffer(64);
      g.image.fill(0);
      g.width = 8;
      g.height = 8;
      g.x = 0;
      g.y = 0;
      g.offX = 0;
      g.offY = 0;
      g.offX = gi.metrics.horiAdvance ;
    } else {
      g.x = gi.bitmap_left;
      g.y = gi.bitmap_top;

      g.height = bb.rows;
      g.origWidth = bb.width;
      g.image = padWidth(b, bb.width);
      g.width = g.image.length / g.height;
      g.offX = gi.metrics.horiAdvance ; // / 64;
      g.offY = 0;
    }
    glyphs.push(g);
  }
  var gs = new GlyphSet(this.app);
  gs.addGlyphs(glyphs);
  return gs;
};

module.exports = FontFace;
