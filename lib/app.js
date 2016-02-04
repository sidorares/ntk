var Window = require('./window');
var Pixmap = require('./pixmap');

module.exports = App;

function App(display) {
  this.display = display;
  this.X = display.client;
}

App.prototype.createWindow = function(args) {
  return new Window(this, args);
}

App.prototype.rootWindow = function() {
  return new Window(this, { id: this.display.screen[0].root} );
}

App.prototype.createPixmap = function(args) {
  return new Pixmap(this, args);
}
