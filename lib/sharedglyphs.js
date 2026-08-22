// Shared glyphs across processes — the client half (docs/shared-glyphs.md).
//
// A display-wide "glyph directory" (lib/glyphdirectory.js) owns the
// `_NTK_GLYPHD` manager selection and is the single allocator of compact
// local ids inside shared RENDER glyphsets. This module is everything an app
// needs to *use* it: discovery (GetSelectionOwner; self-election when nobody
// owns it yet), the ensure/added property RPC, the XID-reuse fence around
// ReferenceGlyphSet, and the per-page state machine `GlyphPage` and
// `ShapeGlyphPage` bind to.
//
// The feature is a pure overlay: any failure — no owner, a dead owner, a
// refused request, a hardened server — closes the shared side of the page it
// happened to, and glyphs keep rendering through today's private per-process
// path. Entries already bound to a shared set stay bound: aliases survive
// the directory's death (fenced by test/shared-glyphs-assumptions.test.js),
// so pages merely freeze rather than break.
//
// The one rule everything here enforces: a client never composites a glyph
// id it has not confirmed present — Xorg silently skips unknown ids without
// advancing the pen, which corrupts layout rather than erroring.

import x11 from 'x11';

import { variationKey } from './text/font.js';
import { builtin } from './builtin.js';
import GlyphSet from './glyphset.js';
import GlyphDirectory from './glyphdirectory.js';
import { GLYPHD, encodeGlyphdRequest, parseGlyphdReply } from './glyphdwire.js';

export { GLYPHD, RPC_VERSION, encodeGlyphdRequest, parseGlyphdRequest, encodeGlyphdReply, parseGlyphdReply } from './glyphdwire.js';

/** shape pages: one display-wide page for every corner glyph, as today's
 *  per-process page is one page for all corners (lib/shapeglyphs.js) */
export const SHAPE_PAGE_TOKEN = 'ntks1:a8';

// How long to wait for the directory's DONE before declaring it dead. The
// answer is one property read and one write away, so a healthy directory
// answers in a round trip or two; this is a liveness fence, not a pace.
const RPC_TIMEOUT = 2000;

/**
 * The token naming one shared font page: content-addressed, because the
 * generator's input is a font file far too big to name literally.
 *
 *     ntkg1:<sha1 of font file bytes>:<variation coords>:<px size>:<format>
 *
 * The `ntkg1` version prefix is load-bearing, not hygiene: advances are
 * baked into glyphs at AddGlyphs time and idempotent duplicate uploads
 * assume byte-identical rasterization, both of which hold only among
 * processes running the same rasterizer and rounding. Change either — bump
 * the version, and two ntk versions on one display simply share nothing.
 *
 * The sha1 is computed from the loaded font buffer, lazily on first shared
 * use, and cached on the base face (a variation instance hashes the same
 * file its base was cut from). `null` — no buffer to hash, or no crypto in
 * this environment — means this page stays private, which is the correct
 * degradation everywhere it can happen.
 *
 * @param {Font} font
 * @param {number} size pixel size
 * @returns {string|null}
 */
export function fontPageToken(font, size) {
  const base = font.variationOf ?? font;
  if (base._ntkSha1 === undefined) {
    const buffer = base.fk?.stream?.buffer;
    const crypto = buffer ? builtin('node:crypto') : undefined;
    base._ntkSha1 = crypto ? crypto.createHash('sha1').update(buffer).digest('hex') : null;
  }
  if (!base._ntkSha1) return null;
  return `ntkg1:${base._ntkSha1}:${variationKey(font.variationCoords)}:${size}:a8`;
}

// ---------------------------------------------------------------------------
// The per-app client
// ---------------------------------------------------------------------------

/**
 * The shared-glyph client of one connection — `app.sharedGlyphs`, `null`
 * when the feature is off (`NTK_NO_SHARED_GLYPHS`, or
 * `createClient({ sharedGlyphs: false })`).
 *
 * Everything here is driven lazily by the glyph pages: nothing touches the
 * server until the first page binds. Discovery self-elects when no directory
 * owns the selection — the first ntk app on a display becomes the directory,
 * embedded behind this same code path.
 */
export class SharedGlyphs {
  constructor(app) {
    this.app = app;
    this.X = app.X;
    /** 'idle' | 'resolving' | 'active' | 'dead' (dead = waiting for MANAGER) */
    this.state = 'idle';
    /** bumps whenever the owner changes or dies; bindings pin the epoch a
     *  reply was fenced under, so a stale await cannot adopt across owners */
    this.epoch = 0;
    this.ownerWid = 0;
    this._atoms = null;
    this._mailbox = null;
    this._directory = null; // GlyphDirectory when this app self-elected
    this._resolving = null;
    this._serial = 0;
    this._waiters = new Map(); // serial -> resolve(status)
    this._chain = Promise.resolve(); // RPCs are serialized: one property pair
  }

  /** Bind one glyph page to the shared cache; see SharedPage. */
  bindPage(adapter) {
    return new SharedPage(this, adapter);
  }

  /**
   * Resolve discovery once: 'idle' -> 'active' | 'dead'. After death only a
   * MANAGER announcement (a new owner) re-activates; pages ask again then.
   * @returns {Promise<boolean>} whether the directory is usable
   */
  _ready() {
    if (this.state === 'active') return Promise.resolve(true);
    if (this.state === 'dead') return Promise.resolve(false);
    if (!this._resolving) this._resolving = this._resolve();
    return this._resolving;
  }

  async _resolve() {
    this.state = 'resolving';
    try {
      const names = [GLYPHD.selection, GLYPHD.ensure, GLYPHD.added, GLYPHD.done, GLYPHD.property, GLYPHD.manager];
      const ids = await Promise.all(names.map((n) => this._atom(n)));
      this._atoms = {
        selection: ids[0],
        ensure: ids[1],
        added: ids[2],
        done: ids[3],
        property: ids[4],
        manager: ids[5]
      };
      // the mailbox: selection-style helper window — request/reply properties
      // live on it and DONE ClientMessages are addressed to it
      this._mailbox = this.app.createWindow({
        width: 1,
        height: 1,
        eventMask: x11.eventMask.PropertyChange
      });
      this._mailbox.on('message', (ev) => this._onDone(ev));
      // handover/new-owner announcements arrive as MANAGER ClientMessages on
      // the root; StructureNotify is the mask ICCCM says they are sent with.
      // A server that refuses the selection just costs us handover detection.
      const root = this.app.rootWindow();
      root.on('message', (ev) => this._onRootMessage(ev));
      await root.selectInput(x11.eventMask.StructureNotify).catch(() => {});

      let owner = await this._selectionOwner();
      if (!owner) {
        // nobody home: self-elect. claim() resolves the race for us — it
        // returns whoever actually owns the selection afterwards.
        this._directory = new GlyphDirectory(this.app, this.app.options.sharedGlyphs || undefined);
        owner = await this._directory.claim();
        if (owner !== this._directory.wid) this._directory = null;
      }
      // a MANAGER announcement racing this discovery may have adopted a
      // newer owner already — never clobber it with what we found first
      if (this.state === 'resolving') {
        if (!owner) {
          this.state = 'dead';
          return false;
        }
        this.ownerWid = owner;
        this.state = 'active';
      }
      return this.state === 'active';
    } catch {
      if (this.state === 'resolving') this.state = 'dead';
      return this.state === 'active';
    }
  }

  /** the directory stopped answering (or its window is gone): freeze. New
   *  pages go private until a MANAGER announcement names a successor. */
  _die() {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.epoch++;
    for (const resolve of this._waiters.values()) resolve(0);
    this._waiters.clear();
  }

  _onRootMessage(ev) {
    if (!this._atoms || ev.message_type !== this._atoms.manager) return;
    if ((ev.data[1] >>> 0) !== this._atoms.selection) return;
    const wid = ev.data[2] >>> 0;
    if (!wid || (this.state === 'active' && wid === this.ownerWid)) return;
    // a new owner (first announcement after a death, or a live handover):
    // adopt it for pages bound from here on; already-bound pages notice the
    // epoch change and freeze instead of mixing generations.
    this.epoch++;
    this.ownerWid = wid;
    this.state = 'active';
  }

  _onDone(ev) {
    if (!this._atoms || ev.message_type !== this._atoms.done) return;
    const resolve = this._waiters.get(ev.data[0]);
    if (!resolve) return;
    this._waiters.delete(ev.data[0]);
    resolve(ev.data[1]);
  }

  /**
   * One RPC: write the request property on the mailbox, poke the directory,
   * await DONE, read back the reply property (ensure only). Serialized so a
   * single property pair serves every page; batching keeps this rare (one
   * ensure per draw that met new glyphs, mirroring today's one AddGlyphs).
   * Resolves `null` on any failure — a dead directory kills the client, a
   * refusal only this request.
   */
  _rpc(kindAtom, payload, wantReply) {
    const run = () => this._rpcNow(kindAtom, payload, wantReply);
    const result = this._chain.then(run, run);
    this._chain = result.catch(() => {});
    return result;
  }

  async _rpcNow(kindAtom, payload, wantReply) {
    if (this.state !== 'active') return null;
    const epoch = this.epoch;
    const a = this._atoms;
    const serial = ++this._serial;
    const X = this.X;
    X.ChangeProperty(0, this._mailbox.id, a.property, a.property, 8, payload);
    const status = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        // no answer: the owner is gone or wedged — same consequence
        this._waiters.delete(serial);
        this._die();
        resolve(0);
      }, RPC_TIMEOUT);
      timer.unref?.();
      this._waiters.set(serial, (st) => {
        clearTimeout(timer);
        resolve(st);
      });
      // wid = the directory's own window: ClientMessages route to a Window
      // wrapper by their wid field, and the mailbox rides in data[0]
      X.SendClientMessage(this.ownerWid, this.ownerWid, kindAtom, 32, [this._mailbox.id, serial, a.property], 0, (err) => {
        // BadWindow: the owner's window is gone — fail fast, not by timeout
        if (err) this._die();
        return true;
      });
    });
    if (!status || this.epoch !== epoch) return null;
    if (!wantReply) return { status };
    const prop = await new Promise((resolve) =>
      X.GetProperty(1, this._mailbox.id, a.property, 0, 0, 0x1fffffff, (err, res) => resolve(err ? null : res))
    );
    if (!prop || !prop.data || this.epoch !== epoch) return null;
    const reply = parseGlyphdReply(prop.data);
    return reply && reply.serial === serial ? reply : null;
  }

  _ensure(token, indices, keys) {
    return this._rpc(this._atoms.ensure, encodeGlyphdRequest({ token, indices, keys }), true);
  }

  _added(token, indices, keys, bytes) {
    return this._rpc(this._atoms.added, encodeGlyphdRequest({ token, indices, keys, bytes }), false);
  }

  _selectionOwner() {
    return new Promise((resolve) =>
      this.X.GetSelectionOwner(this._atoms.selection, (err, wid) => resolve(err ? 0 : wid))
    );
  }

  _atom(name) {
    return new Promise((resolve, reject) =>
      this.X.InternAtom(false, name, (err, atom) => (err ? reject(err) : resolve(atom)))
    );
  }
}

/**
 * One page's shared side, driven by `GlyphPage`/`ShapeGlyphPage` through an
 * adapter:
 *
 *   token      the page's name on the wire (fontPageToken / SHAPE_PAGE_TOKEN)
 *   indices    member keys are u32 font glyph indices rather than strings
 *   makeGlyph(key, payload, lid)  a fresh AddGlyphs object for a glyph the
 *              directory reported absent (node-x11 mutates its input, so
 *              fresh per call); may rasterize when the payload carries no
 *              bitmap (the warm path)
 *   adopt(key, lid, gsid, payload)  bind the page entry to the shared set —
 *              called only for ids confirmed present or just uploaded by us
 *
 * A binding binds to exactly one (owner epoch, gsid, generation). Any
 * disagreement afterwards — new generation, new owner, a failed RPC — closes
 * it: entries already adopted keep compositing from the alias (frozen), new
 * glyphs stay on the page's private path, and a fresh page binds fresh.
 */
export class SharedPage {
  constructor(client, adapter) {
    this.client = client;
    this.adapter = adapter;
    this.open = true;
    this.bound = false;
    this.alias = null; // GlyphSet referencing the directory's set
    this.gsid = 0;
    this.generation = 0;
    this.pending = new Map(); // key -> payload, in flight
    this._chain = Promise.resolve(); // asks are serialized per page
  }

  /**
   * Ask the directory about keys this page has not confirmed yet.
   * `items` is [{ key, payload }]; keys already in flight are skipped.
   * Never rejects; resolves once the batch is adopted, uploaded, or dropped.
   */
  ask(items) {
    if (!this.open) return Promise.resolve();
    const keys = [];
    for (const { key, payload } of items) {
      if (this.pending.has(key)) continue;
      this.pending.set(key, payload);
      keys.push(key);
    }
    if (keys.length === 0) return this._chain;
    const run = () => this._ask(keys).catch(() => this._drop(keys));
    this._chain = this._chain.then(run, run);
    return this._chain;
  }

  async _ask(keys) {
    if (!(await this.client._ready()) || !this.open) return this._drop(keys);
    const epoch = this.client.epoch;
    const reply = await this.client._ensure(this.adapter.token, this.adapter.indices, keys);
    if (!this.open) return this._drop(keys);
    if (!reply || reply.entries.length !== keys.length) {
      this._drop(keys);
      this._close();
      return;
    }
    if (!this.bound) {
      // The XID-reuse fence. The reply's gsid must not be referenced into a
      // void: the directory could be gone and the id recycled. Reference and
      // GetSelectionOwner go out back to back; replies are processed in
      // order, and the directory's contract is that it frees nothing while
      // it owns the selection — so if the owner still is the window that
      // advertised this gsid *after* the reference executed, the reference
      // bound the intended set. Anything else: drop the alias and close (a
      // reference that raced the death itself fails with a GLYPHSET error —
      // an error, never wrong pixels — surfacing as one benign warning).
      const alias = GlyphSet.referenceTo(this.client.app, reply.gsid);
      const owner = await this.client._selectionOwner();
      if (owner !== this.client.ownerWid || this.client.epoch !== epoch || !this.open) {
        alias.destroy();
        this._drop(keys);
        this._close();
        return;
      }
      this.alias = alias;
      this.gsid = reply.gsid;
      this.generation = reply.generation;
      this.bound = true;
    } else if (reply.gsid !== this.gsid || reply.generation !== this.generation || this.client.epoch !== epoch) {
      // the directory opened a new generation (or changed hands): this page
      // freezes on the set it has; a future page binds to the new one
      this._drop(keys);
      this._close();
      return;
    }
    const uploads = [];
    const uploadedKeys = [];
    let bytes = 0;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const payload = this.pending.get(key);
      this.pending.delete(key);
      if (payload === undefined) continue;
      const { lid, present } = reply.entries[i];
      if (!present) {
        // ours to upload: the directory told everyone racing on this glyph
        // the same, and duplicate uploads are idempotent (identical bytes,
        // AddGlyphs replaces by id, Xorg dedupes storage by content hash)
        const glyph = this.adapter.makeGlyph(key, payload, lid);
        if (!glyph) continue; // cannot produce the bitmap: leave it private
        uploads.push(glyph);
        uploadedKeys.push(key);
        bytes += glyph.image.length;
      }
      this.adapter.adopt(key, lid, this.alias.id, payload);
    }
    if (uploads.length) {
      // upload through our own alias, then flip the directory's presence
      // bits. Our own composites are ordered after the upload on this
      // connection, so adopting before the AddGlyphs flushes is safe.
      this.alias.addGlyphs(uploads);
      await this.client._added(this.adapter.token, this.adapter.indices, uploadedKeys, bytes);
    }
  }

  _drop(keys) {
    for (const key of keys) this.pending.delete(key);
  }

  _close() {
    this.open = false;
    this.pending.clear();
  }

  /** the page is going away: drop the alias (a server-side refcount) */
  destroy() {
    this._close();
    if (this.alias) {
      this.alias.destroy();
      this.alias = null;
    }
  }
}

/**
 * The app's shared-glyph client, or `null` when the feature is off. Decided
 * once per app: `createClient({ sharedGlyphs: false })`, or the
 * `NTK_NO_SHARED_GLYPHS` environment kill switch. Off means not a byte of
 * this machinery runs — pages behave exactly as they did before it existed.
 */
export function sharedGlyphsFor(app) {
  if (app._sharedGlyphs === undefined) {
    const disabled =
      app.options.sharedGlyphs === false ||
      (typeof process !== 'undefined' && process.env && process.env.NTK_NO_SHARED_GLYPHS);
    app._sharedGlyphs = disabled ? null : new SharedGlyphs(app);
  }
  return app._sharedGlyphs;
}
