var EventEmitter = require('events').EventEmitter;
var util = require('util');
var xevents = require('./events_map');

module.exports = Window;

function Window(app, args)
{
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
util.inherits(Window, EventEmitter);

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
}

Window.prototype.move = function(x, y) {
    this.X.MoveWindow(this.id, x, y);
}

Window.prototype.setTitle = function(title) {
    this.X.ChangeProperty(0, this.id, this.display.client.atoms.WM_NAME, this.display.client.atoms.STRING, 8, title);
}

Window.prototype.setMouseHintOnly = function(isOn) {
    if (isOn && !(this.eventMask & x11.eventMask.PointerMotionHint )) {
        this.eventMask |= x11.eventMask.PointerMotionHint;

    } else if (!isOn && (this.eventMask & x11.eventMask.PointerMotionHint )) {
        this.eventMask -= x11.eventMask.PointerMotionHint;
    } else
        return;
    this.X.ChangeWindowAttributes(this.id, { eventMask: this.eventMask}, function() {});
}

Window.prototype.queryPointer = function(callback) {
    this.X.QueryPointer(this.id, callback);
};

Window.prototype.getContext = function(name, callback) {
    // TODO: move to external files
    var X = this.X;
    var self = this;
    switch(name) {
    case 'opengl':
        // get best gl visual via glxinfo. to be removed
        require('child_process').exec('glxinfo -i -b', function(error, stdout, stderr) {
            if (error)
               return callback(error);
            var visual = parseInt(stdout) + 1;
            var ctx = X.AllocID();
            console.log('VISUAL: ', visual);
            self.display.GLX.CreateContext(ctx, visual, 0, 0, 0);
            self.display.GLX.MakeCurrent(self.id, ctx, 0, function() {});
            var gl = self.display.GLX.renderPipeline(ctx);
            swapBuffers = gl.SwapBuffers;
            var id = self.id;
            gl.SwapBuffers = function() { swapBuffers.call(gl, id); };
            callback(null, gl);
        });
        break;
    case '2d':
        var ctx = {};
        if (!self.gc) {
            self.gc = X.AllocID();
            X.CreateGC(self.gc, self.id);
        }
        ctx.putImageData = function(data, x, y) {
            X.PutImage(2, self.id, self.gc, data.width, data.height, x, y, 0, 24, data.data);
        }
        return callback(null, ctx);
        break;
    default:
        throw new Error('Context not supported: ' + name);
    }
}