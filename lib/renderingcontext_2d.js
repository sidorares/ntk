import parseFontStyle from 'canvas-fontstyle';
import extrudePolyline from 'extrude-polyline';

import { safeRelease } from './cleanup.js';
import { cssColor } from './color.js';
import Drawable from './drawable.js';
import { Image } from './image.js';
import { ImageData, fromStraightRgba, pixelLayout, toStraightRgba } from './imagedata.js';
import {
  Path2D,
  flattenPath,
  transformCommands,
  ellipseSegments,
  polysContain,
  matApply,
  matInvert,
  matIsIdentity,
  matMultiply
} from './path.js';
import Picture from './picture.js';
import Pixmap from './pixmap.js';
import { routeRaster } from './rasterize.js';
import { compositeTraps, drawGlyphRuns } from './text/glyphs.js';
import { TextLayout } from './text/layout.js';
import { reorderRuns } from './text/shape.js';
import { trapezoidize } from './trapezoid.js';

const DEFAULT_FONT = '20px sans-serif';

/**
 * Fallback for a context dropped without `destroy()`, matching Pixmap,
 * Picture and GlyphSet. Only the GCs are freed here: everything else a
 * context owns is a Pixmap or a Picture, which carry their own finalizers,
 * and reaching into them from this one would race those.
 */
const gcRegistry = new FinalizationRegistry(({ X, gcs }) => {
  safeRelease(X, () => {
    for (const gc of gcs) {
      if (!gc) continue;
      X.FreeGC(gc);
      X.ReleaseID(gc);
    }
  });
});

/**
 * What `drawImage` takes as a server-side source: anything that knows its own
 * size and can hand over a `Picture` for this connection.
 *
 * `Image` is client pixels uploaded once; `Surface` is pixels the server drew
 * itself. Neither is special — the contract is the two members, so a caller
 * with its own cache of rendered things can satisfy it without ntk knowing
 * the type. A `RenderingContext2d` deliberately does not match: its `picture`
 * is a property rather than a method, and it keeps its own branch below.
 */
/** a fillStyle with a single colour behind it, as opposed to a gradient or a
 * caller-supplied Picture */
function isPlainColor(style) {
  return typeof style === 'string' || Array.isArray(style);
}

function isPictureSource(image) {
  return (
    image instanceof Image ||
    (image != null &&
      typeof image.picture === 'function' &&
      Number.isFinite(image.width) &&
      Number.isFinite(image.height))
  );
}

// canvas globalCompositeOperation -> XRender PictOp name. Porter-Duff ops
// map directly; with a clip/shape mask active the op only applies inside
// the mask coverage (outside pixels are left untouched).
const GCO_TO_PICTOP = {
  'source-over': 'Over',
  copy: 'Src',
  'destination-over': 'OverReverse',
  'source-in': 'In',
  'destination-in': 'InReverse',
  'source-out': 'Out',
  'destination-out': 'OutReverse',
  'source-atop': 'Atop',
  'destination-atop': 'AtopReverse',
  xor: 'Xor',
  lighter: 'Add'
};

// extrude-polyline has no round caps/joins: 'round' extrudes as butt/bevel
// and the missing coverage is unioned in afterwards as triangle-fan disks
// (see _strokePolys)
const LINE_CAP = { butt: 'butt', square: 'square', round: 'butt' };
const LINE_JOIN = { miter: 'miter', bevel: 'bevel', round: 'bevel' };

/**
 * Split a device-space polyline into dash "on" runs by arc length.
 *
 * `pts` is [[x, y], ...] with no consecutive duplicates; for closed subpaths
 * the closing point is already appended, and the pattern continues around the
 * loop as one uninterrupted walk. Returns null when the pattern cannot
 * produce gaps (all-zero), otherwise { runs, closedLoop }: `runs` is a list
 * of [[x, y], ...] open polylines (caps apply to each), `closedLoop` marks a
 * closed subpath the pattern never split — stroke it closed, with no caps.
 */
function dashPolyline(pts, closed, pattern, offset) {
  let total = 0;
  for (const d of pattern) total += d;
  if (!(total > 0)) return null;

  // starting phase: offset into the pattern, wrapped into [0, total)
  let phase = offset % total;
  if (phase < 0) phase += total;
  let idx = 0;
  while (phase > 0 && phase >= pattern[idx]) {
    phase -= pattern[idx];
    idx = (idx + 1) % pattern.length;
  }

  let on = idx % 2 === 0; // even entries are "on", odd are gaps
  const startedOn = on;
  let toggled = false;
  let remain = pattern[idx] - phase;
  const runs = [];
  let cur = on ? [pts[0]] : null;
  let x0 = pts[0][0];
  let y0 = pts[0][1];

  for (let i = 1; i < pts.length; i++) {
    const x1 = pts[i][0];
    const y1 = pts[i][1];
    let len = Math.hypot(x1 - x0, y1 - y0);
    while (len > remain) {
      // cross a dash boundary inside this segment
      const t = len > 0 ? remain / len : 0;
      const bx = x0 + (x1 - x0) * t;
      const by = y0 + (y1 - y0) * t;
      if (on) {
        cur.push([bx, by]);
        runs.push(cur);
        cur = null;
      } else {
        cur = [[bx, by]];
      }
      on = !on;
      toggled = true;
      x0 = bx;
      y0 = by;
      len = Math.hypot(x1 - x0, y1 - y0);
      idx = (idx + 1) % pattern.length;
      remain = pattern[idx];
    }
    remain -= len;
    if (on) cur.push([x1, y1]);
    x0 = x1;
    y0 = y1;
  }
  if (cur) runs.push(cur);

  if (closed && !toggled) return { runs, closedLoop: startedOn };
  // closed subpath with dashes on both sides of the seam: merge the last
  // run into the first so no caps appear at the seam
  if (closed && startedOn && on && runs.length > 1) {
    const last = runs.pop();
    runs[0] = last.concat(runs[0].slice(1));
  }
  return { runs, closedLoop: false };
}

// An array is taken as already-premultiplied `[r, g, b, a]` in 0..1 (the
// documented form in docs/context-2d.md), so it passes through untouched; a
// string is a CSS colour and gets premultiplied on the way in. Both end up in
// createSolidPicture, which hands them to XRender.
function parseColor(value) {
  if (Array.isArray(value)) return value;
  const c = cssColor(value);
  if (!c) throw new Error(`Not a color: ${JSON.stringify(value)}`);
  return c;
}

/**
 * Canvas-like 2d rendering context backed by the XRender extension: most
 * operations (composition, gradients, text composition) happen server-side.
 *
 * Paths follow the HTML canvas model: the default path records points with
 * the current transform applied at command time; `Path2D` objects are
 * transformed when filled/stroked/clipped. See docs/context-2d.md for the
 * supported surface and the differences from the browser canvas.
 */
class RenderingContext2d {
  constructor(window) {
    const X = window.X;
    this.X = X;
    // ids land here as they are allocated; the finalizer holds this array
    // rather than the context, so registering cannot keep the context alive
    this._gcs = [];
    gcRegistry.register(this, { X, gcs: this._gcs }, this);

    this.window = window;
    this.display = window.app.display;
    this.Render = this.display.Render;
    this._layoutCache = null;

    // draw into the window's backing pixmap when it has one (double
    // buffering); re-bind when the backing pixmap is reallocated on resize
    this._target = null;
    this._gc = null;
    this.picture = null;
    this._bindTarget();
    if (typeof window.on === 'function') {
      window.on('_backing', () => this._bindTarget());
      // masks are sized to the drawable — recreate them after a resize
      window.on('resize', () => this._dropMasks());
      // window-backed pictures are freed server-side with the window
      window.on('_destroyed', () => {
        if (this.picture && this._target === this.window) {
          this.picture.forget();
          this.picture = null;
        }
      });
    }

    this._solidPictures = new Map();
    this.fillMask = null;
    this.fillMaskDrawable = null;
    this.clipMask = null;
    this.clipMaskDrawable = null;
    this._textStyle = null;
    this._lastFontString = null;
    this.textAlign = 'start';
    this.textBaseline = 'alphabetic';

    this._path = new Path2D();
    this._m = [1, 0, 0, 1, 0, 0];
    this._stack = [];
    this._clips = []; // [{ polys, rule }] in device space, already stacked
    this._gco = 'source-over';
    this.globalAlpha = 1;
    this.lineCap = 'butt';
    this.lineJoin = 'miter';
    this.miterLimit = 10;
    this._lineDash = [];
    this._lineDashOffset = 0;

    this.fillStyle = 'white';
    this.strokeStyle = 'black';
    this.lineWidth = 1;
  }

  _bindTarget() {
    const target = this.window._backing || this.window;
    if (this._target === target) return;
    this._target = target;
    this._layoutCache = null; // the new target may be a different depth

    if (!this._gc) {
      // one GC is enough: it stays valid for any drawable of the same
      // screen and depth (the backing pixmap matches the window depth)
      this._gc = this.X.AllocID();
      this._gcs.push(this._gc);
      this.X.CreateGC(this._gc, target.id);
    }
    if (this.picture) this.picture.destroy();
    // a8 targets are coverage, not colour: drawing into one and using the
    // result as a mask is how a monochrome drawing gets rendered once and
    // recoloured on every use (see Surface).
    const depth = target.depth ?? this.window.depth;
    const format =
      depth === 32
        ? this.Render.rgba32
        : depth === 8
          ? this.Render.a8
          : this.Render.rgb24;
    this.picture = new Picture(this.window.app, {
      drawable: target,
      format,
      polyEdge: 1,
      polyMode: 1
    });
    this._dropMasks();
  }

  /**
   * Release everything this context allocated server-side. Idempotent, and
   * the context must not be drawn with afterwards.
   *
   * A context bound to a window normally lives as long as the window and the
   * connection outlives both, which is why this went missing for so long (see
   * issue #156). It matters as soon as contexts are created *dynamically* —
   * one per offscreen `Surface`, say — because without it each one
   * permanently costs a GC, a Picture, and a 1x1 pixmap per fill colour used.
   *
   * `_backgroundPicture` and `_glyphSource` are deliberately not freed here:
   * both are either aliases into `_solidPictures`, already freed below, or a
   * `Picture`/`CanvasGradient` the caller passed in through `fillStyle`,
   * which is not ours to free.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    gcRegistry.unregister(this);

    this._clips = [];
    this._dropMasks();
    for (const gc of [this._gc, this._fillMaskGC]) {
      if (!gc) continue;
      safeRelease(this.X, () => {
        this.X.FreeGC(gc);
        this.X.ReleaseID(gc);
      });
    }
    this._gc = this._fillMaskGC = null;
    this._gcs.length = 0;

    for (const picture of this._solidPictures.values()) {
      picture.destroy();
      picture._sourcePixmap?.destroy();
    }
    this._solidPictures.clear();
    this._backgroundPicture = this._glyphSource = null;

    if (this.picture) {
      // a picture on a *window* is freed by the server with the window;
      // asking again would raise BadPicture. Same rule as `_destroyed`.
      if (this._target === this.window && !(this.window instanceof Pixmap)) {
        this.picture.forget();
      } else {
        this.picture.destroy();
      }
      this.picture = null;
    }
  }

  [Symbol.dispose]() {
    this.destroy();
  }

  _dropMasks() {
    if (this.fillMask) {
      this.fillMask.destroy();
      this.fillMaskDrawable.destroy();
      this.fillMask = this.fillMaskDrawable = null;
    }
    if (this.clipMask) {
      this.clipMask.destroy();
      this.clipMaskDrawable.destroy();
      this.clipMask = this.clipMaskDrawable = null;
    }
    // clip paths are device-space and survive the resize; rebuild the mask
    if (this._clips && this._clips.length) this._rebuildClipMask();
  }

  // notify a double-buffered window that its backing content changed
  _markDirty() {
    if (typeof this.window._markDirty !== 'function') return;
    // The clip bounds everything this operation could have touched, so it is
    // also the region the window has to blit. Reporting it lets the present
    // copy the part of the backing store that changed instead of all of it —
    // a hover repaint of two tab headers used to blit the whole window. A
    // context with no rectangular clip reports nothing, and the window falls
    // back to a full blit, which is what any drawing outside a clip needs.
    this.window._markDirty(this._clips.length ? this._clipRect() : null);
  }

  // html context2d compatibility: canvas.getContext('2d').canvas == canvas
  get canvas() {
    return this.window;
  }

  get width() {
    return this.window.width;
  }

  get height() {
    return this.window.height;
  }

  _op() {
    return this.Render.PictOp[GCO_TO_PICTOP[this._gco] || 'Over'];
  }

  set globalCompositeOperation(value) {
    if (value in GCO_TO_PICTOP) this._gco = value;
  }

  get globalCompositeOperation() {
    return this._gco;
  }

  createSolidPicture(r, g, b, a) {
    const key = [r, g, b, a].join('|');
    let p = this._solidPictures.get(key);
    if (p) return p;

    // TODO: use window.createPixmap
    const pixmap = new Pixmap(this.window.app, { depth: 32, width: 1, height: 1 });
    const pictSolidPix = this.window.X.AllocID();
    this.Render.CreatePicture(pictSolidPix, pixmap.id, this.Render.rgba32, { repeat: 1 });
    this.Render.FillRectangles(1, pictSolidPix, [r, g, b, a], [0, 0, 100, 100]);
    p = new Picture(this.window.app, { id: pictSolidPix });
    p._sourcePixmap = pixmap; // keep the 1x1 pixmap alive alongside the picture
    this._solidPictures.set(key, p);
    return p;
  }

  _stylePicture(value) {
    if (typeof value === 'string' || Array.isArray(value)) {
      const c = parseColor(value);
      return this.createSolidPicture(c[0], c[1], c[2], c[3]);
    }
    if (value instanceof Picture || value instanceof CanvasGradient) {
      return value;
    }
    throw new Error('Unknown fill style');
  }

  set fillStyle(value) {
    this._fillStyle = value;
    this._backgroundPicture = this._stylePicture(value);
  }

  get fillStyle() {
    return this._fillStyle;
  }

  set strokeStyle(value) {
    this._strokeStyle = value;
    this._strokePicture = this._stylePicture(value);
  }

  get strokeStyle() {
    return this._strokeStyle;
  }

  /**
   * Canvas-spec dash list: values are distances (user-space units) of
   * alternating dashes and gaps. An empty list means solid; an odd-length
   * list is doubled; any negative or non-finite value invalidates the whole
   * call (it is ignored).
   */
  setLineDash(segments) {
    const list = Array.from(segments ?? [], Number);
    for (const v of list) if (!Number.isFinite(v) || v < 0) return;
    this._lineDash = list.length % 2 ? list.concat(list) : list;
  }

  getLineDash() {
    return this._lineDash.slice();
  }

  set lineDashOffset(value) {
    const v = Number(value);
    if (Number.isFinite(v)) this._lineDashOffset = v;
  }

  get lineDashOffset() {
    return this._lineDashOffset;
  }

  // ------------------------------------------------------------------
  // state

  save() {
    this._stack.push({
      fillStyle: this._fillStyle,
      strokeStyle: this._strokeStyle,
      lineWidth: this.lineWidth,
      lineCap: this.lineCap,
      lineJoin: this.lineJoin,
      miterLimit: this.miterLimit,
      lineDash: this._lineDash, // never mutated in place: safe to share
      lineDashOffset: this._lineDashOffset,
      globalAlpha: this.globalAlpha,
      gco: this._gco,
      textStyle: this._textStyle,
      fontString: this._lastFontString,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
      m: this._m.slice(),
      clips: this._clips
    });
  }

  restore() {
    const s = this._stack.pop();
    if (!s) return;
    this.fillStyle = s.fillStyle;
    this.strokeStyle = s.strokeStyle;
    this.lineWidth = s.lineWidth;
    this.lineCap = s.lineCap;
    this.lineJoin = s.lineJoin;
    this.miterLimit = s.miterLimit;
    this._lineDash = s.lineDash;
    this._lineDashOffset = s.lineDashOffset;
    this.globalAlpha = s.globalAlpha;
    this._gco = s.gco;
    this._textStyle = s.textStyle;
    this._lastFontString = s.fontString;
    this.textAlign = s.textAlign;
    this.textBaseline = s.textBaseline;
    this._m = s.m;
    if (s.clips !== this._clips) {
      this._clips = s.clips;
      this._rebuildClipMask();
    }
  }

  // ------------------------------------------------------------------
  // transform

  translate(x, y) {
    this._m = matMultiply(this._m, [1, 0, 0, 1, x, y]);
  }

  rotate(angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    this._m = matMultiply(this._m, [c, s, -s, c, 0, 0]);
  }

  scale(x, y = x) {
    this._m = matMultiply(this._m, [x, 0, 0, y, 0, 0]);
  }

  transform(a, b, c, d, e, f) {
    this._m = matMultiply(this._m, [a, b, c, d, e, f]);
  }

  setTransform(a, b, c, d, e, f) {
    if (typeof a === 'object' && a !== null) {
      const m = a;
      this._m = Array.isArray(m) ? m.slice(0, 6) : [m.a, m.b, m.c, m.d, m.e, m.f];
      return;
    }
    if (a === undefined) return this.resetTransform();
    this._m = [a, b, c, d, e, f];
  }

  resetTransform() {
    this._m = [1, 0, 0, 1, 0, 0];
  }

  getTransform() {
    const [a, b, c, d, e, f] = this._m;
    return { a, b, c, d, e, f };
  }

  // ------------------------------------------------------------------
  // path building (default path is recorded in device space, per spec)

  beginPath() {
    this._path = new Path2D();
  }

  closePath() {
    this._path.closePath();
  }

  moveTo(x, y) {
    const [dx, dy] = matApply(this._m, x, y);
    this._path.moveTo(dx, dy);
  }

  lineTo(x, y) {
    const [dx, dy] = matApply(this._m, x, y);
    this._path.lineTo(dx, dy);
  }

  bezierCurveTo(x1, y1, x2, y2, x, y) {
    const [dx1, dy1] = matApply(this._m, x1, y1);
    const [dx2, dy2] = matApply(this._m, x2, y2);
    const [dx, dy] = matApply(this._m, x, y);
    this._path.bezierCurveTo(dx1, dy1, dx2, dy2, dx, dy);
  }

  quadraticCurveTo(x1, y1, x, y) {
    const [dx1, dy1] = matApply(this._m, x1, y1);
    const [dx, dy] = matApply(this._m, x, y);
    this._path.quadraticCurveTo(dx1, dy1, dx, dy);
  }

  // append user-space segments ({start, cmds}) through the current transform
  _appendUserSegments({ start, cmds }) {
    const [dsx, dsy] = matApply(this._m, start.x, start.y);
    if (this._path._x === null) this._path.moveTo(dsx, dsy);
    else this._path.lineTo(dsx, dsy);
    this._path._append(transformCommands(cmds, this._m));
  }

  arc(x, y, r, startAngle, endAngle, counterclockwise = false) {
    if (r < 0) throw new RangeError('arc: negative radius');
    this._appendUserSegments(ellipseSegments(x, y, r, r, 0, startAngle, endAngle, counterclockwise));
  }

  ellipse(x, y, rx, ry, rotation, startAngle, endAngle, counterclockwise = false) {
    if (rx < 0 || ry < 0) throw new RangeError('ellipse: negative radius');
    this._appendUserSegments(ellipseSegments(x, y, rx, ry, rotation, startAngle, endAngle, counterclockwise));
  }

  arcTo(x1, y1, x2, y2, r) {
    if (this._path._x === null) return this.moveTo(x1, y1);
    const inv = matInvert(this._m);
    if (!inv) return;
    const [ux, uy] = matApply(inv, this._path._x, this._path._y);
    const tmp = new Path2D();
    tmp.moveTo(ux, uy);
    tmp.arcTo(x1, y1, x2, y2, r);
    // drop the seed moveTo: the current point is already there
    this._path._append(transformCommands(tmp._cmds.slice(1), this._m));
  }

  rect(x, y, w, h) {
    const tmp = new Path2D();
    tmp.rect(x, y, w, h);
    this._path.addPath(tmp, this._m);
  }

  roundRect(x, y, w, h, radii) {
    const tmp = new Path2D();
    tmp.roundRect(x, y, w, h, radii);
    this._path.addPath(tmp, this._m);
  }

  // args: ([path], [fillRule]) — returns device-space polys + rule
  _polysFor(args) {
    if (args[0] instanceof Path2D) {
      return {
        polys: flattenPath(args[0]._cmds, this._m),
        rule: args[1] === 'evenodd' ? 'evenodd' : 'nonzero'
      };
    }
    return {
      polys: flattenPath(this._path._cmds, null),
      rule: args[0] === 'evenodd' ? 'evenodd' : 'nonzero'
    };
  }

  // ------------------------------------------------------------------
  // rasterization plumbing

  _ensureFillMask() {
    if (this.fillMask) return;
    this.fillMaskDrawable = new Pixmap(this.window.app, {
      depth: 8,
      width: this.width,
      height: this.height
    });
    this.fillMask = new Picture(this.window.app, {
      drawable: this.fillMaskDrawable,
      format: this.Render.a8
    });
  }

  _ensureClipMask() {
    if (this.clipMask) return;
    this.clipMaskDrawable = new Pixmap(this.window.app, {
      depth: 8,
      width: this.width,
      height: this.height
    });
    this.clipMask = new Picture(this.window.app, {
      drawable: this.clipMaskDrawable,
      format: this.Render.a8
    });
  }

  _rasterizePolys(picture, polys, rule) {
    const flat = [];
    for (const p of polys) if (p.pts.length >= 6) flat.push(p.pts);
    if (!flat.length) return;
    const traps = trapezoidize(flat, 0, 0, [], rule);
    // stay under the server's maximum request size
    const chunk = 4000 * 6;
    for (let i = 0; i < traps.length; i += chunk) {
      this.Render.AddTraps(picture.id, 0, 0, traps.slice(i, i + chunk));
    }
  }

  // GC for uploading coverage into the scratch a8 mask
  _maskGC() {
    if (!this._fillMaskGC) {
      this._fillMaskGC = this.X.AllocID();
      this._gcs.push(this._fillMaskGC);
      this.X.CreateGC(this._fillMaskGC, this.fillMaskDrawable.id);
    }
    return this._fillMaskGC;
  }

  /**
   * Rasterize `job` here and PutImage the coverage into the scratch mask at
   * the drawing's bounding box, instead of asking the server to rasterize
   * trapezoids. Returns false when the app has no rasterizer, when the policy
   * routes this drawing to the server, or when the rasterizer declines — in
   * every one of those cases the caller falls back to the trapezoid path.
   *
   * PutImage writes with Src semantics, so this replaces the mask clear as
   * well as the AddTraps: two requests become one, and the one that is left
   * touches only the bounding box.
   */
  _uploadCoverage(job, b, edges) {
    const rasterizer = this.window.app.rasterizer;
    if (!rasterizer) return false;
    if (routeRaster(b.w, b.h, edges, this.window.app.rasterPolicy) !== 'local') return false;

    const coverage = rasterizer.rasterize({ ...job, width: b.w, height: b.h });
    if (!coverage) return false;

    // X wants scanlines padded to 4 bytes; the rasterizer contract is
    // unpadded rows. When the width is already a multiple of 4 — which every
    // power-of-two icon box is — the coverage goes out as a view over the
    // rasterizer's own bytes, with no copy at all.
    const stride = (b.w + 3) & ~3;
    let data;
    if (stride === b.w) {
      data = Buffer.isBuffer(coverage)
        ? coverage
        : Buffer.from(coverage.buffer, coverage.byteOffset, coverage.length);
    } else {
      data = Buffer.alloc(stride * b.h);
      for (let y = 0; y < b.h; ++y) {
        Buffer.from(coverage.buffer, coverage.byteOffset + y * b.w, b.w).copy(data, y * stride);
      }
    }
    this.X.PutImage(2, this.fillMaskDrawable.id, this._maskGC(), b.w, b.h, b.x, b.y, 0, 8, data);
    return true;
  }

  /**
   * Core fill: rasterize device-space polys into the scratch a8 mask,
   * scale by globalAlpha, intersect with the clip, composite the source.
   */
  /**
   * Device-space bounding box of flattened polys, with a pixel of slack for
   * the antialiased edge, clamped to the surface. Null when nothing lands
   * on it.
   */
  _polysBBox(polys) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const poly of polys) {
      const pts = poly.pts;
      for (let i = 0; i < pts.length; i += 2) {
        if (pts[i] < minX) minX = pts[i];
        if (pts[i] > maxX) maxX = pts[i];
        if (pts[i + 1] < minY) minY = pts[i + 1];
        if (pts[i + 1] > maxY) maxY = pts[i + 1];
      }
    }
    if (maxX === -Infinity) return null;
    return this._clampBBox(minX, minY, maxX, maxY);
  }

  /** the same, for a flat triangle soup (stroke geometry) */
  _trisBBox(tris) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < tris.length; i += 2) {
      if (tris[i] < minX) minX = tris[i];
      if (tris[i] > maxX) maxX = tris[i];
      if (tris[i + 1] < minY) minY = tris[i + 1];
      if (tris[i + 1] > maxY) maxY = tris[i + 1];
    }
    if (maxX === -Infinity) return null;
    return this._clampBBox(minX, minY, maxX, maxY);
  }

  // a pixel of slack for the antialiased edge, clamped to the surface
  _clampBBox(minX, minY, maxX, maxY) {
    const x = Math.max(0, Math.floor(minX) - 1);
    const y = Math.max(0, Math.floor(minY) - 1);
    const w = Math.min(this.width, Math.ceil(maxX) + 1) - x;
    const h = Math.min(this.height, Math.ceil(maxY) + 1) - y;
    if (w <= 0 || h <= 0) return null;
    return { x, y, w, h };
  }

  _fillPolys(polys, rule, { src = null, op = null, alpha = null } = {}) {
    if (!polys.length) return;
    src = src ?? this._backgroundPicture;
    op = op ?? this._op();
    alpha = alpha ?? this.globalAlpha;
    if (alpha <= 0) return;

    // Everything below is bounded to the shape's bounding box rather than
    // the whole surface. On the wire it makes no difference — a Composite
    // request is the same size either way — but it is the difference
    // between the server touching a 34x34 box and a 400x400 one per fill.
    // Stale mask content outside the box is never composited, so clearing
    // only the box is safe.
    const b = this._polysBBox(polys);
    if (!b) return;
    const R = this.Render;

    this._ensureFillMask();
    const flat = [];
    let edges = 0;
    for (const p of polys) {
      if (p.pts.length < 6) continue;
      flat.push(p.pts);
      edges += p.pts.length / 2;
    }
    if (!this._uploadCoverage({ polys: flat, rule, dx: -b.x, dy: -b.y }, b, edges)) {
      R.FillRectangles(R.PictOp.Src, this.fillMask.id, [0, 0, 0, 0], [b.x, b.y, b.w, b.h]);
      this._rasterizePolys(this.fillMask, polys, rule);
    }

    if (alpha < 1) {
      // In with a constant color scales the a8 coverage by that alpha
      R.FillRectangles(R.PictOp.In, this.fillMask.id, [0, 0, 0, alpha], [b.x, b.y, b.w, b.h]);
    }
    if (this.clipMask) {
      // clipMask is surface-aligned, so it is sampled at the same offset
      R.Composite(R.PictOp.In, this.clipMask.id, 0, this.fillMask.id, b.x, b.y, 0, 0, b.x, b.y, b.w, b.h);
    }
    // src is either a 1x1 repeating solid (offset irrelevant) or a
    // surface-aligned gradient, so it is sampled at the same offset too
    R.Composite(op, src.id, this.fillMask.id, this.picture.id, b.x, b.y, b.x, b.y, b.x, b.y, b.w, b.h);
    this._markDirty();
  }

  _strokePolys(polys, { src = null } = {}) {
    src = src ?? this._strokePicture;
    if (this.globalAlpha <= 0) return;
    // approximate transform-aware line width by the average scale factor
    const det = this._m[0] * this._m[3] - this._m[1] * this._m[2];
    const scale = Math.sqrt(Math.abs(det)) || 1;
    const thickness = this.lineWidth * scale;
    const roundCap = this.lineCap === 'round';
    const roundJoin = this.lineJoin === 'round';
    const stroke = extrudePolyline({
      thickness,
      cap: LINE_CAP[this.lineCap] || 'butt',
      join: LINE_JOIN[this.lineJoin] || 'miter',
      miterLimit: this.miterLimit
    });
    // dash distances are user-space lengths; scale them like the line width
    const dash = this._lineDash.length ? this._lineDash.map((d) => d * scale) : null;
    const dashOffset = this._lineDashOffset * scale;

    const tris = [];
    // round caps/joins: extrude-polyline extrudes them as butt/bevel (see
    // LINE_CAP/LINE_JOIN) and we union triangle-fan disks of radius
    // lineWidth/2 on top — a full disk at an endpoint is exactly a round
    // cap, and a disk at an interior vertex fills the bevel notch
    let hasRound = false;
    const r = thickness / 2;
    const diskSegs = Math.max(8, Math.min(32, Math.ceil(r * 2)));
    const addDisk = (x, y) => {
      hasRound = true;
      let ex = x + r;
      let ey = y;
      for (let i = 1; i <= diskSegs; i++) {
        const a = (i / diskSegs) * 2 * Math.PI;
        const nx = x + r * Math.cos(a);
        const ny = y + r * Math.sin(a);
        tris.push(x, y, ex, ey, nx, ny);
        ex = nx;
        ey = ny;
      }
    };
    // join disk at b (between a->b and b->c), but only where the bevel
    // notch is visible — flattened curves have many near-collinear vertices
    const maybeJoinDisk = (a, b, c) => {
      const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
      if (!l1 || !l2) return;
      let dot = ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])) / (l1 * l2);
      dot = Math.max(-1, Math.min(1, dot));
      // bevel-to-arc gap depth for turn angle θ: r * (1 - cos(θ/2))
      if (r * (1 - Math.sqrt((1 + dot) / 2)) > 0.05) addDisk(b[0], b[1]);
    };
    // one polyline through extrusion + round-geometry post-processing;
    // closed loops carry the seam point at both ends and get no caps
    const extrudeRun = (pts, closed) => {
      if (pts.length === 1) {
        // degenerate (zero-length dash): with round caps this is a dot
        if (roundCap) addDisk(pts[0][0], pts[0][1]);
        return;
      }
      if (pts.length < 2) return;
      const mesh = stroke.build(pts);
      for (const tri of mesh.cells) {
        for (let i = 0; i < 3; ++i) {
          tris.push(mesh.positions[tri[i]][0], mesh.positions[tri[i]][1]);
        }
      }
      if (roundJoin) {
        for (let i = 1; i < pts.length - 1; i++) maybeJoinDisk(pts[i - 1], pts[i], pts[i + 1]);
        // the seam of a closed loop is a join too (pts[0] === pts[last])
        if (closed && pts.length > 2) maybeJoinDisk(pts[pts.length - 2], pts[0], pts[1]);
      }
      if (roundCap && !closed) {
        addDisk(pts[0][0], pts[0][1]);
        addDisk(pts[pts.length - 1][0], pts[pts.length - 1][1]);
      }
    };
    // dash boundaries can duplicate run endpoints; collapse them
    const cleanRun = (run) => {
      const out = [run[0]];
      for (let i = 1; i < run.length; i++) {
        const p = run[i];
        const q = out[out.length - 1];
        if (Math.abs(p[0] - q[0]) > 1e-6 || Math.abs(p[1] - q[1]) > 1e-6) out.push(p);
      }
      return out;
    };

    for (const poly of polys) {
      // drop consecutive (near-)duplicate points — zero-length segments make
      // extrude-polyline emit NaN joins that turn into spikes at the origin
      const pts = [];
      let lx = Infinity;
      let ly = Infinity;
      for (let i = 0; i < poly.pts.length; i += 2) {
        const x = poly.pts[i];
        const y = poly.pts[i + 1];
        if (!(Math.abs(x - lx) > 1e-6 || Math.abs(y - ly) > 1e-6)) continue;
        pts.push([x, y]);
        lx = x;
        ly = y;
      }
      if (pts.length >= 2 && poly.closed) {
        const [fx, fy] = pts[0];
        if (Math.abs(fx - lx) > 1e-6 || Math.abs(fy - ly) > 1e-6) pts.push([fx, fy]);
      }
      if (pts.length < 2) continue;

      if (!dash) {
        extrudeRun(pts, poly.closed);
        continue;
      }
      const dashed = dashPolyline(pts, poly.closed, dash, dashOffset);
      if (!dashed) {
        extrudeRun(pts, poly.closed);
      } else if (dashed.closedLoop) {
        extrudeRun(pts, true);
      } else {
        for (const run of dashed.runs) extrudeRun(cleanRun(run), false);
      }
    }
    if (!tris.length) return;

    const op = this._op();
    // round-cap/join disks overlap the stroke body; overlapping coverage
    // must accumulate in the clamped a8 mask (single composite) or a
    // semi-transparent stroke style would double-blend at the overlaps
    const direct = !hasRound && this.globalAlpha >= 1 && !this.clipMask && op === this.Render.PictOp.Over;
    const chunk = 4000 * 6;
    if (direct) {
      for (let i = 0; i < tris.length; i += chunk) {
        this.Render.Triangles(op, src.id, 0, 0, this.picture.id, this.Render.a8, tris.slice(i, i + chunk));
      }
      this._markDirty();
      return;
    }

    // Render coverage into the scratch mask, then composite through it so
    // the stroke honors clip / globalAlpha / composite op.
    //
    // Bounded to the stroke's bounding box, for the same reason _fillPolys
    // is: on the wire a Composite is the same size either way, but this
    // branch runs once per stroke, and a wall of 400 round-capped icons is
    // 3200 of them. Clearing and compositing the whole surface each time was
    // ~6 Gpx a frame and took 1.9 s on XQuartz where the bounded version
    // takes 37 ms (react-x11#148). Stale mask content outside the box is
    // never composited, so clearing only the box is safe.
    this._ensureFillMask();
    const b = this._trisBBox(tris);
    if (!b) return;
    if (!this._uploadCoverage({ triangles: tris, dx: -b.x, dy: -b.y }, b, tris.length / 2)) {
      this.Render.FillRectangles(this.Render.PictOp.Src, this.fillMask.id, [0, 0, 0, 0], [b.x, b.y, b.w, b.h]);
      const opaque = this.createSolidPicture(0, 0, 0, 1);
      for (let i = 0; i < tris.length; i += chunk) {
        this.Render.Triangles(this.Render.PictOp.Add, opaque.id, 0, 0, this.fillMask.id, this.Render.a8, tris.slice(i, i + chunk));
      }
    }
    if (this.globalAlpha < 1) {
      this.Render.FillRectangles(this.Render.PictOp.In, this.fillMask.id, [0, 0, 0, this.globalAlpha], [b.x, b.y, b.w, b.h]);
    }
    if (this.clipMask) {
      this.Render.Composite(this.Render.PictOp.In, this.clipMask.id, 0, this.fillMask.id, b.x, b.y, 0, 0, b.x, b.y, b.w, b.h);
    }
    this.Render.Composite(op, src.id, this.fillMask.id, this.picture.id, b.x, b.y, b.x, b.y, b.x, b.y, b.w, b.h);
    this._markDirty();
  }

  /**
   * Composite shaped glyph runs onto this context, honouring the clip.
   *
   * CompositeGlyphs writes straight to the destination picture, so it has
   * no way to consult our clip mask — text drawn through it used to spill
   * out of clipped boxes while every fill and stroke stayed inside. With a
   * clip active, render the glyph coverage into the scratch a8 mask
   * instead, intersect that with the clip, and paint the real source
   * through the result — the same shape as _fillPolys.
   */
  drawGlyphs(op, src, positioned) {
    const app = this.window.app;
    const R = this.Render;
    if (!this.clipMask) {
      drawGlyphRuns(app, op, src.id, this.picture.id, positioned);
      this._markDirty();
      return;
    }
    // Fast path: a rectangular clip is something the server can do itself.
    // Two small requests around the ordinary glyph composite, instead of
    // clearing and compositing a full-surface a8 mask three times — which
    // costs the same on the wire but many times the pixel work.
    const rect = this._clipRect();
    if (rect) {
      if (rect.w === 0 || rect.h === 0) return;
      R.SetPictureClipRectangles(this.picture.id, 0, 0, [rect.x, rect.y, rect.w, rect.h]);
      drawGlyphRuns(app, op, src.id, this.picture.id, positioned);
      R.SetPictureClipRectangles(this.picture.id, 0, 0, [0, 0, this.width, this.height]);
      this._markDirty();
      return;
    }
    this._ensureFillMask();
    this._glyphSource ??= this.createSolidPicture(1, 1, 1, 1);
    R.FillRectangles(R.PictOp.Src, this.fillMask.id, [0, 0, 0, 0], [0, 0, this.width, this.height]);
    // solid white through the glyphs leaves their coverage in the a8 mask
    drawGlyphRuns(app, R.PictOp.Over, this._glyphSource.id, this.fillMask.id, positioned);
    R.Composite(R.PictOp.In, this.clipMask.id, 0, this.fillMask.id, 0, 0, 0, 0, 0, 0, this.width, this.height);
    R.Composite(op, src.id, this.fillMask.id, this.picture.id, 0, 0, 0, 0, 0, 0, this.width, this.height);
    this._markDirty();
  }

  /**
   * Trapezoid coverage under the clip — `drawGlyphs` for vector shapes that
   * are already trapezoidized (KaTeX radicals and rules go this way).
   * Without it they composite straight to the destination picture and spill
   * out of clipped boxes, which is what glyphs used to do.
   */
  drawTraps(op, src, traps) {
    if (!traps.length) return;
    const app = this.window.app;
    const R = this.Render;
    if (!this.clipMask) {
      compositeTraps(app, op, src.id, this.picture.id, traps);
      this._markDirty();
      return;
    }
    const rect = this._clipRect();
    if (rect) {
      if (rect.w === 0 || rect.h === 0) return;
      R.SetPictureClipRectangles(this.picture.id, 0, 0, [rect.x, rect.y, rect.w, rect.h]);
      compositeTraps(app, op, src.id, this.picture.id, traps);
      R.SetPictureClipRectangles(this.picture.id, 0, 0, [0, 0, this.width, this.height]);
      this._markDirty();
      return;
    }
    this._ensureFillMask();
    this._glyphSource ??= this.createSolidPicture(1, 1, 1, 1);
    R.FillRectangles(R.PictOp.Src, this.fillMask.id, [0, 0, 0, 0], [0, 0, this.width, this.height]);
    compositeTraps(app, R.PictOp.Over, this._glyphSource.id, this.fillMask.id, traps);
    R.Composite(R.PictOp.In, this.clipMask.id, 0, this.fillMask.id, 0, 0, 0, 0, 0, 0, this.width, this.height);
    R.Composite(op, src.id, this.fillMask.id, this.picture.id, 0, 0, 0, 0, 0, 0, this.width, this.height);
    this._markDirty();
  }

  // combined clip ∩ globalAlpha mask for direct composites (rect/image
  // fast paths); returns a picture id or 0. Reuses the fill scratch mask.
  _compositeMask() {
    if (this.globalAlpha >= 1) return this.clipMask ? this.clipMask.id : 0;
    this._ensureFillMask();
    this.Render.FillRectangles(this.Render.PictOp.Src, this.fillMask.id, [0, 0, 0, this.globalAlpha], [0, 0, this.width, this.height]);
    if (this.clipMask) {
      this.Render.Composite(this.Render.PictOp.In, this.clipMask.id, 0, this.fillMask.id, 0, 0, 0, 0, 0, 0, this.width, this.height);
    }
    return this.fillMask.id;
  }

  // ------------------------------------------------------------------
  // drawing

  clearRect(x, y, w, h) {
    if (matIsIdentity(this._m) && !this.clipMask) {
      this.Render.FillRectangles(this.Render.PictOp.Src, this.picture.id, [1, 1, 1, 1], [x, y, w, h]);
      this._markDirty();
      return;
    }
    const tmp = new Path2D();
    tmp.rect(x, y, w, h);
    // clear = opaque white, ignoring alpha and the composite op (but
    // honoring the clip), matching the identity fast path above
    this._fillPolys(flattenPath(tmp._cmds, this._m), 'nonzero', {
      src: this.createSolidPicture(1, 1, 1, 1),
      op: this.Render.PictOp.Over,
      alpha: 1
    });
  }

  fillRect(x, y, w, h) {
    if (matIsIdentity(this._m)) {
      const mask = this._compositeMask();
      this.Render.Composite(
        this._op(),
        this._backgroundPicture.id,
        mask,
        this.picture.id,
        x, y,
        x, y,
        x, y,
        w, h
      );
      this._markDirty();
      return;
    }
    const tmp = new Path2D();
    tmp.rect(x, y, w, h);
    this._fillPolys(flattenPath(tmp._cmds, this._m), 'nonzero');
  }

  strokeRect(x, y, w, h) {
    const tmp = new Path2D();
    tmp.rect(x, y, w, h);
    this._strokePolys(flattenPath(tmp._cmds, this._m));
  }

  fill(...args) {
    const { polys, rule } = this._polysFor(args);
    this._fillPolys(polys, rule);
  }

  stroke(...args) {
    const polys =
      args[0] instanceof Path2D
        ? flattenPath(args[0]._cmds, this._m)
        : flattenPath(this._path._cmds, null);
    this._strokePolys(polys);
  }

  /**
   * Intersect the clip region with the given path (or the current path).
   * Cleared by restore() to the state at the matching save() — like the
   * browser canvas, there is no other way to widen the clip again.
   */
  /**
   * The axis-aligned rectangle a flattened path describes, or null. Clips
   * in practice are almost always rectangles — a content box, a scroll
   * viewport, `overflow: hidden` — and a rectangular clip can be pushed
   * to the server instead of rasterized into a mask.
   */
  static _rectOfPolys(polys) {
    if (polys.length !== 1) return null;
    const { pts } = polys[0];
    if (pts.length !== 8) return null;
    const [x0, y0, x1, y1, x2, y2, x3, y3] = pts;
    const axis =
      (y0 === y1 && x1 === x2 && y2 === y3 && x3 === x0) ||
      (x0 === x1 && y1 === y2 && x2 === x3 && y3 === y0);
    if (!axis) return null;
    const xs = [x0, x1, x2, x3];
    const ys = [y0, y1, y2, y3];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const w = Math.max(...xs) - x;
    const h = Math.max(...ys) - y;
    if (!(w > 0 && h > 0)) return null;
    // Server clip rectangles are integers, so a fractional edge could only
    // be honoured by rounding — which would differ from the mask path's
    // antialiased edge by up to a pixel. Rare, so leave those to the mask
    // rather than quietly changing what they look like.
    const integral = (v) => Math.abs(v - Math.round(v)) < 1e-6;
    if (![x, y, w, h].every(integral)) return null;
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }

  /** Intersection of the whole clip stack, or null if any part is not a
   *  rectangle (or the stack is empty). */
  _clipRect() {
    if (!this._clips.length) return null;
    let out = null;
    for (const entry of this._clips) {
      const r = entry.rect;
      if (!r) return null;
      if (!out) {
        out = { ...r };
        continue;
      }
      const x = Math.max(out.x, r.x);
      const y = Math.max(out.y, r.y);
      const right = Math.min(out.x + out.w, r.x + r.w);
      const bottom = Math.min(out.y + out.h, r.y + r.h);
      out = { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
    }
    // clamp into the surface: the server rejects out-of-range rectangles
    const x = Math.max(0, Math.min(out.x, this.width));
    const y = Math.max(0, Math.min(out.y, this.height));
    const w = Math.max(0, Math.min(out.x + out.w, this.width) - x);
    const h = Math.max(0, Math.min(out.y + out.h, this.height) - y);
    return { x, y, w, h };
  }

  clip(...args) {
    const { polys, rule } = this._polysFor(args);
    const entry = { polys, rule, rect: RenderingContext2d._rectOfPolys(polys) };
    // copy-on-write: earlier save() snapshots keep their own clip list
    this._clips = this._clips.concat([entry]);

    if (this._clips.length === 1) {
      this._ensureClipMask();
      this.Render.FillRectangles(this.Render.PictOp.Src, this.clipMask.id, [0, 0, 0, 0], [0, 0, this.width, this.height]);
      this._rasterizePolys(this.clipMask, polys, rule);
      return;
    }
    this._intersectClip(entry);
  }

  // rasterize one clip entry into a temp a8 and In-composite it onto the mask
  _intersectClip(entry) {
    // Intersecting with a *rectangle* is just "keep the inside, clear the
    // outside", and up to four FillRectangles say that exactly — no temp
    // pixmap to allocate and free, no rasterization, and no full-surface
    // Composite. The general path below costs the whole surface per clip
    // however small the rectangle is, which is what made nested clipping the
    // dominant cost of a frame: scrolling a table clipped roughly 170 times
    // per repaint, and at 900x600 that alone was ~92 megapixels of work
    // before a single glyph was drawn.
    if (entry.rect) {
      const r = entry.rect;
      const x = Math.max(0, Math.min(r.x, this.width));
      const y = Math.max(0, Math.min(r.y, this.height));
      const right = Math.max(x, Math.min(r.x + r.w, this.width));
      const bottom = Math.max(y, Math.min(r.y + r.h, this.height));
      const outside = [];
      if (y > 0) outside.push(0, 0, this.width, y);
      if (bottom < this.height) {
        outside.push(0, bottom, this.width, this.height - bottom);
      }
      if (x > 0) outside.push(0, y, x, bottom - y);
      if (right < this.width) {
        outside.push(right, y, this.width - right, bottom - y);
      }
      if (outside.length) {
        this.Render.FillRectangles(this.Render.PictOp.Src, this.clipMask.id, [0, 0, 0, 0], outside);
      }
      return;
    }
    const tmpPixmap = new Pixmap(this.window.app, { depth: 8, width: this.width, height: this.height });
    const tmpMask = new Picture(this.window.app, { drawable: tmpPixmap, format: this.Render.a8 });
    this.Render.FillRectangles(this.Render.PictOp.Src, tmpMask.id, [0, 0, 0, 0], [0, 0, this.width, this.height]);
    this._rasterizePolys(tmpMask, entry.polys, entry.rule);
    this.Render.Composite(this.Render.PictOp.In, tmpMask.id, 0, this.clipMask.id, 0, 0, 0, 0, 0, 0, this.width, this.height);
    tmpMask.destroy();
    tmpPixmap.destroy();
  }

  _rebuildClipMask() {
    if (!this._clips.length) {
      if (this.clipMask) {
        this.clipMask.destroy();
        this.clipMaskDrawable.destroy();
        this.clipMask = this.clipMaskDrawable = null;
      }
      return;
    }
    this._ensureClipMask();
    this.Render.FillRectangles(this.Render.PictOp.Src, this.clipMask.id, [0, 0, 0, 0], [0, 0, this.width, this.height]);
    this._rasterizePolys(this.clipMask, this._clips[0].polys, this._clips[0].rule);
    for (let i = 1; i < this._clips.length; i++) this._intersectClip(this._clips[i]);
  }

  isPointInPath(...args) {
    let path = null;
    let rest = args;
    if (args[0] instanceof Path2D) {
      path = args[0];
      rest = args.slice(1);
    }
    const [x, y, rule] = rest;
    const polys = path ? flattenPath(path._cmds, this._m) : flattenPath(this._path._cmds, null);
    return polysContain(polys, x, y, rule === 'evenodd' ? 'evenodd' : 'nonzero');
  }

  // ------------------------------------------------------------------
  // text

  _resolvedTextStyle() {
    if (!this._textStyle) this.font = DEFAULT_FONT;
    return this._textStyle;
  }

  // horizontal offset of the alignment point, given the shaped width
  _alignOffset(shaped) {
    let align = this.textAlign;
    if (align === 'start') align = shaped.baseLevel & 1 ? 'right' : 'left';
    if (align === 'end') align = shaped.baseLevel & 1 ? 'left' : 'right';
    if (align === 'center') return -shaped.width / 2;
    if (align === 'right') return -shaped.width;
    return 0;
  }

  // vertical distance from the requested y to the baseline
  _baselineOffset(metrics) {
    switch (this.textBaseline) {
      case 'top':
        return metrics.ascent;
      case 'hanging':
        return metrics.ascent * 0.8;
      case 'middle':
        return (metrics.ascent - metrics.descent) / 2;
      case 'bottom':
      case 'ideographic':
        return -metrics.descent;
      default:
        // 'alphabetic'
        return 0;
    }
  }

  /**
   * Draw text with full shaping: OpenType kerning/ligatures, complex-script
   * contextual forms, bidi reordering and automatic font fallback.
   * Glyphs are uploaded to the server once per (face, size) and referenced
   * by 1–2 byte ids afterwards — see docs/text.md.
   *
   * The current transform's translation applies to the anchor point;
   * glyphs themselves are not rotated/scaled by the transform (size the
   * font via `ctx.font` instead).
   */
  fillText(text, x, y) {
    text = String(text ?? '');
    if (!text) return;
    const style = this._resolvedTextStyle();
    const app = this.window.app;
    const shaped = app.fonts.shape(text, style);
    const [tx, ty] = matApply(this._m, x, y);
    const ox = tx + this._alignOffset(shaped);
    const oy = ty + this._baselineOffset(style.font.metrics(style.size));

    const positioned = [];
    let cursor = ox;
    for (const run of reorderRuns(shaped.runs)) {
      positioned.push({ run, x: cursor, y: oy });
      cursor += run.width;
    }
    this.drawGlyphs(this.Render.PictOp.Over, this._backgroundPicture, positioned);
  }

  /**
   * Measure shaped text. Returns a canvas-style TextMetrics object:
   * `width` (advance), actual bounding box (ink extents relative to the
   * origin), and font bounding box (from font metrics).
   */
  measureText(text) {
    const style = this._resolvedTextStyle();
    const shaped = this.window.app.fonts.shape(String(text ?? ''), style);
    let minX = 0;
    let maxX = 0;
    let minY = 0;
    let maxY = 0;
    let cursor = 0;
    for (const run of reorderRuns(shaped.runs)) {
      for (const g of run.glyphs) {
        const e = run.font.glyphExtents(g.id, run.size);
        const gx = cursor + g.dx;
        const gy = -g.dy;
        if (gx + e.minX < minX) minX = gx + e.minX;
        if (gx + e.maxX > maxX) maxX = gx + e.maxX;
        if (gy + e.minY < minY) minY = gy + e.minY;
        if (gy + e.maxY > maxY) maxY = gy + e.maxY;
        cursor += g.ax;
      }
    }
    const m = style.font.metrics(style.size);
    return {
      width: shaped.width,
      actualBoundingBoxLeft: -minX,
      actualBoundingBoxRight: maxX,
      actualBoundingBoxAscent: -minY,
      actualBoundingBoxDescent: maxY,
      fontBoundingBoxAscent: m.ascent,
      fontBoundingBoxDescent: m.descent,
      emHeightAscent: m.ascent,
      emHeightDescent: m.descent,
      // legacy ntk field: ink height
      height: maxY - minY
    };
  }

  /**
   * Lay out (possibly styled) text for a target width without drawing it —
   * returns a TextLayout (lines, metrics) that can be inspected and then
   * drawn with `layout.draw(ctx, x, y)`. The current `ctx.font` is the base
   * style; see docs/text.md for spans and options.
   *
   * @param {string|Array} content plain text or spans [{ text, ...style }]
   * @param {object} [options] { maxWidth, align, lineHeight, direction }
   */
  layoutText(content, options = {}) {
    const style = this._resolvedTextStyle();
    return new TextLayout(this.window.app.fonts, content, style, options);
  }

  /**
   * CSS-style font shorthand, e.g. `'bold italic 40px "DejaVu Sans", serif'`.
   * Resolution goes through `app.fonts`: fonts registered with
   * `app.fonts.load()` win over system (fontconfig) lookup.
   */
  set font(val) {
    if (!val || typeof val !== 'string') return;
    const parsed = parseFontStyle(val);
    if (!parsed) return;
    const style = {
      family: parsed.family,
      weight: parsed.weight,
      style: parsed.style,
      size: parsed.size
    };
    style.font = this.window.app.fonts.match(style.family, style);
    this._lastFontString = val;
    this._textStyle = style;
  }

  get font() {
    return this._lastFontString || DEFAULT_FONT;
  }

  // ------------------------------------------------------------------
  // gradients / images

  createLinearGradient(x0, y0, x1, y1) {
    return new CanvasGradient('linear', this, x0, y0, x1, y1);
  }

  createRadialGradient(x0, y0, r0, x1, y1, r1) {
    return new CanvasGradient('radial', this, x0, y0, x1, y1, r0, r1);
  }

  createConicalGradient(x0, y0, angle) {
    return new CanvasGradient('conical', this, x0, y0, angle);
  }

  /** the pixel layout of whatever this context currently draws into */
  get _layout() {
    const depth = this._target.depth ?? this.window.depth ?? this.display.screen[0].root_depth;
    if (!this._layoutCache || this._layoutCache.depth !== depth) {
      this._layoutCache = pixelLayout(this.display, depth);
    }
    return this._layoutCache;
  }

  /**
   * A blank `ImageData`, or a copy of one — both canvas forms:
   *
   *   createImageData(width, height)
   *   createImageData(imagedata)
   */
  createImageData(a, b) {
    if (typeof a === 'number') return new ImageData(a, b);
    if (a && typeof a.width === 'number' && a.data) return new ImageData(a.width, a.height);
    throw new TypeError('createImageData: pass (width, height) or an ImageData');
  }

  /**
   * Write straight RGBA pixels into the drawable at `(x, y)`.
   *
   * `data` is an `ImageData` or anything shaped like one; its bytes are
   * non-premultiplied RGBA, and they are converted to the drawable's own
   * pixel layout on the way out. The optional `dirty*` rectangle limits the
   * write to part of the source, as in the canvas spec.
   */
  putImageData(data, x, y, dirtyX = 0, dirtyY = 0, dirtyWidth, dirtyHeight) {
    const { width, height } = data;
    const src = data.data;
    if (!src || src.length !== width * height * 4) {
      throw new Error(
        `putImageData: data must be ${width * height * 4} RGBA bytes for ${width}x${height}`
      );
    }
    dirtyWidth ??= width;
    dirtyHeight ??= height;
    // the spec normalises negative extents by moving the origin
    if (dirtyWidth < 0) { dirtyX += dirtyWidth; dirtyWidth = -dirtyWidth; }
    if (dirtyHeight < 0) { dirtyY += dirtyHeight; dirtyHeight = -dirtyHeight; }
    const sx = Math.max(0, dirtyX);
    const sy = Math.max(0, dirtyY);
    const sw = Math.min(width, dirtyX + dirtyWidth) - sx;
    const sh = Math.min(height, dirtyY + dirtyHeight) - sy;
    if (!(sw > 0) || !(sh > 0)) return;

    let rgba = src;
    if (sx !== 0 || sy !== 0 || sw !== width || sh !== height) {
      const cropped = new Uint8ClampedArray(sw * sh * 4);
      for (let row = 0; row < sh; row++) {
        cropped.set(
          src.subarray((sy + row) * width * 4 + sx * 4, (sy + row) * width * 4 + (sx + sw) * 4),
          row * sw * 4
        );
      }
      rgba = cropped;
    }

    const layout = this._layout;
    const bytes = fromStraightRgba(rgba, layout, sw, sh);
    // stay under the server's maximum request size by uploading row bands
    const stride = sw * 4;
    const maxBytes = ((this.display.max_request_length ?? 65535) - 8) * 4;
    const rowsPerBand = Math.max(1, Math.floor(maxBytes / stride));
    for (let row = 0; row < sh; row += rowsPerBand) {
      const rows = Math.min(rowsPerBand, sh - row);
      this.X.PutImage(
        2, // ZPixmap
        this._target.id,
        this._gc,
        sw, rows,
        x + sx, y + sy + row,
        0,
        layout.depth,
        bytes.subarray(row * stride, (row + rows) * stride)
      );
    }
    this._markDirty();
  }

  /**
   * Read pixels back as canvas `ImageData` — straight (non-premultiplied)
   * RGBA in a `Uint8ClampedArray`, exactly like the browser's.
   *
   * Reads the backing pixmap on double-buffered windows, so it is valid even
   * where the window is occluded. Returns a promise; a trailing
   * `cb(err, imageData)` is still accepted.
   *
   * The drawable's own bytes are none of those things — see
   * `lib/imagedata.js` — so this costs a pass over the pixels. `readPixels()`
   * is the way to skip that when you want the server's layout.
   */
  getImageData(x, y, w, h, cb) {
    const promise = this.readPixels(x, y, w, h).then(
      (raw) => new ImageData(toStraightRgba(raw.data, raw.layout, w, h), w, h)
    );
    if (typeof cb === 'function') {
      promise.then((data) => cb(null, data), cb);
      return undefined;
    }
    return promise;
  }

  /**
   * Read pixels in the server's own layout, with no conversion.
   *
   * The escape hatch under `getImageData` for code that wants to hand the
   * bytes straight back to `PutImage`, feed a codec, or do its own unpacking.
   * Unlike a bare `GetImage` it says what the bytes mean:
   *
   *   { width, height, data, depth, bitsPerPixel, byteOrder, masks,
   *     premultiplied }
   *
   * `byteOrder` is `'lsb'` or `'msb'` and is the *server's* pixel order,
   * which is a different handshake field from the one this connection
   * speaks. `masks` gives the bit position of each channel inside a pixel
   * word, `alpha` being 0 when the drawable has no alpha channel — in which
   * case the spare byte is undefined padding, not opacity.
   *
   * @returns {Promise<object>}
   */
  readPixels(x, y, w, h) {
    const layout = this._layout;
    return new Promise((resolve, reject) => {
      this.X.GetImage(2, this._target.id, x, y, w, h, 0xffffffff, (err, img) => {
        if (err) return reject(err);
        resolve({ width: w, height: h, data: img.data, layout, ...layout });
      });
    });
  }

  /**
   * Draw an image, with the three canvas signatures:
   *
   *   ctx.drawImage(image, dx, dy)
   *   ctx.drawImage(image, dx, dy, dWidth, dHeight)
   *   ctx.drawImage(image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight)
   *
   * `image` is an ntk `Image` (see `loadImage()` — PNG/JPEG decoded
   * client-side, uploaded to the server once and composited from there;
   * scaling is server-side with bilinear filtering), another
   * RenderingContext2d, or a node-canvas-like object. Images honor the
   * current transform (server-side, via the picture transform).
   */
  /**
   * Clip and mask for a direct composite, as a bracket around it.
   *
   * A rectangular clip is something the server can do itself: two small
   * requests around the composite instead of intersecting a full-surface a8
   * mask, which costs the same on the wire and many times the pixel work.
   * This is the fast path `drawGlyphs` already has — and a renderer that
   * clips to a damage rect makes it the common case, not a rare one.
   *
   * Uniform alpha needs no surface-sized mask either: a 1x1 repeating
   * picture is the same thing to the server, with no pixel work at all.
   */
  _beginDirectComposite() {
    const rect = this.clipMask ? this._clipRect() : null;
    if (!rect) return { mask: this._compositeMask(), clipped: false, empty: false };
    if (rect.w === 0 || rect.h === 0) return { mask: 0, clipped: false, empty: true };
    this.Render.SetPictureClipRectangles(this.picture.id, 0, 0, [rect.x, rect.y, rect.w, rect.h]);
    const mask =
      this.globalAlpha >= 1 ? 0 : this.createSolidPicture(0, 0, 0, this.globalAlpha).id;
    return { mask, clipped: true, empty: false };
  }

  _endDirectComposite(state) {
    if (!state.clipped) return;
    this.Render.SetPictureClipRectangles(this.picture.id, 0, 0, [0, 0, this.width, this.height]);
  }

  /** The source colour for a coverage composite, with `globalAlpha` folded
   * into it. The mask slot is taken by the coverage, so the alpha has to go
   * somewhere — and a 1x1 solid is free, where a surface-sized alpha mask is
   * not. Falls back to the fill picture for gradients, which have no single
   * colour to fold into; `_drawCoverage` routes those through the scratch. */
  _coverageSource() {
    const style = this._fillStyle;
    if (this.globalAlpha >= 1 || !isPlainColor(style)) return this._backgroundPicture;
    const c = parseColor(style);
    return this.createSolidPicture(c[0], c[1], c[2], c[3] * this.globalAlpha);
  }

  /**
   * Composite a coverage source: the a8 picture is the *mask* and the current
   * `fillStyle` is what gets painted through it.
   *
   * This is the same shape as `drawGlyphs`, and for the same reason — a
   * monochrome drawing rendered once as coverage can then be painted in any
   * colour, so a hover, a disabled state and a theme change all reuse the one
   * rendered copy instead of each needing their own.
   */
  _drawCoverage(picture, sx, sy, sw, sh, dx, dy, dw, dh, op) {
    const R = this.Render;
    const scaled = dw !== sw || dh !== sh;
    if (scaled) {
      R.SetPictureTransform(picture.id, [sw / dw, 0, sx, 0, sh / dh, sy, 0, 0, 1]);
      picture.setFilter('bilinear');
    }
    // with a transform in place the mask is already sampled from (sx, sy)
    const mx = scaled ? 0 : sx;
    const my = scaled ? 0 : sy;

    const rect = this.clipMask ? this._clipRect() : null;
    // the mask slot can hold exactly one picture, so anything that cannot be
    // folded into the colour or handed to the server as a clip rectangle has
    // to be intersected into the scratch mask first
    const scratch =
      (this.clipMask && !rect) || (this.globalAlpha < 1 && !isPlainColor(this._fillStyle));

    if (scratch) {
      this._ensureFillMask();
      R.FillRectangles(R.PictOp.Src, this.fillMask.id, [0, 0, 0, 0], [0, 0, this.width, this.height]);
      R.Composite(R.PictOp.Src, picture.id, 0, this.fillMask.id, mx, my, 0, 0, dx, dy, dw, dh);
      if (this.globalAlpha < 1) {
        R.Composite(
          R.PictOp.InReverse,
          this.createSolidPicture(0, 0, 0, this.globalAlpha).id,
          0,
          this.fillMask.id,
          0, 0, 0, 0, 0, 0,
          this.width, this.height
        );
      }
      if (this.clipMask) {
        R.Composite(R.PictOp.In, this.clipMask.id, 0, this.fillMask.id, 0, 0, 0, 0, 0, 0, this.width, this.height);
      }
      R.Composite(
        op,
        this._backgroundPicture.id,
        this.fillMask.id,
        this.picture.id,
        0, 0, 0, 0,
        dx, dy,
        dw, dh
      );
    } else if (!rect || (rect.w > 0 && rect.h > 0)) {
      if (rect) {
        R.SetPictureClipRectangles(this.picture.id, 0, 0, [rect.x, rect.y, rect.w, rect.h]);
      }
      R.Composite(
        op,
        this._coverageSource().id,
        picture.id,
        this.picture.id,
        0, 0,
        mx, my,
        dx, dy,
        dw, dh
      );
      if (rect) {
        R.SetPictureClipRectangles(this.picture.id, 0, 0, [0, 0, this.width, this.height]);
      }
    }

    if (scaled) {
      // restore defaults so the cached surface stays reusable as-is
      R.SetPictureTransform(picture.id, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
      picture.setFilter('nearest');
    }
    this._markDirty();
  }

  drawImage(image, ...args) {
    if (isPictureSource(image)) {
      let sx = 0;
      let sy = 0;
      let sw = image.width;
      let sh = image.height;
      let dx = 0;
      let dy = 0;
      let dw;
      let dh;
      if (args.length >= 8) {
        [sx, sy, sw, sh, dx, dy, dw, dh] = args;
      } else if (args.length >= 4) {
        [dx, dy, dw, dh] = args;
      } else {
        [dx = 0, dy = 0] = args;
        dw = sw;
        dh = sh;
      }
      if (!(dw > 0) || !(dh > 0) || !(sw > 0) || !(sh > 0)) return;

      const picture = image.picture(this.window.app);
      const op = this._op();

      if (!matIsIdentity(this._m)) {
        this._drawImageTransformed(picture, sx, sy, sw, sh, dx, dy, dw, dh, op);
        return;
      }

      if (image.format === 'a8') {
        this._drawCoverage(picture, sx, sy, sw, sh, dx, dy, dw, dh, op);
        return;
      }

      const state = this._beginDirectComposite();
      if (state.empty) return;
      const mask = state.mask;
      const scaled = dw !== sw || dh !== sh;
      if (scaled) {
        // the picture transform maps composite coordinates into source
        // samples: dest pixel (i, j) reads (sx + i*sw/dw, sy + j*sh/dh)
        this.Render.SetPictureTransform(picture.id, [sw / dw, 0, sx, 0, sh / dh, sy, 0, 0, 1]);
        picture.setFilter('bilinear');
        this.Render.Composite(
          op,
          picture.id,
          mask,
          this.picture.id,
          0, 0,
          dx, dy,
          dx, dy,
          dw, dh
        );
        // restore defaults so the cached upload can be reused as-is
        this.Render.SetPictureTransform(picture.id, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
        picture.setFilter('nearest');
      } else {
        this.Render.Composite(
          op,
          picture.id,
          mask,
          this.picture.id,
          sx, sy,
          dx, dy,
          dx, dy,
          dw, dh
        );
      }
      this._endDirectComposite(state);
      this._markDirty();
      return;
    }

    const sWidth = image.width;
    const sHeight = image.height;
    const sx = 0;
    const sy = 0;

    // Drawables reach the branch above by way of Surface, which is what a
    // Window/Pixmap/Picture source actually needs: a size and a Picture.
    if (image instanceof RenderingContext2d) {
      // TODO: if need to scale, set transform
      // TODO: respect global compositing blend mode
      this.Render.Composite(
        this.Render.PictOp.Over,
        image.picture.id,
        this._compositeMask(),
        this.picture.id,
        0, 0, 0, 0, 0, 0,
        this.width,
        this.height
      );
      this._markDirty();
    } else if (image && image.context && typeof image.context.getImageData === 'function') {
      // node-canvas Canvas ( or any ctx with ctx.canvas.getImageData returning pixels)
      const imageData = image.context.getImageData(sx, sy, sWidth, sHeight);
      // node-canvas hands over straight RGBA, and the rgba32 picture below is
      // premultiplied — this used to swap the channels and stop there, which
      // composited translucent images at full brightness
      const data = fromStraightRgba(
        imageData.data,
        pixelLayout(this.display, 32),
        sWidth,
        sHeight
      );

      // One upload GC per app rather than one per call, the same sharing
      // Image.picture does: a GC is valid for any drawable of the same screen
      // and depth. This used to allocate a GC, a pixmap and a picture every
      // time and free none of them, so drawing a node-canvas source in an
      // animation loop leaked three server resources per frame.
      const app = this.window.app;
      const pixmap = new Pixmap(app, { depth: 32, width: sWidth, height: sHeight });
      const picture = new Picture(app, { drawable: pixmap, format: this.Render.rgba32 });
      try {
        let gc = app._imageUploadGC;
        if (!gc) {
          gc = app._imageUploadGC = this.X.AllocID();
          this.X.CreateGC(gc, pixmap.id);
        }
        // the crop already happened in getImageData, so it lands at the
        // pixmap's origin — sx/sy here wrote it off the edge
        this.X.PutImage(2, pixmap.id, gc, sWidth, sHeight, 0, 0, 0, 32, data);

        this.Render.Composite(
          this.Render.PictOp.Over,
          picture.id,
          this._compositeMask(),
          this.picture.id,
          0, 0, 0, 0, 0, 0,
          this.width,
          this.height
        );
        this._markDirty();
      } finally {
        // the composite is queued, and X executes requests in order, so the
        // server is done with these by the time it reads the frees
        picture.destroy();
        pixmap.destroy();
      }
    }
  }

  // general-affine drawImage: fold CTM + dest rect + source offset into the
  // source picture transform and composite over the transformed bbox
  _drawImageTransformed(picture, sx, sy, sw, sh, dx, dy, dw, dh, op) {
    // maps source-local (u, v) in [0..sw)x[0..sh) to device coordinates
    const M = matMultiply(this._m, [dw / sw, 0, 0, dh / sh, dx, dy]);
    const inv = matInvert(M);
    if (!inv) return;

    // device bbox of the transformed dest rect, clamped to the canvas
    const corners = [
      matApply(this._m, dx, dy),
      matApply(this._m, dx + dw, dy),
      matApply(this._m, dx, dy + dh),
      matApply(this._m, dx + dw, dy + dh)
    ];
    const x0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))));
    const y0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))));
    const x1 = Math.min(this.width, Math.ceil(Math.max(...corners.map((c) => c[0]))));
    const y1 = Math.min(this.height, Math.ceil(Math.max(...corners.map((c) => c[1]))));
    if (x1 <= x0 || y1 <= y0) return;

    // device -> source sample (adding the source-rect origin)
    const srcM = [inv[0], inv[1], inv[2], inv[3], inv[4] + sx, inv[5] + sy];
    this.Render.SetPictureTransform(picture.id, [srcM[0], srcM[2], srcM[4], srcM[1], srcM[3], srcM[5], 0, 0, 1]);
    picture.setFilter('bilinear');
    const mask = this._compositeMask();
    this.Render.Composite(op, picture.id, mask, this.picture.id, x0, y0, x0, y0, x0, y0, x1 - x0, y1 - y0);
    this.Render.SetPictureTransform(picture.id, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    picture.setFilter('nearest');
    this._markDirty();
  }
}

class CanvasGradient {
  constructor(type, ctx, p0, p1, p2, p3, p4, p5) {
    this.type = type;
    this.stops = [];
    this.ctx = ctx;
    this._id = null;
    this._picture = null;

    this.x0 = p0;
    this.y0 = p1;
    if (type === 'linear' || type === 'radial') {
      this.x1 = p2;
      this.y1 = p3;
      this.r0 = p4;
      this.r1 = p5;
    } else {
      this.angle = p2;
    }
    // TODO: check if ChangePictureAttribute works on gradients ( set repeat edge pixels flag )
  }

  addColorStop(offset, color) {
    this.stops.push([offset, parseColor(color)]);
    return this;
  }

  // gradient pictures are created lazily, on first use as a fill/stroke style
  get id() {
    if (this._id !== null) return this._id;

    const Render = this.ctx.Render;
    const X = this.ctx.X;

    this._id = X.AllocID();
    switch (this.type) {
      case 'linear':
        Render.LinearGradient(this._id, [this.x0, this.y0], [this.x1, this.y1], this.stops);
        break;
      case 'radial':
        Render.RadialGradient(this._id, [this.x0, this.y0], [this.x1, this.y1], this.r0, this.r1, this.stops);
        break;
      case 'conical':
        Render.ConicalGradient(this._id, [this.x0, this.y0], this.angle, this.stops);
        break;
      default:
        throw new Error('unknown gradient type');
    }
    // wrap with picture so FreePicture is invoked on gc via FinalizationRegistry
    this._picture = new Picture(this.ctx.window.app, { id: this._id });
    return this._id;
  }
}

// register context
Drawable.renderingContextFactory['2d'] = (window) => new RenderingContext2d(window);

export default RenderingContext2d;
export { CanvasGradient };
