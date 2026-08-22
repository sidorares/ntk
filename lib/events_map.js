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
  // not an X event of its own: Window derives it from the PropertyNotify for
  // _NET_WM_STATE, so it needs the same mask a 'property' listener does
  statechange: x11.eventMask.PropertyChange,
  // also derived: a wheel is a click of button 4-7 in the core protocol, and
  // a scroll valuator under XI2 (see lib/xi2.js). ButtonPress covers the core
  // half; the XI2 half is opt-in per window and selects itself
  wheel: x11.eventMask.ButtonPress,
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
  expose: 'union',
  // DamageNotify is the expose case again — a burst of rectangles whose
  // union is what a repaint wants — reported about a drawable's content
  // instead of a window's visibility
  damage: 'union',
  // 'accumulate' — scroll distance adds up. Keeping the last delta instead
  // would throw away everything but the final step of a fast scroll, and a
  // frame's worth of a touchpad's sub-notch deltas is exactly the case the
  // smooth-scroll path exists for.
  wheel: 'accumulate'
};

// XFixes SelectionNotify subtype -> why the ownership changed, the same
// vocabulary clipboard.watch already answers in. The codes are fixed by
// xfixesproto (SelectionEvent), not assigned by the server.
const selectionReason = ['new-owner', 'destroyed', 'closed'];

// ShapeNotify kind -> which of the window's three shapes changed
// (shapeproto ShapeKind)
const shapeKind = ['bounding', 'clip', 'input'];

/**
 * The non-generic extension events, and how to deliver them.
 *
 * Unlike core events their type codes are assigned by the server at
 * QueryExtension time (`ext.firstEvent` + a fixed offset), and the drawable
 * each one names arrives under the field its own protocol calls it —
 * DamageNotify a `drawable`, the others a `window` — never under the `wid`
 * node-x11 dispatches per-window consumers by. So they need both halves of
 * this table: a name, and which field to route by. App reads it when an
 * extension is required through its accessors (`app.damage()` and friends)
 * and hands each event to the Window or Pixmap it names — see
 * App#_routeExtensionEvents and docs/app.md "Extension events".
 *
 * Keyed by node-x11's module name, then by the event's key in `ext.events`.
 * `translate` shapes the raw node-x11 event into the one delivered.
 */
export const extension = {
  damage: {
    DamageNotify: {
      name: 'damage',
      target: 'drawable',
      // expose-shaped, because it is the same news: the box in
      // x/y/width/height so 'union' coalescing applies to it unchanged.
      // Bit 7 of the level byte is the wire's own "more follow" flag —
      // split out, since the report level it rides on is 0..3.
      translate: (ev) => ({
        x: ev.area.x,
        y: ev.area.y,
        width: ev.area.w,
        height: ev.area.h,
        geometry: ev.geometry,
        damage: ev.damage,
        level: ev.level & 0x7f,
        more: !!(ev.level & 0x80),
        time: ev.time
      })
    }
  },
  fixes: {
    // 'selection' is taken — it is core SelectionNotify, a conversion
    // answered — and this event is about who owns the selection, hence the
    // qualified name
    SelectionNotify: {
      name: 'selection_owner',
      target: 'window',
      translate: (ev) => ({
        selection: ev.selection,
        owner: ev.owner,
        reason: selectionReason[ev.subtype] ?? ev.subtype,
        timestamp: ev.timestamp,
        selectionTimestamp: ev.selectionTimestamp
      })
    },
    CursorNotify: {
      name: 'cursor',
      target: 'window',
      translate: (ev) => ({
        cursorSerial: ev.cursorSerial,
        cursorName: ev.cursorName,
        time: ev.timestamp
      })
    }
  },
  shape: {
    ShapeNotify: {
      name: 'shape',
      target: 'window',
      translate: (ev) => ({
        kind: shapeKind[ev.kind] ?? ev.kind,
        x: ev.x,
        y: ev.y,
        width: ev.width,
        height: ev.height,
        shaped: !!ev.shaped,
        time: ev.time
      })
    }
  }
};

// every routed extension event name — what a Pixmap watches `newListener`
// for to enrol itself in the routing table (see lib/pixmap.js)
export const extensionEventNames = new Set(
  Object.values(extension).flatMap((events) => Object.values(events).map((spec) => spec.name))
);

export const toSnake = {
  onMouseMove: 'mousemove',
  onMouseOver: 'mouseover',
  onMouseOut: 'mouseout',
  onMouseDown: 'mousedown',
  onMouseUp: 'mouseup',
  onWheel: 'wheel',
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

export default { eventName, mask, maskCamelCase, toSnake, coalesce, extension, extensionEventNames };
