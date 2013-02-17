module.exports = function(window, callback) {
    callback(null, new RenderingContextX11(window));
}

function RenderingContextX11(window) {
	var X = window.X;
	this.gc = X.AllocID();
    X.CreateGC(this.gc, window.id);
    this.window = window;
}

var RC = RenderingContextX11.prototype;

RC.putImage = function(data, x, y) {
	// todo: use constants
    X.PutImage(2, this.window.id, this.gc, data.width, data.height, x, y, 0, 24, data.data);
}

// TODO: add poly point, poly rect, color functions

// register context
require('./drawable').prototype.renderingContextFactory['x11'] = module.exports;
