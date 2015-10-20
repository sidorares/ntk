var ntk = require('../lib');
var co = require('co');

co(function*() {

  var app = yield ntk.createClient();
  var wnd = app.createWindow({title: "Close me!", x: 100, y: 100, width: 300, height: 300});
  wnd.map();
  wnd.on('mousedown', function(ev) {
    console.log(ev);
  });

});
