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
    this._fixes = null; // XFixes extension, required on first watch()
    this._fixesFirstEvent = -1; // its event base, to recognise its events
    this._selectionWatchers = new Map(); // selection atom -> { name, handlers }
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
    if (ev.type !== 29 && ev.type !== 30) return;
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
        // x11 >= 3.4 encodes a number array at the property's declared
        // format, so this reaches the requestor as three CARD32 atoms
        X.ChangeProperty(0, ev.requestor, property, X.atoms.ATOM, 32, [
          a.TARGETS,
          a.UTF8_STRING,
          X.atoms.STRING
        ]);
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
      // mask 0: SelectionNotify is addressed to the requestor itself, so it
      // goes to the client that created that window rather than to whoever
      // selected events on it (ICCCM 2.2)
      X.SendEvent(ev.requestor, 0, 0, {
        name: 'SelectionNotify',
        time: ev.time,
        requestor: ev.requestor,
        selection: ev.selection,
        target: ev.target,
        property
      });
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
