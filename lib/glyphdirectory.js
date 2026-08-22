// The `_NTK_GLYPHD` glyph directory (docs/shared-glyphs.md): the naming half
// of the display-wide shared glyph cache.
//
// The directory does not rasterize and knows nothing about fonts. It owns
// three things and nothing else: the ICCCM manager selection that names it,
// the map from page tokens to server-side glyphsets, and the compact local
// id space inside each set — it is the single writer of lids, which is what
// keeps them dense enough for CompositeGlyphs8. Presence is a bit it tracks
// per (token, member key): clients report uploads (`_NTK_GLYPHD_ADDED`), and
// later askers are told "already there".
//
// Lifetime contract, load-bearing for the client's XID-reuse fence: while
// the directory owns the selection it frees nothing. Eviction opens a new
// *generation* — fresh sets advertised, old ones no longer handed out; the
// retired sets stay pinned by this connection (their ids are the cheap part;
// Xorg dedupes the pixel storage by content anyway) and die with it, or
// when the last client alias drops, whichever is later.
//
// Every ntk app embeds one of these behind the same code path: the first app
// on a display self-elects (lib/sharedglyphs.js calls `claim()` when nobody
// owns the selection), a standalone directory process would claim it the
// same way and simply outlive the apps.

import x11 from 'x11';

import GlyphSet from './glyphset.js';
import {
  GLYPHD,
  MAX_LIDS,
  encodeGlyphdReply,
  parseGlyphdRequest
} from './glyphdwire.js';

/**
 * Directory-side policy: the byte budget across the current generation's
 * pages. Uploads reported by clients accumulate against it; exceeding it
 * opens a new generation. It bounds *growth*, not total server memory —
 * retired generations froze at whatever size they reached.
 */
export const DEFAULT_SHARED_GLYPHS_POLICY = {
  budgetBytes: 32 << 20
};

const TIME_TIMEOUT = 2000;

export default class GlyphDirectory {
  /**
   * @param {App} app the connection the directory rides
   * @param {object} [options] `{ budgetBytes }` over DEFAULT_SHARED_GLYPHS_POLICY
   */
  constructor(app, options) {
    this.app = app;
    this.X = app.X;
    this.policy = { ...DEFAULT_SHARED_GLYPHS_POLICY, ...options };
    this.window = null;
    this.generation = 1;
    this.pages = new Map(); // token -> { set, members: Map(key -> {lid, present}), bytes }
    this.active = false;
    this._atoms = null;
    this._bytes = 0; // uploads reported into the current generation
    this._retired = []; // GlyphSets of past generations: pinned, never freed
    this._onXEvent = this._onXEvent.bind(this);
  }

  /** the selection endpoint's window id, 0 before claim() */
  get wid() {
    return this.window ? this.window.id : 0;
  }

  /**
   * Claim the manager selection (ICCCM 2.8): an unmapped window, a real
   * timestamp, `SetSelectionOwner`, and a `MANAGER` announcement on the root
   * so waiting clients adopt the new directory.
   *
   * @returns {Promise<number>} the window id of whoever owns the selection
   *   afterwards — ours when the claim won, the winner's when it raced and
   *   lost, 0 when the server refused the whole dance
   */
  async claim() {
    const X = this.X;
    try {
      const names = [GLYPHD.selection, GLYPHD.ensure, GLYPHD.added, GLYPHD.done, GLYPHD.time];
      const [selection, ensure, added, done, time] = await Promise.all(
        names.map((name) => this._atom(name))
      );
      this._atoms = { selection, ensure, added, done, time };
      this.window = this.app.createWindow({
        width: 1,
        height: 1,
        eventMask: x11.eventMask.PropertyChange
      });
      // ICCCM 2.1: never CurrentTime. The property-append trick gives a real
      // server timestamp; 0 (CurrentTime) is the documented fallback when
      // the server will not answer, which every server ntk targets accepts.
      const stamp = await this._serverTime();
      X.SetSelectionOwner(this.window.id, selection, stamp);
      // SetSelectionOwner is void, and a race is settled by whoever the
      // server says owns the selection now
      const owner = await new Promise((resolve, reject) =>
        X.GetSelectionOwner(selection, (err, wid) => (err ? reject(err) : resolve(wid)))
      );
      if (owner !== this.window.id) {
        this.window.destroy();
        this.window = null;
        return owner;
      }
      this.active = true;
      this.window.on('message', (ev) => this._onMessage(ev));
      // SelectionClear (a successor took over) carries the owner in
      // ev.owner, not ev.wid, so the Window wrapper never sees it — raw
      // listener, the same reason the clipboard has one
      X.on('event', this._onXEvent);
      // announce (ICCCM 2.8): MANAGER on the root with the acquisition
      // timestamp, StructureNotify mask — what surviving clients of a dead
      // directory are listening for
      await this.app
        .rootWindow()
        .sendClientMessage(GLYPHD.manager, [stamp, selection, this.window.id], {
          mask: x11.eventMask.StructureNotify
        });
      return this.window.id;
    } catch {
      if (this.window) {
        this.window.destroy();
        this.window = null;
      }
      this.active = false;
      return 0;
    }
  }

  /**
   * Stop answering. The sets stay: clients still hold aliases into them, and
   * the fence contract ("frees nothing while it owns the selection") has
   * already ended with the ownership — nothing here may free what a reply
   * has advertised, so everything is simply kept until the connection ends.
   */
  deactivate() {
    if (!this.active) return;
    this.active = false;
    this.X.removeListener('event', this._onXEvent);
  }

  _onXEvent(ev) {
    // SelectionClear: another manager took the selection with a later
    // timestamp — the ICCCM handover. It answers from here on.
    if (ev.type === 29 && this.window && ev.owner === this.window.id) this.deactivate();
  }

  _onMessage(ev) {
    if (!this.active || !this._atoms) return;
    if (ev.message_type === this._atoms.ensure) {
      this._serve(ev, true).catch(() => {});
    } else if (ev.message_type === this._atoms.added) {
      this._serve(ev, false).catch(() => {});
    }
  }

  /**
   * One RPC: read the request property off the client's mailbox (the read
   * deletes it), answer, confirm with DONE. Failures on the client's side —
   * a mailbox that vanished mid-request — are its own; every cross-client
   * request here swallows its error rather than warning about a dead peer.
   */
  async _serve(ev, isEnsure) {
    const X = this.X;
    const [mailbox, serial, property] = ev.data;
    const done = (status) => {
      X.SendClientMessage(mailbox, mailbox, this._atoms.done, 32, [serial, status], 0, () => true);
    };
    const prop = await new Promise((resolve) =>
      X.GetProperty(1, mailbox, property, 0, 0, 0x1fffffff, (err, res) => resolve(err ? null : res))
    );
    const request = prop && prop.data ? parseGlyphdRequest(prop.data) : null;
    if (!request || !request.token) return done(0);
    if (isEnsure) {
      const entries = this._ensure(request);
      if (!entries) return done(0);
      const reply = encodeGlyphdReply({
        serial,
        generation: this.generation,
        gsid: this.pages.get(request.token).set.id,
        entries
      });
      X.ChangeProperty(0, mailbox, property, property, 8, reply, () => true);
      return done(1);
    }
    this._added(request);
    return done(1);
  }

  /**
   * Allocate (or look up) a lid per member key, in request order. The single
   * writer of the lid space is what keeps ids compact — dense from 0 in
   * first-asked order, whichever client asked.
   * @returns {Array<{lid, present}>|null} null refuses the request
   */
  _ensure({ token, keys }) {
    let page = this.pages.get(token);
    if (!page) {
      page = { set: new GlyphSet(this.app), members: new Map(), bytes: 0 };
      this.pages.set(token, page);
    }
    const entries = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      let member = page.members.get(keys[i]);
      if (!member) {
        if (page.members.size >= MAX_LIDS) return null;
        member = { lid: page.members.size, present: false };
        page.members.set(keys[i], member);
      }
      entries[i] = member;
    }
    return entries;
  }

  /**
   * A client uploaded: flip the presence bits so later askers skip the
   * rasterization, and count the bytes against the generation budget. A
   * token this generation does not advertise (retired since the client
   * bound) is ignored — the uploader still draws from its own alias, and
   * the next generation simply re-earns those glyphs.
   */
  _added({ token, keys, bytes }) {
    const page = this.pages.get(token);
    if (!page) return;
    for (const key of keys) {
      const member = page.members.get(key);
      if (member) member.present = true;
    }
    page.bytes += bytes;
    this._bytes += bytes;
    if (this._bytes > this.policy.budgetBytes) this._openGeneration();
  }

  /**
   * Eviction, directory style: no set is freed — the current pages retire
   * (pinned here so not even a GC finalizer can free what was advertised)
   * and the next ensure of each token starts a fresh set in a fresh
   * generation. Clients bound to a retired (gsid, generation) notice the
   * mismatch in their next reply and freeze that page.
   */
  _openGeneration() {
    for (const page of this.pages.values()) this._retired.push(page.set);
    this.pages.clear();
    this._bytes = 0;
    this.generation++;
  }

  // a current server timestamp, via the zero-length property append trick
  // (the same one the clipboard uses): the PropertyNotify it provokes
  // carries the server's clock
  _serverTime() {
    return new Promise((resolve) => {
      const finish = (time) => {
        clearTimeout(timer);
        this.window.removeListener('property', onProperty);
        resolve(time);
      };
      const onProperty = (ev) => {
        if (ev.atom === this._atoms.time && ev.state === 0) finish(ev.time >>> 0);
      };
      const timer = setTimeout(() => finish(0), TIME_TIMEOUT);
      timer.unref?.();
      this.window.on('property', onProperty);
      this.X.ChangeProperty(2, this.window.id, this._atoms.time, this.X.atoms.STRING, 8, Buffer.alloc(0));
    });
  }

  _atom(name) {
    return new Promise((resolve, reject) =>
      this.X.InternAtom(false, name, (err, atom) => (err ? reject(err) : resolve(atom)))
    );
  }
}
