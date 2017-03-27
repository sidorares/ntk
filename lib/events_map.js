var x11 = require('x11');

// todo: move event names to node-x11, it should be part of event object
var eventIdToName = module.exports.eventName = [];
eventIdToName[2]  = 'keydown';
eventIdToName[3]  = 'keyup';
eventIdToName[4]  = 'mousedown';
eventIdToName[5]  = 'mouseup';
eventIdToName[6]  = 'mousemove';
eventIdToName[12] = 'expose';
eventIdToName[17] = 'destroy';
eventIdToName[18] = 'unmap';
eventIdToName[19] = 'map';
eventIdToName[20] = 'map_request';
eventIdToName[21] = 'reparent';
eventIdToName[22] = 'resize';
eventIdToName[23] = 'configure_request';
// 25 - gravity
eventIdToName[25] = 'resize_request';
eventIdToName[26] = 'circulate';
eventIdToName[27] = 'circulate_request';
eventIdToName[28] = 'property';
eventIdToName[29] = 'selection_clear';
eventIdToName[30] = 'selection_request';
eventIdToName[31] = 'selection';
eventIdToName[33] = 'message';

// event mask you need to select to receive event
// 0 = no need to express interest, event is sent regardless of mask
module.exports.mask = {
	'mousemove': x11.eventMask.PointerMotion,
	'mouseover': x11.eventMask.EnterWindow,
	'mouseout': x11.eventMask.LeaveWindow,
	'mousedown': x11.eventMask.ButtonPress,
	'mouseup': x11.eventMask.ButtonRelease,
	'map'  : x11.eventMask.StructureNotify,
	'unmap': x11.eventMask.StructureNotify,
	'resize': x11.eventMask.StructureNotify,
  'reparent': x11.eventMask.StructureNotify,
	'keydown': x11.eventMask.KeyPress,
	'expose': x11.eventMask.Exposure,
	'map_request': x11.eventMask.SubstructureRedirect,
	'configure_request': x11.eventMask.SubstructureRedirect,
	'destroy': x11.eventMask.StructureNotify,
	'keyup': x11.eventMask.KeyRelease,
	'property': x11.eventMask.PropertyChange,
	'selection': 0,
	'selection_request': 0,
	'message': 0
};

module.exports.maskCamelCase = {
	'onMouseMove': x11.eventMask.PointerMotion,
	'onMouseOver': x11.eventMask.EnterWindow,
	'onMouseOut': x11.eventMask.LeaveWindow,
	'onMouseDown': x11.eventMask.ButtonPress,
	'onMouseUp': x11.eventMask.ButtonRelease,
	'onMap'  : x11.eventMask.StructureNotify,
	'onUnmap': x11.eventMask.StructureNotify,
	'onResize': x11.eventMask.StructureNotify,
  'onReparent': x11.eventMask.StructureNotify,
	'onKeyDown': x11.eventMask.KeyPress,
	'onExpose': x11.eventMask.Exposure,
	'onMapRequest': x11.eventMask.SubstructureRedirect,
	'onConfigureRequest': x11.eventMask.SubstructureRedirect,
	'onDestroy': x11.eventMask.StructureNotify,
	'onKeyUp': x11.eventMask.KeyRelease,
	'onPropertyChange': x11.eventMask.PropertyChange,
	// TODO
	'onSelection': 0,
	'onSelectionRequest': 0,
	'onMessage': 0
};

module.exports.toSnake = {
	'onMouseMove': 'mousemove',
	'onMouseOver': 'over',
	'onMouseOut': 'mouseout',
	'onMouseDown': 'mousedown',
	'onMouseUp': 'mouseup',
	'onMap'  : 'map',
	'onUnmap': 'unmap',
	'onResize': 'resize',
  'onReparent': 'reparent',
	'onKeyDown': 'keydown',
	'onExpose': 'expose',
	'onMapRequest': 'map_request',
	'onConfigureRequest': 'configure_request',
	'onDestroy': 'destroy',
	'onKeyUp': 'keyup',
	'onPropertyChange': 'property',
	// TODO
	'onSelection': 'selection',
	'onSelectionRequest': 'selection_request',
	'onMessage': 'message'
};
