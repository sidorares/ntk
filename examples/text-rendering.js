var ntk = require('../lib');
var Pixmap   = require('../lib/pixmap.js');

ntk.createClient(main);

function main(err, app) {
  var wnd = app.createWindow({}).map();
  var pixmap = new Pixmap(app, {parent: wnd, depth: 32, width: 1800, height: 1800});
  debugger
  var ctx  = pixmap.getContext('2d');
  var ctx1 = wnd.getContext('2d');

  var shadow  = ctx.createSolidPicture(0, 0, 0, 0.1);
  var black  = ctx.createSolidPicture(0, 0, 0, 0.9);

  /*
  //TODO
  var grad = ctx.createLinearGradient(0,0,200,0);
  grad.addColorStop(0, 1, 0, 0, 1);
  grad.addColorStop(0.5, 0, 1, 0, 1);
  grad.addColorStop(1, 0, 0, 1, 1);
  */

  //var glyphs = ctx.loadFont('/Library/Fonts/Arial.ttf', 32, 96, 96);
  var glyphs = ctx.loadFont('/Library/Fonts/Times New Roman Italic.ttf', 92, 96, 96);
  ctx.setFont(glyphs);

  wnd.on('mousemove', function(ev) {
    console.log(ev.x, ev.y);
    ctx.fillRect(0, 0, 1000, 1000, 1, 1, 1, 1)
    ctx.setBackground(shadow);
    ctx.fillText(process.argv[2], ev.x - 2, ev.y + 5);
    ctx.setBackground(black);
    ctx.fillText(process.argv[2], ev.x, ev.y);

    ctx1.draw(ctx);
  });
}
