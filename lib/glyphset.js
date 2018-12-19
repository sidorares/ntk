var weak = require('weak-napi');

function GlyphSet(app, args) {
  var X = app.X;
  this.X = X;
  var display = app.display;
  this.Render = display.Render;
  this.display = display;
  this.id = X.AllocID();
  this.Render.CreateGlyphSet(this.id, this.Render.a8);
  var ref = weak(this, function(obj) {
    X.FreeGlyphSet(obj.id);
  });
  this._glyphs = {};
}

GlyphSet.prototype.addGlyphs = function(glyphs) {
  glyphs.forEach(g => {
    this._glyphs[g.id] = g;
  });
  this.Render.AddGlyphs(this.id, glyphs);
};

module.exports = GlyphSet;
