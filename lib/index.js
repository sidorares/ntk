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
    this.id = X.AllocID();
    this.eventMask = 0; //x11.eventMask.PointerMotion|x11.eventMask.Exposure;
    X.CreateWindow(this.id, this.display.screen[0].root, this.x, this.y, this.width, this.height,
      0, 0, 0, 0,
      {eventMask: this.eventMask}
    );
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
            case 6:
                this.emit('mousemove', ntkev);
                break;
            case 4:
                this.emit('mousedown', ntkev);
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
        'resize': x11.eventMask.StructureNotify
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

Window.prototype.getContext = function(name) {
    switch(name) {
    case 'opengl':
        var visual = 161;
        var ctx = this.display.X.AllocID();
        this.display.GLX.CreateContext(ctx, visual, 0, 0, 0);
        this.display.GLX.MakeCurrent(this.id, ctx, 0, function() {});
        var gl = this.display.GLX.renderPipeline(ctx);
        swapBuffers = gl.SwapBuffers;
        var id = this.id;
        gl.SwapBuffers = function() { swapBuffers.call(gl, id); };
        return gl;
    }
    throw new Error('Context not supported: ' + name);
}
