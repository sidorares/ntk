var weak = require('weak');

function GlyphSet(app, args)
{
  var X = app.X;
  this.X = X;
  var display = app.display;
  this.Render = display.Render;
  this.display = display;
  this.id = X.AllocID();
  this.Render.CreateGlyphSet(this.id, this.Render.a8);
  var ref = weak(this, function (obj) {
    X.FreeGlyphSet(obj.id);
  });
}

GlyphSet.prototype.addGlyphs = function(glyphs) {
  this.Render.AddGlyphs(this.id, glyphs);
  this._glyphs = glyphs;
};

module.exports = GlyphSet;
