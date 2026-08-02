import x11 from 'x11';

import { safeRelease } from './cleanup.js';

// Clipboard (app.clipboard): ICCCM selection transfer.
//
// X has no clipboard buffer — "copy" means owning a selection atom
// (CLIPBOARD for explicit copy/paste, PRIMARY for middle-click paste) and
// answering conversion requests from whoever pastes; "paste" means asking
// the current owner to convert into a property on one of our windows. This
// module hides that dance behind write()/read() promises, using a hidden
// 1x1 never-mapped helper window as the selection endpoint.
//
// As an owner, ntk answers the three targets ICCCM 2.6.2 makes mandatory
// (TARGETS, TIMESTAMP, MULTIPLE) plus whatever the caller offered: a string
// is served as UTF8_STRING and STRING (latin-1, best effort), an object maps
// target names to payloads, so HTML, images and — later — XDND drags are the
// same machinery. Payloads larger than one request are transferred
// incrementally (INCR, ICCCM 2.7.2), in both directions.
//
// Reads prefer UTF8_STRING and retry once with STRING when the owner
// refuses (old Xt/Motif apps).

const DEFAULT_TIMEOUT = 2000;
// An INCR transfer we are feeding is driven entirely by the requestor: each
// chunk goes out in answer to its property deletion. A requestor that stops
// (or dies mid-paste) would otherwise leave us holding its payload and an
// event mask on its window forever, so give up after this much silence.
const INCR_TIMEOUT = 10000;
// node-x11 writes ChangeProperty's length field as a CARD16 — only PutImage
// emits the BIG-REQUESTS extended form — so a request can never exceed
// 65535 four-byte units however much the server allows.
const REQUEST_UNITS_LIMIT = 0xffff;

const isBinary = (value) => ArrayBuffer.isView(value) || value instanceof ArrayBuffer;

// payload bytes for one target: text is UTF-8 (latin-1 for STRING, which is
// defined as latin-1), binary is taken as-is
const encodePayload = (value, name) => {
  if (typeof value === 'string') return Buffer.from(value, name === 'STRING' ? 'latin1' : 'utf8');
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value))
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new TypeError(`clipboard: the ${name} payload must be a string or binary data`);
};

export default class Clipboard {
  constructor(app) {
    this.app = app;
    this.X = app.X;
    this._window = null; // hidden helper window, created on first use
    this._owned = new Map(); // selection atom -> { time, targets }
    this._atoms = null; // { TARGETS, TIMESTAMP, MULTIPLE, ATOM_PAIR, UTF8_STRING, INCR }
    this._transferProp = null; // property reads are converted into
    this._timeProp = null; // property the server-timestamp trick appends to
    this._transfers = new Map(); // `requestor:property` -> INCR transfer we feed
    this._watched = new Map(); // requestor wid -> { count, mask } while feeding
    this._transferLimit = null; // bytes one ChangeProperty can carry
    this._incrTimeout = INCR_TIMEOUT;
    this._ready = null;
    this._readQueue = Promise.resolve();
    this._fixes = null; // XFixes extension, required on first watch()
    this._fixesFirstEvent = -1; // its event base, to recognise its events
    this._selectionWatchers = new Map(); // selection atom -> { name, handlers }
    this._onXEvent = this._onXEvent.bind(this);
  }

  /**
   * Take ownership of a selection and serve `data` to anyone who pastes.
   * Resolves once the server confirms the ownership; ownership (and the
   * data) is held until another client copies or the app closes.
   *
   * `data` is either a string — offered as UTF8_STRING and STRING — or an
   * object (or Map) from target name to payload, which is how richer
   * formats are published:
   *
   *   await app.clipboard.write({
   *     'text/plain;charset=utf-8': 'hello',
   *     'text/html': '<b>hello</b>',
   *     'image/png': pngBuffer
   *   });
   *
   * String payloads are encoded UTF-8 (latin-1 for the STRING target);
   * Buffers/TypedArrays are served as-is. TARGETS, TIMESTAMP and MULTIPLE
   * are answered by ntk itself and cannot be offered as data.
   *
   * @param {string|object|Map} data
   * @param {object} [options] { selection: 'CLIPBOARD' (default) or
   *   'PRIMARY' (middle-click paste) — any selection atom name works;
   *   time: the server timestamp of the event that triggered the copy
   *   (ICCCM 2.1). Without one ntk asks the server for the current time
   *   rather than using CurrentTime, which ICCCM forbids }
   * @returns {Promise<void>}
   */
  async write(data, { selection = 'CLIPBOARD', time } = {}) {
    await this._ensure();
    const [sel, targets] = await Promise.all([this._atom(selection), this._encode(data)]);
    // ICCCM 2.1: never CurrentTime. The timestamp of the event that
    // triggered the copy is the right one — it is what arbitrates a race
    // with another app copying at the same moment. Without one, "now" is
    // still a real timestamp, and one no server will reject as stale.
    const stamp = time === undefined ? await this._serverTime() : time >>> 0;
    this._owned.set(sel, { time: stamp, targets });
    this.X.SetSelectionOwner(this._window.id, sel, stamp);
    // SetSelectionOwner is void: confirm via GetSelectionOwner that the
    // server actually made us the owner (it ignores a stale timestamp)
    const owner = await new Promise((resolve, reject) =>
      this.X.GetSelectionOwner(sel, (err, wid) => (err ? reject(err) : resolve(wid)))
    );
    if (owner !== this._window.id) {
      this._owned.delete(sel);
      throw new Error(`clipboard: failed to acquire ${selection} selection ownership`);
    }
  }

  /**
   * Give a selection back: stop owning it, and stop answering for it.
   *
   *   await app.clipboard.clear();                 // CLIPBOARD
   *   await app.clipboard.clear('XdndSelection');  // at the end of a drag
   *
   * The counterpart to `write()`, which otherwise holds a selection until
   * another client takes it or the app exits. Two things want this: a drag
   * source, which should stop offering its payload once the drag is over
   * (a stale offer answered later is exactly what XDND's "throw out
   * extremely old data" rule is about), and apps that clear the clipboard
   * on purpose — a password manager, say.
   *
   * Clearing a selection this app does not own does nothing, and in
   * particular sends nothing: `SetSelectionOwner(None)` from a non-owner
   * would take the selection away from whoever legitimately holds it.
   *
   * A transfer already in flight still completes — an INCR transfer keeps
   * its own copy of the payload (ICCCM 2.7.2), the same as when another
   * client takes the selection from us.
   *
   * @param {string} [selection] selection atom name, default 'CLIPBOARD'
   * @returns {Promise<void>}
   */
  async clear(selection = 'CLIPBOARD') {
    // nothing has ever been written, so nothing can be owned: answer
    // without interning an atom or creating the helper window
    if (!this._owned.size) return;
    const sel = await this._atom(selection);
    const entry = this._owned.get(sel);
    if (!entry) return;
    this._owned.delete(sel);
    // ICCCM 2.3.1: release with the timestamp the selection was acquired
    // with, not a fresh one. A SetSelectionOwner is ignored when its time is
    // earlier than the selection's current last-change time, so the old
    // stamp is what makes this lose to a client that has taken the selection
    // since — where a fresh one would take it away from them.
    this.X.SetSelectionOwner(0, sel, entry.time);
    // The server answers the release with a SelectionClear addressed to the
    // helper window; _onXEvent deletes an _owned entry that is already gone,
    // which is harmless.
    //
    // GetSelectionOwner here is a barrier, not a check: requests are
    // buffered (one socket write per frame) and it is a reply that forces
    // the flush, so without it the release could still be sitting in our
    // output buffer when the caller's next await resumes. Whoever owns the
    // selection afterwards is not our business — we only promised to stop
    // being the owner.
    await new Promise((resolve, reject) =>
      this.X.GetSelectionOwner(sel, (err) => (err ? reject(err) : resolve()))
    );
  }

  /**
   * Read the current text of a selection from whoever owns it.
   * Rejects when the selection has no owner, when the owner supports
   * neither UTF8_STRING nor STRING, or when the owner stops responding
   * (`timeout` ms, default 2000).
   *
   * @param {object} [options] { selection: 'CLIPBOARD' | 'PRIMARY' | ...,
   *   timeout: ms to wait for the owner at each protocol step;
   *   target: one named target, returned as bytes, instead of text;
   *   time: the server timestamp of the event that asked for the paste
   *   (ICCCM 2.4) — see `targets()` for why it is worth passing }
   * @returns {Promise<string|Buffer>}
   */
  read({ selection = 'CLIPBOARD', timeout = DEFAULT_TIMEOUT, target, time } = {}) {
    return this._serialize(() =>
      target === undefined
        ? this._read(selection, timeout, time)
        : this._readTarget(selection, target, timeout, time)
    );
  }

  /**
   * What the current owner of a selection can convert to, as target names.
   *
   *   const offered = await app.clipboard.targets();
   *   if (offered.includes('image/png')) { ... }
   *
   * This is the question to ask before `read({ target })`: an owner answers
   * `TARGETS` cheaply, where guessing costs a failed conversion per guess.
   * Returns `[]` when nothing owns the selection.
   *
   * `time` is the timestamp of the event that asked for the data. ICCCM 2.4
   * says to pass it rather than CurrentTime, so that an owner which has
   * since replaced its data can tell that the request is for the older
   * value; XDND makes it binding, since a drop must convert with the
   * timestamp from its `XdndDrop` message. Omitting it means CurrentTime,
   * which every mainstream owner accepts and a strict one may not.
   *
   * @param {object} [options] { selection, timeout, time }
   * @returns {Promise<string[]>}
   */
  targets({ selection = 'CLIPBOARD', timeout = DEFAULT_TIMEOUT, time } = {}) {
    return this._serialize(() => this._targets(selection, timeout, time));
  }

  /** Concurrent conversions would share the one transfer property on the
   * helper window, so let each finish before the next starts. */
  _serialize(run) {
    const result = this._readQueue.then(run, run);
    this._readQueue = result.catch(() => {});
    return result;
  }

  async _targets(selection, timeout, time) {
    await this._ensure();
    const sel = await this._atom(selection);
    const prop = this._transferProp;
    const notify = await this._convert(sel, this._atoms.TARGETS, prop, selection, timeout, time);
    if (notify.property === 0) return [];
    const { data, format } = await this._fetchProperty(prop, selection, timeout);
    // an INCR reassembly reports no format, and a target list is far too
    // small to arrive that way — so only a stated non-32 format disqualifies
    if (format !== undefined && format !== 32) return [];
    const atoms = [];
    for (let o = 0; o + 4 <= data.length; o += 4) atoms.push(data.readUInt32LE(o));
    const names = await Promise.all(atoms.map((atom) => this._atomName(atom)));
    return names.filter(Boolean);
  }

  /**
   * Read one named target, as bytes. The mirror of writing one: what
   * `write({ 'image/png': buf })` publishes, this is how another ntk app
   * gets it back.
   */
  async _readTarget(selection, target, timeout, time) {
    await this._ensure();
    const sel = await this._atom(selection);
    const atom = await this._atom(target);
    const prop = this._transferProp;
    const notify = await this._convert(sel, atom, prop, selection, timeout, time);
    if (notify.property === 0) {
      const owner = await new Promise((resolve, reject) =>
        this.X.GetSelectionOwner(sel, (err, wid) => (err ? reject(err) : resolve(wid)))
      );
      throw new Error(
        owner
          ? `clipboard: ${selection} selection owner cannot convert to ${target}`
          : `clipboard: nothing to paste — ${selection} selection has no owner`
      );
    }
    const { data } = await this._fetchProperty(prop, selection, timeout);
    return data;
  }

  _atomName(atom) {
    return new Promise((resolve) =>
      this.X.GetAtomName(atom, (err, name) => resolve(err ? null : name))
    );
  }

  async _read(selection, timeout, time) {
    await this._ensure();
    const X = this.X;
    const sel = await this._atom(selection);
    const prop = this._transferProp;

    let notify = await this._convert(sel, this._atoms.UTF8_STRING, prop, selection, timeout, time);
    if (notify.property === 0) {
      // property None: no owner, or the owner refused UTF8_STRING (old
      // Xt/Motif apps) — ask again for latin-1 STRING before giving up.
      // Same timestamp: this is a retry of one paste, not a second one.
      notify = await this._convert(sel, X.atoms.STRING, prop, selection, timeout, time);
    }
    if (notify.property === 0) {
      const owner = await new Promise((resolve, reject) =>
        X.GetSelectionOwner(sel, (err, wid) => (err ? reject(err) : resolve(wid)))
      );
      throw new Error(
        owner
          ? `clipboard: ${selection} selection owner refused both UTF8_STRING and STRING targets`
          : `clipboard: nothing to paste — ${selection} selection has no owner`
      );
    }
    const { type, data } = await this._fetchProperty(prop, selection, timeout);
    return data.toString(type === X.atoms.STRING ? 'latin1' : 'utf8');
  }

  // lazily create the helper window, resolve atoms, hook selection events
  _ensure() {
    if (this._ready) return this._ready;
    this._ready = (async () => {
      // 1x1 and never mapped: selection ownership and transfer properties
      // need a window id, not visible pixels. PropertyChange is in the
      // creation mask so INCR chunk notifications arrive without a later
      // ChangeWindowAttributes round-trip.
      this._window = this.app.createWindow({
        width: 1,
        height: 1,
        eventMask: x11.eventMask.PropertyChange
      });
      const [TARGETS, TIMESTAMP, MULTIPLE, ATOM_PAIR, UTF8_STRING, INCR, transferProp, timeProp] =
        await Promise.all(
          [
            'TARGETS',
            'TIMESTAMP',
            'MULTIPLE',
            'ATOM_PAIR',
            'UTF8_STRING',
            'INCR',
            'NTK_SELECTION',
            'NTK_TIME'
          ].map((name) => this._atom(name))
        );
      this._atoms = { TARGETS, TIMESTAMP, MULTIPLE, ATOM_PAIR, UTF8_STRING, INCR };
      this._transferProp = transferProp;
      this._timeProp = timeProp;
      // SelectionRequest/SelectionClear carry the owner in ev.owner, not
      // ev.wid, so node-x11's event_consumers routing (keyed on ev.wid)
      // never delivers them to the Window wrapper — listen on the raw
      // client instead. INCR chunk pacing needs PropertyNotify for the
      // requestor's window, which is not ours either.
      this.X.on('event', this._onXEvent);
    })();
    return this._ready;
  }

  /**
   * Call `handler` whenever a selection changes hands.
   *
   *   const unwatch = await app.clipboard.watch('CLIPBOARD', (ev) => {
   *     pasteItem.disabled = ev.owner === 0;
   *   });
   *   unwatch();
   *
   * The alternative is polling `read()`, which is a full conversion round
   * trip against whatever foreign client owns the selection — and a two
   * second wait when that client is wedged. This is a server-side
   * subscription instead: the server tells us, and it costs nothing until
   * something actually changes.
   *
   * `ev` is `{ selection, owner, timestamp, selectionTimestamp, reason }`,
   * where `reason` is `'new-owner'` when someone took the selection,
   * `'destroyed'` when the owning window went away, and `'closed'` when the
   * owning client disconnected. `owner` is 0 when the selection ends up
   * unowned, which is the case an edit menu wants: nothing to paste.
   *
   * Watchers share one server-side registration per selection, so watching
   * the same selection twice costs one extra callback and no extra protocol.
   *
   * @param {string} selection selection atom name, e.g. 'CLIPBOARD' or 'PRIMARY'
   * @param {function} handler called with the event
   * @returns {Promise<function>} call it to stop watching
   */
  async watch(selection, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('clipboard: watch needs a handler function');
    }
    await this._ensure();
    const fixes = await this._ensureFixes();
    const sel = await this._atom(selection);

    let entry = this._selectionWatchers.get(sel);
    if (!entry) {
      entry = { name: selection, handlers: new Set() };
      this._selectionWatchers.set(sel, entry);
      const mask =
        fixes.SelectionEventMask.SetSelectionOwner |
        fixes.SelectionEventMask.SelectionWindowDestroy |
        fixes.SelectionEventMask.SelectionClientClose;
      safeRelease(this.X, () => fixes.SelectSelectionInput(this._window.id, sel, mask));
    }
    entry.handlers.add(handler);

    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      const current = this._selectionWatchers.get(sel);
      if (!current) return;
      current.handlers.delete(handler);
      if (current.handlers.size) return;
      // last watcher for this selection: drop the server-side registration
      this._selectionWatchers.delete(sel);
      safeRelease(this.X, () => fixes.SelectSelectionInput(this._window.id, sel, 0));
    };
  }

  /** XFixes, required once. Rejects with something readable on a server
   * without it — every X server since about 2004 has had it, so this is a
   * "your server is unusual" error rather than a routine fallback. */
  _ensureFixes() {
    if (this._fixes) return this._fixes;
    this._fixes = new Promise((resolve, reject) => {
      this.X.require('fixes', (err, fixes) => {
        if (err || !fixes) {
          this._fixes = null; // let a later call try again
          return reject(
            new Error(
              'clipboard: this X server has no XFixes extension, so selection ' +
                `changes cannot be watched${err ? `: ${err.message}` : ''}`
            )
          );
        }
        this._fixesFirstEvent = fixes.firstEvent;
        resolve(fixes);
      });
    });
    return this._fixes;
  }

  /** An XFixes SelectionNotify: translate the subtype and fan out. */
  _onSelectionChange(ev, fixes) {
    const entry = this._selectionWatchers.get(ev.selection);
    if (!entry) return;
    const reason =
      ev.subtype === fixes.SelectionEvent.SelectionWindowDestroy
        ? 'destroyed'
        : ev.subtype === fixes.SelectionEvent.SelectionClientClose
          ? 'closed'
          : 'new-owner';
    const detail = {
      selection: entry.name,
      owner: ev.owner,
      timestamp: ev.timestamp,
      selectionTimestamp: ev.selectionTimestamp,
      reason
    };
    // a throwing handler must not cost the others their event
    for (const handler of [...entry.handlers]) {
      try {
        handler(detail);
      } catch (err) {
        console.warn(`ntk: clipboard watch handler threw: ${err.message}`);
      }
    }
  }

  _atom(name) {
    // predefined atoms (PRIMARY = 1, STRING = 31, ...) resolve without a
    // round-trip; node-x11 caches interned ones after the first reply
    return new Promise((resolve, reject) =>
      this.X.InternAtom(false, name, (err, atom) => (err ? reject(err) : resolve(atom)))
    );
  }

  // every server call from an event handler runs inside the packet parser's
  // emit: if the connection is closing, drop it instead of throwing
  _send(fn) {
    safeRelease(this.X, fn);
  }

  // name -> payload map for one selection, target names resolved to atoms
  async _encode(data) {
    const a = this._atoms;
    if (data === null || typeof data !== 'object') {
      const text = String(data);
      const STRING = this.X.atoms.STRING;
      return new Map([
        [a.UTF8_STRING, { type: a.UTF8_STRING, format: 8, data: Buffer.from(text, 'utf8') }],
        [STRING, { type: STRING, format: 8, data: Buffer.from(text, 'latin1') }]
      ]);
    }
    if (isBinary(data)) {
      throw new TypeError(
        "clipboard: binary data needs a target name — write({ 'image/png': buffer })"
      );
    }
    const entries = data instanceof Map ? [...data] : Object.entries(data);
    if (!entries.length) throw new TypeError('clipboard: write() needs at least one target');
    const atoms = await Promise.all(entries.map(([name]) => this._atom(name)));
    const targets = new Map();
    entries.forEach(([name, value], i) => {
      const atom = atoms[i];
      if (atom === a.TARGETS || atom === a.TIMESTAMP || atom === a.MULTIPLE) {
        throw new TypeError(`clipboard: ${name} is answered by ntk and cannot be offered as data`);
      }
      targets.set(atom, { type: atom, format: 8, data: encodePayload(value, name) });
    });
    return targets;
  }

  // A current server timestamp, the way X clients without a triggering
  // event get one: append zero bytes to a property on a window we watch and
  // take the time from the PropertyNotify it generates. Falls back to 0
  // (CurrentTime) rather than making write() hang.
  _serverTime() {
    return new Promise((resolve) => {
      const done = (time) => {
        clearTimeout(timer);
        this._window.removeListener('property', onProperty);
        resolve(time);
      };
      const onProperty = (ev) => {
        if (ev.atom === this._timeProp && ev.state === 0) done(ev.time >>> 0);
      };
      const timer = setTimeout(() => done(0), DEFAULT_TIMEOUT);
      timer.unref?.();
      this._window.on('property', onProperty);
      const empty = Buffer.alloc(0);
      this.X.ChangeProperty(2, this._window.id, this._timeProp, this.X.atoms.STRING, 8, empty);
    });
  }

  // largest payload one ChangeProperty can carry; beyond it a conversion is
  // answered incrementally. Tests lower it to exercise INCR cheaply.
  _limit() {
    if (this._transferLimit === null) {
      const offered = this.app.display.max_request_length || REQUEST_UNITS_LIMIT;
      const units = Math.min(offered, REQUEST_UNITS_LIMIT);
      this._transferLimit = units * 4 - 24 - 4; // ChangeProperty header, padding
    }
    return this._transferLimit;
  }

  _onXEvent(ev) {
    if (!this._window) return;
    // XFixes events carry a server-assigned type above the core range, so
    // this cannot be confused with core SelectionNotify, which is 31
    if (ev.type === this._fixesFirstEvent && this._selectionWatchers.size) {
      this._fixes?.then(
        (fixes) => this._onSelectionChange(ev, fixes),
        () => {}
      );
      return;
    }
    if (ev.type === 28) {
      // PropertyNotify, state 1 = Deleted: a requestor consumed the INCR
      // chunk we gave it and is asking for the next one
      if (ev.state === 1 && this._transfers.size) this._onChunkConsumed(ev);
      return;
    }
    if (ev.type !== 29 && ev.type !== 30) return;
    if (ev.owner !== this._window.id) return;
    if (ev.type === 29) {
      // SelectionClear: another client copied — we no longer answer for it.
      // Transfers already under way keep their own copy of the data and
      // must still finish (ICCCM 2.7.2).
      this._owned.delete(ev.selection);
    } else {
      this._onSelectionRequest(ev);
    }
  }

  // we own the selection and somebody is pasting
  _onSelectionRequest(ev) {
    this._answer(ev).catch(() => {
      // a step of the conversion failed outright (a requestor that vanished
      // mid-paste, most likely) after we had already answered: nothing left
      // to say, and the requestor's own timeout covers it
    });
  }

  // write the converted data to the requestor's property and confirm (or
  // refuse) via SelectionNotify
  async _answer(ev) {
    const entry = this._owned.get(ev.selection);
    // obsolete requestors may pass property None — ICCCM says use the
    // target atom as the property name then
    let property = ev.property || ev.target;
    let served = false;
    try {
      if (entry) {
        served =
          ev.target === this._atoms.MULTIPLE
            ? await this._serveMultiple(ev, entry, property)
            : await this._serveTarget(ev.requestor, property, ev.target, entry);
      }
      // entry undefined: raced with a SelectionClear we haven't seen yet
    } catch {
      served = false; // refuse rather than leave the requestor waiting
    }
    if (!served) property = 0;
    // mask 0: SelectionNotify is addressed to the requestor itself, so it
    // goes to the client that created that window rather than to whoever
    // selected events on it (ICCCM 2.2)
    this._send(() =>
      this.X.SendEvent(ev.requestor, 0, 0, {
        name: 'SelectionNotify',
        time: ev.time,
        requestor: ev.requestor,
        selection: ev.selection,
        target: ev.target,
        property
      })
    );
  }

  // convert one target into one property on the requestor's window;
  // false means "cannot convert", which the caller turns into a refusal
  async _serveTarget(requestor, property, target, entry) {
    const X = this.X;
    const a = this._atoms;
    if (target === a.TARGETS) {
      // x11 >= 3.4 encodes a number array at the property's declared
      // format, so this reaches the requestor as CARD32 atoms
      this._send(() =>
        X.ChangeProperty(0, requestor, property, X.atoms.ATOM, 32, [
          a.TARGETS,
          a.TIMESTAMP,
          a.MULTIPLE,
          ...entry.targets.keys()
        ])
      );
      return true;
    }
    if (target === a.TIMESTAMP) {
      // ICCCM 2.6.2: the timestamp this selection was acquired with, as an
      // INTEGER — Xt-based requestors ask for it before anything else
      this._send(() => X.ChangeProperty(0, requestor, property, X.atoms.INTEGER, 32, [entry.time]));
      return true;
    }
    // MULTIPLE inside MULTIPLE is not allowed, and a bare MULTIPLE never
    // reaches here (its own branch runs first)
    if (target === a.MULTIPLE) return false;
    const value = entry.targets.get(target);
    if (!value) return false;
    if (value.data.length > this._limit()) {
      await this._startIncr(requestor, property, value);
      return true;
    }
    this._send(() =>
      X.ChangeProperty(0, requestor, property, value.type, value.format, value.data)
    );
    return true;
  }

  // MULTIPLE (ICCCM 2.6.2): the requestor left a list of (target, property)
  // pairs on its own window; convert each one and hand the list back with
  // None in place of the properties we could not fill.
  async _serveMultiple(ev, entry, property) {
    const pairs = await this._getProperty(property, ev.requestor, 0);
    // the list is defined as ATOM_PAIR, but requestors have been known to
    // label it otherwise: what matters is that it decodes as 32-bit pairs
    if (!pairs || pairs.format !== 32 || !pairs.data.length || pairs.data.length % 8) return false;
    const list = Buffer.from(pairs.data);
    let refused = false;
    for (let o = 0; o < list.length; o += 8) {
      const target = list.readUInt32LE(o);
      const prop = list.readUInt32LE(o + 4);
      if (!prop) continue; // already None
      if (!(await this._serveTarget(ev.requestor, prop, target, entry))) {
        list.writeUInt32LE(0, o + 4);
        refused = true;
      }
    }
    if (refused) {
      const type = pairs.type || this._atoms.ATOM_PAIR;
      this._send(() => this.X.ChangeProperty(0, ev.requestor, property, type, 32, list));
    }
    return true;
  }

  // ---- INCR, owner side (ICCCM 2.7.2): the mirror of _fetchProperty ----

  // Answer the conversion with an INCR property holding a lower bound on
  // the byte count; the requestor deleting that property starts the chunks.
  async _startIncr(requestor, property, value) {
    const key = `${requestor}:${property}`;
    this._endTransfer(key); // a new conversion supersedes an unfinished one
    await this._watch(requestor);
    const transfer = {
      key,
      requestor,
      property,
      type: value.type,
      format: value.format,
      data: value.data,
      offset: 0,
      terminated: false,
      timer: null
    };
    this._transfers.set(key, transfer);
    this._touch(transfer);
    this._send(() =>
      this.X.ChangeProperty(0, requestor, property, this._atoms.INCR, 32, [value.data.length])
    );
  }

  _onChunkConsumed(ev) {
    const transfer = this._transfers.get(`${ev.wid}:${ev.atom}`);
    if (!transfer) return;
    if (transfer.terminated) {
      // the zero-length property that ended the transfer has been read
      this._endTransfer(transfer.key);
      return;
    }
    const chunk = transfer.data.subarray(transfer.offset, transfer.offset + this._limit());
    transfer.offset += chunk.length;
    // an empty chunk is the end marker, not a chunk
    if (chunk.length === 0) transfer.terminated = true;
    this._touch(transfer);
    this._send(() =>
      this.X.ChangeProperty(
        0,
        transfer.requestor,
        transfer.property,
        transfer.type,
        transfer.format,
        chunk
      )
    );
  }

  _touch(transfer) {
    clearTimeout(transfer.timer);
    transfer.timer = setTimeout(() => this._endTransfer(transfer.key), this._incrTimeout);
    transfer.timer.unref?.();
  }

  _endTransfer(key) {
    const transfer = this._transfers.get(key);
    if (!transfer) return;
    clearTimeout(transfer.timer);
    this._transfers.delete(key);
    this._unwatch(transfer.requestor);
  }

  // PropertyNotify on the requestor's window is how the chunks are paced.
  // Event masks are per-client, so ours is ours to set — but restore what
  // we found: with a self-paste the requestor is our own helper window,
  // whose PropertyChange the read path depends on.
  async _watch(requestor) {
    let watch = this._watched.get(requestor);
    if (!watch) {
      // register before the round trip, not after it: ICCCM lets a
      // requestor run several conversions at once (on distinct properties),
      // and those must share one watch rather than race to install it
      watch = { count: 0, mask: 0 };
      watch.ready = new Promise((resolve, reject) =>
        this.X.GetWindowAttributes(requestor, (err, attrs) =>
          err ? reject(err) : resolve(attrs.myEventMasks)
        )
      ).then((mask) => {
        watch.mask = mask;
        if (mask & x11.eventMask.PropertyChange) return;
        this._send(() =>
          this.X.ChangeWindowAttributes(
            requestor,
            { eventMask: mask | x11.eventMask.PropertyChange },
            () => true
          )
        );
      });
      this._watched.set(requestor, watch);
    }
    watch.count++;
    try {
      await watch.ready;
    } catch (err) {
      this._unwatch(requestor); // the requestor is gone; do not keep its entry
      throw err;
    }
  }

  _unwatch(requestor) {
    const watch = this._watched.get(requestor);
    if (!watch || --watch.count > 0) return;
    this._watched.delete(requestor);
    if (watch.mask & x11.eventMask.PropertyChange) return;
    // () => true swallows the BadWindow of a requestor that destroyed its
    // window as soon as the paste completed — the usual ending
    this._send(() =>
      this.X.ChangeWindowAttributes(requestor, { eventMask: watch.mask }, () => true)
    );
  }

  // ---- INCR, requestor side ----

  // ConvertSelection and wait for the owner's SelectionNotify answer.
  // `time` is the timestamp of the event that asked for the data; ICCCM 2.4
  // says to send it rather than CurrentTime. Undefined coerces to 0, which
  // is CurrentTime — the documented default for callers with no event.
  _convert(sel, target, prop, selectionName, timeout, time) {
    return new Promise((resolve, reject) => {
      const X = this.X;
      const wid = this._window.id;
      const onEvent = (ev) => {
        if (ev.type !== 31 || ev.requestor !== wid || ev.selection !== sel) return;
        cleanup();
        resolve(ev);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `clipboard: timed out after ${timeout}ms waiting for the ${selectionName} selection owner to convert`
          )
        );
      }, timeout);
      const cleanup = () => {
        clearTimeout(timer);
        X.removeListener('event', onEvent);
      };
      X.on('event', onEvent);
      X.ConvertSelection(wid, sel, target, prop, time >>> 0);
    });
  }

  _getProperty(prop, wid = this._window.id, del = 1) {
    // delete=true: for plain transfers frees the property; for INCR chunks
    // it doubles as the "send the next chunk" handshake
    return new Promise((resolve, reject) =>
      this.X.GetProperty(del, wid, prop, 0, 0, 0x1fffffff, (err, res) =>
        err ? reject(err) : resolve(res)
      )
    );
  }

  // read the converted property, following the INCR protocol when the
  // owner chose an incremental transfer
  async _fetchProperty(prop, selectionName, timeout) {
    // collect NewValue notifications from here on: with INCR the owner's
    // next chunk lands as soon as we delete the previous property, possibly
    // before an await below resumes — a listener installed later would
    // miss it. The helper window gets 'property' events through the normal
    // pipeline (PropertyNotify carries ev.wid).
    const queue = [];
    let waiter = null;
    const onProperty = (ev) => {
      if (ev.atom !== prop || ev.state !== 0) return; // 0 = NewValue
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(ev);
      } else {
        queue.push(ev);
      }
    };
    this._window.on('property', onProperty);

    const nextChunkNotify = () =>
      new Promise((resolve, reject) => {
        if (queue.length) return resolve(queue.shift());
        const timer = setTimeout(() => {
          waiter = null;
          reject(
            new Error(
              `clipboard: INCR transfer of ${selectionName} selection stalled (no chunk within ${timeout}ms)`
            )
          );
        }, timeout);
        waiter = (ev) => {
          clearTimeout(timer);
          resolve(ev);
        };
      });

    try {
      const first = await this._getProperty(prop);
      if (first.type !== this._atoms.INCR) return first;
      // INCR (ICCCM 2.7.2): the property held a lower-bound byte count and
      // our delete-on-read told the owner to start. Each chunk arrives as
      // a NewValue PropertyNotify; reading it with delete=true requests
      // the next one; a zero-length chunk ends the transfer.
      const chunks = [];
      let type = 0;
      for (;;) {
        await nextChunkNotify();
        const part = await this._getProperty(prop);
        if (part.data.length === 0) break;
        type = part.type;
        chunks.push(part.data);
      }
      return { type, data: Buffer.concat(chunks) };
    } finally {
      this._window.removeListener('property', onProperty);
    }
  }
}
