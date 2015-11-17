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
          display.client.require('render', function(err, Render) {
            // we prelod Render and GLX
            display.Render = Render;
            display.GLX = GLX;
            var X = display.client;

            var keysyms = require('x11/lib/keysyms');
            var ks2name = {};
            for (var k in keysyms)
              ks2name[keysyms[k].code] = keysyms[k].description;
            var kk2name = {};

            function updateKeyboardMapping(min, max) {
              X.GetKeyboardMapping(min, max-min, function(err, list) {
                for (var i=0; i < list.length; ++i) {
                  var name = kk2name[i+min] = [];
                  var sublist = list[i];
                  for (var j =0; j < sublist.length; ++j)
                    name.push({ code: sublist[j], description: ks2name[sublist[j]]});
                  X.kkToName = kk2name;
                }
              });
            }
            X.on('event', function(ev) {
              // MappingNotify
              if (ev.type == 34) {
                updateKeyboardMapping(ev.firstKeyCode, ev.firstKeyCode + count);
              }
            });
            updateKeyboardMapping(display.min_keycode, display.max_keycode);
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
