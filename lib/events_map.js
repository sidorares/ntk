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
// FocusIn/FocusOut: keyboard focus arriving at or leaving this window,
// usually because the window manager moved it
eventName[9] = 'focus';
eventName[10] = 'blur';
eventName[12] = 'expose';
// CreateNotify: a child window appeared under a parent we watch. Carries a
// `parent` field, so it arrives as a child-event like the *_request ones.
eventName[16] = 'create';
eventName[17] = 'destroy';
eventName[18] = 'unmap';
eventName[19] = 'map';
eventName[20] = 'map_request';
eventName[21] = 'reparent';
eventName[22] = 'resize';
eventName[23] = 'configure_request';
eventName[24] = 'gravity';
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
  focus: x11.eventMask.FocusChange,
  blur: x11.eventMask.FocusChange,
  expose: x11.eventMask.Exposure,
  map_request: x11.eventMask.SubstructureRedirect,
  configure_request: x11.eventMask.SubstructureRedirect,
  circulate_request: x11.eventMask.SubstructureRedirect,
  // a child window appeared under a window we watch — the one
  // SubstructureNotify event with its own name, because the rest
  // (map/unmap/destroy/resize/reparent of a child) are the same event types
  // a window gets about itself and are emitted on the child's own wrapper
  create: x11.eventMask.SubstructureNotify,
  gravity: x11.eventMask.StructureNotify,
  circulate: x11.eventMask.StructureNotify,
  resize_request: x11.eventMask.ResizeRedirect,
  destroy: x11.eventMask.StructureNotify,
  keyup: x11.eventMask.KeyRelease,
  property: x11.eventMask.PropertyChange,
  selection: 0,
  selection_request: 0,
  message: 0
};

// events that are noisy by nature: intermediate occurrences carry no
// information the final one doesn't, so Window merges bursts into a single
// event per paced frame (see docs/window.md). 'last' — the newest event
// wins (older ones ride along in ev.coalesced); 'union' — damage
// rectangles accumulate (bounding box in ev.x/y/width/height, every rect
// in ev.rects).
export const coalesce = {
  mousemove: 'last',
  resize: 'last',
  expose: 'union'
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
  onFocus: 'focus',
  onBlur: 'blur',
  onExpose: 'expose',
  onMapRequest: 'map_request',
  onConfigureRequest: 'configure_request',
  onCirculateRequest: 'circulate_request',
  onCreate: 'create',
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

export default { eventName, mask, maskCamelCase, toSnake, coalesce };
