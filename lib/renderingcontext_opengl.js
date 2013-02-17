module.exports = function(window, callback) {
	// TODO: 1) use glx api to get best visual; 2) cache
	require('child_process').exec('glxinfo -i -b', function(error, stdout, stderr) {
        if (error)
            return callback(error);
        var visual = parseInt(stdout);
        callback(null, new RenderingContextOpenGL(window, visual));
    });
}

function RenderingContextOpenGL(window, visual) {
	console.log(window);
	var X = window.X;
	console.log(window.display);
	var GLX = window.display.GLX;
	this.window = window;

    var ctx = X.AllocID();
    GLX.CreateContext(ctx, visual, 0, 0, 0);
    GLX.MakeCurrent(window.id, ctx, 0, function() {});
    var gl = GLX.renderPipeline(ctx);
    for(key in gl) {
    	if (key !== 'SwapBuffers') {
    	    var val = gl[key];
    	    if (typeof val == 'function')
    	    	this[key] = val.bind(gl);
    	    else
    	    	this[key] = val;
    	}
    }
    swapBuffers = gl.SwapBuffers;
    var id = window.id;
    this.SwapBuffers = function() { swapBuffers.call(gl, id); };
}

// register context
require('./drawable').prototype.renderingContextFactory['opengl'] = module.exports;
