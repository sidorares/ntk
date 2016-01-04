var util = require('util');
var Drawable = require('./drawable');
var xevents = require('./events_map');
var x11 = require('x11');

module.exports = Window;

function Window(app, args)
{
    if (args.id) {
        var cached = Window.cache[args.id];
        if (cached)
            return cached;
    }
    if (this.constructor !== Window)
      return new Window(app, args);

    Drawable.call(this);

	  // shortcuts
    var X = app.X;
    this.X = X
    this.app = app;
    var display = app.display;
    this.display = display;
    var self = this;

    this.width = args.width ? args.width : 800;
    this.height = args.height ? args.height : 800;
    this.x = args.x ? args.x : 0;
    this.y = args.y ? args.y : 0;

    var parent, parentId;

    if (!args.parent)
       parentId = display.screen[0].root;
    else {
       parentId = args.parent.id;
    }

    if (!args.id) {
      this.id = X.AllocID();
      this.eventMask = x11.eventMask.StructureNotify;
      X.CreateWindow(this.id, parentId, this.x, this.y, this.width, this.height,
        0, 0, 0, 0,
        {eventMask: this.eventMask}
      );
    } else {
      this.id = args.id;
    }

    Window.cache[this.id] = this;

    if (args.title) {
      this.setTitle(args.title);
    }

    X.event_consumers[this.id] = this;
    this.on('event', function(ev) {
      var ntkev = ev; // todo: clone
      ntkev.window = this;
      var eventName = xevents.eventName[ev.type];
      if (eventName) {
        if (eventName == 'keydown') {
          var evKeysym = X.keycode2keysyms[ev.keycode];
          var shift = ev.buttons & 1;
          var capsLock = ev.buttons & 2;
          var capital = (capsLock && ( !shift )) || (shift && !capsLock)
          var keysym = require('keysym');
          var symInd = capital ? 1 : 0; // TODO: AltGr & other modifiers to use syms 2, 3, 4 etc
          var entry = keysym.fromKeysym(evKeysym[symInd]);
          console.log('=======', entry, ev.keycode, evKeysym);
          if (entry) {
            ev.codepoint = entry.unicode;
          }
        }
        this.emit(eventName, ntkev);
      } else
        console.log("Unknown event: ", ev);
    });
    this.on('child-event', function(ev) {
      console.log('CHILD EVENT', ee);
    })

    this.on('newListener', function(name) {
      // check eventMask and add handler if missing
      var eventMask = xevents.mask[name];
      if ( (eventMask & self.eventMask) == 0) {
        self.eventMask |= eventMask;
        X.ChangeWindowAttributes(self.id, { eventMask: this.eventMask}, function() {});
      }
    });

    var wnd = this;
    this.on('resize', function(ev) {
      wnd.width = ev.width;
      wnd.height = ev.height;
      wnd.x = ev.x;
      wnd.y = ev.y;
    });
}
util.inherits(Window, Drawable);

Window.cache = [];

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

Window.prototype.queryTree = function(callback) {
  var app = this.app;
  this.X.QueryTree(this.id, function(err, tree) {
    if (err)
      return callback(err);
    var children = tree.children.map(function(id) { return new Window(app, {id: id} )});;
    var parent = new Window(app, {id: tree.parent});
    // note that this root may be different from app.rootWindow() because there can be multiple screens (and roots)
    var root = new Window(app, {id: tree.root});
    callback(null, { parent: parent, root: root, children: children});
  });
  return this;
}

Window.prototype.createPixmap = function(params) {
  var Pixmap   = require('../lib/pixmap.js');
  var pixmapParams = Object.assign({}, params);
  pixmapParams.parent = pixmapParams.parent || this;
  pixmapParams.width  = pixmapParams.width || this.width;
  pixmapParams.height = pixmapParams.height || this.height;
  // TODO: use window depth
  pixmapParams.depth  = pixmapParams.depth || 32;
  return new Pixmap(this.app, pixmapParams);
}
