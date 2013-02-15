var x11 = require('x11');
var EventEmitter = require('events').EventEmitter;
var util = require('util');

module.exports.createClient = function(main) {
    x11.createClient(function(error, display) {
        if (error)
            return main(error, null);
        display.client.require('glx', function(glx) {
          display.GLX = glx;
          var app = new App(display);
          main(null, app);
        });
    });
};

function App(display, glx) {
    this.display = display;
    this.display.X = display.client;
}

App.prototype.createWindow = function(args) {
    return new Window(this.display, args);
}

function Window(display, args)
{
    var X = display.client;
    this.display = display;
    this.width = args.width ? args.width : 100;
    this.height = args.height ? args.height : 100;
    this.y = args.y ? args.y : 0;
    this.y = args.y ? args.y : 0;

    var parent, parentId;

    if (!args.parent)
       parentId = this.display.screen[0].root;
    else {
       parentId = args.parent.id;
    }

    if (!args.id) {
      this.id = X.AllocID();
      this.eventMask = 0; //x11.eventMask.PointerMotion|x11.eventMask.Exposure;
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
        // translate to ntk event and re-emit
        // console.log(ev);
        var ntkev = ev;
        ntkev.window = this;
        switch(ev.type) {
            case 2:
                this.emit('keydown', ntkev);
                break;
            case 3:
                this.emit('keyup', ntkev);
                break;
            case 6:
                this.emit('mousemove', ntkev);
                break;
            case 4:
                this.emit('mousedown', ntkev);
                break;
            case 5:
                this.emit('mouseup', ntkev);
                break;
            case 22:
                this.emit('resize', ntkev);
                break;
            default:
                console.log(ev);
        }
    });

    var name2mask = {
        'mousedown': x11.eventMask.PointerMotion,
        'mousemove': x11.eventMask.PointerMotion,
        'mouseover': x11.eventMask.EnterWindow,
        'mouseout': x11.eventMask.LeaveWindow,
        'mousedown': x11.eventMask.ButtonPress,
        'mouseup': x11.eventMask.ButtonRelease,
        'resize': x11.eventMask.StructureNotify,
        'keydown': x11.eventMask.KeyPress,
        'keyup': x11.eventMask.KeyRelease
    };

    this.on('newListener', function(name) {
        // check eventMask and add handler if missing
        var eventMask = name2mask[name];
        if ( (eventMask & this.eventMask) == 0) {
            this.eventMask |= eventMask;
            X.ChangeWindowAttributes(this.id, { eventMask: this.eventMask}, function() { console.trace(); console.log(arguments); });
            console.log('New event mask: ', this.eventMask);
        }
    });
}
util.inherits(Window, EventEmitter);

Window.prototype.map = function() {
    this.display.client.MapWindow(this.id);
    return this;
}
Window.prototype.unmap = function() {
    this.display.client.UnmapWindow(this.id);
    return this;
}

Window.prototype.resize = function(w, h) {
    this.display.client.ResizeWindow(this.id, w, h);
}

Window.prototype.move = function(x, y) {
    this.display.client.MoveWindow(this.id, x, y);
}

Window.prototype.setTitle = function(title) {
    this.display.client.ChangeProperty(0, this.id, this.display.client.atoms.WM_NAME, this.display.client.atoms.STRING, 8, title);
}

Window.prototype.setMouseHintOnly = function(isOn) {
    if (isOn && !(this.eventMask & x11.eventMask.PointerMotionHint )) {
        this.eventMask |= x11.eventMask.PointerMotionHint;

    } else if (!isOn && (this.eventMask & x11.eventMask.PointerMotionHint )) {
        this.eventMask -= x11.eventMask.PointerMotionHint;
    } else
        return;
    this.display.X.ChangeWindowAttributes(this.id, { eventMask: this.eventMask}, function() { console.trace(); console.log(arguments); });
}

Window.prototype.queryPointer = function(callback) {
    this.display.X.QueryPointer(this.id, callback);
};

Window.prototype.getContext = function(name, callback) {
    // TODO: move to external files
    var X = this.display.X;
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
