var ntk = require('../lib');

ntk.createClient(main);

function main(err, app) {
  var mainwnd = app.createWindow({title: "Close me!"})
   .on('mouseout', function(ev) { console.log('Out'); })
   .on('mouseover', function(ev) { console.log('In'); })
   .on('mousedown', function(ev) {
       ev.window.unmap();
       setTimeout(function() { ev.window.map(); }, 1000);
    })
   .map();
}
