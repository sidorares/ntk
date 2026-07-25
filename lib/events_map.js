import x11 from 'x11';

// todo: move event names to node-x11, it should be part of event object
export const eventName = [];
eventName[2] = 'keydown';
eventName[3] = 'keyup';
eventName[4] = 'mousedown';
eventName[5] = 'mouseup';
eventName[6] = 'mousemove';
eventName[7] = 'mouseover';
eventName[8] = 'mouseout';
eventName[12] = 'expose';
eventName[17] = 'destroy';
eventName[18] = 'unmap';
eventName[19] = 'map';
eventName[20] = 'map_request';
eventName[21] = 'reparent';
eventName[22] = 'resize';
eventName[23] = 'configure_request';
// 25 - gravity
eventName[25] = 'resize_request';
eventName[26] = 'circulate';
eventName[27] = 'circulate_request';
eventName[28] = 'property';
eventName[29] = 'selection_clear';
eventName[30] = 'selection_request';
eventName[31] = 'selection';
eventName[33] = 'message';

// event mask you need to select to receive event
// 0 = no need to express interest, event is sent regardless of mask
export const mask = {
  mousemove: x11.eventMask.PointerMotion,
  mouseover: x11.eventMask.EnterWindow,
  mouseout: x11.eventMask.LeaveWindow,
  mousedown: x11.eventMask.ButtonPress,
  mouseup: x11.eventMask.ButtonRelease,
  map: x11.eventMask.StructureNotify,
  unmap: x11.eventMask.StructureNotify,
  resize: x11.eventMask.StructureNotify,
  reparent: x11.eventMask.StructureNotify,
  keydown: x11.eventMask.KeyPress,
  expose: x11.eventMask.Exposure,
  map_request: x11.eventMask.SubstructureRedirect,
  configure_request: x11.eventMask.SubstructureRedirect,
  destroy: x11.eventMask.StructureNotify,
  keyup: x11.eventMask.KeyRelease,
  property: x11.eventMask.PropertyChange,
  selection: 0,
  selection_request: 0,
  message: 0
};

export const toSnake = {
  onMouseMove: 'mousemove',
  onMouseOver: 'mouseover',
  onMouseOut: 'mouseout',
  onMouseDown: 'mousedown',
  onMouseUp: 'mouseup',
  onMap: 'map',
  onUnmap: 'unmap',
  onResize: 'resize',
  onReparent: 'reparent',
  onKeyDown: 'keydown',
  onExpose: 'expose',
  onMapRequest: 'map_request',
  onConfigureRequest: 'configure_request',
  onDestroy: 'destroy',
  onKeyUp: 'keyup',
  onPropertyChange: 'property',
  onSelection: 'selection',
  onSelectionRequest: 'selection_request',
  onMessage: 'message'
};

export const maskCamelCase = Object.fromEntries(
  Object.entries(toSnake).map(([camel, snake]) => [camel, mask[snake]])
);

export default { eventName, mask, maskCamelCase, toSnake };
