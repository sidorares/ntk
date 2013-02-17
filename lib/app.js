var Window = require('./window');

module.exports = App;

function App(display, glx) {
    this.display = display;
    this.X = display.client;
}

App.prototype.createWindow = function(args) {
    return new Window(this, args);
}
App.prototype.root = function() {
    if (!this._root)
        this._root = new Window(this.display, { id: this.display.screen[0].root });
    return this._root;
}