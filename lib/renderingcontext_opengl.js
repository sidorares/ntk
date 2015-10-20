module.exports = function(window, visual) {
	// TODO: 1) use glx api to get best visual; 2) cache
	//require('child_process').exec('glxinfo -i -b', function(error, stdout, stderr) {
  var gl = new RenderingContextOpenGL(window, visual);
  return gl;
}

function RenderingContextOpenGL(window, visual) {

    var X = window.X;
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

    this.CreateGLXPixmap = function(pixmapId) {
      var glxpixmapId = X.AllocID();
      GLX.CreateGLXPixmap(0, visual, pixmapId, glxpixmapId);
      return glxpixmapId;
    };
    this.BindTexImage = function(pixmap, buffer) {
      GLX.BindTexImage(ctx, pixmap, buffer);
    };
}

// register context
require('./drawable').prototype.renderingContextFactory['opengl'] = module.exports;
