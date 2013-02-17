module.exports = function(window, callback) {
    callback(null, new RenderingContextX11(window));
}

function RenderingContextX11(window) {
	var X = window.X;
	if (!window._gc)
	    window._gc = X.AllocID();
    X.CreateGC(window._gc, window.id);
    this.window = window;
}

var RC = RenderingContextX11.prototype;

RC.putImageData = function(data, x, y) {
	// todo: use constants
    X.PutImage(2, this.window.id, self.gc, data.width, data.height, x, y, 0, 24, data.data);
}

// register context
require('./drawable').prototype.renderingContextFactory['2d'] = module.exports;
