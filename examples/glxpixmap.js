var ntk = require('../lib');
var Pixmap = require('../lib/pixmap');

ntk.createClient(function(err, app) {
  var wnd = app.createWindow({title: "Close me!", x: 100, y: 100, width: 300, height: 300});
  wnd.map();
  var xpixmap = new Pixmap(app, {parent: wnd, width: 512, height: 512, depth: 24});
  wnd.getContext('opengl', function(err, gl) {
    var pixmap = gl.CreateGLXPixmap(xpixmap);
    console.log('gl.BindTexImage(', pixmap.id, 0x20DE );
    //gl.BindTexImage(pixmap.id, 0x20DE);
  });
});
