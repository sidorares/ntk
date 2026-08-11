import x11 from 'x11';

import { safeRelease } from './cleanup.js';
import { EventEmitter } from './drawable.js';

// XEmbed (http://specifications.freedesktop.org/xembed/0.5/): putting one
// client's top-level window inside another client's window hierarchy, across
// toolkits. Two roles — the embedder (GTK's socket, Qt's container) and the
// client (GTK's plug) — and no X extension: core requests only.
//
// The mechanics are deliberately short. The client sets `_XEMBED_INFO` on an
// unmapped top-level window; the embedder adds that window to its save-set,
// reparents it into one of its own and says so with an `XEMBED_EMBEDDED_NOTIFY`
// ClientMessage; from then on the two sides talk in `_XEMBED` messages —
// activation, focus, modality — while the embedder keeps the client's mapped
// state in step with the `XEMBED_MAPPED` bit of `_XEMBED_INFO`.
//
// Most of the interesting clients do not speak any of it. `xterm -into WID`,
// `mpv --wid=WID`, VLC and Wine want plain reparenting and set no
// `_XEMBED_INFO` at all, so a missing property means "map it now, skip the
// message protocol" — the same thing GtkSocket does, and the path that makes a
// terminal pane or a video surface work.
//
// Two things about focus are worth knowing before reading XEmbedSocket:
//
// - The embedder holds the real X input focus; the client gets *logical* focus
//   by message. So activation and focus are things the embedder tells the
//   client about, not things the client observes.
// - Key events therefore have to be routed by hand. X delivers a key press to
//   the focus window, or to the deepest descendant of it under the pointer —
//   so with focus on the embedder's toplevel, whether the embedded client sees
//   a keystroke would depend on where the mouse happens to be. FocusProxy is
//   the classic answer: an InputOnly window that holds the real focus while
//   the client is logically focused, forwarding what it receives with
//   SendEvent.

/**
 * Protocol constants: the version, the `_XEMBED_INFO` flags, the message
 * opcodes and the details `XEMBED_FOCUS_IN` can carry.
 */
export const XEMBED = {
  /** highest protocol version this implementation speaks */
  VERSION: 0,

  // _XEMBED_INFO flags
  /** bit 0 of the flags word: the client wants to be mapped */
  MAPPED: 1 << 0,

  // opcodes (message data l[1])
  EMBEDDED_NOTIFY: 0,
  WINDOW_ACTIVATE: 1,
  WINDOW_DEACTIVATE: 2,
  REQUEST_FOCUS: 3,
  FOCUS_IN: 4,
  FOCUS_OUT: 5,
  FOCUS_NEXT: 6,
  FOCUS_PREV: 7,
  MODALITY_ON: 10,
  MODALITY_OFF: 11,
  REGISTER_ACCELERATOR: 12,
  UNREGISTER_ACCELERATOR: 13,
  ACTIVATE_ACCELERATOR: 14,

  // XEMBED_FOCUS_IN details (message data l[2])
  /** focus the client without moving its own logical focus */
  FOCUS_CURRENT: 0,
  /** a Tab arriving from outside: focus the first widget in the tab chain */
  FOCUS_FIRST: 1,
  /** a back-Tab arriving from outside: focus the last one */
  FOCUS_LAST: 2
};

/** opcode -> name, for logging and for the `'message'` events */
export const XEMBED_OPCODE_NAMES = Object.freeze({
  0: 'EMBEDDED_NOTIFY',
  1: 'WINDOW_ACTIVATE',
  2: 'WINDOW_DEACTIVATE',
  3: 'REQUEST_FOCUS',
  4: 'FOCUS_IN',
  5: 'FOCUS_OUT',
  6: 'FOCUS_NEXT',
  7: 'FOCUS_PREV',
  10: 'MODALITY_ON',
  11: 'MODALITY_OFF',
  12: 'REGISTER_ACCELERATOR',
  13: 'UNREGISTER_ACCELERATOR',
  14: 'ACTIVATE_ACCELERATOR'
});

const NAME = '_XEMBED';
const INFO = '_XEMBED_INFO';

/**
 * The two CARD32s of an `_XEMBED_INFO` property: the protocol version the
 * client speaks and its flags word.
 *
 * @param {object} [info] `{ version, flags, mapped }` — `mapped` is the
 *   XEMBED_MAPPED bit spelled out, and wins over the same bit in `flags`
 * @returns {number[]} `[version, flags]`
 */
export function encodeXEmbedInfo(info = {}) {
  const { version = XEMBED.VERSION, flags = 0, mapped } = info;
  let word = flags >>> 0;
  if (mapped !== undefined) {
    word = mapped ? word | XEMBED.MAPPED : word & ~XEMBED.MAPPED;
  }
  return [version >>> 0, word >>> 0];
}

/**
 * The inverse. `null` for a property that is absent or too short to be one —
 * which is not an error but the ordinary case: a client that speaks no XEmbed
 * sets no `_XEMBED_INFO`, and is embedded by plain reparenting.
 *
 * @param {number[]|null} words the property read `{ as: 'numbers' }`
 * @returns {{version: number, flags: number, mapped: boolean}|null}
 */
export function decodeXEmbedInfo(words) {
  if (!words || words.length < 2) return null;
  const flags = words[1] >>> 0;
  return { version: words[0] >>> 0, flags, mapped: (flags & XEMBED.MAPPED) !== 0 };
}

/** Read `_XEMBED_INFO` off a window. `null` when it is not set. */
export async function readXEmbedInfo(window) {
  const words = await window.getProperty(INFO, { as: 'numbers' }).catch(() => null);
  return decodeXEmbedInfo(words);
}

/**
 * The window that holds the real X input focus on the client's behalf, and
 * forwards keystrokes into it.
 *
 * X delivers a key press to the focus window or to the deepest descendant of
 * it that contains the pointer, so an embedder that simply focuses its own
 * toplevel would send the embedded client keys only while the mouse is over
 * it. A 1x1 InputOnly window, mapped but clipped entirely outside its parent,
 * has no descendants and covers no pixels: it can hold focus, it can never be
 * entered by the pointer, and everything it receives belongs to whoever is
 * logically focused.
 *
 * Forwarded events carry X's `send_event` flag, as any SendEvent does. Toolkit
 * clients accept them — this is how XEmbed keyboard input has always worked —
 * but a client that filters synthetic events will not see them.
 */
export class FocusProxy {
  /**
   * @param {import('./window.js').default} parent the window to create the
   *   proxy under; it must be viewable for the proxy to be able to take focus
   */
  constructor(parent) {
    this.app = parent.app;
    this.X = parent.X;
    this.target = 0;
    // -1,-1: entirely outside the parent, so the pointer can never be in it
    this.window = this.app.createWindow({
      parent,
      x: -1,
      y: -1,
      width: 1,
      height: 1,
      windowClass: 2, // InputOnly
      eventMask: x11.eventMask.KeyPress | x11.eventMask.KeyRelease
    });
    this.window.map();
    this._forward = this._forward.bind(this);
    this.window.on('keydown', this._forward);
    this.window.on('keyup', this._forward);
  }

  /**
   * Take the X input focus and forward what arrives to `windowId`.
   * @param {number} windowId
   */
  take(windowId) {
    this.target = windowId >>> 0;
    this.window.focus(2); // revert to the parent when we stop being viewable
    return this;
  }

  /** Stop forwarding. Does not move the focus — that is the embedder's call. */
  release() {
    this.target = 0;
    return this;
  }

  destroy() {
    this.target = 0;
    this.window.removeListener('keydown', this._forward);
    this.window.removeListener('keyup', this._forward);
    this.window.destroy();
  }

  _forward(ev) {
    if (!this.target) return;
    // the same event, re-addressed: `wid` is the window it is reported on and
    // `child` the descendant it happened over, neither of which survives the
    // move. Mask 0 delivers it to the window's owner whatever it selected.
    safeRelease(this.X, () =>
      this.X.SendEvent(this.target, 0, 0, { ...ev, wid: this.target, child: 0 })
    );
  }
}

/**
 * The embedder half: a container window that another client's top-level
 * window is reparented into.
 *
 *   const socket = new XEmbedSocket(parentWindow, { x, y, width, height });
 *   await socket.embed(clientWindowId);
 *
 * Events:
 *   'embedded'     `{ id, window, version, xembed }` — `xembed:false` is a
 *                  client that set no `_XEMBED_INFO` and got plain reparenting
 *   'mappedChange' `(mapped)` — the client asked to be mapped or unmapped
 *   'requestFocus' the client wants the logical focus
 *   'focusNext' / 'focusPrev' — the client ran off the end of its tab chain
 *   'message'      `{ opcode, name, detail, data1, data2, time }` — an
 *                  `_XEMBED` message this class does not act on itself
 *   'gone'         the client was destroyed or reparented away by someone else
 */
export class XEmbedSocket extends EventEmitter {
  /**
   * @param {import('./window.js').default} parent where the container window
   *   goes
   * @param {object} [options] `{ x, y, width, height }` for the container
   *   window this creates, or `{ window }` to embed into a window the caller
   *   already owns (which it also keeps responsible for destroying).
   *   `{ version }` caps the protocol version offered to the client;
   *   `{ focusOnRequest: false }` stops `XEMBED_REQUEST_FOCUS` from being
   *   answered automatically, for an embedder with a focus manager of its own.
   */
  constructor(parent, options = {}) {
    super();
    const {
      x = 0,
      y = 0,
      width = 1,
      height = 1,
      window = null,
      version = XEMBED.VERSION,
      focusOnRequest = true
    } = options;

    this.app = parent.app;
    this.X = this.app.X;
    this.version = version;
    this._focusOnRequest = focusOnRequest;
    this._ownsWindow = !window;
    /** the container window; the client becomes a child of this */
    this.window = window ?? this.app.createWindow({ parent, x, y, width, height });

    /** the embedded client, as a Window, or null */
    this.client = null;
    /** whether the client answered with `_XEMBED_INFO` */
    this.xembed = false;
    /** the protocol version in use, once a client is embedded */
    this.clientVersion = 0;
    this.active = false;
    this.focused = false;

    this._proxy = null;
    this._mapped = false;
    this._destroyed = false;
    this._infoAtom = 0;
    this._xembedAtom = 0;
    // the newest server timestamp we have seen, which is what a message
    // should carry: CurrentTime is not a timestamp and cannot arbitrate
    this._time = 0;

    this._onClientProperty = this._onClientProperty.bind(this);
    this._onClientDestroy = this._onClientDestroy.bind(this);
    this._onClientReparent = this._onClientReparent.bind(this);
    this._onMessage = this._onMessage.bind(this);
    this.window.on('message', this._onMessage);
  }

  /**
   * Take over `clientId` — a top-level window belonging to another client —
   * and put it inside this socket.
   *
   * Resolves once the client is reparented and, for a client that speaks the
   * protocol, told about it; the `'embedded'` event carries the same
   * information. Rejects if the window does not exist.
   *
   * @param {number} clientId
   * @returns {Promise<{id: number, window: object, version: number, xembed: boolean}>}
   */
  async embed(clientId) {
    if (this.client) {
      throw new Error(
        `xembed: this socket already holds window ${this.client.id}; call release() first, ` +
          'or use one socket per embedded client'
      );
    }
    if (!clientId) throw new Error('xembed: embed() needs the client window id');

    return this._attach(this.app.createWindow({ id: clientId }), true);
  }

  /**
   * Take whatever turns up as a child of this socket as the client.
   *
   * `xterm -into WID` and `mpv --wid=WID` are handed a window id and put
   * their own window inside it, so by the time you hear about them there is
   * nothing left to reparent — but everything after that (sizing, the
   * synthetic ConfigureNotify, the mapped state, `'gone'`) is the same
   * embedding. Give the program `socket.window.id` and call this:
   *
   *   const socket = new XEmbedSocket(pane, { width: 640, height: 480 });
   *   spawn('xterm', ['-into', String(socket.window.id)]);
   *   await socket.adopt();
   *
   * A child that is already there is taken immediately.
   *
   * @param {object} [options] `{ timeout }` in ms — without one this waits
   *   for as long as it takes, which is right for a program that is still
   *   starting up and wrong for one that has already failed to
   * @returns {Promise<{id: number, window: object, version: number, xembed: boolean}>}
   */
  async adopt(options = {}) {
    const { timeout = 0 } = options;
    if (this.client) {
      throw new Error(`xembed: this socket already holds window ${this.client.id}`);
    }
    if (this._ownsWindow) this.window.map();

    const child = await new Promise((resolve, reject) => {
      let timer = null;
      let done = false;
      const settle = (fn, value) => {
        if (done) return;
        done = true;
        this.window.removeListener('create', look);
        this.window.removeListener('reparent', look);
        if (timer) clearTimeout(timer);
        fn(value);
      };
      // Which event announces the window depends on how the program got it
      // there: `mpv --wid` creates it as our child (CreateNotify), `xterm
      // -into` creates a toplevel and reparents it in (ReparentNotify, which
      // also fires for a window leaving us). Rather than tell those apart,
      // ask the server what our children actually are.
      const look = () => {
        if (done) return;
        this._firstChild().then((id) => {
          if (id) settle(resolve, this.app.createWindow({ id }));
        }, () => {});
      };
      // Listen first, then look: a program racing us would otherwise fall
      // between the two, appearing after the QueryTree that found nothing and
      // before the selection that would have reported it. `on(…)` selects
      // SubstructureNotify, and requests on one connection are ordered, so by
      // the time the QueryTree is answered the selection is in force.
      this.window.on('create', look);
      this.window.on('reparent', look);
      look();
      if (timeout) {
        timer = setTimeout(() => {
          settle(
            reject,
            new Error(
              `xembed: nothing put a window inside ${this.window.id} within ${timeout}ms. ` +
                'Check that the program was given that id (xterm -into ID, mpv --wid=ID) ' +
                'and that it is talking to the same display.'
            )
          );
        }, timeout);
        timer.unref?.();
      }
    });
    return this._attach(child, false);
  }

  /** the first child of the container that is not something we made */
  _firstChild() {
    return new Promise((resolve) => {
      let asked = false;
      safeRelease(this.X, () => {
        asked = true;
        this.X.QueryTree(this.window.id, (err, tree) => {
          if (err) return resolve(0);
          resolve(tree.children.find((id) => id !== this._proxy?.window.id) ?? 0);
        });
      });
      if (!asked) resolve(0); // the connection is gone
    });
  }

  async _attach(client, reparent) {
    // PropertyChange for _XEMBED_INFO, StructureNotify for the lifecycle
    // (destroy, and a reparent that takes the client away from us). This is
    // also the round trip that says whether the window exists at all.
    await client.selectInput(x11.eventMask.PropertyChange | x11.eventMask.StructureNotify);

    const [info, infoAtom, xembedAtom] = await Promise.all([
      readXEmbedInfo(client),
      this.window.atom(INFO),
      this.window.atom(NAME)
    ]);
    if (this._destroyed) return { id: client.id, window: client, version: 0, xembed: false };

    this._infoAtom = infoAtom;
    this._xembedAtom = xembedAtom;
    this.client = client;
    this.xembed = !!info;
    // both sides speak the lower of the two versions
    this.clientVersion = info ? Math.min(this.version, info.version) : 0;

    client.on('property', this._onClientProperty);
    client.on('destroy', this._onClientDestroy);
    client.on('reparent', this._onClientReparent);

    // the client must outlive us: the save-set puts it back under the root if
    // this connection dies while it is our child, instead of taking it with us
    client.addToSaveSet();
    if (reparent) {
      // a container nobody has mapped makes the client unviewable, however
      // mapped the client itself is. One passed in as `{ window }` is the
      // caller's to map.
      if (this._ownsWindow) this.window.map();
      client.reparentTo(this.window, 0, 0);
    }
    client.moveResize(0, 0, this.window.width, this.window.height);

    if (this.xembed) {
      // data1 is the window the client has been embedded into — the one it
      // sends its own messages back to — and data2 the version in use
      this._send(XEMBED.EMBEDDED_NOTIFY, 0, this.window.id, this.clientVersion);
    }
    // A client that speaks the protocol is mapped only when it asks to be; one
    // that does not never will, so it is mapped now. A window waiting to be
    // embedded is unmapped — that is what waiting looks like — and mapping an
    // adopted one that already showed itself costs nothing.
    this._setMapped(this.xembed ? info.mapped : true);
    await this._syncConfigure();

    const embedded = {
      id: client.id,
      window: client,
      version: this.clientVersion,
      xembed: this.xembed
    };
    this.emit('embedded', embedded);
    return embedded;
  }

  /**
   * Move and resize the container, and the client with it.
   *
   * The client also gets a synthetic ConfigureNotify with root-relative
   * coordinates: its own says where it is inside our window, which is not the
   * question a client asks (ICCCM 4.1.5).
   *
   * @param {object} [geometry] `{ x, y, width, height }`; anything omitted
   *   stays as it is
   * @returns {Promise<XEmbedSocket>}
   */
  async resize(geometry = {}) {
    const win = this.window;
    const { x = win.x, y = win.y, width = win.width, height = win.height } = geometry;
    if (this._ownsWindow) {
      win.moveResize(x, y, width, height);
      win.x = x;
      win.y = y;
      win.width = width;
      win.height = height;
    }
    if (this.client && !this.client._destroyed) {
      this.client.moveResize(0, 0, width, height);
      await this._syncConfigure(width, height);
    }
    return this;
  }

  /**
   * Tell the client whether the toplevel it lives in is the active window
   * (`XEMBED_WINDOW_ACTIVATE` / `XEMBED_WINDOW_DEACTIVATE`). A client starts
   * out inactive, so this only has to be called when that changes.
   *
   * @param {boolean} [active]
   * @param {object} [options] `{ time }` — the server timestamp of the event
   *   that caused this
   */
  activate(active = true, options = {}) {
    if (this.active === !!active) return this;
    this.active = !!active;
    this._send(active ? XEMBED.WINDOW_ACTIVATE : XEMBED.WINDOW_DEACTIVATE, 0, 0, 0, options);
    return this;
  }

  /** `activate(false)`. */
  deactivate(options = {}) {
    return this.activate(false, options);
  }

  /**
   * Give the client the logical focus (`XEMBED_FOCUS_IN`) and start routing
   * keystrokes into it.
   *
   * @param {number} [detail] `XEMBED.FOCUS_CURRENT` (a click: focus the client
   *   without disturbing which of its widgets is focused),
   *   `XEMBED.FOCUS_FIRST` or `XEMBED.FOCUS_LAST` (a Tab or back-Tab arriving
   *   from outside)
   * @param {object} [options] `{ time }`
   */
  focusIn(detail = XEMBED.FOCUS_CURRENT, options = {}) {
    if (!this.client) return this;
    this.focused = true;
    this._send(XEMBED.FOCUS_IN, detail, 0, 0, options);
    this._ensureProxy().take(this.client.id);
    return this;
  }

  /** Take the logical focus away again (`XEMBED_FOCUS_OUT`). */
  focusOut(options = {}) {
    if (!this.focused) return this;
    this.focused = false;
    this._proxy?.release();
    this._send(XEMBED.FOCUS_OUT, 0, 0, 0, options);
    return this;
  }

  /**
   * Turn a modality shield on or off (`XEMBED_MODALITY_ON` / `_OFF`): the
   * client should stop responding to input because the embedder has put up a
   * modal dialog somewhere else.
   */
  modality(on = true, options = {}) {
    this._send(on ? XEMBED.MODALITY_ON : XEMBED.MODALITY_OFF, 0, 0, 0, options);
    return this;
  }

  /**
   * Send a raw `_XEMBED` message. Everything above is a wrapper over this;
   * it is here for the opcodes ntk does not model (the accelerator ones).
   */
  send(opcode, detail = 0, data1 = 0, data2 = 0, options = {}) {
    this._send(opcode, detail, data1, data2, options);
    return this;
  }

  /**
   * Hand the client back: reparent it to the root, drop it from our save-set
   * and stop watching it. It becomes an ordinary top-level window again, at
   * the position it occupied on screen, which is what "unplugging" means for
   * `xterm -into` and for GtkSocket alike.
   *
   * @returns {Promise<XEmbedSocket>}
   */
  async release() {
    const client = this.client;
    if (!client) return this;
    this._detach();
    if (client._destroyed) return this;

    const { x, y } = await this._rootCoords();
    // stop selecting events on a window that is no longer ours before the
    // reparent, so its ReparentNotify does not come back to us
    safeRelease(this.X, () => {
      client.eventMask = 0;
      this.X.ChangeWindowAttributes(client.id, { eventMask: 0 }, () => {});
    });
    client.reparentTo(this.app.rootWindow(), x, y);
    client.removeFromSaveSet();
    return this;
  }

  /**
   * Release the client, then drop the container window and the focus proxy.
   * A container passed in as `{ window }` belongs to the caller and is left
   * alone.
   */
  async destroy() {
    if (this._destroyed) return this;
    this._destroyed = true;
    await this.release();
    this.window.removeListener('message', this._onMessage);
    this._proxy?.destroy();
    this._proxy = null;
    if (this._ownsWindow) this.window.destroy();
    return this;
  }

  // -------------------------------------------------------------------

  _ensureProxy() {
    if (!this._proxy) this._proxy = new FocusProxy(this.window);
    return this._proxy;
  }

  _send(opcode, detail = 0, data1 = 0, data2 = 0, options = {}) {
    if (!this.client || this.client._destroyed) return;
    const { time = this._time } = options;
    this.client
      .sendClientMessage(this._xembedAtom || NAME, [time, opcode, detail, data1, data2])
      .catch((err) => this.app.options?.onXError?.(err));
  }

  _setMapped(mapped) {
    if (this._mapped === !!mapped) return;
    this._mapped = !!mapped;
    if (!this.client || this.client._destroyed) return;
    if (this._mapped) this.client.map();
    else this.client.unmap();
    this.emit('mappedChange', this._mapped);
  }

  /** where the container's origin is on the root window */
  async _rootCoords() {
    const root = this.app.display.screen[0].root;
    return new Promise((resolve) => {
      safeRelease(this.X, () =>
        this.X.TranslateCoordinates(this.window.id, root, 0, 0, (err, res) =>
          resolve(err ? { x: 0, y: 0 } : { x: res.destX, y: res.destY })
        )
      );
    });
  }

  async _syncConfigure(width = this.window.width, height = this.window.height) {
    const client = this.client;
    if (!client || client._destroyed) return;
    const { x, y } = await this._rootCoords();
    if (client._destroyed) return;
    client.sendConfigureNotify({ x, y, width, height });
  }

  _onMessage(ev) {
    if (!this._xembedAtom || ev.message_type !== this._xembedAtom) return;
    const [time, opcode, detail, data1, data2] = ev.data;
    if (time) this._time = time >>> 0;
    switch (opcode) {
      case XEMBED.REQUEST_FOCUS:
        this.emit('requestFocus');
        // the client saying the user clicked it. An embedder with its own
        // focus manager turns this off and calls focusIn() itself.
        if (this._focusOnRequest) this.focusIn(XEMBED.FOCUS_CURRENT);
        break;
      case XEMBED.FOCUS_NEXT:
        this.emit('focusNext');
        break;
      case XEMBED.FOCUS_PREV:
        this.emit('focusPrev');
        break;
      default:
        this.emit('message', {
          opcode,
          name: XEMBED_OPCODE_NAMES[opcode],
          detail,
          data1,
          data2,
          time
        });
    }
  }

  _onClientProperty(ev) {
    if (ev.atom !== this._infoAtom) return;
    if (ev.time) this._time = ev.time >>> 0;
    // state 1 is Delete. The spec has no meaning for a client withdrawing the
    // property mid-embedding, so the mapped state it last asked for stands.
    if (ev.state === 1) return;
    readXEmbedInfo(this.client).then(
      (info) => {
        if (info) this._setMapped(info.mapped);
      },
      () => {}
    );
  }

  _onClientDestroy() {
    this._detach();
    this.emit('gone');
  }

  _onClientReparent(ev) {
    // ours is the reparent *into* the socket; anything else is the client
    // being taken away from us
    if (ev.parent === this.window.id) return;
    this._detach();
    this.emit('gone');
  }

  /** forget the client without touching it — it is gone, or no longer ours */
  _detach() {
    const client = this.client;
    if (!client) return;
    client.removeListener('property', this._onClientProperty);
    client.removeListener('destroy', this._onClientDestroy);
    client.removeListener('reparent', this._onClientReparent);
    this.client = null;
    this.xembed = false;
    this.clientVersion = 0;
    this.active = false;
    this.focused = false;
    this._mapped = false;
    this._proxy?.release();
  }
}

/**
 * The client half: a top-level window that offers itself to be embedded.
 *
 *   const plug = new XEmbedPlug(app, { width: 300, height: 200 });
 *   await plug.ready;
 *   console.log(plug.window.id); // hand this to the embedder
 *
 * The window is deliberately left unmapped — an embedder maps it, once it has
 * reparented it and read `XEMBED_MAPPED` out of `_XEMBED_INFO`. Draw into
 * `plug.window` as usual.
 *
 * Events:
 *   'embedded'   `(embedderId)` — reparented into someone else's window
 *   'activate' / 'deactivate' — the toplevel we are inside became (in)active
 *   'focusIn'    `(detail)` — one of `XEMBED.FOCUS_CURRENT/FIRST/LAST`
 *   'focusOut'
 *   'modality'   `(on)`
 *   'message'    `{ opcode, name, detail, data1, data2, time }` — anything
 *                this class does not model
 *   'released'   reparented back to the root: the protocol is over
 */
export class XEmbedPlug extends EventEmitter {
  /**
   * @param {import('./app.js').default} app
   * @param {object} [options] `{ version, mapped }` — the two words of
   *   `_XEMBED_INFO` — plus `{ window }` to adopt a window instead of
   *   creating one. Anything else is passed to `app.createWindow()`.
   */
  constructor(app, options = {}) {
    super();
    const { version = XEMBED.VERSION, mapped = true, window = null, ...windowArgs } = options;

    this.app = app;
    this.X = app.X;
    this.version = version >>> 0;
    /** the window to draw into; its id is what an embedder needs */
    this.window = window ?? app.createWindow(windowArgs);
    this._ownsWindow = !window;

    /** the embedder's window id, or 0 while free-standing */
    this.embedder = 0;
    this._embedderWindow = null;
    /** whether the embedder speaks the message protocol */
    this.xembed = false;
    this.active = false;
    this.focused = false;
    this.modal = false;
    this._mapped = !!mapped;
    this._embedded = false;
    this._xembedAtom = 0;
    this._destroyed = false;

    this._onMessage = this._onMessage.bind(this);
    this._onReparent = this._onReparent.bind(this);
    this.window.on('message', this._onMessage);
    this.window.on('reparent', this._onReparent);

    /**
     * Resolves once `_XEMBED_INFO` is on the window — which is what has to be
     * true before its id is given to anyone.
     * @type {Promise<XEmbedPlug>}
     */
    this.ready = this._publish().then(() => this);
  }

  /** The `XEMBED_MAPPED` bit: whether the embedder should map us. */
  get mapped() {
    return this._mapped;
  }

  /**
   * Ask the embedder to map or unmap us. An embedder may leave us unmapped
   * while the bit is set (a tab that is not the current one), but must unmap
   * promptly when it clears.
   * @returns {Promise<XEmbedPlug>}
   */
  async setMapped(mapped) {
    this._mapped = !!mapped;
    await this._publish();
    return this;
  }

  /**
   * Ask for the logical focus (`XEMBED_REQUEST_FOCUS`) — what a client sends
   * when the user clicks it. The embedder answers with `XEMBED_FOCUS_IN`, or
   * does not.
   */
  requestFocus() {
    return this._send(XEMBED.REQUEST_FOCUS);
  }

  /**
   * Hand the focus back to the embedder because we ran off the end of our own
   * tab chain: it moves on to its next (or previous) widget.
   */
  focusNext() {
    return this._send(XEMBED.FOCUS_NEXT);
  }

  /** @see focusNext */
  focusPrev() {
    return this._send(XEMBED.FOCUS_PREV);
  }

  /** Send a raw `_XEMBED` message to the embedder. */
  send(opcode, detail = 0, data1 = 0, data2 = 0, options = {}) {
    return this._send(opcode, detail, data1, data2, options);
  }

  /** Stop listening, and destroy the window if this created it. */
  destroy() {
    if (this._destroyed) return this;
    this._destroyed = true;
    this.window.removeListener('message', this._onMessage);
    this.window.removeListener('reparent', this._onReparent);
    if (this._ownsWindow) this.window.destroy();
    return this;
  }

  // -------------------------------------------------------------------

  async _publish() {
    if (!this._xembedAtom) this._xembedAtom = await this.window.atom(NAME);
    await this.window.setProperty(
      INFO,
      encodeXEmbedInfo({ version: this.version, mapped: this._mapped }),
      // the property's type is its own name — that is what the spec says it
      // is, not CARDINAL
      { type: INFO, format: 32 }
    );
    return this;
  }

  _send(opcode, detail = 0, data1 = 0, data2 = 0, options = {}) {
    if (!this.embedder) return this;
    const { time = 0 } = options;
    // A client's messages go to the embedder's window, and name it: in both
    // directions the message is about the window it is delivered to, so mask
    // 0 hands it to that window's owner whatever it selected.
    if (this._embedderWindow?.id !== this.embedder) {
      this._embedderWindow = this.app.createWindow({ id: this.embedder });
    }
    this._embedderWindow
      .sendClientMessage(this._xembedAtom || NAME, [time, opcode, detail, data1, data2])
      .catch((err) => this.app.options?.onXError?.(err));
    return this;
  }

  _onReparent(ev) {
    const root = this.app.display.screen[0].root;
    if (ev.parent === root) {
      if (!this._embedded) return;
      // spec step 5: back under the root ends the protocol
      this._embedded = false;
      this.embedder = 0;
      this._embedderWindow = null;
      this.xembed = false;
      this.active = this.focused = this.modal = false;
      this.emit('released');
      return;
    }
    this.embedder = ev.parent;
    if (this._embedded) return;
    this._embedded = true;
    // An XEmbed-aware embedder sends XEMBED_EMBEDDED_NOTIFY straight after
    // the reparent, so `xembed` and `version` are worth reading on the next
    // turn rather than inside this handler; an embedder that only reparents
    // (xterm -into, mpv --wid) sends nothing and leaves them as they are.
    this.emit('embedded', this.embedder);
  }

  _onMessage(ev) {
    if (!this._xembedAtom || ev.message_type !== this._xembedAtom) return;
    const [time, opcode, detail, data1, data2] = ev.data;
    switch (opcode) {
      case XEMBED.EMBEDDED_NOTIFY:
        this.xembed = true;
        // data1 is the embedder's window; older embedders leave it 0 and the
        // ReparentNotify is then the only source
        if (data1) this.embedder = data1 >>> 0;
        this.version = Math.min(this.version, data2 >>> 0);
        if (!this._embedded && this.embedder) {
          this._embedded = true;
          this.emit('embedded', this.embedder);
        }
        break;
      case XEMBED.WINDOW_ACTIVATE:
        this.active = true;
        this.emit('activate');
        break;
      case XEMBED.WINDOW_DEACTIVATE:
        this.active = false;
        this.emit('deactivate');
        break;
      case XEMBED.FOCUS_IN:
        this.focused = true;
        this.emit('focusIn', detail);
        break;
      case XEMBED.FOCUS_OUT:
        this.focused = false;
        this.emit('focusOut');
        break;
      case XEMBED.MODALITY_ON:
      case XEMBED.MODALITY_OFF:
        this.modal = opcode === XEMBED.MODALITY_ON;
        this.emit('modality', this.modal);
        break;
      default:
        this.emit('message', {
          opcode,
          name: XEMBED_OPCODE_NAMES[opcode],
          detail,
          data1,
          data2,
          time
        });
    }
  }
}

export default { XEMBED, XEmbedSocket, XEmbedPlug, FocusProxy };
