import x11 from 'x11';

import { safeRelease } from './cleanup.js';

// Clipboard (app.clipboard): ICCCM selection transfer for plain text.
//
// X has no clipboard buffer — "copy" means owning a selection atom
// (CLIPBOARD for explicit copy/paste, PRIMARY for middle-click paste) and
// answering conversion requests from whoever pastes; "paste" means asking
// the current owner to convert into a property on one of our windows. This
// module hides that dance behind write()/read() promises, using a hidden
// 1x1 never-mapped helper window as the selection endpoint.
//
// Supported targets when ntk owns a selection: TARGETS, UTF8_STRING and
// STRING (latin-1, best effort). Everything else — MULTIPLE, TIMESTAMP,
// images — is refused with SelectionNotify property None per ICCCM.
//
// Reads prefer UTF8_STRING and retry once with STRING when the owner
// refuses (old Xt/Motif apps). Incremental (INCR) transfers are supported
// on the read side, so pasting more than the server's transfer limit works.
//
// LIMITATION: INCR is NOT implemented on the write side — write() hands the
// whole payload to the server in a single ChangeProperty when a requestor
// converts. Texts approaching the server's maximum request length (~256KB
// on servers without BIG-REQUESTS, node-x11 does not negotiate it) may fail
// to paste into other applications.

const DEFAULT_TIMEOUT = 2000;

// SendEvent takes the raw 32-byte wire form of the event to deliver and
// node-x11 has no packer for outgoing events, so build SelectionNotify
// (code 31) by hand: CARD8 code, pad, CARD16 sequence (filled server-side),
// TIMESTAMP, requestor WINDOW, then selection/target/property ATOMs.
function encodeSelectionNotify(time, requestor, selection, target, property) {
  const b = Buffer.alloc(32);
  b[0] = 31;
  b.writeUInt32LE(time >>> 0, 4);
  b.writeUInt32LE(requestor >>> 0, 8);
  b.writeUInt32LE(selection >>> 0, 12);
  b.writeUInt32LE(target >>> 0, 16);
  b.writeUInt32LE(property >>> 0, 20);
  return b;
}

export default class Clipboard {
  constructor(app) {
    this.app = app;
    this.X = app.X;
    this._window = null; // hidden helper window, created on first use
    this._owned = new Map(); // selection atom -> text we serve
    this._atoms = null; // { TARGETS, UTF8_STRING, INCR }
    this._transferProp = null; // property reads are converted into
    this._ready = null;
    this._readQueue = Promise.resolve();
    this._onXEvent = this._onXEvent.bind(this);
  }

  /**
   * Take ownership of a selection and serve `text` to anyone who pastes.
   * Resolves once the server confirms the ownership; ownership (and the
   * text) is held until another client copies or the app closes.
   *
   * @param {string} text
   * @param {object} [options] { selection: 'CLIPBOARD' (default) or
   *   'PRIMARY' (middle-click paste) — any selection atom name works }
   * @returns {Promise<void>}
   */
  async write(text, { selection = 'CLIPBOARD' } = {}) {
    await this._ensure();
    const sel = await this._atom(selection);
    this._owned.set(sel, String(text));
    // time 0 = CurrentTime: best effort — ntk has no "last user input"
    // timestamp to arbitrate ownership races with (ICCCM prefers one)
    this.X.SetSelectionOwner(this._window.id, sel, 0);
    // SetSelectionOwner is void: confirm via GetSelectionOwner that the
    // server actually made us the owner
    const owner = await new Promise((resolve, reject) =>
      this.X.GetSelectionOwner(sel, (err, wid) => (err ? reject(err) : resolve(wid)))
    );
    if (owner !== this._window.id) {
      this._owned.delete(sel);
      throw new Error(`clipboard: failed to acquire ${selection} selection ownership`);
    }
  }

  /**
   * Read the current text of a selection from whoever owns it.
   * Rejects when the selection has no owner, when the owner supports
   * neither UTF8_STRING nor STRING, or when the owner stops responding
   * (`timeout` ms, default 2000).
   *
   * @param {object} [options] { selection: 'CLIPBOARD' | 'PRIMARY' | ...,
   *   timeout: ms to wait for the owner at each protocol step }
   * @returns {Promise<string>}
   */
  read({ selection = 'CLIPBOARD', timeout = DEFAULT_TIMEOUT } = {}) {
    // serialize: concurrent reads would share the one transfer property on
    // the helper window, so let each conversion finish before the next
    const run = () => this._read(selection, timeout);
    const result = this._readQueue.then(run, run);
    this._readQueue = result.catch(() => {});
    return result;
  }

  async _read(selection, timeout) {
    await this._ensure();
    const X = this.X;
    const sel = await this._atom(selection);
    const prop = this._transferProp;

    let notify = await this._convert(sel, this._atoms.UTF8_STRING, prop, selection, timeout);
    if (notify.property === 0) {
      // property None: no owner, or the owner refused UTF8_STRING (old
      // Xt/Motif apps) — ask again for latin-1 STRING before giving up
      notify = await this._convert(sel, X.atoms.STRING, prop, selection, timeout);
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
      const [TARGETS, UTF8_STRING, INCR, transferProp] = await Promise.all([
        this._atom('TARGETS'),
        this._atom('UTF8_STRING'),
        this._atom('INCR'),
        this._atom('NTK_SELECTION')
      ]);
      this._atoms = { TARGETS, UTF8_STRING, INCR };
      this._transferProp = transferProp;
      // SelectionRequest/SelectionClear carry the owner in ev.owner, not
      // ev.wid, so node-x11's event_consumers routing (keyed on ev.wid)
      // never delivers them to the Window wrapper — listen on the raw
      // client instead
      this.X.on('event', this._onXEvent);
    })();
    return this._ready;
  }

  _atom(name) {
    // predefined atoms (PRIMARY = 1, STRING = 31, ...) resolve without a
    // round-trip; node-x11 caches interned ones after the first reply
    return new Promise((resolve, reject) =>
      this.X.InternAtom(false, name, (err, atom) => (err ? reject(err) : resolve(atom)))
    );
  }

  _onXEvent(ev) {
    if (!this._window || (ev.type !== 29 && ev.type !== 30)) return;
    if (ev.owner !== this._window.id) return;
    if (ev.type === 29) {
      // SelectionClear: another client copied — we no longer answer for it
      this._owned.delete(ev.selection);
    } else {
      this._onSelectionRequest(ev);
    }
  }

  // we own the selection and somebody is pasting: write the converted data
  // to the requestor's property and confirm (or refuse) via SelectionNotify
  _onSelectionRequest(ev) {
    const X = this.X;
    const a = this._atoms;
    const text = this._owned.get(ev.selection);
    // obsolete requestors may pass property None — ICCCM says use the
    // target atom as the property name then
    let property = ev.property || ev.target;
    // the whole answer runs from the packet parser's emit: if the
    // connection is closing, drop it instead of throwing (see cleanup.js)
    safeRelease(X, () => {
      if (text === undefined) {
        property = 0; // raced with a SelectionClear we haven't seen yet
      } else if (ev.target === a.TARGETS) {
        const data = Buffer.alloc(12);
        data.writeUInt32LE(a.TARGETS, 0);
        data.writeUInt32LE(a.UTF8_STRING, 4);
        data.writeUInt32LE(X.atoms.STRING, 8);
        X.ChangeProperty(0, ev.requestor, property, X.atoms.ATOM, 32, data);
      } else if (ev.target === a.UTF8_STRING) {
        X.ChangeProperty(0, ev.requestor, property, a.UTF8_STRING, 8, Buffer.from(text, 'utf8'));
      } else if (ev.target === X.atoms.STRING) {
        // latin-1 best effort: codepoints above U+00FF are lossy here;
        // modern requestors ask for UTF8_STRING
        X.ChangeProperty(0, ev.requestor, property, X.atoms.STRING, 8, Buffer.from(text, 'latin1'));
      } else {
        // unsupported target (MULTIPLE, TIMESTAMP, images, ...): refuse
        // with property None per ICCCM
        property = 0;
      }
      X.SendEvent(
        ev.requestor,
        0,
        0,
        encodeSelectionNotify(ev.time, ev.requestor, ev.selection, ev.target, property)
      );
    });
  }

  // ConvertSelection and wait for the owner's SelectionNotify answer
  _convert(sel, target, prop, selectionName, timeout) {
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
      X.ConvertSelection(wid, sel, target, prop, 0);
    });
  }

  _getProperty(prop) {
    // delete=true: for plain transfers frees the property; for INCR chunks
    // it doubles as the "send the next chunk" handshake
    return new Promise((resolve, reject) =>
      this.X.GetProperty(1, this._window.id, prop, 0, 0, 0x1fffffff, (err, res) =>
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
