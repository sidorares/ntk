var util = require('util');
var Drawable = require('./drawable');
var xevents = require('./events_map');

module.exports = Window;

function Window(app, args)
{
	Drawable.call(this);
	// shortcuts
    var X = app.X;
    this.X = X;
    var display = app.display;
    this.display = display;
    var self = this;

    this.width = args.width ? args.width : 100;
    this.height = args.height ? args.height : 100;
    this.y = args.y ? args.y : 0;
    this.y = args.y ? args.y : 0;

    var parent, parentId;

    if (!args.parent)
       parentId = display.screen[0].root;
    else {
       parentId = args.parent.id;
    }

    if (!args.id) {
      this.id = X.AllocID();
      this.eventMask = 0;
      X.CreateWindow(this.id, parentId, this.x, this.y, this.width, this.height,
        0, 0, 0, 0,
        {eventMask: this.eventMask}
      );
    } else {
      this.id = args.id;
    }
    if (args.title) {
        this.setTitle(args.title);
    }

    X.on('error', console.log);

    X.event_consumers[this.id] = this;
    this.on('event', function(ev) {
        var ntkev = ev; // todo: clone
        ntkev.window = this;
        var eventName = xevents.eventName[ev.type];
        if (eventName)
            this.emit(eventName, ntkev);
        else
            console.log("Unknown event: ", ev);
    });

    this.on('newListener', function(name) {
        // check eventMask and add handler if missing
        var eventMask = xevents.mask[name];
        if ( (eventMask & self.eventMask) == 0) {
            self.eventMask |= eventMask;
            X.ChangeWindowAttributes(self.id, { eventMask: this.eventMask}, function() {});
        }
    });
}
util.inherits(Window, Drawable);

Window.prototype.map = function() {
    this.X.MapWindow(this.id);
    return this;
}
Window.prototype.unmap = function() {
    this.X.UnmapWindow(this.id);
    return this;
}

Window.prototype.resize = function(w, h) {
    this.X.ResizeWindow(this.id, w, h);
    return this;
}

Window.prototype.move = function(x, y) {
    this.X.MoveWindow(this.id, x, y);
    return this;
}

Window.prototype.setTitle = function(title) {
    this.X.ChangeProperty(0, this.id, this.display.client.atoms.WM_NAME, this.display.client.atoms.STRING, 8, title);
    return this;
}

Window.prototype.setMouseHintOnly = function(isOn) {
    if (isOn && !(this.eventMask & x11.eventMask.PointerMotionHint )) {
        this.eventMask |= x11.eventMask.PointerMotionHint;

    } else if (!isOn && (this.eventMask & x11.eventMask.PointerMotionHint )) {
        this.eventMask -= x11.eventMask.PointerMotionHint;
    } else
        return this;
    this.X.ChangeWindowAttributes(this.id, { eventMask: this.eventMask}, function() {});
    return this;
}

Window.prototype.queryPointer = function(callback) {
    this.X.QueryPointer(this.id, callback);
    return this;
};