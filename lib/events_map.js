var x11 = require('x11');

// todo: move event names to node-x11, it should be part of event object
var eventIdToName = module.exports.eventName = [];
eventIdToName[2]  = 'keydown';
eventIdToName[3]  = 'keyup';
eventIdToName[4]  = 'mousedown';
eventIdToName[5]  = 'mouseup';
eventIdToName[6]  = 'mousemove';
eventIdToName[12] = 'expose';
eventIdToName[12] = 'destroy';
eventIdToName[20] = 'map_request';
eventIdToName[22] = 'resize';
eventIdToName[23] = 'configure_request';

// event mask you need to select to receive event
module.exports.mask = {
	'mousedown': x11.eventMask.PointerMotion,
	'mousemove': x11.eventMask.PointerMotion,
	'mouseover': x11.eventMask.EnterWindow,
	'mouseout': x11.eventMask.LeaveWindow,
	'mousedown': x11.eventMask.ButtonPress,
	'mouseup': x11.eventMask.ButtonRelease,
	'resize': x11.eventMask.StructureNotify,
	'keydown': x11.eventMask.KeyPress,
	'expose': x11.eventMask.Exposure,
	'map_request': x11.eventMask.SubstructureRedirect,
	'configure_request': x11.eventMask.SubstructureRedirect,
	'destroy': x11.eventMask.SubstructureNotify,
	'keyup': x11.eventMask.KeyRelease
};
