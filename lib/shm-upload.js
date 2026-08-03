// Optional MIT-SHM fast path for bulk pixel transfers.
//
// Large PutImage/GetImage traffic on a local connection is much cheaper through
// shared memory than down the socket — roughly 2x on uploads and many times
// faster on readbacks (which otherwise pay for a whole image-sized reply). This
// wraps node-x11's provider-backed MIT-SHM API (X.require('shm')) into a small,
// ordering-safe helper the 2d context and Image use, and falls back to core
// PutImage/GetImage wherever SHM will not attach (remote display, old server,
// no /dev/shm) or the transfer is too small to bother.
//
// Ordering discipline: an SHM upload is only ever issued through a segment that
// is *already attached* — so it slots into the request stream synchronously,
// exactly where a core PutImage would have gone, and never reorders drawing.
// Attaching a segment costs a round trip, so the first upload of a given size
// falls back to core and warms a segment in the background; the next one is a
// synchronous shared-memory write. A segment is returned to the pool only after
// the server signals (ShmCompletion) it has finished reading, so a reused
// buffer is never overwritten mid-read.

// Below this many bytes the socket is as fast as shared memory (measured: a
// PutImage and a tmpfs write are both syscall-bound at a few KB; the win starts
// around 64 KB and grows with size). Coverage masks (a8, 1 byte/pixel) stay
// under it at every size the rasterizer produces, which is why the 2d fill mask
// keeps using core PutImage.
const MIN_UPLOAD_BYTES = 64 * 1024;
// A readback pays the win sooner: a core GetImage reply carries the pixels back
// over the socket and, on some drivers, blocks the server for tens of
// milliseconds, so route more of them through shared memory.
const MIN_READBACK_BYTES = 16 * 1024;
// Round segment sizes up so a handful of buckets serve many nearby sizes and
// the pool actually hits.
const SIZE_QUANTUM = 64 * 1024;

function roundUp(n) {
  return Math.max(SIZE_QUANTUM, Math.ceil(n / SIZE_QUANTUM) * SIZE_QUANTUM);
}

export class ShmUploader {
  /** @param {import('./app.js').default} app */
  constructor(app) {
    this.app = app;
    this.X = app.X;
    this.ext = null; // node-x11 shm extension once required; false if unavailable
    this.ready = false; // usable() confirmed a segment attaches
    this._pool = []; // free, already-read segments (not in flight)
    this._warming = false;
    this._resolving = null;
  }

  /**
   * Resolve availability once (requires the extension and probes usable()).
   * `cb(ready)`. Cheap and idempotent; safe to call before every draw.
   */
  resolve(cb) {
    if (this.ready || this.ext === false) return cb(this.ready);
    if (this._resolving) {
      this._resolving.push(cb);
      return;
    }
    this._resolving = [cb];
    this.X.require('shm', (err, ext) => {
      if (err || !ext) return this._resolved(false, false);
      ext.usable((e, ok) => this._resolved(ok ? ext : false, !!ok));
    });
  }

  _resolved(ext, ready) {
    this.ext = ext;
    this.ready = ready;
    const cbs = this._resolving || [];
    this._resolving = null;
    for (const cb of cbs) cb(ready);
  }

  _acquire(bytes) {
    for (let i = 0; i < this._pool.length; ++i) {
      if (this._pool[i].size >= bytes) return this._pool.splice(i, 1)[0];
    }
    return null;
  }

  _warm(bytes) {
    if (this._warming || !this.ready) return;
    this._warming = true;
    this.ext.createSegment(roundUp(bytes), (err, seg) => {
      this._warming = false;
      if (!err && seg) this._pool.push(seg);
    });
  }

  /**
   * Upload `data` (server-layout pixels, `stride*height` bytes at offset 0) to
   * `drawable` at `dstX,dstY` as a `depth` image `width*height`. Returns true
   * when shared memory handled it (the caller must then issue nothing else),
   * or false to signal "do it with core PutImage" — including every case where
   * SHM is unavailable, too small, or momentarily out of free segments (a
   * segment is warmed in the background for next time).
   */
  putImage(drawable, gc, { width, height, depth, dstX = 0, dstY = 0, data }) {
    const bytes = data.length;
    if (!this.ready || bytes < MIN_UPLOAD_BYTES) return false;
    const seg = this._acquire(bytes);
    if (!seg) {
      this._warm(bytes);
      return false;
    }
    data.copy ? data.copy(seg.buffer, 0, 0, bytes) : seg.buffer.set(data.subarray(0, bytes));
    seg.putImage(drawable, gc, { width, height, depth, dstX, dstY, sendEvent: true });
    // reuse only once the server is done reading it
    seg.once('complete', () => this._pool.push(seg));
    return true;
  }

  /**
   * Whether a readback of `bytes` should use shared memory (usable and large
   * enough). The caller does the async segment dance through `getImage` below.
   */
  wantsReadback(bytes) {
    return this.ready && bytes >= MIN_READBACK_BYTES;
  }

  /**
   * Read `width*height` pixels of `depth` from `drawable` at `x,y` through a
   * shared segment. `cb(err, buffer)` — `buffer` is a view of the segment's
   * bytes valid until the next `getImage`; copy out before then. Falls back is
   * the caller's job: only call this when `wantsReadback` was true.
   */
  getImage(drawable, x, y, width, height, depth, cb) {
    const bytes = width * height * ((depth + 7) >> 3 === 3 ? 4 : (depth + 7) >> 3);
    const use = (seg) => {
      seg.getImage(drawable, x, y, width, height, 0xffffffff, undefined, 0, (err, rep) => {
        if (err) {
          this._pool.push(seg);
          return cb(err);
        }
        // hand back the buffer, then reclaim the segment after the caller has
        // synchronously copied out (they must, per the doc above)
        cb(null, seg.buffer, rep);
        this._pool.push(seg);
      });
    };
    const seg = this._acquire(bytes);
    if (seg) return use(seg);
    this.ext.createSegment(roundUp(bytes), (err, s) => {
      if (err || !s) return cb(err || new Error('shm: no segment'));
      use(s);
    });
  }

  /** Detach every pooled segment (called from App#close). */
  dispose() {
    const pool = this._pool;
    this._pool = [];
    this.ready = false;
    for (const seg of pool) {
      try {
        seg.detach();
      } catch {
        /* connection may already be gone */
      }
    }
  }
}
