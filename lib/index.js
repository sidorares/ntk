var Promise = require('es6-promise').Promise;
var x11 = require('x11');
var App = require('./app');


module.exports.createClient = function(main) {
  return new Promise(function(resolve, reject) {

     var callback = function(err, display) {
       if (err) {
         reject(err);
         if (main)
           return main(err);
       }
       resolve(display);
       if (main)
         return main(null, display);
     }

     x11.createClient({ debug: true }, function(error, display) {
        if (error)
          return callback(error, null);

        display.client.on('error', function(err) {
          console.log(err.longstack);
          process.exit(1);
        });

        display.client.require('glx', function(err, GLX) {
          display.client.require('Render', function(err, Render) {
            // we prelod Render and GLX
            display.Render = Render;
            display.GLX = GLX;
            var app = new App(display);
            callback(null, app);
          });
        });
    });
  });
};

require('./renderingcontext_x11');
require('./renderingcontext_2d');
require('./renderingcontext_opengl');
