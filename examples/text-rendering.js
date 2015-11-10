var ntk = require('../lib');
var Pixmap   = require('../lib/pixmap.js');

ntk.createClient(main);

function main(err, app) {
  var wnd = app.createWindow({}).map();
  var pixmap = new Pixmap(app, {parent: wnd, depth: 32, width: 1800, height: 1800});
  var ctx  = pixmap.getContext('2d');
  var ctx1 = wnd.getContext('2d');

  var shadow  = ctx.createSolidPicture(0, 0, 0, 0.1);
  var black   = ctx.createSolidPicture(0, 0, 0, 0.6);

  //var glyphs = ctx.loadFont('/Library/Fonts/Times New Roman Italic.ttf', 120, 96, 96);
  //ctx.setFont(glyphs);


  wnd.on('mousemove', function(ev) {
    ctx.fillRect(0, 0, 1000, 1000, 1, 1, 1, 1)
    ctx.setBackground(shadow);
    ctx.font = 'bold italic 40mm TimesNewRoman';
    ctx.fillText(process.argv[2], ev.x - 2, ev.y + 5);
    ctx.setBackground(black);
    ctx.font = 'bold italic 50mm CourierNew';
    ctx.fillText(process.argv[2], ev.x + 100, ev.y);
    ctx1.draw(ctx);
  });
}
