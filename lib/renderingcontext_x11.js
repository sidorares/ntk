module.exports = function(window, callback) {
    callback(null, new RenderingContextX11(window));
}

function RenderingContextX11(window) {
  var X = window.X;
  this.gc = X.AllocID();
  
  var white = X.display.screen[0].white_pixel;
  var black = X.display.screen[0].black_pixel;
  X.CreateGC(this.gc, window.id, { foreground: white, background: black });
  this.window = window;
}

var RC = RenderingContextX11.prototype;

RC.putImage = function(data, x, y) {
    this.window.X.PutImage(2, this.window.id, this.gc, data.width, data.height, x, y, 0, 24, data.data);
}

RC.point = function(p) {
  for (var x=-5; x < 5; ++x)
    for (var y=-5; y < 5; ++y)
      this.window.X.PolyPoint(0, this.window.id, this.gc, [p.x+x, p.y+y]);
}

RC.copy = function(dst) {
   this.window.X.CopyArea(this.window.id, dst.id, this.gc, 0, 0, 0, 0, 512, 512);
}

// TODO: add poly point, poly rect, color functions

// register context
require('./drawable').prototype.renderingContextFactory['x11'] = module.exports;
