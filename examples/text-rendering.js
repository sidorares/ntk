var ntk = require('../lib');
var Pixmap   = require('../lib/pixmap.js');
//var Picture  = require('../lib/picture.js');


ntk.createClient(main);

function main(err, app) {
  var wnd = app.createWindow({}).map();
  var pixmap = new Pixmap(app, {parent: wnd, depth: 32, width: 1800, height: 1800});
  var ctx  = pixmap.getContext('2d');
  var ctx1 = wnd.getContext('2d');

  //var shadow  = ctx.createSolidPicture(0, 0, 0, 0.1);
  //var shadow = ctx.createRadialGradient(400, 200, 400, 200, 800, 100);
  var shadow = ctx.createConicalGradient(100, 100, 45);

  shadow.addColorStop(0,    [1, 0, 0, 1]);
//  shadow.addColorStop(0.25, [1, 0, 1, 1]);
  shadow.addColorStop(0.5,  [1, 1, 0, 1]);
//  shadow.addColorStop(0.75, [1, 1, 0, 1]);
  shadow.addColorStop(1,    [1, 0, 0, 1]);

  //var black   = ctx.createSolidPicture1();
  //var black = ctx.createRadialGradient(0, 0, 10, 10, 0, 400);
  var black = ctx.createLinearGradient(0, 0, 100, 500);
  black.addColorStop(0,   [1, 0, 0, 0.1]);
  black.addColorStop(0.5, [0, 1, 0, 0.5]);
  black.addColorStop(1,   [0, 0, 1, 0.5]);

  //var glyphs = ctx.loadFont('/Library/Fonts/Times New Roman Italic.ttf', 120, 96, 96);
  //ctx.setFont(glyphs);


  wnd.on('mousemove', function(ev) {
    console.log(ev.x, ev.y);
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, 1000, 1000, 1, 1, 1, 1)
    ctx.fillStyle = 'black'
    ctx.font = `bold italic 40pt "${process.argv[2]}"`;
    ctx.fillText(process.argv[3], ev.x - 2, ev.y);
    ctx1.drawImage(ctx, 0, 0);
  });
}
