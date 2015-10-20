var weak = require('weak');

function Picture(app, args)
{
  var X = app.X;
  this.X = X;
  this.Render = app.display.Render;
  var display = app.display;
  this.display = display;
  if (typeof args.id == 'undefined') {
    this.id = X.AllocID();
    var format = args.format || this.Render.rgb24;
    this.format = format;
    console.log('this.Render.CreatePicture(this.id, args.drawable.id, format, args);',
      this.id, args.drawable.id, format, args
    )
    this.Render.CreatePicture(this.id, args.drawable.id, format, args);
  } else {
    this.id = args.id;
  }
  var ref = weak(this, function (obj) {
    console.log('Called FreePicture for ' + obj.id);
    app.Render.FreePicture(obj.id);
  });
}

Picture.prototype.setFilter = function(name, params) {
  this.Render.SetPictureFilter(this.id, name, params);
};

module.exports = Picture;
