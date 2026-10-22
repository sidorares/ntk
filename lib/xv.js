// XVideo: a YCbCr frame handed to the server, which converts it — and can
// scale it — on the GPU (docs/xv.md).
//
// A thin layer over node-x11's Xv requests (x11 >= 4.2 has the image half:
// QueryImageAttributes, PutImage, ShmPutImage, StopVideo), with what every
// caller would otherwise write again:
//
// - **a port**, chosen and grabbed once: the first image adaptor that draws
//   at the depth asked for, and the first port on it no other client holds;
// - **the formats ntk can lay out**, by name — `'NV12'`, `'I420'`, `'YV12'`,
//   `'UYVY'`, `'YUY2'`, `'AR24'` — and the layout the port wants each in at a
//   size, `QueryImageAttributes` asked once per size and kept;
// - **the transport**: a frame goes through a shared-memory segment where
//   MIT-SHM attaches, and down the socket as `PutImage` where it does not and
//   the frame fits one request;
// - **a target**, because a pixmap is not one. Measured on Xwayland's glamor
//   adaptor: `PutImage` into a depth-24 pixmap is `BadWindow`, into a depth-32
//   one `BadMatch` — the textured adaptors take windows only. A window draws
//   on screen and takes the pointer, which is what a video in a layout must
//   not do, so `VideoTarget` is a child window that is **manually
//   redirected** and placed outside its parent: Composite gives it a pixmap
//   of its own that nothing shows, the adaptor draws into that, and RENDER
//   reads it back out wherever the caller composites it, in paint order.
//
// And a clean decline: `openVideoPort` answers `null` where there is no
// XVideo, no image adaptor at the depth, no port free, or an x11 too old for
// the image requests — XQuartz and Xvfb advertise the extension and answer
// "no adaptors present", so a caller always has a path without this one.
//
// Ordering: every request here is a void request issued in line with the
// caller's drawing. A frame through shared memory uses only a segment that is
// already attached (the discipline of lib/shm-upload.js), so a put lands
// exactly where the caller made it, and a composite issued after it reads the
// new frame.

import Picture, { OWN_PICTURE } from './picture.js';
import { safeRelease } from './cleanup.js';

/** The formats ntk lays out, by the FOURCC each is known by. */
export const VIDEO_FOURCC = Object.freeze({
  I420: 0x30323449,
  YV12: 0x32315659,
  NV12: 0x3231564e,
  UYVY: 0x59565955,
  YUY2: 0x32595559,
  AR24: 0x34325241
});

const NAME_OF = new Map(Object.entries(VIDEO_FOURCC).map(([name, id]) => [id, name]));

// Segments a port keeps for frames in flight: one the server is reading, one
// being written, and one spare for a frame pushed before the first came back.
const MAX_SEGMENTS = 3;
const SEGMENT_QUANTUM = 64 * 1024;

const roundUp = (n) => Math.max(SEGMENT_QUANTUM, Math.ceil(n / SEGMENT_QUANTUM) * SEGMENT_QUANTUM);

/**
 * The planes of a `format` frame at `width` x `height`, in the format's own
 * order: the bytes of picture a row of each holds, and how many rows. Chroma
 * subsampled by two is half the size, rounded up; a 4:2:2 packed row is a
 * whole number of pixel pairs.
 */
export function videoPlanes(format, width, height) {
  const cw = Math.ceil(width / 2);
  const ch = Math.ceil(height / 2);
  switch (format) {
    case 'I420':
    case 'YV12':
      return [
        { rowBytes: width, rows: height },
        { rowBytes: cw, rows: ch },
        { rowBytes: cw, rows: ch }
      ];
    case 'NV12':
      return [
        { rowBytes: width, rows: height },
        { rowBytes: cw * 2, rows: ch }
      ];
    case 'UYVY':
    case 'YUY2':
      return [{ rowBytes: cw * 4, rows: height }];
    case 'AR24':
      return [{ rowBytes: width * 4, rows: height }];
  }
  throw new TypeError(`ntk: Xv format ${JSON.stringify(format)} is not one ntk lays out`);
}

/**
 * Copy a frame's planes into `out` at the port's layout: plane `i` at
 * `layout.offsets[i]`, `layout.pitches[i]` bytes a row. `planes` are in the
 * format's own order, `strides` their bytes per row (packed when left out).
 * A plane whose rows already sit at the port's pitch goes in one copy.
 */
export function packVideoFrame(format, width, height, planes, strides, layout, out) {
  const geometry = videoPlanes(format, width, height);
  for (let i = 0; i < geometry.length; i++) {
    const { rowBytes, rows } = geometry[i];
    const src = planes[i];
    const stride = strides?.[i] ?? rowBytes;
    const pitch = layout.pitches[i];
    const at = layout.offsets[i];
    if (stride === pitch) {
      const length = pitch * (rows - 1) + rowBytes;
      out.set(src.subarray(0, length), at);
      continue;
    }
    for (let row = 0; row < rows; row++) {
      const from = row * stride;
      out.set(src.subarray(from, from + rowBytes), at + row * pitch);
    }
  }
  return out;
}

const call = (fn, ...args) =>
  new Promise((resolve, reject) => fn(...args, (err, value) => (err ? reject(err) : resolve(value))));

/**
 * Open a port that draws frames at `depth` (24, the depth every textured
 * adaptor measured offers), or `null` where this server has none to give.
 *
 * Grabs the port: Xv lets any client put through an ungrabbed one, but an
 * attribute another client sets — the colour space — would then change our
 * frames under us. Release it with `close()`; the server releases it with
 * the connection.
 *
 * @param {import('./app.js').default} app
 * @param {{ depth?: number }} [options]
 * @returns {Promise<VideoPort|null>}
 */
export async function openVideoPort(app, { depth = 24 } = {}) {
  const Xv = await app.xv();
  // x11 < 4.2 answers the extension with the query half only
  if (!Xv || typeof Xv.PutImage !== 'function' || typeof Xv.QueryImageAttributes !== 'function') {
    return null;
  }
  const screen = app.display.screen[0];
  let adaptors;
  try {
    adaptors = await call(Xv.QueryAdaptors, screen.root);
  } catch {
    return null;
  }
  const IMAGE = Xv.Type.ImageMask | Xv.Type.InputMask;
  for (const adaptor of adaptors) {
    if ((adaptor.type & IMAGE) !== IMAGE) continue;
    const drawsAt = adaptor.formats.find((f) => f.depth === depth);
    if (!drawsAt) continue;
    for (let port = adaptor.baseId; port < adaptor.baseId + adaptor.numPorts; port++) {
      let status;
      try {
        status = await call(Xv.GrabPort, port, 0);
      } catch {
        continue;
      }
      if (status !== Xv.GrabPortStatus.Success) continue;
      try {
        const [formats, attributes, composite, pictFormat] = await Promise.all([
          call(Xv.ListImageFormats, port),
          call(Xv.QueryPortAttributes, port),
          app.composite(),
          app.pictFormatFor(drawsAt.visual, { depth })
        ]);
        const colorspace = attributes.find(
          (a) => a.name === 'XV_COLORSPACE' && a.flags & Xv.AttributeFlag.Settable && a.min <= 0 && a.max >= 1
        );
        const colorspaceAtom = colorspace ? await call(app.X.InternAtom.bind(app.X), false, 'XV_COLORSPACE') : null;
        await new Promise((resolve) => app.shm.resolve(resolve));
        const opened = new VideoPort(app, Xv, {
          id: port,
          adaptor: adaptor.name,
          depth,
          visual: drawsAt.visual,
          pictFormat,
          formats: formats.map((f) => NAME_OF.get(f.id)).filter(Boolean),
          colorspaceAtom,
          composite
        });
        // the app closes what is still open with the connection
        (app._videoPorts ??= new Set()).add(opened);
        return opened;
      } catch {
        safeRelease(app.X, () => Xv.UngrabPort(port, 0));
        return null;
      }
    }
  }
  return null;
}

/**
 * One grabbed Xv port: what it takes, and `putImage` into a window — most
 * usefully a `VideoTarget`'s (`createTarget`).
 */
export class VideoPort {
  constructor(app, Xv, { id, adaptor, depth, visual, pictFormat, formats, colorspaceAtom, composite }) {
    this.app = app;
    this.X = app.X;
    this.Xv = Xv;
    /** the port's XID */
    this.id = id;
    /** the adaptor's name, as the server gives it — `'glamor textured video'` */
    this.adaptor = adaptor;
    /** the depth of every drawable this port draws into */
    this.depth = depth;
    this.visual = visual;
    this.pictFormat = pictFormat;
    /** the formats the port takes that ntk can lay out, by name */
    this.formats = Object.freeze(formats);
    /**
     * The colour matrices a frame can be put in. Every adaptor reads BT.601
     * when told nothing; one with a settable `XV_COLORSPACE` — glamor's, and
     * the Intel drivers' — reads BT.709 at 1. Every adaptor ntk knows reads
     * video range, black at 16: a full-range frame is not one to put here.
     */
    this.colorSpaces = Object.freeze(colorspaceAtom ? ['bt601', 'bt709'] : ['bt601']);
    this.closed = false;
    this._composite = composite;
    this._colorspaceAtom = colorspaceAtom;
    // Unknown until set: a port's attributes are the server's and outlive
    // the client that set them, so the last one to hold the port — this
    // program's last run, as often as not — left it at whatever it used.
    this._colorspace = null;
    this._layouts = new Map();
    this._pool = [];
    this._segments = 0;
    this._warming = false;
    this._gc = 0;
    this._colormap = 0;
    this._drawables = new Set();
  }

  /** Whether `createTarget` can make a target here: it needs Composite. */
  get targets() {
    return Boolean(this._composite) && !this.closed;
  }

  /**
   * The port's layout for a `format` frame at `width` x `height` —
   * `{ width, height, dataSize, pitches, offsets }`, the size possibly
   * rounded up — or `null` the first time it is asked, while the query is in
   * flight. `prepare` is the same question awaited.
   */
  layout(format, width, height) {
    const key = `${format} ${width}x${height}`;
    const known = this._layouts.get(key);
    if (known && typeof known.then !== 'function') return known;
    if (!known) this._query(key, format, width, height).catch(() => {});
    return null;
  }

  /** `layout`, awaited: resolves once the port has said. */
  prepare(format, width, height) {
    const key = `${format} ${width}x${height}`;
    const known = this._layouts.get(key);
    if (known) return Promise.resolve(known);
    return this._query(key, format, width, height);
  }

  _query(key, format, width, height) {
    const fourcc = VIDEO_FOURCC[format];
    if (!fourcc || !this.formats.includes(format)) {
      return Promise.reject(new Error(`ntk: Xv port ${this.id} takes no ${format}`));
    }
    const pending = call(this.Xv.QueryImageAttributes, this.id, fourcc, width, height).then(
      (layout) => {
        this._layouts.set(key, layout);
        return layout;
      },
      (err) => {
        this._layouts.delete(key);
        throw err;
      }
    );
    this._layouts.set(key, pending);
    return pending;
  }

  /**
   * Set the matrix the next frame is read with. False for one this port
   * cannot be told — and BT.601 is what an adaptor with nothing to set reads.
   */
  setColorSpace(colorSpace) {
    if (!this.colorSpaces.includes(colorSpace)) return false;
    if (!this._colorspaceAtom) return true;
    const value = colorSpace === 'bt709' ? 1 : 0;
    if (value !== this._colorspace) {
      this.Xv.SetPortAttribute(this.id, this._colorspaceAtom, value);
      this._colorspace = value;
    }
    return true;
  }

  /**
   * One frame into `drawable`, a window at the port's depth: converted, and
   * scaled from `src` (frame pixels, the whole frame when left out) to `dst`
   * (drawable pixels, the frame's size at 0,0 when left out).
   *
   * `planes` are the frame's, in the format's own order (`[y, u, v]` for
   * I420, `[y, v, u]` for YV12, `[y, uv]` for NV12, one for the packed ones),
   * with `strides` where a decoder pads its rows; they are copied before
   * this returns, so the caller may reuse them at once.
   *
   * Answers whether the frame was sent. False — and nothing on the wire —
   * for a format the port does not take, a colour space it cannot be told,
   * a size whose layout is not known yet (the first ask starts the query),
   * or a frame too large for one request on a connection with no shared
   * memory. A caller that gets false draws the frame its own way.
   *
   * @param {number} drawable
   * @param {object} frame
   * @param {string} frame.format
   * @param {number} frame.width
   * @param {number} frame.height
   * @param {ArrayLike<Uint8Array>} frame.planes
   * @param {number[]} [frame.strides]
   * @param {{x:number,y:number,width:number,height:number}} [frame.src]
   * @param {{x:number,y:number,width:number,height:number}} [frame.dst]
   * @param {'bt601'|'bt709'} [frame.colorSpace]
   * @returns {boolean}
   */
  putImage(drawable, { format, width, height, planes, strides, src, dst, colorSpace = 'bt601' }) {
    if (this.closed) return false;
    const fourcc = VIDEO_FOURCC[format];
    if (!fourcc || !this.formats.includes(format)) return false;
    const layout = this.layout(format, width, height);
    if (!layout) return false;
    // AR24 is RGB: no matrix to read it with, and no attribute to send
    if (format !== 'AR24' && !this.setColorSpace(colorSpace)) return false;
    const s = src ?? { x: 0, y: 0, width, height };
    const d = dst ?? { x: 0, y: 0, width, height };
    const image = {
      srcX: s.x,
      srcY: s.y,
      srcWidth: s.width,
      srcHeight: s.height,
      drwX: d.x,
      drwY: d.y,
      drwWidth: d.width,
      drwHeight: d.height,
      width: layout.width,
      height: layout.height
    };
    const gc = this._gcFor(drawable);
    const segment = this._acquire(layout.dataSize);
    if (segment) {
      packVideoFrame(format, width, height, planes, strides, layout, segment.buffer);
      segment.commit(0, layout.dataSize);
      this.Xv.ShmPutImage(this.id, drawable, gc, segment.shmseg, fourcc, {
        ...image,
        offset: 0,
        sendEvent: true
      });
      // back in the pool only once the server has read it
      segment.once('complete', () => this._release(segment));
    } else {
      // Down the socket, and node-x11 queues the payload by reference: a
      // buffer of the frame's own, never the segment's.
      const data = Buffer.alloc(layout.dataSize);
      packVideoFrame(format, width, height, planes, strides, layout, data);
      try {
        this.Xv.PutImage(this.id, drawable, gc, fourcc, { ...image, data });
      } catch {
        // larger than one request can carry here: refused before sending
        return false;
      }
    }
    this._drawables.add(drawable);
    return true;
  }

  /** Stop whatever this port is putting into `drawable` — before the
   *  drawable goes, so the server drops what it keeps for the pair. */
  stop(drawable) {
    if (!this._drawables.delete(drawable)) return;
    safeRelease(this.X, () => this.Xv.StopVideo(this.id, drawable));
  }

  /** `drawable` went with its window, and the server dropped what it kept
   *  for the pair itself: nothing to send. */
  forget(drawable) {
    this._drawables.delete(drawable);
  }

  /**
   * A `VideoTarget` under `parent` (an ntk Window or a window id) at
   * `width` x `height`, or null where this server has no Composite.
   */
  createTarget(parent, { width, height }) {
    if (!this.targets) return null;
    return new VideoTarget(this, parent, { width, height });
  }

  /** Ungrab the port and let go of its segments. Idempotent. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.app._videoPorts?.delete(this);
    const X = this.X;
    safeRelease(X, () => {
      for (const drawable of this._drawables) this.Xv.StopVideo(this.id, drawable);
      this.Xv.UngrabPort(this.id, 0);
      if (this._gc) X.FreeGC(this._gc);
      if (this._colormap) X.FreeColormap(this._colormap);
    });
    this._drawables.clear();
    const pool = this._pool;
    this._pool = [];
    for (const segment of pool) detach(segment);
  }

  /** The port's GC: made on the first drawable it draws into, valid for
   *  every drawable at its depth on the screen. */
  _gcFor(drawable) {
    if (!this._gc) {
      this._gc = this.X.AllocID();
      this.X.CreateGC(this._gc, drawable, { graphicsExposures: 0 });
    }
    return this._gc;
  }

  /** The colormap a window on the port's visual is created with. */
  _colormapFor() {
    const screen = this.app.display.screen[0];
    if (this.visual === screen.root_visual) return screen.default_colormap;
    if (!this._colormap) this._colormap = this.app.createColormap(this.visual);
    return this._colormap;
  }

  /**
   * A free attached segment of at least `bytes`, or null — warming one for
   * next time when there is room. A segment too small for the frames now
   * being put is let go on the way past.
   */
  _acquire(bytes) {
    const shm = this.app.shm;
    if (!shm.ready) return null;
    for (let i = 0; i < this._pool.length; i++) {
      const segment = this._pool[i];
      if (segment.size >= bytes) return this._pool.splice(i, 1)[0];
    }
    for (let i = this._pool.length - 1; i >= 0; i--) {
      detach(this._pool[i]);
      this._segments--;
    }
    this._pool.length = 0;
    if (!this._warming && this._segments < MAX_SEGMENTS) {
      this._warming = true;
      this._segments++;
      shm.ext.createSegment(roundUp(bytes), (err, segment) => {
        this._warming = false;
        if (err || !segment) {
          this._segments--;
          return;
        }
        if (this.closed) detach(segment);
        else this._pool.push(segment);
      });
    }
    return null;
  }

  _release(segment) {
    if (this.closed) detach(segment);
    else this._pool.push(segment);
  }
}

function detach(segment) {
  try {
    segment.detach();
  } catch {
    // the connection went first
  }
}

/**
 * Where a port draws a frame that is not to be seen yet: a child window,
 * manually redirected and placed outside its parent, so the server keeps
 * its pixels in a pixmap nothing shows and the pointer never finds it.
 * Shaped like an `Image` — `width`, `height`, `picture(app)` — so
 * `ctx.drawImage(target, …)` composites the last frame put into it, and
 * `copyTo(surface)` keeps one.
 *
 * Its pixels last as long as its parent is mapped: a window that is not
 * viewable has no redirected pixmap, so put a frame and copy it out in the
 * same breath, while the parent is on screen.
 */
export class VideoTarget {
  constructor(port, parent, { width, height }) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error('VideoTarget: width and height must be positive integers');
    }
    const app = port.app;
    const X = app.X;
    this.port = port;
    this.app = app;
    this.width = width;
    this.height = height;
    this.id = X.AllocID();
    const parentId = typeof parent === 'number' ? parent : parent.id;
    // Outside the parent, up and to the left: a redirected window still
    // takes the pointer where it is, and a child entirely outside its
    // parent is where the pointer can never be. Its pixels are its own
    // pixmap's either way (measured at -5000,-5000 on Xwayland).
    X.CreateWindow(this.id, parentId, -width - 1, -height - 1, width, height, 0, port.depth, 1, port.visual, {
      // a depth or visual other than the parent's needs both named
      borderPixel: 0,
      colormap: port._colormapFor(),
      // none: the adaptor writes every pixel, and a cleared one is wasted work
      backgroundPixmap: 0
    });
    const composite = port._composite;
    composite.RedirectWindow(this.id, composite.Redirect.Manual);
    X.MapWindow(this.id);
    this._picture = new Picture(app, {
      drawable: { id: this.id },
      format: port.pictFormat ?? app.display.Render.rgb24
    });
    this._destroyed = false;
    // An ntk Window going takes this one with it, and the server frees the
    // window, its picture and the port's hold on it in the same breath:
    // asking for any of them again afterwards would be three X errors. A
    // parent given by id is the caller's to outlive.
    this._parent = typeof parent === 'object' && typeof parent.once === 'function' ? parent : null;
    this._onParentGone = () => this._gone();
    this._parent?.once('_destroyed', this._onParentGone);
  }

  /** The window went with its parent: forget it all, send nothing. */
  _gone() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.port.forget(this.id);
    this._picture.forget();
  }

  /** Gone: destroyed, or taken with its parent window. */
  get destroyed() {
    return this._destroyed;
  }

  /**
   * Whether a frame put now lands anywhere: false once the target is gone,
   * and while an ntk parent is unmapped — a minimized window, one not yet
   * mapped — when the child has no pixmap to hold it and a copy out of it
   * would read whatever the server has there. A parent given by id is
   * taken to be on screen.
   */
  get viewable() {
    return !this._destroyed && (this._parent === null || this._parent._mapped === true);
  }

  /**
   * A frame into the target, scaled to fill it: `port.putImage` with the
   * destination named. False where the target is not `viewable`, or the
   * port declined (see there).
   */
  put(frame) {
    if (!this.viewable) return false;
    return this.port.putImage(this.id, {
      ...frame,
      dst: { x: 0, y: 0, width: this.width, height: this.height }
    });
  }

  /** The picture, read as stored, as `Surface.picture(app)` is. */
  picture(app) {
    return this[OWN_PICTURE](app)._settle();
  }

  [OWN_PICTURE](app) {
    if (app && app !== this.app) {
      throw new Error('VideoTarget: belongs to a different X connection');
    }
    return this._picture;
  }

  /**
   * The last frame into `destination` — an ntk `Surface`, or anything with
   * its picture — at `dx`, `dy`: one server-side copy, alpha opaque, in
   * line with the put before it.
   */
  copyTo(destination, dx = 0, dy = 0) {
    if (this._destroyed) return;
    const R = this.app.display.Render;
    const dst = destination[OWN_PICTURE]?.(this.app) ?? destination.picture(this.app);
    R.Composite(R.PictOp.Src, this._picture.id, 0, dst.id, 0, 0, 0, 0, dx, dy, this.width, this.height);
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._parent?.off('_destroyed', this._onParentGone);
    this.port.stop(this.id);
    this._picture.destroy();
    safeRelease(this.app.X, () => this.app.X.DestroyWindow(this.id));
  }

  [Symbol.dispose]() {
    this.destroy();
  }
}
