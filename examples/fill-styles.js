var ntk = require('../lib');

ntk.createClient( (err, app) => {
  var wnd = app.createWindow({ width: 800, height: 600});
  var ctx = wnd.getContext('2d');

  var text = 'This-is-Test\u2038 test';

  var lastx = 0;
  var lasty = 0;

  wnd.on('expose', (ev) => {
    ctx.fillStyle = 'white';
    ctx.fillRect(ev.x, ev.y, ev.width, ev.height, 1, 0.5, 0.5, 1);
    ctx.font = "190px 'Times New Roman'";
    var w = ctx.measureText(text).width;
    ctx.fillStyle = ctx.createLinearGradient(0, 0, w, 100)
      .addColorStop(0, 'red')
      .addColorStop(1, 'blue'); 
    ctx.fillStyle = 'rgba(200, 200, 180, 0.7)';
    ctx.fillText(text, 750 - w, 250);
  });
  var shift = 0;
  wnd.on('keydown', function(ev) {
    if (ev.codepoint == 8)
      text = text.slice(0, -1);
    else if (ev.codepoint)
      text = text + String.fromCodePoint(ev.codepoint);

    wnd.emit('expose', { x: 0, y: 0, width: 1000, height: 1000});
  });
  wnd.on('mousemove', function(ev) {
    lastx = ev.x;
    lasty = ev.y;
    wnd.emit('expose', { x: 0, y: 0, width: 1000, height: 1000});
  });
  wnd.map();
});

