// The swap chain behind a direct rendering context: GPU buffers in, X pixmaps
// out, and the bookkeeping that keeps the two in step.
//
// A frame's life:
//
//   draw with GL  ->  surface.swap()  ->  dma-buf fd (first time only)
//                     -> DRI3.PixmapFromBuffer  -> a pixmap for that buffer
//                     -> Present.Pixmap         -> shown at the next vblank
//                     <- PresentIdleNotify      -> the buffer is ours again
//
// No pixel data crosses the socket: the descriptor is passed once per buffer,
// and every later frame in that buffer is a Present of a pixmap the server
// already has.
//
// Two rules shape the code. **A buffer belongs to the server until IdleNotify
// says otherwise** — drawing into one before then paints whatever is on
// screen — so a buffer is released back to GBM there and nowhere else. And
// **a pixmap must exist before it is presented**: a new buffer's import is
// confirmed by a round trip before the first Present names it, or the Present
// would fail with BadPixmap. A new buffer appears a handful of times per
// generation (and never again in steady state), so that round trip is a
// startup cost, not a per-frame one.

import { GLError, glError } from './gl.js';

// bpp is 32 for both formats we use; depth is what tells them apart (24 =
// XRGB, no alpha; 32 = ARGB, per-pixel alpha the compositor blends)
const BPP = 32;

/**
 * One generation of buffers: a GBM surface at one size, and the pixmap each
 * of its buffers was imported as.
 *
 * A resize cannot just drop the old surface — the server may still be
 * scanning out one of its buffers — so the old generation is retired and
 * torn down as its buffers come back idle.
 */
class Generation {
  constructor(surface, width, height, linear) {
    this.surface = surface;
    this.width = width;
    this.height = height;
    this.linear = linear;
    this.pixmaps = new Map(); // buffer key -> { pixmap, busy }
    this.retired = false;
  }

  /** buffers the server still holds */
  get busyCount() {
    let n = 0;
    for (const entry of this.pixmaps.values()) if (entry.busy) n++;
    return n;
  }
}

export class GLSwapchain {
  /**
   * @param {object} opts
   * @param {import('./window.js').default} opts.window the drawable presented to
   * @param {object} opts.gpu an x11-dri Gpu
   * @param {object} opts.dri the x11-dri module
   * @param {object} opts.DRI3 node-x11 dri3 extension
   * @param {object} opts.Present node-x11 present extension
   * @param {number} opts.depth the window's depth (24 or 32)
   * @param {object} opts.policy resolved glPolicy
   */
  constructor({ window, gpu, dri, DRI3, Present, depth, policy }) {
    this.window = window;
    this.X = window.X;
    this.gpu = gpu;
    this.dri = dri;
    this.DRI3 = DRI3;
    this.Present = Present;
    this.depth = depth;
    this.policy = policy;

    this.generation = null;
    this.retired = [];
    this.serial = 0;
    this.inFlight = 0;
    /** an import is being confirmed; no frame may swap until it lands */
    this.importing = false;
    /** the last swap found every buffer busy — a frame is owed once one frees */
    this.starved = false;
    this.destroyed = false;
    this.error = null;
    /** called when a frame became possible again (idle buffer, import done) */
    this.onReady = null;
    /** called once the first buffer has been imported, or it failed */
    this.onValidated = null;
    this._validated = false;

    this._eid = this.X.AllocID();
    this.Present.SelectInput(
      this._eid,
      window.id,
      Present.EventMask.CompleteNotify | Present.EventMask.IdleNotify
    );
  }

  /**
   * Point the chain at a size. Returns the GBM surface to draw into, creating
   * a new generation when the size changed.
   */
  surfaceFor(width, height) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const gen = this.generation;
    if (gen && gen.width === w && gen.height === h) return gen.surface;
    this._retire(gen);
    // a generation that had to go linear keeps that layout: whatever made the
    // server refuse the tiled buffer has not changed since
    return this._newGeneration(w, h, gen ? gen.linear : false);
  }

  _newGeneration(w, h, linear) {
    const use = linear ? this.dri.GBM_USE.RENDERING | this.dri.GBM_USE.LINEAR : undefined;
    let surface;
    try {
      surface = use === undefined ? this.gpu.createSurface(w, h) : this.gpu.createSurface(w, h, use);
    } catch (err) {
      throw glError(GLError.CONTEXT_FAILED, `could not create a ${w}x${h} GPU surface: ${err.message}`, null, err);
    }
    this.generation = new Generation(surface, w, h, linear);
    return surface;
  }

  /** Can a frame be drawn and presented right now? */
  canRender() {
    if (this.destroyed || this.error) return false;
    if (this.importing) return false;
    return this.inFlight < this.policy.maxInFlight;
  }

  /**
   * Show what was just drawn.
   *
   * Returns false when the frame could not go out — every buffer still held
   * by the server, or an import in flight. The frame is not lost: `onReady`
   * fires when one is free again, and the caller draws it then.
   */
  swap() {
    if (this.destroyed || this.error || this.importing) return false;
    const gen = this.generation;
    if (!gen) return false;

    let out;
    try {
      out = gen.surface.swap();
    } catch (err) {
      this._fail(glError(GLError.CONTEXT_FAILED, `GPU buffer swap failed: ${err.message}`, null, err));
      return false;
    }
    // every buffer is still on the server's side of the fence
    if (!out) {
      this.starved = true;
      return false;
    }
    this.starved = false;

    const known = gen.pixmaps.get(out.key);
    if (known) {
      this._present(gen, out.key, known);
      return true;
    }
    this._import(gen, out, true);
    return true;
  }

  /**
   * Prove the path before anything is drawn: take a buffer, hand its
   * descriptor to the server, and give it straight back.
   *
   * `ready` has to be answerable *before* the first frame — a caller deciding
   * whether to render a fallback cannot be asked to render a frame first, and
   * `await gl.ready` before drawing is the obvious thing to write. Importing
   * without presenting settles it at no cost: the import is what every part of
   * the path has to survive (a descriptor over the socket, a server willing to
   * take this device's buffers), showing it is not, and the pixmap stays
   * cached for whichever frame draws into that buffer later.
   */
  validate() {
    if (this._validated || this.destroyed || this.error) return;
    const gen = this.generation;
    if (!gen) return;
    let out;
    try {
      out = gen.surface.swap();
    } catch (err) {
      return this._fail(glError(GLError.CONTEXT_FAILED, `GPU buffer swap failed: ${err.message}`, null, err));
    }
    // a fresh surface always has a buffer to give, and a new one is new
    if (!out) return;
    if (!out.isNew) return this._validate(null);
    this._import(gen, out, false);
  }

  /**
   * A buffer the server has not seen: hand over its descriptor, and only
   * present it once the server confirms it took it — a Present naming a
   * pixmap whose import failed is a BadPixmap, which would bury the real
   * error under a second one.
   *
   * @param {boolean} present show this buffer once it is imported, or hand it
   *   straight back (the validation path, which has drawn nothing worth
   *   showing)
   */
  _import(gen, out, present) {
    const pixmap = this.X.AllocID();
    const entry = { pixmap, busy: false };
    this.importing = true;
    this.DRI3.PixmapFromBuffer(
      pixmap,
      this.window.id,
      {
        fd: out.fd,
        width: out.width,
        height: out.height,
        stride: out.stride,
        depth: this.depth,
        bpp: BPP
      },
      (err) => {
        this.importing = false;
        if (this.destroyed) return;
        if (err) return this._importFailed(gen, out, present, err);
        gen.pixmaps.set(out.key, entry);
        this._validate(null);
        // the generation may have been retired while this was in flight; its
        // buffer is still ours to give back, and the pixmap still needs freeing
        if (gen.retired) {
          this._releaseBuffer(gen, out.key, entry);
          this._sweep(gen);
        } else if (present) {
          this._present(gen, out.key, entry);
        } else {
          this._releaseBuffer(gen, out.key, entry);
        }
        this.onReady?.();
      }
    );
    this.X.flush?.();
  }

  /**
   * The server would not take the buffer. Almost always this means client and
   * server are on different DRM devices and the tiled layout means nothing to
   * the one displaying it — which a linear buffer fixes, at the cost of some
   * bandwidth. Worth one retry before giving up on the whole backend.
   */
  _importFailed(gen, out, present, err) {
    if (this.policy.linearFallback && !gen.linear && !this._validated) {
      const { width, height } = gen;
      this._retire(gen);
      try {
        this._newGeneration(width, height, true);
      } catch (retryErr) {
        return this._fail(retryErr);
      }
      // the retry has to happen here: on the validation path there is no
      // frame loop yet to come back and try again
      if (!present) this.validate();
      this.onReady?.();
      return;
    }
    this._fail(
      glError(
        GLError.IMPORT_FAILED,
        `the X server refused the GPU buffer (${err.message}), so there is nothing to show`,
        'Client and server are probably on different DRM devices. Name the server\'s\n' +
          "device with glPolicy: { devicePath: '/dev/dri/renderD###' }, or fall back to\n" +
          "indirect GLX with glPolicy: 'indirect'.",
        err
      )
    );
  }

  _present(gen, key, entry) {
    entry.busy = true;
    this.inFlight++;
    // targetMsc 0 is "the next vblank", and no Option.Copy: a swap chain wants
    // the server to flip when it can, which is the copy-free path. IdleNotify
    // is what says the buffer came back, whichever it did.
    this.Present.Pixmap(this.window.id, entry.pixmap, { serial: ++this.serial });
    this.X.flush?.();
  }

  /** Present's events for this window: CompleteNotify and IdleNotify. */
  handleEvent(ev) {
    if (this.destroyed) return;
    const P = this.Present;
    if (ev.evtype === P.events.IdleNotify) return this._onIdle(ev);
  }

  _onIdle(ev) {
    for (const gen of this._generations()) {
      for (const [key, entry] of gen.pixmaps) {
        if (entry.pixmap !== ev.pixmap || !entry.busy) continue;
        this.inFlight = Math.max(0, this.inFlight - 1);
        this._releaseBuffer(gen, key, entry);
        // every retired generation, not just this buffer's: a sweep can be
        // held back by an import in flight, and this is where it gets another
        // chance to finish
        this._sweepRetired();
        // a frame that could not draw for want of a buffer now can
        if (this.starved || this.inFlight < this.policy.maxInFlight) this.onReady?.();
        return;
      }
    }
  }

  /** Give a buffer back to GBM so the next frame can be drawn into it. */
  _releaseBuffer(gen, key, entry) {
    entry.busy = false;
    try {
      gen.surface.release(key);
    } catch {
      // a destroyed surface has nothing to take back
    }
  }

  *_generations() {
    if (this.generation) yield this.generation;
    yield* this.retired;
  }

  /**
   * Resolve the "does this actually work" promise, once. The first successful
   * import proves the whole path — addon, device, descriptor passing, and a
   * server willing to take the buffer.
   */
  _validate(err) {
    if (this._validated) return;
    this._validated = true;
    this.onValidated?.(err);
  }

  _fail(err) {
    if (this.error) return;
    this.error = err;
    this._validate(err);
  }

  _retire(gen) {
    if (!gen || gen.retired) return;
    gen.retired = true;
    this.retired.push(gen);
    this.generation = null;
    this._sweep(gen);
  }

  _sweepRetired() {
    for (const gen of [...this.retired]) this._sweep(gen);
  }

  /** Free what a retired generation no longer needs; drop it when empty. */
  _sweep(gen) {
    for (const [key, entry] of gen.pixmaps) {
      if (entry.busy) continue;
      gen.pixmaps.delete(key);
      this._freePixmap(entry.pixmap);
    }
    if (gen.pixmaps.size || this.importing) return;
    const index = this.retired.indexOf(gen);
    if (index >= 0) this.retired.splice(index, 1);
    try {
      gen.surface.destroy();
    } catch {
      // already gone
    }
  }

  _freePixmap(pixmap) {
    try {
      this.X.FreePixmap(pixmap);
    } catch {
      // the connection is closing; the server frees everything with it
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.onReady = null;
    this.onValidated = null;
    for (const gen of this._generations()) {
      for (const entry of gen.pixmaps.values()) this._freePixmap(entry.pixmap);
      gen.pixmaps.clear();
      try {
        gen.surface.destroy();
      } catch {
        // already gone
      }
    }
    this.generation = null;
    this.retired.length = 0;
    if (this._eid) {
      try {
        this.Present.SelectInput(this._eid, this.window.id, this.Present.EventMask.NoEvent);
      } catch {
        // the window or the connection is already gone
      }
      this._eid = 0;
    }
  }
}

export default GLSwapchain;
