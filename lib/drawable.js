var EventEmitter = require('events').EventEmitter;
var util = require('util');

module.exports = Drawable;

function Drawable() {
    EventEmitter.call(this);
}
util.inherits(Drawable, EventEmitter);

Drawable.prototype.renderingContextFactory = {};

Drawable.prototype.getContext = function(name, arg1, arg2, arg3) {
	var renderingContextFactory = this.renderingContextFactory[name];
	if (!renderingContextFactory)
		throw new Error('Unknown rendering context:', name);
  return renderingContextFactory(this, arg1, arg2, arg3);
}
