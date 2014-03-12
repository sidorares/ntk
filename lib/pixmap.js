var util = require('util');
var Drawable = require('./drawable');

module.exports = Pixmap;

function Pixmap(app, args)
{
    Drawable.call(this);
    var X = app.X;

    var parentId;
    if (!args.parent)
       parentId = app.display.screen[0].root;
    else {
       parentId = args.parent.id;
    }

    if (!args.id) {
      this.id = X.AllocID();
      X.CreatePixmap(this.id, parentId, args.depth, args.width, args.height);
    } else {
      this.id = args.id;
    }

    this.X = X;
    var display = app.display;
    this.display = display;
}
util.inherits(Pixmap, Drawable);
