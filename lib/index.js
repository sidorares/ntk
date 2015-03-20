var x11 = require('x11');
var App = require('./app');


module.exports.createClient = function(main) {
    x11.createClient(function(error, display) {
        if (error)
            return main(error, null);
        display.client.require('glx', function(err, glx) {
          display.GLX = glx;
          var app = new App(display);
          main(null, app);
        });
    });
};

require('./renderingcontext_x11');
require('./renderingcontext_2d');
require('./renderingcontext_opengl');
