var ntk = require('../lib');

async function test() {
  var app = await ntk.createClient();
  var wnd = app.createWindow({title: "Close me!", x: 100, y: 100, width: 300, height: 300});

  // await wnd.mapped(); - map() + wait for 'is visible' event

  wnd.map();

  var tree    = await wnd.tree;
  var pointer = await wnd.pointer;
  var ctx     = await wnd.getContext('2d');

  // all in parallel
  let [tree, pointer, ctx] = await [wnd.tree, wnd.pointer, wnd.getContext('2d')]

  wnd.on('mousedown', function(ev) {
    console.log(ev);
  });
}

test();
