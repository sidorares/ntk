module.exports = function(window) {
  //callback(null, new RenderingContextX11(window));
  return new RenderingContextX11(window);
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
  this.window.X.PolyPoint(0, this.window.id, this.gc, [p.x, p.y]);
}

RC.setForeground = function(color) {
  this.window.X.ChangeGC(this.gc, { foreground: color });
}

RC.setBackground = function(color) {
  this.window.X.ChangeGC(this.gc, { background: color });
}

RC.polyLine = function(pts) {
  var coords = [];
  pts.forEach(function(p) {
    coords.push(p.x);
    coords.push(p.y);
  });
  this.window.X.PolyLine(0, this.window.id, this.gc, coords);
}

RC.fillRectangle = function(r) {
  //console.log('fillRectangle', r);
  var coords = [parseInt(r.left), parseInt(r.top), parseInt(r.width), parseInt(r.height)];
  this.window.X.PolyFillRectangle(this.window.id, this.gc, coords);
}

RC.rectangle = function(r) {
  //console.log('rectangle', r);
  var coords = [parseInt(r.left), parseInt(r.top), parseInt(r.width), parseInt(r.height)];
  this.window.X.PolyRectangle(this.window.id, this.gc, coords);
}

RC.copy = function(dst) {
  this.window.X.CopyArea(this.window.id, dst.id, this.gc, 0, 0, 0, 0, 1000, 1000);
}

RC.drawText = function(text, x, y) {
  //console.log('drawText', x, y, text);
  this.window.X.PolyText8(this.window.id, this.gc, x, y, [text]);
}

// TODO: add poly point, poly rect, color functions

// register context
require('./drawable').prototype.renderingContextFactory['x11'] = module.exports;
