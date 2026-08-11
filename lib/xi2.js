/**
 * XI2 (X Input Extension 2) device events: what to select, how to turn one
 * into an ntk event, and the per-device bookkeeping a scroll delta needs.
 *
 * The core protocol flattens every input device onto one virtual pointer and
 * one virtual keyboard, and reports a wheel as a click of button 4/5/6/7. A
 * touchpad's two-finger scroll therefore reaches a core client as a series of
 * whole notches, which is why nothing built on core X can scroll smoothly.
 * XI2 carries the same gesture as a *valuator*: an absolute accumulator per
 * scroll axis, whose difference between two events is the distance scrolled,
 * in units of the axis' `increment` (one notch).
 *
 * Three facts shape everything here:
 *
 * 1. **Valuators are absolute.** A delta is `(now - before) / increment`, so
 *    the first event from a device has nothing to subtract from and must seed
 *    rather than report — otherwise the first scroll of a session jumps by
 *    however far the axis had travelled before the window existed.
 * 2. **A device's axes are described once, not per event.** Which valuator is
 *    the vertical scroll axis, and what one notch of it is worth, comes from
 *    `XIQueryDevice`'s `Scroll` classes. They change under a master device
 *    when the user switches from a mouse to a touchpad, which is what
 *    `XIDeviceChanged` announces — and that also resets the accumulators.
 * 3. **Selecting XI2 turns off core delivery.** The server delivers an event
 *    to a client once: an XI2 selection on a window suppresses the core
 *    events of the same types *for that client on that window*. So a window
 *    that selects XI2 Motion stops receiving core MotionNotify, and this
 *    module has to reproduce the core-shaped event ntk consumers already
 *    listen for.
 */

/**
 * XI2 event types ntk can deliver, and the ntk event each becomes.
 *
 * Only the types node-x11 decodes into fields are here. The rest —
 * Enter/Leave, FocusIn/FocusOut, HierarchyChanged, the barriers — arrive with
 * their bodies undecoded (`ev.data`), and selecting one would suppress the
 * core event that *is* decoded in exchange for nothing.
 */
export const xi2EventName = {
  Motion: 'mousemove',
  ButtonPress: 'mousedown',
  ButtonRelease: 'mouseup',
  KeyPress: 'keydown',
  KeyRelease: 'keyup',
  TouchBegin: 'touchstart',
  TouchUpdate: 'touchmove',
  TouchEnd: 'touchend'
};

/**
 * What `xi2: true` selects: the pointer, which is what smooth scrolling
 * needs. Keyboard and touch are opt-in by name — a window that selects XI2
 * KeyPress takes on decoding it (and loses the core KeyPress it was getting).
 */
export const DEFAULT_XI2_EVENTS = ['Motion', 'ButtonPress', 'ButtonRelease'];

// XIScrollClass.scrollType
const SCROLL_VERTICAL = 1;

// XIPointerEventFlags.PointerEmulated: this button event is the server's
// rendering of a scroll axis into a wheel click, for clients that cannot read
// valuators. Both halves of the scroll are sent, so a client that reads the
// axis has to drop this one or count every notch twice.
export const POINTER_EMULATED = 1 << 16;

/** Wheel buttons in the core protocol: up, down, left, right. */
export const WHEEL_BUTTONS = { 4: [0, -1], 5: [0, 1], 6: [-1, 0], 7: [1, 0] };

/**
 * Check a list of XI2 event-type names, and say what a caller can ask for.
 *
 * The failure this catches is a silent one: an unknown name reaches
 * `XISelectEvents` as `undefined` and throws from node-x11 naming a bit
 * position, and a *known* name ntk cannot decode (`Enter`) would select
 * happily and then deliver nothing anyone can read.
 *
 * @param {string[]|string} types
 * @returns {string[]}
 */
export function normalizeXI2Types(types) {
  const list = typeof types === 'string' ? [types] : Array.from(types ?? []);
  for (const name of list) {
    if (xi2EventName[name]) continue;
    const known = Object.keys(xi2EventName).join(', ');
    throw new Error(
      `ntk: selectXI2 cannot deliver '${name}'. Supported XI2 event types: ${known}. ` +
        (name?.startsWith?.('Raw')
          ? 'Raw events carry no window and are only sent for selections on the root, ' +
            'so they are not routed to a window — read them off app.X directly.'
          : 'Other XI2 events arrive with their bodies undecoded, and selecting one ' +
            'would suppress the core event carrying the same information.')
    );
  }
  return list;
}

/**
 * The scroll axes of one device, from its `XIQueryDevice` classes:
 * valuator number -> `{ vertical, increment }`.
 *
 * A device with no scroll class (a plain wheel mouse on an old driver, a
 * tablet) yields an empty map, and everything below then leaves scrolling to
 * the emulated buttons.
 */
export function scrollAxes(device) {
  const axes = new Map();
  for (const cls of device?.classes ?? []) {
    // ClassType.Scroll
    if (cls.type !== 3) continue;
    if (!cls.increment) continue; // an axis one of whose notches is 0 long
    axes.set(cls.number, {
      vertical: cls.scrollType === SCROLL_VERTICAL,
      increment: cls.increment
    });
  }
  return axes;
}

/**
 * Per-device scroll accumulators.
 *
 * Keyed by the *source* device as well as the master, because a master
 * pointer's valuators are whatever its last-used slave put there: switching
 * from the touchpad to the mouse continues the numbering with an unrelated
 * value, and subtracting across that switch is the same jump as subtracting
 * from zero.
 */
export class ScrollTracker {
  constructor() {
    this._last = new Map();
  }

  /** Forget a device's axes: the next event from it seeds again. */
  reset(deviceId) {
    for (const key of this._last.keys()) {
      if (key.startsWith(`${deviceId}:`)) this._last.delete(key);
    }
  }

  /**
   * The scroll an event's valuators describe, or null when it carries no
   * scroll axis and is therefore about something else (a pointer move).
   *
   * `moved` distinguishes a scroll from the first event of one: the seeding
   * event carries a scroll axis — so it is not a pointer move and must not be
   * reported as one — but has nothing to subtract from and so no distance to
   * report. Distances are in notches, fractional, positive down and right
   * (the direction a DOM `wheel` event calls positive).
   *
   * @param {object} ev a decoded XI2 device event
   * @param {Map<number, {vertical: boolean, increment: number}>} axes
   * @returns {{deltaX: number, deltaY: number, moved: boolean}|null}
   */
  delta(ev, axes) {
    if (!axes?.size) return null;
    let deltaX = 0;
    let deltaY = 0;
    let scrolled = false;
    let moved = false;
    for (const [number, axis] of axes) {
      const value = ev.valuators?.[number];
      if (value === undefined) continue;
      scrolled = true;
      const key = `${ev.deviceId}:${ev.sourceId}:${number}`;
      const previous = this._last.get(key);
      this._last.set(key, value);
      // seeding: an absolute accumulator says nothing on its own
      if (previous === undefined || value === previous) continue;
      moved = true;
      // a negative increment is how a device declares its axis inverted, and
      // dividing by it puts the delta back in the natural direction
      const notches = (value - previous) / axis.increment;
      if (axis.vertical) deltaY += notches;
      else deltaX += notches;
    }
    return scrolled ? { deltaX, deltaY, moved } : null;
  }
}

/**
 * The core `state` field, rebuilt from an XI2 event.
 *
 * ntk hands this to consumers as `ev.buttons` and to the keyboard decoder as
 * the layout group, both of which predate XI2 and read the core bit layout:
 * modifiers in bits 0-7, buttons 1-5 in bits 8-12, the XKB group in 13-14.
 * XI2 splits the same information three ways, and reports buttons as a list.
 */
export function coreState(ev) {
  let state = (ev.mods?.effective ?? 0) & 0xff;
  for (const button of ev.buttons ?? []) {
    if (button >= 1 && button <= 5) state |= 1 << (7 + button);
  }
  state |= ((ev.group?.effective ?? 0) & 3) << 13;
  return state;
}

// Core event codes, so a translated event answers `ev.type` the way the event
// it stands in for would.
const coreType = {
  mousemove: 6,
  mousedown: 4,
  mouseup: 5,
  keydown: 2,
  keyup: 3
};

/**
 * An XI2 device event in the shape ntk delivers.
 *
 * Core-compatible where the two overlap — a handler written against
 * `mousedown` cannot tell the difference — with the XI2 extras alongside:
 * `deviceId`/`sourceId`, the sub-pixel `preciseX`/`preciseY` that FP1616
 * coordinates carry and the integer `x`/`y` cannot, and the raw `valuators`.
 */
export function toNtkEvent(name, ev) {
  const out = {
    type: coreType[name] ?? ev.type,
    name: ev.name,
    xi2: true,
    time: ev.time,
    root: ev.root,
    wid: ev.wid,
    child: ev.child,
    // core X reports integer coordinates; keep that the delivered contract and
    // put the precision XI2 adds next to it rather than in place of it
    x: Math.round(ev.x),
    y: Math.round(ev.y),
    rootx: Math.round(ev.rootx),
    rooty: Math.round(ev.rooty),
    preciseX: ev.x,
    preciseY: ev.y,
    preciseRootX: ev.rootx,
    preciseRootY: ev.rooty,
    buttons: coreState(ev),
    buttonsDown: ev.buttons,
    deviceId: ev.deviceId,
    sourceId: ev.sourceId,
    flags: ev.flags,
    valuators: ev.valuators,
    sameScreen: 1
  };
  // `detail` is the keycode, the button number or the touch id, depending;
  // core X calls the first two `keycode`, and ntk documents them under that
  if (name === 'touchstart' || name === 'touchmove' || name === 'touchend') {
    out.touchId = ev.detail;
  } else {
    out.keycode = ev.detail;
  }
  return out;
}

/**
 * A `wheel` event: `deltaX`/`deltaY` in notches, positive down and right.
 *
 * Notches rather than pixels, because a notch is the only unit the device
 * agrees on — `increment` is defined as the value that makes one — and how
 * many pixels one is worth is the consumer's line height, not ours. A
 * touchpad reports fractions of one, which is the whole point: `smooth` says
 * whether this delta came from a device that can, so a consumer can decide
 * whether to animate the scroll or snap it.
 *
 * @param {string} source 'valuator' (XI2 scroll axes) or 'button' (4-7)
 */
export function wheelEvent(base, deltaX, deltaY, source) {
  return {
    // `type` stays that of the X event this was derived from — a button press
    // or a motion — because a wheel has no core event code of its own
    ...base,
    name: 'wheel',
    deltaX,
    deltaY,
    deltaMode: 'line',
    smooth: source === 'valuator',
    source
  };
}

export default {
  xi2EventName,
  DEFAULT_XI2_EVENTS,
  POINTER_EMULATED,
  WHEEL_BUTTONS,
  normalizeXI2Types,
  scrollAxes,
  ScrollTracker,
  coreState,
  toNtkEvent,
  wheelEvent
};
