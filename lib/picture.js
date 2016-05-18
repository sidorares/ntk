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
    //console.log('this.Render.CreatePicture(this.id, args.drawable.id, format, args);',
    //  this.id, args.drawable.id, format, args
    //)
    this.Render.CreatePicture(this.id, args.drawable.id, format, args);
  } else {
    this.id = args.id;
  }
  var id = this.id;
  var ref = weak(this, function () {
    app.display.Render.FreePicture(id);
    X.ReleaseID(id);
  });
}

Picture.prototype.setFilter = function(name, params) {
  this.Render.SetPictureFilter(this.id, name, params);
};

Picture.prototype.setBlurFilter = function(radius, sigma) {
  if (radius === 0) {
    return this.setFilter('convolution', [1, 1, 1]);
  }

  if (!sigma)
    sigma = radius/2;
  var dim = parseInt(radius);
  if (radius % 2 == 0) radius++;
  var generateGaussianKernel = require('gaussian-convolution-kernel');
  var params = [radius, radius].concat(generateGaussianKernel(radius, sigma));
  this.setFilter('convolution', params);
}

module.exports = Picture;
