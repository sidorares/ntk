var util = require('util');
var Drawable = require('./drawable');

module.exports = Pixmap;

function Pixmap(app, args)
{
	Drawable.call(this);

    if (!args.parent)
       parentId = display.screen[0].root;
    else {
       parentId = args.parent.id;
    }

	if (!args.id) {
      this.id = X.AllocID();
      this.eventMask = 0;
      X.CreatePixmap(this.id, parentId, this.depth, this.width, this.height);
    } else {
      this.id = args.id;
    }

	// shortcuts
    var X = app.X;
    this.X = X;
    var display = app.display;
    this.display = display;
}
util.inherits(Pixmap, Drawable);