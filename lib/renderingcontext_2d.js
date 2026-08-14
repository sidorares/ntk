import parseFontStyle from "canvas-fontstyle";
import extrudePolyline from "extrude-polyline";

import { safeRelease } from "./cleanup.js";
import { cssColor } from "./color.js";
import Drawable from "./drawable.js";
import { Image } from "./image.js";
import {
  ImageData,
  fromStraightRgba,
  pixelLayout,
  toStraightRgba,
} from "./imagedata.js";
import {
  Path2D,
  arcSegmentCount,
  flattenPath,
  transformCommands,
  ellipseSegments,
  polysContain,
  matApply,
  matInvert,
  matIsIdentity,
  matMultiply,
} from "./path.js";
import Picture from "./picture.js";
import Pixmap from "./pixmap.js";
import { routeRaster } from "./rasterize.js";
import { Surface } from "./surface.js";
import {
  BL,
  BR,
  TL,
  TR,
  cornerKey,
  countShapeHit,
  countShapeMiss,
  getShapeGlyphPage,
  roundRectBandRects,
  shapePolicyOf,
  trimShapeGlyphs,
} from "./shapeglyphs.js";
import {
  compositeTraps,
  drawGlyphRuns,
  encodeGlyphItems,
} from "./text/glyphs.js";
import { TextLayout } from "./text/layout.js";
import { reorderRuns } from "./text/shape.js";
import { trapezoidize } from "./trapezoid.js";

/** The overlap of two {x, y, w, h} boxes, or null when they have none. */
function intersectBox(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= x || bottom <= y) return null;
  return { x, y, w: right - x, h: bottom - y };
}

const DEFAULT_FONT = "20px sans-serif";

// `"wght" 460, "wdth" 87.5` — the CSS grammar, quotes optional. An object is
// passed through, so callers can skip the string entirely.
const VARIATION_RE = /["']?([a-zA-Z0-9]{4})["']?\s+(-?[\d.]+)/g;

function parseVariationSettings(val) {
  if (!val || val === "normal") return null;
  if (typeof val === "object") return val;
  if (typeof val !== "string") return null;
  const out = {};
  let any = false;
  for (const [, tag, value] of val.matchAll(VARIATION_RE)) {
    out[tag] = Number(value);
    any = true;
  }
  return any ? out : null;
}

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
/** a fillStyle with a single colour behind it, as opposed to a gradient, a
 * pattern or a caller-supplied Picture */
function isPlainColor(style) {
  return typeof style === "string" || Array.isArray(style);
}

// `createPattern` repetitions -> XRender Repeat modes. The canvas spec's
// per-axis 'repeat-x'/'repeat-y' have no mode here (see createPattern);
// 'pad' and 'reflect' are the two XRender modes the spec has no name for.
const REPEAT_MODES = {
  repeat: 1, // Repeat.Normal
  "no-repeat": 0, // Repeat.None
  pad: 2, // clamp to the edge pixels
  reflect: 3, // mirror every other tile
};

const PATTERN_DOCS =
  "https://github.com/sidorares/ntk/blob/master/docs/context-2d.md#patterns";

/**
 * What a pattern tiles: a drawable holding the tile plus the picture format
 * to read it through. A repeating source Picture is created over it rather
 * than the source's own picture being changed, so tiling a `Surface` leaves
 * `drawImage` of that same surface exactly as it was.
 */
function patternSourceOf(app, source) {
  const Render = app.display.Render;
  const formatFor = (depth) =>
    depth === 32 ? Render.rgba32 : depth === 8 ? "a8" : Render.rgb24;

  let drawable = null;
  let width;
  let height;
  let format;
  if (source instanceof Surface) {
    if (source.app !== app) {
      throw new Error(
        "createPattern: the Surface belongs to a different X connection",
      );
    }
    drawable = source.pixmap;
    format = source.format === "a8" ? "a8" : Render.rgba32;
    ({ width, height } = source);
  } else if (source instanceof Image) {
    drawable = source.pixmap(app);
    format = Render.rgba32;
    ({ width, height } = source);
  } else if (source && typeof source.id === "number") {
    // a Drawable: a Pixmap, or a Window (through its backing pixmap, which
    // is where a double-buffered window's current pixels actually are)
    drawable = source._backing || source;
    const depth = drawable.depth ?? source.depth;
    if (!depth) {
      throw new Error(
        "createPattern: the drawable's depth is not known yet — await the window's geometry, or pass a Surface",
      );
    }
    format = formatFor(depth);
    width = drawable.width ?? source.width;
    height = drawable.height ?? source.height;
  } else {
    throw new Error(
      "createPattern: expected a Surface, an Image, a Pixmap or a Window as the tile, got " +
        (source === null ? "null" : typeof source),
    );
  }
  if (format === "a8") {
    throw new Error(
      "createPattern: a coverage (a8) tile has no colour to paint with — XRender would " +
        "sample it as black. Draw the tile into an argb32 Surface and tile that, or keep " +
        `the a8 one and use ctx.drawImage, which paints it in the current fillStyle. ${PATTERN_DOCS}`,
    );
  }
  return { drawable, format, width, height };
}

/**
 * Point a pattern's picture transform at the transform in force for this
 * fill — patterns are painted in user space, so the CTM is part of the
 * mapping. Returns false when nothing would be painted (a singular matrix),
 * true for anything else, including every non-pattern style.
 */
function preparePattern(src, m) {
  return src instanceof CanvasPattern ? src._sync(m) : true;
}

function isPictureSource(image) {
  return (
    image instanceof Image ||
    (image != null &&
      typeof image.picture === "function" &&
      Number.isFinite(image.width) &&
      Number.isFinite(image.height))
  );
}

// canvas globalCompositeOperation -> XRender PictOp name. Porter-Duff ops
// map directly; with a clip/shape mask active the op only applies inside
// the mask coverage (outside pixels are left untouched).
const GCO_TO_PICTOP = {
  "source-over": "Over",
  copy: "Src",
  "destination-over": "OverReverse",
  "source-in": "In",
  "destination-in": "InReverse",
  "source-out": "Out",
  "destination-out": "OutReverse",
  "source-atop": "Atop",
  "destination-atop": "AtopReverse",
  xor: "Xor",
  lighter: "Add",
};

// extrude-polyline has no round caps/joins: 'round' extrudes as butt/bevel
// and the missing coverage is unioned in afterwards as triangle-fan disks
// (see _strokePolys)
const LINE_CAP = { butt: "butt", square: "square", round: "butt" };
const LINE_JOIN = { miter: "miter", bevel: "bevel", round: "bevel" };

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
    if (typeof window.on === "function") {
      window.on("_backing", () => this._bindTarget());
      // masks are sized to the drawable — recreate them after a resize
      window.on("resize", () => this._dropMasks());
      // window-backed pictures are freed server-side with the window
      window.on("_destroyed", () => {
        if (this.picture && this._target === this.window) {
          this.picture.forget();
          this.picture = null;
        }
      });
    }

    this.fillMask = null;
    this.fillMaskDrawable = null;
    this.clipMask = null;
    this.clipMaskDrawable = null;
    this._textStyle = null;
    this._lastFontString = null;
    this.textAlign = "start";
    this.textBaseline = "alphabetic";

    this._path = new Path2D();
    this._m = [1, 0, 0, 1, 0, 0];
    // Rounded-rect fast-path observability (issue #211): every bail-out is
    // a silent perf cliff, so hits and misses-by-reason are always counted.
    // NTK_DEBUG_SHAPES=1 prints the process-wide aggregate at exit.
    this.shapeStats = { hits: 0, misses: {} };
    this._stack = [];
    this._clips = []; // [{ polys, rule }] in device space, already stacked
    this._gco = "source-over";
    this.globalAlpha = 1;
    this.lineCap = "butt";
    this.lineJoin = "miter";
    this.miterLimit = 10;
    this._lineDash = [];
    this._lineDashOffset = 0;

    this.fillStyle = "white";
    this.strokeStyle = "black";
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
    // Does the target have a real alpha channel? Only then is "transparent"
    // a colour it can hold, which is what clearRect turns on.
    this._hasAlpha = depth === 32;
    this.picture = new Picture(this.window.app, {
      drawable: target,
      format,
      polyEdge: 1,
      polyMode: 1,
    });
    this._dropMasks();
  }

  // Undo a rectangular server-side clip. "No clip" has to be stamped as a
  // rectangle that outlives window growth: the backing pixmap has headroom
  // past the window and growing into it does not rebind the picture, so a
  // restore at today's window size would keep clipping tomorrow's pixels.
  // Coordinates are INT16 — one rect at their maximum covers any drawable.
  _resetPictureClip() {
    this.Render.SetPictureClipRectangles(this.picture.id, 0, 0, [0, 0, 0x7fff, 0x7fff]);
  }

  /**
   * Release everything this context allocated server-side. Idempotent, and
   * the context must not be drawn with afterwards.
   *
   * A context bound to a window normally lives as long as the window and the
   * connection outlives both, which is why this went missing for so long (see
   * issue #156). It matters as soon as contexts are created *dynamically* —
   * one per offscreen `Surface`, say — because without it each one
   * permanently costs a GC and a Picture.
   *
   * `_backgroundPicture` and `_glyphSource` are deliberately not freed here:
   * both are either solids owned by the app (`App#solidPicture` — shared
   * with every other context, freed with the connection) or a
   * `Picture`/`CanvasGradient` the caller passed in through `fillStyle`,
   * which is not ours to free.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    gcRegistry.unregister(this);

    this._clips = [];
    this._dropMasks();
    for (const gc of [this._gc, this._fillMaskGC, this._clipMaskGC]) {
      if (!gc) continue;
      safeRelease(this.X, () => {
        this.X.FreeGC(gc);
        this.X.ReleaseID(gc);
      });
    }
    this._gc = this._fillMaskGC = this._clipMaskGC = null;
    this._gcs.length = 0;

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
    if (typeof this.window._markDirty !== "function") return;
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
    return this.Render.PictOp[GCO_TO_PICTOP[this._gco] || "Over"];
  }

  set globalCompositeOperation(value) {
    if (value in GCO_TO_PICTOP) this._gco = value;
  }

  get globalCompositeOperation() {
    return this._gco;
  }

  // solids live on the app, not the context: contexts can be as short-lived
  // as one Surface.render call, and the colours outlive all of them
  createSolidPicture(r, g, b, a) {
    return this.window.app.solidPicture(r, g, b, a);
  }

  _stylePicture(value) {
    if (typeof value === "string" || Array.isArray(value)) {
      const c = parseColor(value);
      return this.createSolidPicture(c[0], c[1], c[2], c[3]);
    }
    if (
      value instanceof Picture ||
      value instanceof CanvasGradient ||
      value instanceof CanvasPattern
    ) {
      return value;
    }
    throw new Error("Unknown fill style");
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
      fontVariations: this._fontVariations,
      textRendering: this._textRendering,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
      m: this._m.slice(),
      clips: this._clips,
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
    this._fontVariations = s.fontVariations;
    this._textRendering = s.textRendering;
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
    if (typeof a === "object" && a !== null) {
      const m = a;
      this._m = Array.isArray(m)
        ? m.slice(0, 6)
        : [m.a, m.b, m.c, m.d, m.e, m.f];
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
    if (r < 0) throw new RangeError("arc: negative radius");
    this._appendUserSegments(
      ellipseSegments(x, y, r, r, 0, startAngle, endAngle, counterclockwise),
    );
  }

  ellipse(
    x,
    y,
    rx,
    ry,
    rotation,
    startAngle,
    endAngle,
    counterclockwise = false,
  ) {
    if (rx < 0 || ry < 0) throw new RangeError("ellipse: negative radius");
    this._appendUserSegments(
      ellipseSegments(
        x,
        y,
        rx,
        ry,
        rotation,
        startAngle,
        endAngle,
        counterclockwise,
      ),
    );
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
    const wasEmpty = this._path._cmds.length === 0;
    this._path.addPath(tmp, this._m);
    // Re-derive the recognition tag in device space (addPath cleared it): it
    // survives only when this roundRect is the whole path and the CTM is a
    // pure translation at record time — the default path bakes the transform
    // into its commands here, so this is the last moment the box exists.
    if (!tmp._roundRect || !wasEmpty) return;
    const m = this._m;
    if (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1) {
      const t = tmp._roundRect;
      this._path._roundRect = {
        x: t.x + m[4],
        y: t.y + m[5],
        w: t.w,
        h: t.h,
        radii: t.radii,
      };
    } else {
      // a box recorded under rotation/scale can never take the glyph route;
      // leave the reason behind so fill()/stroke() count the bail-out
      this._path._roundRectMiss = "transform";
    }
  }

  // args: ([path], [fillRule]) — returns device-space polys + rule
  _polysFor(args) {
    if (args[0] instanceof Path2D) {
      return {
        polys: flattenPath(args[0]._cmds, this._m),
        rule: args[1] === "evenodd" ? "evenodd" : "nonzero",
      };
    }
    return {
      polys: flattenPath(this._path._cmds, null),
      rule: args[0] === "evenodd" ? "evenodd" : "nonzero",
    };
  }

  // ------------------------------------------------------------------
  // rasterization plumbing

  _ensureFillMask() {
    if (this.fillMask) return;
    this.fillMaskDrawable = new Pixmap(this.window.app, {
      depth: 8,
      width: this.width,
      height: this.height,
    });
    this.fillMask = new Picture(this.window.app, {
      drawable: this.fillMaskDrawable,
      format: this.Render.a8,
    });
  }

  _ensureClipMask() {
    if (this.clipMask) return;
    this.clipMaskDrawable = new Pixmap(this.window.app, {
      depth: 8,
      width: this.width,
      height: this.height,
    });
    this.clipMask = new Picture(this.window.app, {
      drawable: this.clipMaskDrawable,
      format: this.Render.a8,
    });
  }

  _rasterizePolys(picture, polys, rule, dx = 0, dy = 0) {
    const flat = [];
    for (const p of polys) if (p.pts.length >= 6) flat.push(p.pts);
    if (!flat.length) return;
    const traps = trapezoidize(flat, dx, dy, [], rule);
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
    if (routeRaster(b.w, b.h, edges, this.window.app.rasterPolicy) !== "local")
      return false;

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
        Buffer.from(coverage.buffer, coverage.byteOffset + y * b.w, b.w).copy(
          data,
          y * stride,
        );
      }
    }
    this.X.PutImage(
      2,
      this.fillMaskDrawable.id,
      this._maskGC(),
      b.w,
      b.h,
      b.x,
      b.y,
      0,
      8,
      data,
    );
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
    if (!preparePattern(src, this._m)) return;

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
    if (
      !this._uploadCoverage({ polys: flat, rule, dx: -b.x, dy: -b.y }, b, edges)
    ) {
      R.FillRectangles(
        R.PictOp.Src,
        this.fillMask.id,
        [0, 0, 0, 0],
        [b.x, b.y, b.w, b.h],
      );
      this._rasterizePolys(this.fillMask, polys, rule);
    }

    // a rectangular clip narrows where the coverage is *composited*; the
    // mask content outside it is stale by the same argument as outside `b`.
    // A stack whose mask was dropped by restore() may still hold a poly —
    // _clipRect says null then, and the mask comes back on demand.
    let out = b;
    if (this._clips.length && !this.clipMask) {
      const cr = this._clipRect();
      if (cr) {
        out = intersectBox(b, cr);
        if (!out) return;
      } else {
        this._requireClipMask();
      }
    }
    if (alpha < 1) {
      // In with a constant color scales the a8 coverage by that alpha
      R.FillRectangles(
        R.PictOp.In,
        this.fillMask.id,
        [0, 0, 0, alpha],
        [out.x, out.y, out.w, out.h],
      );
    }
    if (this.clipMask) {
      // clipMask is surface-aligned, so it is sampled at the same offset
      R.Composite(
        R.PictOp.In,
        this.clipMask.id,
        0,
        this.fillMask.id,
        out.x,
        out.y,
        0,
        0,
        out.x,
        out.y,
        out.w,
        out.h,
      );
    }
    // src is either a 1x1 repeating solid (offset irrelevant) or a
    // surface-aligned gradient, so it is sampled at the same offset too
    R.Composite(
      op,
      src.id,
      this.fillMask.id,
      this.picture.id,
      out.x,
      out.y,
      out.x,
      out.y,
      out.x,
      out.y,
      out.w,
      out.h,
    );
    this._markDirty();
  }

  _strokePolys(polys, { src = null } = {}) {
    src = src ?? this._strokePicture;
    if (this.globalAlpha <= 0) return;
    // approximate transform-aware line width by the average scale factor
    const det = this._m[0] * this._m[3] - this._m[1] * this._m[2];
    const scale = Math.sqrt(Math.abs(det)) || 1;
    const thickness = this.lineWidth * scale;
    const roundCap = this.lineCap === "round";
    const roundJoin = this.lineJoin === "round";
    const cap = LINE_CAP[this.lineCap] || "butt";
    const join = LINE_JOIN[this.lineJoin] || "miter";
    const stroke = extrudePolyline({
      thickness,
      cap,
      join,
      miterLimit: this.miterLimit,
    });
    // A closed subpath has no ends, so the canvas spec gives it no caps.
    // That cannot share the extruder above: with lineCap 'square'
    // extrude-polyline pushes the first and last points outward along the
    // line, which on a closed loop extends the seam over band it already
    // covers — invisible against an opaque colour, a double-blended edge
    // against a translucent one. Runs cut at an escaping join (see
    // escapingJoins) want butt ends for the same reason.
    const buttStroke =
      cap === "butt"
        ? stroke
        : extrudePolyline({
            thickness,
            cap: "butt",
            join,
            miterLimit: this.miterLimit,
          });
    // dash distances are user-space lengths; scale them like the line width
    const dash = this._lineDash.length
      ? this._lineDash.map((d) => d * scale)
      : null;
    const dashOffset = this._lineDashOffset * scale;

    const tris = [];
    // round caps/joins: extrude-polyline extrudes them as butt/bevel (see
    // LINE_CAP/LINE_JOIN) and we union triangle-fan disks of radius
    // lineWidth/2 on top — a full disk at an endpoint is exactly a round
    // cap, and a disk at an interior vertex fills the bevel notch
    let hasRound = false;
    const r = thickness / 2;
    // A disk is an arc like any other: the sagitta formula sizes it to the
    // flatness tolerance instead of a floor of 8 (which spent 16 triangles
    // on the half-pixel cap of a 1px line) and a ceiling of 32 (which was
    // coarse enough to show on a fat one). Three is the fewest that
    // enclose any area at all.
    const diskSegs = Math.max(3, arcSegmentCount(2 * Math.PI, r));
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
      let dot =
        ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])) /
        (l1 * l2);
      dot = Math.max(-1, Math.min(1, dot));
      // bevel-to-arc gap depth for turn angle θ: r * (1 - cos(θ/2))
      if (r * (1 - Math.sqrt((1 + dot) / 2)) > 0.05) addDisk(b[0], b[1]);
    };
    /**
     * Interior vertices whose join extrude-polyline cannot be trusted with,
     * ascending; null — the common case — for a polyline with none.
     *
     * Whatever the join style, it closes the *inner* side of a join at the
     * intersection of the two inner offsets, r/cos(φ/2) from the vertex for
     * a turn of φ: 'bevel' bevels the outer side and still emits that
     * point, and `miterLimit` only chooses which side gets bevelled. As φ
     * approaches a reversal the intersection runs away to infinity, so a
     * hairpin — a cusp in a curve, a polyline that doubles back — threw a
     * spike hundreds of pixels off the path that no join style and no miter
     * limit could reach (issue #233).
     *
     * The intersection is legitimate only while it stays inside the two
     * segments, which it does when each is at least r·tan(φ/2) long: that
     * is how far back along both the point sits. Where they are shorter it
     * is ink outside the path, and the run is cut at that vertex instead —
     * both sides then end butt on it, so the inner corner is the union of
     * the two rectangles, and the outer side gets addJoinWedge.
     */
    const escapingJoins = (run) => {
      let cuts = null;
      for (let i = 1; i < run.length - 1; i++) {
        const ax = run[i][0] - run[i - 1][0];
        const ay = run[i][1] - run[i - 1][1];
        const bx = run[i + 1][0] - run[i][0];
        const by = run[i + 1][1] - run[i][1];
        // This runs over every vertex of every stroke and almost never
        // fires, so it is written to answer "no" in multiplications alone:
        // squared lengths, and the raw (unnormalized) dot and cross, which
        // give tan(φ/2) = cross / (|a||b| + dot) directly.
        const la = ax * ax + ay * ay;
        const lb = bx * bx + by * by;
        if (!la || !lb) continue;
        const shortest = la < lb ? la : lb;
        const dot = ax * bx + ay * by;
        // a turn of 90° or less has tan(φ/2) <= 1, and so cannot reach past
        // a segment that is already at least r long
        if (dot >= 0 && r * r <= shortest) continue;
        const cross = ax * by - ay * bx;
        // r·tan(φ/2) > min(|a|, |b|), squared. A non-positive denominator
        // is the reversal the tangent is infinite at — but near one the
        // denominator is pure cancellation (√(la·lb) and -dot agree to ~15
        // digits), so an exact double-back lands a few ulps to either side
        // of 0. The same-x bursts of issue #259 have cross exactly 0 too,
        // so when denom rounded positive neither test here fired and the
        // extruder met the reversal itself, normalizing a zero-length
        // tangent into NaN join vertices. Below its own noise floor denom
        // only means "within microradians of a reversal", where the true
        // tangent exceeds a million and no segment can hold the join: cut
        // unconditionally.
        const ab = Math.sqrt(la * lb);
        const denom = ab + dot;
        if (
          denom <= ab * 1e-12 ||
          (r * cross) ** 2 > shortest * denom * denom
        ) {
          (cuts ??= []).push(i);
        }
      }
      return cuts;
    };
    /**
     * The outer side of the join at `b`, which cutting the run leaves to us:
     * the wedge between the two segments' outer offsets. A miter within the
     * limit fills it to the tip, everything else bevels — the same choice
     * the extruder would have made, on geometry that stays put.
     */
    const addJoinWedge = (a, b, c) => {
      const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
      if (!l1 || !l2) return;
      const ux = (b[0] - a[0]) / l1;
      const uy = (b[1] - a[1]) / l1;
      const vx = (c[0] - b[0]) / l2;
      const vy = (c[1] - b[1]) / l2;
      // outer side: away from the turn. A zero cross product is a straight
      // run or an exact reversal, and neither leaves a wedge to fill.
      const cross = ux * vy - uy * vx;
      if (!cross) return;
      // each segment's own offset at b: the normal r out on the outer side
      const s = cross > 0 ? -r : r;
      const p1x = b[0] - uy * s;
      const p1y = b[1] + ux * s;
      const p2x = b[0] - vy * s;
      const p2y = b[1] + vx * s;
      const dot = Math.max(-1, Math.min(1, ux * vx + uy * vy));
      const ratio = 1 / Math.sqrt((1 + dot) / 2); // miter length / r
      if (join === "miter" && ratio <= this.miterLimit) {
        // the tip is r·ratio along the bisector, where the two offsets meet
        const mx = p1x + p2x - 2 * b[0];
        const my = p1y + p2y - 2 * b[1];
        const ml = Math.hypot(mx, my);
        const tx = b[0] + (mx / ml) * r * ratio;
        const ty = b[1] + (my / ml) * r * ratio;
        tris.push(b[0], b[1], p1x, p1y, tx, ty);
        tris.push(b[0], b[1], tx, ty, p2x, p2y);
        return;
      }
      tris.push(b[0], b[1], p1x, p1y, p2x, p2y);
    };
    const emit = (run, extruder) => {
      const mesh = extruder.build(run);
      for (const tri of mesh.cells) {
        for (let i = 0; i < 3; ++i) {
          tris.push(mesh.positions[tri[i]][0], mesh.positions[tri[i]][1]);
        }
      }
    };
    // a square cap's extension of end point `p` away from its neighbour `q`
    const capOut = (p, q) => {
      const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (!d) return p;
      return [p[0] + ((p[0] - q[0]) / d) * r, p[1] + ((p[1] - q[1]) / d) * r];
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
      if (closed && pts.length >= 3) {
        // Move the seam to the middle of the first edge. extrude-polyline
        // treats every polyline as open — it butt-extrudes both ends and
        // emits no join between them — so a closed loop lost the join at
        // whichever vertex it happened to start on: a stroked rectangle
        // came out with three square corners and a notched one, the notch
        // being a quarter of the line width square. Cutting the loop in
        // the middle of a straight edge instead leaves the two ends
        // collinear, so they meet exactly, and makes every real vertex
        // interior, so extrude-polyline gives each the join it asked for
        // — miter, bevel and round alike.
        const mid = [
          (pts[0][0] + pts[1][0]) / 2,
          (pts[0][1] + pts[1][1]) / 2,
        ];
        pts = [mid, ...pts.slice(1), mid];
      }
      const cuts = escapingJoins(pts);
      if (!cuts) {
        emit(pts, closed ? buttStroke : stroke);
      } else {
        // Extrude the pieces between the cuts, each ending butt on the cut
        // vertex it shares with the next. That leaves the run's own two ends
        // to us as well: extrude-polyline squares both ends of whatever it
        // is handed, so a square cap is applied here instead.
        const last = pts.length - 1;
        let from = 0;
        for (const to of [...cuts, last]) {
          const run = pts.slice(from, to + 1);
          if (!closed && cap === "square") {
            if (from === 0) run[0] = capOut(run[0], run[1]);
            if (to === last)
              run[run.length - 1] = capOut(
                run[run.length - 1],
                run[run.length - 2],
              );
          }
          emit(run, buttStroke);
          from = to;
        }
        for (const i of cuts) addJoinWedge(pts[i - 1], pts[i], pts[i + 1]);
      }
      if (roundJoin) {
        // every real vertex is interior now, the seam included: a closed
        // run was rotated to break at a collinear point, which needs no
        // join disk of its own
        for (let i = 1; i < pts.length - 1; i++)
          maybeJoinDisk(pts[i - 1], pts[i], pts[i + 1]);
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
        if (Math.abs(p[0] - q[0]) > 1e-6 || Math.abs(p[1] - q[1]) > 1e-6)
          out.push(p);
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
        if (Math.abs(fx - lx) > 1e-6 || Math.abs(fy - ly) > 1e-6)
          pts.push([fx, fy]);
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
    // Nothing non-finite may reach the server: FIXED encoding turns NaN
    // into 0, so one poisoned vertex renders as a wedge to the origin on a
    // real display — while the in-process server quietly drops it, which
    // is why no headless pixel test can see this for us (issue #259). The
    // cuts above are meant to keep the extruder off that path; this keeps
    // a future miss from being catastrophic. A sum is finite iff every
    // term is.
    let w = 0;
    for (let i = 0; i < tris.length; i += 6) {
      const sum =
        tris[i] +
        tris[i + 1] +
        tris[i + 2] +
        tris[i + 3] +
        tris[i + 4] +
        tris[i + 5];
      if (!Number.isFinite(sum)) continue;
      if (w < i) for (let k = 0; k < 6; k++) tris[w + k] = tris[i + k];
      w += 6;
    }
    if (w < tris.length) tris.length = w;
    if (!tris.length) return;

    const op = this._op();
    // round-cap/join disks overlap the stroke body; overlapping coverage
    // must accumulate in the clamped a8 mask (single composite) or a
    // semi-transparent stroke style would double-blend at the overlaps
    const direct =
      !hasRound &&
      this.globalAlpha >= 1 &&
      !this._clips.length &&
      op === this.Render.PictOp.Over;
    const chunk = 4000 * 6;
    if (direct) {
      for (let i = 0; i < tris.length; i += chunk) {
        const batch = tris.slice(i, i + chunk);
        // RENDER aligns the source with the *first triangle's first vertex*,
        // not with the destination: the source is sampled at
        // (srcX + x - floor(tris[0].x)). Passing that vertex back is what
        // makes source coordinates equal destination coordinates, the same
        // convention drawGlyphRuns and compositeTraps use — without it every
        // non-constant stroke style (a gradient, a pattern) is offset by
        // wherever the stroke happens to start, and shifts as it moves.
        this.Render.Triangles(
          op,
          src.id,
          Math.floor(batch[0]),
          Math.floor(batch[1]),
          this.picture.id,
          this.Render.a8,
          batch,
        );
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
    if (
      !this._uploadCoverage(
        { triangles: tris, dx: -b.x, dy: -b.y },
        b,
        tris.length / 2,
      )
    ) {
      this.Render.FillRectangles(
        this.Render.PictOp.Src,
        this.fillMask.id,
        [0, 0, 0, 0],
        [b.x, b.y, b.w, b.h],
      );
      const opaque = this.createSolidPicture(0, 0, 0, 1);
      for (let i = 0; i < tris.length; i += chunk) {
        this.Render.Triangles(
          this.Render.PictOp.Add,
          opaque.id,
          0,
          0,
          this.fillMask.id,
          this.Render.a8,
          tris.slice(i, i + chunk),
        );
      }
    }
    let out = b;
    if (this._clips.length && !this.clipMask) {
      const cr = this._clipRect();
      if (cr) {
        out = intersectBox(b, cr);
        if (!out) return;
      } else {
        this._requireClipMask();
      }
    }
    if (this.globalAlpha < 1) {
      this.Render.FillRectangles(
        this.Render.PictOp.In,
        this.fillMask.id,
        [0, 0, 0, this.globalAlpha],
        [out.x, out.y, out.w, out.h],
      );
    }
    if (this.clipMask) {
      this.Render.Composite(
        this.Render.PictOp.In,
        this.clipMask.id,
        0,
        this.fillMask.id,
        out.x,
        out.y,
        0,
        0,
        out.x,
        out.y,
        out.w,
        out.h,
      );
    }
    this.Render.Composite(
      op,
      src.id,
      this.fillMask.id,
      this.picture.id,
      out.x,
      out.y,
      out.x,
      out.y,
      out.x,
      out.y,
      out.w,
      out.h,
    );
    this._markDirty();
  }

  /**
   * Composite glyph runs onto this context, honouring the clip. This is
   * the primitive `fillText` and `TextLayout.draw` are built on, and it is
   * public: the run shape below is a documented contract
   * (docs/text.md#glyph-runs), so renderers that position glyphs
   * themselves — a terminal grid, a tabular column — can hand-build runs
   * instead of shaping.
   *
   * @param {number} op Render.PictOp (`ctx.Render.PictOp.Over` for normal text)
   * @param {Picture} src source picture the glyphs paint with — a solid
   *   (`ctx.createSolidPicture(r, g, b, a)`, premultiplied 0..1) or a gradient
   * @param {Array<{run, x, y, textRendering?}>} positioned runs in visual
   *   order; `x`/`y` is the run's baseline origin in device space. `run` is
   *   `{ font, size, glyphs }` — a `Font`, a pixel size, and glyphs
   *   `{ id, ax, dx, dy }` in drawing order: `id` a font glyph id
   *   (`Font.shape()`'s `glyphs[].id`, or `Font.glyphIdFor(cp)`), `ax` the
   *   pen advance in px, `dx`/`dy` the drawing offset from the pen position
   *   (y-up: positive `dy` raises the glyph). The pen starts at `x`; each
   *   glyph inks at `(pen + dx, y - dy)` and then advances it by `ax`.
   *   `Font.shape()` returns runs of exactly this shape; extra fields
   *   (`codePoints`, `width`, …) are ignored. `textRendering` optionally
   *   overrides the bitmap/vector routing per run (docs/text.md).
   *
   * CompositeGlyphs writes straight to the destination picture, so it has
   * no way to consult our clip mask — text drawn through it used to spill
   * out of clipped boxes while every fill and stroke stayed inside. With a
   * clip active, render the glyph coverage into the scratch a8 mask
   * instead, intersect that with the clip, and paint the real source
   * through the result — the same shape as _fillPolys. A rectangular clip
   * takes the server-side fast path below instead of the mask.
   */
  drawGlyphs(op, src, positioned) {
    const app = this.window.app;
    const R = this.Render;
    if (!preparePattern(src, this._m)) return;
    if (!this._clips.length) {
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
      R.SetPictureClipRectangles(this.picture.id, 0, 0, [
        rect.x,
        rect.y,
        rect.w,
        rect.h,
      ]);
      drawGlyphRuns(app, op, src.id, this.picture.id, positioned);
      this._resetPictureClip();
      this._markDirty();
      return;
    }
    const clipMask = this._requireClipMask();
    this._ensureFillMask();
    this._glyphSource ??= this.createSolidPicture(1, 1, 1, 1);
    R.FillRectangles(
      R.PictOp.Src,
      this.fillMask.id,
      [0, 0, 0, 0],
      [0, 0, this.width, this.height],
    );
    // solid white through the glyphs leaves their coverage in the a8 mask
    drawGlyphRuns(
      app,
      R.PictOp.Over,
      this._glyphSource.id,
      this.fillMask.id,
      positioned,
    );
    R.Composite(
      R.PictOp.In,
      clipMask.id,
      0,
      this.fillMask.id,
      0,
      0,
      0,
      0,
      0,
      0,
      this.width,
      this.height,
    );
    R.Composite(
      op,
      src.id,
      this.fillMask.id,
      this.picture.id,
      0,
      0,
      0,
      0,
      0,
      0,
      this.width,
      this.height,
    );
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
    if (!this._clips.length) {
      compositeTraps(app, op, src.id, this.picture.id, traps);
      this._markDirty();
      return;
    }
    const rect = this._clipRect();
    if (rect) {
      if (rect.w === 0 || rect.h === 0) return;
      R.SetPictureClipRectangles(this.picture.id, 0, 0, [
        rect.x,
        rect.y,
        rect.w,
        rect.h,
      ]);
      compositeTraps(app, op, src.id, this.picture.id, traps);
      this._resetPictureClip();
      this._markDirty();
      return;
    }
    const clipMask = this._requireClipMask();
    this._ensureFillMask();
    this._glyphSource ??= this.createSolidPicture(1, 1, 1, 1);
    R.FillRectangles(
      R.PictOp.Src,
      this.fillMask.id,
      [0, 0, 0, 0],
      [0, 0, this.width, this.height],
    );
    compositeTraps(
      app,
      R.PictOp.Over,
      this._glyphSource.id,
      this.fillMask.id,
      traps,
    );
    R.Composite(
      R.PictOp.In,
      clipMask.id,
      0,
      this.fillMask.id,
      0,
      0,
      0,
      0,
      0,
      0,
      this.width,
      this.height,
    );
    R.Composite(
      op,
      src.id,
      this.fillMask.id,
      this.picture.id,
      0,
      0,
      0,
      0,
      0,
      0,
      this.width,
      this.height,
    );
    this._markDirty();
  }

  // combined clip ∩ globalAlpha mask for direct composites (rect/image
  // fast paths); returns a picture id or 0. Reuses the fill scratch mask.
  _compositeMask() {
    // reached only when the clip is not a rectangle (those went through the
    // SetPictureClipRectangles path), so a clip here always means the mask
    const clipMask = this._clips.length ? this._requireClipMask() : null;
    if (this.globalAlpha >= 1) return clipMask ? clipMask.id : 0;
    this._ensureFillMask();
    this.Render.FillRectangles(
      this.Render.PictOp.Src,
      this.fillMask.id,
      [0, 0, 0, this.globalAlpha],
      [0, 0, this.width, this.height],
    );
    if (clipMask) {
      this.Render.Composite(
        this.Render.PictOp.In,
        clipMask.id,
        0,
        this.fillMask.id,
        0,
        0,
        0,
        0,
        0,
        0,
        this.width,
        this.height,
      );
    }
    return this.fillMask.id;
  }

  // ------------------------------------------------------------------
  // drawing

  // Clearing means "back to nothing", and what nothing looks like depends on
  // whether the target can hold transparency. A depth-32 ARGB window gets
  // transparent black, the canvas spec's answer, and the compositor shows
  // whatever is behind it. Anything else has no alpha channel to write, so
  // clearing stays opaque white — the paper an opaque window starts from,
  // and what every caller predating ARGB windows expects.
  clearRect(x, y, w, h) {
    const alpha = this._hasAlpha;
    if (matIsIdentity(this._m) && !this._clips.length) {
      this.Render.FillRectangles(
        this.Render.PictOp.Src,
        this.picture.id,
        alpha ? [0, 0, 0, 0] : [1, 1, 1, 1],
        [x, y, w, h],
      );
      this._markDirty();
      return;
    }
    const tmp = new Path2D();
    tmp.rect(x, y, w, h);
    // Transformed or clipped, so the rect is a polygon and the erase has to
    // run through the coverage mask. OutReverse is `dst OUT src`: against an
    // opaque source it scales the destination by 1 - coverage, erasing to
    // transparent with an antialiased edge. PictOpSrc would take the whole
    // bounding box with it, coverage or not. Opaque targets keep the old
    // behaviour: paint white over the shape, ignoring alpha and the
    // composite op but honoring the clip, matching the fast path above.
    this._fillPolys(flattenPath(tmp._cmds, this._m), "nonzero", {
      src: alpha
        ? this.createSolidPicture(0, 0, 0, 1)
        : this.createSolidPicture(1, 1, 1, 1),
      op: alpha ? this.Render.PictOp.OutReverse : this.Render.PictOp.Over,
      alpha: 1,
    });
  }

  fillRect(x, y, w, h) {
    if (matIsIdentity(this._m)) {
      if (!preparePattern(this._backgroundPicture, this._m)) return;
      const mask = this._compositeMask();
      this.Render.Composite(
        this._op(),
        this._backgroundPicture.id,
        mask,
        this.picture.id,
        x,
        y,
        x,
        y,
        x,
        y,
        w,
        h,
      );
      this._markDirty();
      return;
    }
    const tmp = new Path2D();
    tmp.rect(x, y, w, h);
    this._fillPolys(flattenPath(tmp._cmds, this._m), "nonzero");
  }

  /**
   * Fill a batch of axis-aligned rectangles: `fillRect` once per rectangle
   * semantically — fillStyle, globalAlpha, the composite op, the clip and
   * damage reporting all apply — but priced for the "many small rectangles
   * per frame" caller (issue #253): terminal cell backgrounds, sparkline
   * bars, heat maps, row striping.
   *
   * `rects` is an array of `[x, y, w, h]` quadruples or one flat
   * `[x0, y0, w0, h0, x1, ...]` array; rectangles with non-positive width
   * or height are skipped.
   *
   * A solid-colour fillStyle under an identity transform and a rectangular
   * (or absent) clip compiles the whole list into a single
   * `Render.FillRectangles`, where N `fillRect` calls cost N composites.
   * Gradient/Picture styles, transforms and non-rectangular clips fall
   * back to that `fillRect` loop, so the answer is always right and only
   * the request count varies.
   */
  fillRects(rects) {
    if (!rects || !rects.length || this.globalAlpha <= 0) return;
    // normalize to one flat list, dropping empty rectangles up front — the
    // wire encodes width and height unsigned, so a negative would wrap
    const flat = [];
    if (Array.isArray(rects[0])) {
      for (const r of rects) {
        if (r[2] > 0 && r[3] > 0) flat.push(r[0], r[1], r[2], r[3]);
      }
    } else {
      for (let i = 0; i + 3 < rects.length; i += 4) {
        if (rects[i + 2] > 0 && rects[i + 3] > 0)
          flat.push(rects[i], rects[i + 1], rects[i + 2], rects[i + 3]);
      }
    }
    if (!flat.length) return;

    const clip = this._clips.length ? this._clipRect() : null;
    if (
      !matIsIdentity(this._m) ||
      !isPlainColor(this._fillStyle) ||
      (this._clips.length && !clip)
    ) {
      for (let i = 0; i < flat.length; i += 4)
        this.fillRect(flat[i], flat[i + 1], flat[i + 2], flat[i + 3]);
      return;
    }
    if (clip && (clip.w === 0 || clip.h === 0)) return; // clipped away
    const R = this.Render;
    if (clip) {
      R.SetPictureClipRectangles(this.picture.id, 0, 0, [
        clip.x,
        clip.y,
        clip.w,
        clip.h,
      ]);
    }
    // globalAlpha folds into the premultiplied colour — scaling all four
    // components is exactly what compositing at that opacity means, for
    // any composite op (the mask slot would only scale the source the same
    // way)
    const color = this._foldedColor(this._fillStyle);
    // stay under the server's maximum request size
    const chunk = 10000 * 4;
    for (let i = 0; i < flat.length; i += chunk) {
      R.FillRectangles(
        this._op(),
        this.picture.id,
        color,
        i === 0 && flat.length <= chunk ? flat : flat.slice(i, i + chunk),
      );
    }
    if (clip) this._resetPictureClip();
    this._markDirty();
  }

  strokeRect(x, y, w, h) {
    const m = this._m;
    if (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1) {
      const zero = { x: 0, y: 0 };
      const box = {
        x: x + m[4],
        y: y + m[5],
        w,
        h,
        radii: [zero, zero, zero, zero],
      };
      if (this._tryStrokeBox(box)) return;
    } else {
      this._shapeMiss("transform");
    }
    const tmp = new Path2D();
    tmp.rect(x, y, w, h);
    this._strokePolys(flattenPath(tmp._cmds, this._m));
  }

  fill(...args) {
    if (this._tryRoundRectFill(args)) return;
    const { polys, rule } = this._polysFor(args);
    this._fillPolys(polys, rule);
  }

  stroke(...args) {
    const box = this._shapeBoxFor(args);
    if (box && this._tryStrokeBox(box)) return;
    const polys =
      args[0] instanceof Path2D
        ? flattenPath(args[0]._cmds, this._m)
        : flattenPath(this._path._cmds, null);
    this._strokePolys(polys);
  }

  // ------------------------------------------------------------------
  // rounded-rect fast path (issue #211)
  //
  // A fill/stroke of an axis-aligned rounded rect on integer geometry is
  // emitted as corner glyphs + FillRectangles — the box's only curved ink
  // rides the glyph path, cached server-side after first use, and nothing
  // is rasterized or uploaded afterwards. The pieces partition the pixels
  // (glyphs own their integer-cut corner boxes, rects the strips between),
  // so translucent colours are safe with no mask and no accumulation. Every
  // condition below that fails falls through to the polygon route untouched,
  // counting the reason in `shapeStats`.

  /** count one fast-path bail-out; always returns false for tail-calling */
  _shapeMiss(reason) {
    const misses = this.shapeStats.misses;
    misses[reason] = (misses[reason] || 0) + 1;
    countShapeMiss(reason);
    return false;
  }

  /**
   * The device-space rounded-rect a fill/stroke argument list describes, or
   * null. The default path carries its tag in device space already (recorded
   * under a translate-only CTM); a Path2D argument is user-space, so the CTM
   * must be translate-only *now*.
   */
  _shapeBoxFor(args) {
    const path = args[0] instanceof Path2D ? args[0] : this._path;
    const tag = path._roundRect;
    if (path === this._path) {
      if (tag) return tag;
      // a roundRect that could not be tagged at record time left the reason
      if (path._roundRectMiss) this._shapeMiss(path._roundRectMiss);
      return null;
    }
    if (!tag) return null;
    const m = this._m;
    if (!(m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1)) {
      this._shapeMiss("transform");
      return null;
    }
    return {
      x: tag.x + m[4],
      y: tag.y + m[5],
      w: tag.w,
      h: tag.h,
      radii: tag.radii,
    };
  }

  /** premultiplied solid colour with globalAlpha folded in — scaling all
   * four components of a premultiplied colour is exactly what compositing
   * it at that opacity means */
  _foldedColor(style) {
    const c = parseColor(style);
    const a = this.globalAlpha;
    return a >= 1 ? c : [c[0] * a, c[1] * a, c[2] * a, c[3] * a];
  }

  _tryRoundRectFill(args) {
    const box = this._shapeBoxFor(args);
    if (!box) return false;
    // maxRadius <= 0 is the documented off switch (NTK_NO_SHAPE_GLYPHS
    // sets it too): everything falls through, including zero-radius boxes
    const policy = shapePolicyOf(this.window.app);
    if (policy.maxRadius <= 0) return this._shapeMiss("radius-cap");
    // (a rounded rect is one simple closed curve, so the fill rule cannot
    // change what it covers — the rule argument needs no inspection)
    if (!isPlainColor(this._fillStyle)) return this._shapeMiss("gradient");
    if (this._gco !== "source-over") return this._shapeMiss("composite-op");
    const clip = this._clips.length ? this._clipRect() : null;
    if (this._clips.length && !clip) return this._shapeMiss("clip-mask");

    const { x, y, w, h, radii } = box;
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      !Number.isInteger(w) ||
      !Number.isInteger(h)
    ) {
      return this._shapeMiss("fractional");
    }
    for (const r of radii) {
      if (!Number.isInteger(r.x) || !Number.isInteger(r.y))
        return this._shapeMiss("fractional");
      if (r.x > policy.maxRadius || r.y > policy.maxRadius)
        return this._shapeMiss("radius-cap");
    }
    // wire coordinates are INT16, and glyph position deltas too
    if (
      x < -32768 ||
      y < -32768 ||
      x + w > 32767 ||
      y + h > 32767 ||
      w > 32767 ||
      h > 32767
    ) {
      return this._shapeMiss("geometry");
    }
    const [tl, tr, br, bl] = radii;
    // effective corner boxes — a corner with either radius 0 is square
    const c = {
      tlw: tl.x && tl.y ? tl.x : 0,
      tlh: tl.x && tl.y ? tl.y : 0,
      trw: tr.x && tr.y ? tr.x : 0,
      trh: tr.x && tr.y ? tr.y : 0,
      blw: bl.x && bl.y ? bl.x : 0,
      blh: bl.x && bl.y ? bl.y : 0,
      brw: br.x && br.y ? br.x : 0,
      brh: br.x && br.y ? br.y : 0,
    };
    // diagonally opposite corner boxes must not overlap or the partition
    // would paint pixels twice (same-edge pairs are bounded by the radii
    // normalization, but the diagonal is not)
    if (
      (c.tlw + c.brw > w && c.tlh + c.brh > h) ||
      (c.trw + c.blw > w && c.trh + c.blh > h)
    ) {
      return this._shapeMiss("geometry");
    }
    if (this.globalAlpha <= 0 || w <= 0 || h <= 0) {
      // nothing to draw — and the fallback would draw nothing too
      countShapeHit();
      this.shapeStats.hits++;
      return true;
    }

    const corners = [];
    if (c.tlw) {
      corners.push({
        key: cornerKey("fill", c.tlw, c.tlh, 0, TL),
        kind: "fill", rx: c.tlw, ry: c.tlh, bw: 0, corner: TL,
        px: x, py: y,
      });
    }
    if (c.trw) {
      corners.push({
        key: cornerKey("fill", c.trw, c.trh, 0, TR),
        kind: "fill", rx: c.trw, ry: c.trh, bw: 0, corner: TR,
        px: x + w - c.trw, py: y,
      });
    }
    if (c.blw) {
      corners.push({
        key: cornerKey("fill", c.blw, c.blh, 0, BL),
        kind: "fill", rx: c.blw, ry: c.blh, bw: 0, corner: BL,
        px: x, py: y + h - c.blh,
      });
    }
    if (c.brw) {
      corners.push({
        key: cornerKey("fill", c.brw, c.brh, 0, BR),
        kind: "fill", rx: c.brw, ry: c.brh, bw: 0, corner: BR,
        px: x + w - c.brw, py: y + h - c.brh,
      });
    }
    const rects = roundRectBandRects(x, y, w, h, c);
    this._emitShapeGlyphs(corners, rects, this._foldedColor(this._fillStyle), clip);
    return true;
  }

  /**
   * Stroke fast path for a device-space box (from a roundRect tag or
   * strokeRect). Beyond the fill's conditions: uniform lineWidth, no
   * dashes — and the half-pixel one that matters: the stroke band must land
   * on pixel boundaries. A border drawn the correct way (path inset by bw/2,
   * so the band [X, X+bw] sits on integers) passes at any width, odd or even;
   * a 1px stroke on integer path coordinates is genuinely a two-row 50% band
   * and must keep falling back, because the fast path would not reproduce it.
   */
  _tryStrokeBox(box) {
    // the same off switch as the fill's — see _tryRoundRectFill
    const policy = shapePolicyOf(this.window.app);
    if (policy.maxRadius <= 0) return this._shapeMiss("radius-cap");
    if (!isPlainColor(this._strokeStyle)) return this._shapeMiss("gradient");
    if (this._gco !== "source-over") return this._shapeMiss("composite-op");
    if (this._lineDash.length) return this._shapeMiss("dashes");
    const clip = this._clips.length ? this._clipRect() : null;
    if (this._clips.length && !clip) return this._shapeMiss("clip-mask");

    const bw = this.lineWidth;
    if (!Number.isFinite(bw) || bw <= 0) return this._shapeMiss("geometry");
    const { x, y, w, h, radii } = box;
    if (!(w > 0 && h > 0)) return this._shapeMiss("geometry");
    // one circular radius for all four corners: the ring glyph is keyed on
    // a single (r, bw) and mixed or elliptical corners fall back
    const r0 = radii[0];
    for (const r of radii) {
      if (r.x !== r0.x || r.y !== r0.y) return this._shapeMiss("radii-mix");
    }
    if (r0.x !== r0.y) return this._shapeMiss("radii-mix");
    const r = r0.x;

    const X0 = x - bw / 2; // outer band corner
    const Y0 = y - bw / 2;
    const W = w + bw; // outer band size
    const H = h + bw;
    // What the route needs is that the *ink* is pixel-aligned: the band's
    // four outer edges on integers, which is what the four tests below say,
    // and an integer width so the straight runs are whole rows and columns
    // of FillRectangles (fractional extents would be truncated on the wire —
    // and a fractional lineWidth passes the outer-band tests, e.g. x = 0.75
    // with bw = 1.5, so this clause carries real weight).
    //
    // The *path* radius is free. The corner glyph box is cut at
    // K = ceil(r + bw/2), and from the arc's tangent point out to that cut
    // the band is already its own straight continuation — bw whole rows —
    // so a fractional radius rides inside the glyph, which rasterizes on the
    // device pixel grid, exactly as it does on the polygon route. This is
    // what a border inset by bw/2 needs: nesting inside a background corner
    // of radius R means a path radius of R - bw/2, half-integer for every
    // odd width (issue #217).
    if (
      !Number.isInteger(X0) ||
      !Number.isInteger(Y0) ||
      !Number.isInteger(W) ||
      !Number.isInteger(H) ||
      !Number.isInteger(bw)
    ) {
      return this._shapeMiss("fractional");
    }
    if (
      X0 < -32768 ||
      Y0 < -32768 ||
      X0 + W > 32767 ||
      Y0 + H > 32767 ||
      W > 32767 ||
      H > 32767
    ) {
      return this._shapeMiss("geometry");
    }
    if (this.globalAlpha <= 0) {
      countShapeHit();
      this.shapeStats.hits++;
      return true;
    }
    const color = this._foldedColor(this._strokeStyle);

    if (r === 0) {
      // square corners lower to four FillRectangles with no glyphs at all —
      // but only when the miter join actually squares them (the default);
      // bevel or round corners look different and keep the polygon route
      if (this.lineJoin !== "miter" || this.miterLimit < Math.SQRT2)
        return this._shapeMiss("join");
      if (W < 2 * bw || H < 2 * bw) return this._shapeMiss("geometry");
      const rects = [X0, Y0, W, bw, X0, Y0 + H - bw, W, bw];
      if (H > 2 * bw) {
        rects.push(X0, Y0 + bw, bw, H - 2 * bw);
        rects.push(X0 + W - bw, Y0 + bw, bw, H - 2 * bw);
      }
      this._emitShapeGlyphs([], rects, color, clip);
      return true;
    }

    // a border thicker than the corner radius swallows the arc's centre;
    // the ring glyph does not model that, so it stays on the polygon route
    if (r - bw / 2 < 0) return this._shapeMiss("geometry");
    const K = Math.ceil(r + bw / 2); // corner glyph box, integer cut lines
    if (K > policy.maxRadius) return this._shapeMiss("radius-cap");
    if (2 * K > W || 2 * K > H) return this._shapeMiss("geometry");

    const corners = [
      {
        key: cornerKey("stroke", r, r, bw, TL),
        kind: "stroke", rx: r, ry: r, bw, corner: TL,
        px: X0, py: Y0,
      },
      {
        key: cornerKey("stroke", r, r, bw, TR),
        kind: "stroke", rx: r, ry: r, bw, corner: TR,
        px: X0 + W - K, py: Y0,
      },
      {
        key: cornerKey("stroke", r, r, bw, BL),
        kind: "stroke", rx: r, ry: r, bw, corner: BL,
        px: X0, py: Y0 + H - K,
      },
      {
        key: cornerKey("stroke", r, r, bw, BR),
        kind: "stroke", rx: r, ry: r, bw, corner: BR,
        px: X0 + W - K, py: Y0 + H - K,
      },
    ];
    const rects = [];
    if (W > 2 * K) {
      rects.push(X0 + K, Y0, W - 2 * K, bw);
      rects.push(X0 + K, Y0 + H - bw, W - 2 * K, bw);
    }
    if (H > 2 * K) {
      rects.push(X0, Y0 + K, bw, H - 2 * K);
      rects.push(X0 + W - bw, Y0 + K, bw, H - 2 * K);
    }
    this._emitShapeGlyphs(corners, rects, color, clip);
    return true;
  }

  /**
   * Emit one recognized box: ensure the corner glyphs, one CompositeGlyphs
   * run for them, one FillRectangles for the strips — inside a server-side
   * clip rectangle when the clip stack is rectangular (the way glyph runs
   * for text already do it).
   */
  _emitShapeGlyphs(corners, rects, color, clip) {
    countShapeHit();
    this.shapeStats.hits++;
    if (clip && (clip.w === 0 || clip.h === 0)) return; // clipped away
    const R = this.Render;
    const app = this.window.app;
    if (clip) {
      R.SetPictureClipRectangles(this.picture.id, 0, 0, [
        clip.x,
        clip.y,
        clip.w,
        clip.h,
      ]);
    }
    if (corners.length) {
      const page = getShapeGlyphPage(app);
      page.ensure(corners);
      const items = [];
      for (const spec of corners) {
        items.push({
          gs: page.glyphset.id,
          lid: page.entry(spec.key).lid,
          adv: 0,
          x: spec.px,
          y: spec.py,
        });
      }
      const encoded = encodeGlyphItems(items, page.bits);
      const src = app.solidPicture(color[0], color[1], color[2], color[3]);
      R.CompositeGlyphs(
        encoded.bits,
        R.PictOp.Over,
        src.id,
        this.picture.id,
        0,
        encoded.gsid,
        items[0].x,
        items[0].y,
        encoded.elts,
      );
      trimShapeGlyphs(app);
    }
    if (rects.length) {
      R.FillRectangles(R.PictOp.Over, this.picture.id, color, rects);
    }
    if (clip) this._resetPictureClip();
    this._markDirty();
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
    return {
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h),
    };
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

    // A stack of rectangles stays virtual: consumers apply the intersected
    // rectangle server-side (SetPictureClipRectangles, bounded composites),
    // and no a8 mask — no window-sized pixmap, no AddTraps — ever exists.
    // That is the common case by a wide margin: a renderer clipping to a
    // damage rect, a viewport and a cell nests rectangles three deep before
    // the first rounded corner appears. The mask materializes on the first
    // entry that is not a rectangle, and stays in sync from then on.
    if (!this.clipMask) {
      if (entry.rect) return;
      this._materializeClipMask();
      return;
    }
    this._intersectClip(entry);
  }

  /**
   * Build the a8 mask from the whole clip stack, on first demand. Rect
   * entries are plain fills; only genuinely non-rectangular entries
   * rasterize, and those through `_applyPolyClip`, which keeps the
   * trapezoid work off the window-sized mask itself.
   */
  _materializeClipMask() {
    const R = this.Render;
    this._ensureClipMask();
    R.FillRectangles(
      R.PictOp.Src,
      this.clipMask.id,
      [0, 0, 0, 0],
      [0, 0, this.width, this.height],
    );
    const first = this._clips[0];
    if (first.rect) {
      const r = first.rect;
      const x = Math.max(0, Math.min(r.x, this.width));
      const y = Math.max(0, Math.min(r.y, this.height));
      const right = Math.max(x, Math.min(r.x + r.w, this.width));
      const bottom = Math.max(y, Math.min(r.y + r.h, this.height));
      if (right > x && bottom > y) {
        R.FillRectangles(
          R.PictOp.Src,
          this.clipMask.id,
          [0, 0, 0, 1],
          [x, y, right - x, bottom - y],
        );
      }
    } else {
      this._applyPolyClip(first, R.PictOp.Src);
    }
    for (let i = 1; i < this._clips.length; i++)
      this._intersectClip(this._clips[i]);
  }

  /** The live mask, built if the stack has not needed one yet. Callers on
   * the rectangle fast paths never get here; a rect-only stack only
   * materializes when a consumer genuinely has no cheaper way in. */
  _requireClipMask() {
    if (!this.clipMask) this._materializeClipMask();
    return this.clipMask;
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
        this.Render.FillRectangles(
          this.Render.PictOp.Src,
          this.clipMask.id,
          [0, 0, 0, 0],
          outside,
        );
      }
      return;
    }
    this._applyPolyClip(entry, this.Render.PictOp.In);
  }

  /**
   * Rasterize one non-rectangular clip entry and combine it onto the mask:
   * `Src` writes a fresh mask (everything outside was just cleared), `In`
   * intersects a live one. The trapezoids land in a temp sized to the
   * entry's bounding box, never on the window-sized mask — on glamor an
   * AddTraps is a software fallback that maps its whole target pixmap, so
   * the target's size *is* the cost. Everything outside the box is cleared
   * with plain fills: outside the entry the mask is zero by definition.
   */
  _applyPolyClip(entry, op) {
    const R = this.Render;
    const bb = this._polysBBox(entry.polys);
    if (!bb || bb.w <= 0 || bb.h <= 0) {
      R.FillRectangles(
        R.PictOp.Src,
        this.clipMask.id,
        [0, 0, 0, 0],
        [0, 0, this.width, this.height],
      );
      return;
    }
    if (op === R.PictOp.In) {
      const outside = [];
      if (bb.y > 0) outside.push(0, 0, this.width, bb.y);
      if (bb.y + bb.h < this.height) {
        outside.push(0, bb.y + bb.h, this.width, this.height - (bb.y + bb.h));
      }
      if (bb.x > 0) outside.push(0, bb.y, bb.x, bb.h);
      if (bb.x + bb.w < this.width) {
        outside.push(bb.x + bb.w, bb.y, this.width - (bb.x + bb.w), bb.h);
      }
      if (outside.length) {
        R.FillRectangles(R.PictOp.Src, this.clipMask.id, [0, 0, 0, 0], outside);
      }
    }
    const tmpPixmap = new Pixmap(this.window.app, {
      depth: 8,
      width: bb.w,
      height: bb.h,
    });
    const tmpMask = new Picture(this.window.app, {
      drawable: tmpPixmap,
      format: R.a8,
    });
    if (!this._uploadClipCoverage(tmpPixmap, entry, bb)) {
      R.FillRectangles(
        R.PictOp.Src,
        tmpMask.id,
        [0, 0, 0, 0],
        [0, 0, bb.w, bb.h],
      );
      this._rasterizePolys(tmpMask, entry.polys, entry.rule, -bb.x, -bb.y);
    }
    R.Composite(
      op,
      tmpMask.id,
      0,
      this.clipMask.id,
      0,
      0,
      0,
      0,
      bb.x,
      bb.y,
      bb.w,
      bb.h,
    );
    tmpMask.destroy();
    tmpPixmap.destroy();
  }

  /**
   * The clip-mask twin of `_uploadCoverage`: rasterize one clip entry here
   * and PutImage the coverage into the bbox temp, instead of asking the
   * server for trapezoids. Returns false — caller falls back to AddTraps —
   * with no rasterizer, when the policy routes this shape to the server, or
   * when the rasterizer declines.
   *
   * Without this the routing was only half applied. `_uploadCoverage` covers
   * fills and strokes, so an app that set `rasterPolicy` to keep every
   * drawing local still emitted an AddTraps per non-rectangular clip, and on
   * glamor those were the whole remaining cost: a wall of 48 rounded cards
   * spent 12 AddTraps a frame on clips alone (react-x11#199), 116ms of
   * server drain per frame, with no policy able to reach them.
   *
   * PutImage writes Src, so it replaces the temp's clear as well.
   */
  _uploadClipCoverage(tmpPixmap, entry, bb) {
    const rasterizer = this.window.app.rasterizer;
    if (!rasterizer) return false;
    const flat = [];
    let edges = 0;
    for (const p of entry.polys) {
      if (p.pts.length < 6) continue;
      flat.push(p.pts);
      edges += p.pts.length / 2;
    }
    if (!flat.length) return false;
    if (
      routeRaster(bb.w, bb.h, edges, this.window.app.rasterPolicy) !== "local"
    ) {
      return false;
    }

    const coverage = rasterizer.rasterize({
      polys: flat,
      rule: entry.rule,
      dx: -bb.x,
      dy: -bb.y,
      width: bb.w,
      height: bb.h,
    });
    if (!coverage) return false;

    // scanlines padded to 4 bytes, as in _uploadCoverage — and as there, a
    // width that is already a multiple of 4 goes out as a view over the
    // rasterizer's own bytes with no copy
    const stride = (bb.w + 3) & ~3;
    let data;
    if (stride === bb.w) {
      data = Buffer.isBuffer(coverage)
        ? coverage
        : Buffer.from(coverage.buffer, coverage.byteOffset, coverage.length);
    } else {
      data = Buffer.alloc(stride * bb.h);
      for (let y = 0; y < bb.h; ++y) {
        Buffer.from(coverage.buffer, coverage.byteOffset + y * bb.w, bb.w).copy(
          data,
          y * stride,
        );
      }
    }
    this.X.PutImage(
      2,
      tmpPixmap.id,
      this._clipGC(tmpPixmap),
      bb.w,
      bb.h,
      0,
      0,
      0,
      8,
      data,
    );
    return true;
  }

  /**
   * GC for uploading coverage into a clip temp. Created against the first
   * temp and kept: every one of them is depth 8 on the same root, which is
   * all a GC binds to, and the temps themselves come and go per clip entry.
   */
  _clipGC(tmpPixmap) {
    if (!this._clipMaskGC) {
      this._clipMaskGC = this.X.AllocID();
      this._gcs.push(this._clipMaskGC);
      this.X.CreateGC(this._clipMaskGC, tmpPixmap.id);
    }
    return this._clipMaskGC;
  }

  _rebuildClipMask() {
    // The stack changed shape (restore, resize): drop the mask rather than
    // rebuild it eagerly. A stack that went back to rectangles never needs
    // one again, and one that still holds a poly rebuilds on first demand
    // through _requireClipMask — same work, paid only if something draws.
    if (this.clipMask) {
      this.clipMask.destroy();
      this.clipMaskDrawable.destroy();
      this.clipMask = this.clipMaskDrawable = null;
    }
  }

  isPointInPath(...args) {
    let path = null;
    let rest = args;
    if (args[0] instanceof Path2D) {
      path = args[0];
      rest = args.slice(1);
    }
    const [x, y, rule] = rest;
    const polys = path
      ? flattenPath(path._cmds, this._m)
      : flattenPath(this._path._cmds, null);
    return polysContain(
      polys,
      x,
      y,
      rule === "evenodd" ? "evenodd" : "nonzero",
    );
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
    if (align === "start") align = shaped.baseLevel & 1 ? "right" : "left";
    if (align === "end") align = shaped.baseLevel & 1 ? "left" : "right";
    if (align === "center") return -shaped.width / 2;
    if (align === "right") return -shaped.width;
    return 0;
  }

  // vertical distance from the requested y to the baseline
  _baselineOffset(metrics) {
    switch (this.textBaseline) {
      case "top":
        return metrics.ascent;
      case "hanging":
        return metrics.ascent * 0.8;
      case "middle":
        return (metrics.ascent - metrics.descent) / 2;
      case "bottom":
      case "ideographic":
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
    text = String(text ?? "");
    if (!text) return;
    const style = this._resolvedTextStyle();
    const app = this.window.app;
    // through the shaping memo TextLayout uses: a label repainted every
    // frame shapes once, not once per frame
    const shaped = app.fonts._shapeCachedWhole(text, style);
    const [tx, ty] = matApply(this._m, x, y);
    const ox = tx + this._alignOffset(shaped);
    const oy = ty + this._baselineOffset(style.font.metrics(style.size));

    const positioned = [];
    let cursor = ox;
    for (const run of reorderRuns(shaped.runs)) {
      positioned.push({
        run,
        x: cursor,
        y: oy,
        textRendering: this._textRendering,
      });
      cursor += run.width;
    }
    this.drawGlyphs(
      this.Render.PictOp.Over,
      this._backgroundPicture,
      positioned,
    );
  }

  /**
   * Measure shaped text. Returns a canvas-style TextMetrics object:
   * `width` (advance), actual bounding box (ink extents relative to the
   * origin), and font bounding box (from font metrics).
   */
  measureText(text) {
    const style = this._resolvedTextStyle();
    const shaped = this.window.app.fonts.shape(String(text ?? ""), style);
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
      height: maxY - minY,
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
    if (!val || typeof val !== "string") return;
    const parsed = parseFontStyle(val);
    if (!parsed) return;
    const style = {
      family: parsed.family,
      weight: parsed.weight,
      style: parsed.style,
      size: parsed.size,
      variations: this._fontVariations,
    };
    style.font = this.window.app.fonts.match(style.family, style);
    this._lastFontString = val;
    this._textStyle = style;
  }

  get font() {
    return this._lastFontString || DEFAULT_FONT;
  }

  /**
   * CSS's `font-variation-settings`, for a variable font: `'"wght" 460'`,
   * or `{ wght: 460 }`. Axes a font does not have are ignored and values are
   * clamped to their range, so this is safe to set unconditionally.
   *
   * The `wght` axis needs none of this — a numeric weight in the `font`
   * shorthand already drives it (`ctx.font = '460 40px Inter'`). This is for
   * the rest: `wdth`, `slnt`, `opsz` and whatever a display face invents.
   *
   * Order-independent: setting it after `font` re-resolves the face, so the
   * two can be assigned either way round.
   */
  set fontVariationSettings(val) {
    this._fontVariations = parseVariationSettings(val);
    // re-resolve against the font already in force, if there is one
    if (this._textStyle) this.font = this._lastFontString;
  }

  get fontVariationSettings() {
    return this._fontVariations ?? null;
  }

  /**
   * CSS's `text-rendering`: which glyph path this text takes, overriding the
   * size thresholds in `app.textPolicy`.
   *
   * - `'geometricPrecision'` — outlines every draw, glyph origins **not**
   *   rounded to whole pixels. What display text wants, and what any text
   *   whose shape is being animated wants: a variable font's axis moves
   *   advances by fractions of a pixel, and cached glyphs can only land on
   *   whole ones, so those fractions accumulate until a glyph crosses a
   *   rounding boundary and jumps a pixel on its own.
   * - `'optimizeSpeed'` — cached server-side glyphs at any size.
   * - `'auto'` (default) — the thresholds decide.
   *
   * `'optimizeLegibility'` is accepted and means `'auto'`; ntk has no
   * hinting to turn on.
   */
  set textRendering(val) {
    this._textRendering = val || undefined;
  }

  get textRendering() {
    return this._textRendering ?? "auto";
  }

  // ------------------------------------------------------------------
  // gradients / images

  createLinearGradient(x0, y0, x1, y1) {
    return new CanvasGradient("linear", this, x0, y0, x1, y1);
  }

  createRadialGradient(x0, y0, r0, x1, y1, r1) {
    return new CanvasGradient("radial", this, x0, y0, x1, y1, r0, r1);
  }

  createConicalGradient(x0, y0, angle) {
    return new CanvasGradient("conical", this, x0, y0, angle);
  }

  /**
   * A tiled paint: `source` repeated across whatever it fills, by the server,
   * in the one composite the fill already costs (issue #263).
   *
   *     const tile = new Surface(app, { width: 24, height: 24 });
   *     tile.render((c) => { c.fillStyle = '#333'; c.fillRect(0, 0, 1, 1); });
   *     ctx.fillStyle = ctx.createPattern(tile, 'repeat');
   *     ctx.fillRect(0, 0, ctx.width, ctx.height);   // one request, no mask
   *
   * That is the difference between a background grid costing one repeating
   * picture and costing a pane-sized coverage mask: drawn as thousands of
   * tiny subpaths, a dot grid rasterizes client-side into an a8 mask the
   * size of its own bounding box — which for a background *is* the pane —
   * then uploads and composites it, every frame.
   *
   * `source` is a `Surface` (pixels the server drew), an `Image` (pixels
   * uploaded from the client), a `Pixmap` or a `Window`.
   *
   * `repetition` is `'repeat'` (the default), `'no-repeat'`, or the two
   * XRender modes the canvas spec has no name for: `'pad'` (clamp to the
   * edge pixels) and `'reflect'` (mirror every other tile). The spec's
   * per-axis `'repeat-x'`/`'repeat-y'` are not among them — XRender repeats
   * a source picture on both axes or on neither — and asking for one throws
   * with the clip-to-a-strip equivalent.
   */
  createPattern(source, repetition = "repeat") {
    return new CanvasPattern(this.window.app, source, repetition);
  }

  /** the pixel layout of whatever this context currently draws into */
  get _layout() {
    const depth =
      this._target.depth ??
      this.window.depth ??
      this.display.screen[0].root_depth;
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
    if (typeof a === "number") return new ImageData(a, b);
    if (a && typeof a.width === "number" && a.data)
      return new ImageData(a.width, a.height);
    throw new TypeError(
      "createImageData: pass (width, height) or an ImageData",
    );
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
        `putImageData: data must be ${width * height * 4} RGBA bytes for ${width}x${height}`,
      );
    }
    dirtyWidth ??= width;
    dirtyHeight ??= height;
    // the spec normalises negative extents by moving the origin
    if (dirtyWidth < 0) {
      dirtyX += dirtyWidth;
      dirtyWidth = -dirtyWidth;
    }
    if (dirtyHeight < 0) {
      dirtyY += dirtyHeight;
      dirtyHeight = -dirtyHeight;
    }
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
          src.subarray(
            (sy + row) * width * 4 + sx * 4,
            (sy + row) * width * 4 + (sx + sw) * 4,
          ),
          row * sw * 4,
        );
      }
      rgba = cropped;
    }

    const layout = this._layout;
    const bytes = fromStraightRgba(rgba, layout, sw, sh);
    // Shared memory for a large blit; otherwise upload row bands that stay
    // under the server's maximum request size.
    if (
      !this.window.app.shm.putImage(this._target.id, this._gc, {
        width: sw,
        height: sh,
        depth: layout.depth,
        dstX: x + sx,
        dstY: y + sy,
        data: bytes,
      })
    ) {
      const stride = sw * 4;
      const maxBytes = ((this.display.max_request_length ?? 65535) - 8) * 4;
      const rowsPerBand = Math.max(1, Math.floor(maxBytes / stride));
      for (let row = 0; row < sh; row += rowsPerBand) {
        const rows = Math.min(rowsPerBand, sh - row);
        this.X.PutImage(
          2, // ZPixmap
          this._target.id,
          this._gc,
          sw,
          rows,
          x + sx,
          y + sy + row,
          0,
          layout.depth,
          bytes.subarray(row * stride, (row + rows) * stride),
        );
      }
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
      (raw) => new ImageData(toStraightRgba(raw.data, raw.layout, w, h), w, h),
    );
    if (typeof cb === "function") {
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
    const target = this._target.id;
    const X = this.X;
    return new Promise((resolve, reject) => {
      const coreGet = () =>
        X.GetImage(2, target, x, y, w, h, 0xffffffff, (err, img) => {
          if (err) return reject(err);
          resolve({ width: w, height: h, data: img.data, layout, ...layout });
        });

      // A readback is where shared memory helps most: a core GetImage sends the
      // whole image back over the socket and can block the server for tens of
      // milliseconds. Route large ones through a segment; fall back on any miss.
      const bytesPerPixel = layout.bitsPerPixel ? layout.bitsPerPixel >> 3 : 4;
      const shm = this.window.app.shm;
      if (shm.wantsReadback(w * h * bytesPerPixel)) {
        shm.getImage(target, x, y, w, h, layout.depth, (err, buf, rep) => {
          if (err) return coreGet();
          // buf is the segment's own memory, reused after this callback returns
          // — copy out synchronously before it is handed to the next reader
          const data = Buffer.from(buf.subarray(0, rep.size));
          resolve({ width: w, height: h, data, layout, ...layout });
        });
      } else {
        coreGet();
      }
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
    const rect = this._clips.length ? this._clipRect() : null;
    if (!rect)
      return { mask: this._compositeMask(), clipped: false, empty: false };
    if (rect.w === 0 || rect.h === 0)
      return { mask: 0, clipped: false, empty: true };
    this.Render.SetPictureClipRectangles(this.picture.id, 0, 0, [
      rect.x,
      rect.y,
      rect.w,
      rect.h,
    ]);
    const mask =
      this.globalAlpha >= 1
        ? 0
        : this.createSolidPicture(0, 0, 0, this.globalAlpha).id;
    return { mask, clipped: true, empty: false };
  }

  _endDirectComposite(state) {
    if (!state.clipped) return;
    this._resetPictureClip();
  }

  /** The source colour for a coverage composite, with `globalAlpha` folded
   * into it. The mask slot is taken by the coverage, so the alpha has to go
   * somewhere — and a 1x1 solid is free, where a surface-sized alpha mask is
   * not. Falls back to the fill picture for gradients, which have no single
   * colour to fold into; `_drawCoverage` routes those through the scratch. */
  _coverageSource() {
    const style = this._fillStyle;
    if (this.globalAlpha >= 1 || !isPlainColor(style)) {
      // a pattern whose transform collapsed paints nothing, and "nothing" as
      // a source is transparent black — no call site here has to know
      return preparePattern(this._backgroundPicture, this._m)
        ? this._backgroundPicture
        : this.createSolidPicture(0, 0, 0, 0);
    }
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
      R.SetPictureTransform(picture.id, [
        sw / dw,
        0,
        sx,
        0,
        sh / dh,
        sy,
        0,
        0,
        1,
      ]);
      picture.setFilter("bilinear");
    }
    // with a transform in place the mask is already sampled from (sx, sy)
    const mx = scaled ? 0 : sx;
    const my = scaled ? 0 : sy;

    const rect = this._clips.length ? this._clipRect() : null;
    // the mask slot can hold exactly one picture, so anything that cannot be
    // folded into the colour or handed to the server as a clip rectangle has
    // to be intersected into the scratch mask first
    const scratch =
      (this._clips.length && !rect) ||
      (this.globalAlpha < 1 && !isPlainColor(this._fillStyle));

    if (scratch) {
      this._ensureFillMask();
      R.FillRectangles(
        R.PictOp.Src,
        this.fillMask.id,
        [0, 0, 0, 0],
        [0, 0, this.width, this.height],
      );
      R.Composite(
        R.PictOp.Src,
        picture.id,
        0,
        this.fillMask.id,
        mx,
        my,
        0,
        0,
        dx,
        dy,
        dw,
        dh,
      );
      if (this.globalAlpha < 1) {
        R.Composite(
          R.PictOp.InReverse,
          this.createSolidPicture(0, 0, 0, this.globalAlpha).id,
          0,
          this.fillMask.id,
          0,
          0,
          0,
          0,
          0,
          0,
          this.width,
          this.height,
        );
      }
      if (this._clips.length && !rect) {
        const clipMask = this._requireClipMask();
        R.Composite(
          R.PictOp.In,
          clipMask.id,
          0,
          this.fillMask.id,
          0,
          0,
          0,
          0,
          0,
          0,
          this.width,
          this.height,
        );
      } else if (rect) {
        // scratch was forced by alpha-over-gradient, not by the clip: the
        // rectangle still applies, server-side, around the final composite
        R.SetPictureClipRectangles(this.picture.id, 0, 0, [
          rect.x,
          rect.y,
          rect.w,
          rect.h,
        ]);
      }
      // The scratch mask is surface-sized and surface-aligned — the coverage
      // went into it at (dx, dy) — and so is a gradient source, so both are
      // sampled at the destination offset. Reading either from (0, 0) draws a
      // dw x dh window out of the wrong part of a full-surface picture: for
      // the mask that is the region just cleared to zero, so nothing paints at
      // all unless dx and dy are both zero.
      R.Composite(
        op,
        this._backgroundPicture.id,
        this.fillMask.id,
        this.picture.id,
        dx,
        dy,
        dx,
        dy,
        dx,
        dy,
        dw,
        dh,
      );
      if (rect) {
        R.SetPictureClipRectangles(this.picture.id, 0, 0, [
          0,
          0,
          this.width,
          this.height,
        ]);
      }
    } else if (!rect || (rect.w > 0 && rect.h > 0)) {
      if (rect) {
        R.SetPictureClipRectangles(this.picture.id, 0, 0, [
          rect.x,
          rect.y,
          rect.w,
          rect.h,
        ]);
      }
      // the source is a 1x1 repeating solid (offset irrelevant) or the fill
      // picture, which for a gradient is surface-aligned: same offset as the
      // destination, exactly as in _fillPolys
      R.Composite(
        op,
        this._coverageSource().id,
        picture.id,
        this.picture.id,
        dx,
        dy,
        mx,
        my,
        dx,
        dy,
        dw,
        dh,
      );
      if (rect) {
        this._resetPictureClip();
      }
    }

    if (scaled) {
      // restore defaults so the cached surface stays reusable as-is
      R.SetPictureTransform(picture.id, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
      picture.setFilter("nearest");
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

      if (image.format === "a8") {
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
        this.Render.SetPictureTransform(picture.id, [
          sw / dw,
          0,
          sx,
          0,
          sh / dh,
          sy,
          0,
          0,
          1,
        ]);
        picture.setFilter("bilinear");
        this.Render.Composite(
          op,
          picture.id,
          mask,
          this.picture.id,
          0,
          0,
          dx,
          dy,
          dx,
          dy,
          dw,
          dh,
        );
        // restore defaults so the cached upload can be reused as-is
        this.Render.SetPictureTransform(
          picture.id,
          [1, 0, 0, 0, 1, 0, 0, 0, 1],
        );
        picture.setFilter("nearest");
      } else {
        this.Render.Composite(
          op,
          picture.id,
          mask,
          this.picture.id,
          sx,
          sy,
          dx,
          dy,
          dx,
          dy,
          dw,
          dh,
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
        0,
        0,
        0,
        0,
        0,
        0,
        this.width,
        this.height,
      );
      this._markDirty();
    } else if (
      image &&
      image.context &&
      typeof image.context.getImageData === "function"
    ) {
      // node-canvas Canvas ( or any ctx with ctx.canvas.getImageData returning pixels)
      const imageData = image.context.getImageData(sx, sy, sWidth, sHeight);
      // node-canvas hands over straight RGBA, and the rgba32 picture below is
      // premultiplied — this used to swap the channels and stop there, which
      // composited translucent images at full brightness
      const data = fromStraightRgba(
        imageData.data,
        pixelLayout(this.display, 32),
        sWidth,
        sHeight,
      );

      // One upload GC per app rather than one per call, the same sharing
      // Image.picture does: a GC is valid for any drawable of the same screen
      // and depth. This used to allocate a GC, a pixmap and a picture every
      // time and free none of them, so drawing a node-canvas source in an
      // animation loop leaked three server resources per frame.
      const app = this.window.app;
      const pixmap = new Pixmap(app, {
        depth: 32,
        width: sWidth,
        height: sHeight,
      });
      const picture = new Picture(app, {
        drawable: pixmap,
        format: this.Render.rgba32,
      });
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
          0,
          0,
          0,
          0,
          0,
          0,
          this.width,
          this.height,
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
      matApply(this._m, dx + dw, dy + dh),
    ];
    const x0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))));
    const y0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))));
    const x1 = Math.min(
      this.width,
      Math.ceil(Math.max(...corners.map((c) => c[0]))),
    );
    const y1 = Math.min(
      this.height,
      Math.ceil(Math.max(...corners.map((c) => c[1]))),
    );
    if (x1 <= x0 || y1 <= y0) return;

    // device -> source sample (adding the source-rect origin)
    const srcM = [inv[0], inv[1], inv[2], inv[3], inv[4] + sx, inv[5] + sy];
    this.Render.SetPictureTransform(picture.id, [
      srcM[0],
      srcM[2],
      srcM[4],
      srcM[1],
      srcM[3],
      srcM[5],
      0,
      0,
      1,
    ]);
    picture.setFilter("bilinear");
    const mask = this._compositeMask();
    this.Render.Composite(
      op,
      picture.id,
      mask,
      this.picture.id,
      x0,
      y0,
      x0,
      y0,
      x0,
      y0,
      x1 - x0,
      y1 - y0,
    );
    this.Render.SetPictureTransform(picture.id, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    picture.setFilter("nearest");
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
    if (type === "linear" || type === "radial") {
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
      case "linear":
        Render.LinearGradient(
          this._id,
          [this.x0, this.y0],
          [this.x1, this.y1],
          this.stops,
        );
        break;
      case "radial":
        Render.RadialGradient(
          this._id,
          [this.x0, this.y0],
          [this.x1, this.y1],
          this.r0,
          this.r1,
          this.stops,
        );
        break;
      case "conical":
        Render.ConicalGradient(
          this._id,
          [this.x0, this.y0],
          this.angle,
          this.stops,
        );
        break;
      default:
        throw new Error("unknown gradient type");
    }
    // wrap with picture so FreePicture is invoked on gc via FinalizationRegistry
    this._picture = new Picture(this.ctx.window.app, { id: this._id });
    return this._id;
  }
}

/**
 * The fill/stroke style `ctx.createPattern` returns: a tile and how it
 * repeats, backed by one repeating XRender source picture.
 *
 * The picture is created on first use and freed by `destroy()` (or by the
 * GC, through `Picture`'s finalizer). The tile it reads is *not* the
 * pattern's to free: destroying the `Surface`/`Image` it came from is safe
 * while the pattern lives — X keeps pixmap storage alive as long as a
 * picture references it — but the pixels stop tracking anything drawn after.
 *
 * A pattern is bound to the connection, not to the context that made it, so
 * one grid tile serves every window on the app.
 */
class CanvasPattern {
  constructor(app, source, repetition = "repeat") {
    const name = repetition ?? "repeat";
    const repeat = REPEAT_MODES[name];
    if (repeat === undefined) {
      const known = Object.keys(REPEAT_MODES)
        .map((k) => `'${k}'`)
        .join(", ");
      const axis = name === "repeat-x" || name === "repeat-y";
      throw new Error(
        `createPattern: unsupported repetition ${JSON.stringify(name)}` +
          (axis
            ? " — XRender repeats a source picture on both axes or on neither, with no" +
              " per-axis mode to map this one to. Tile with 'repeat' and bound the fill" +
              " to the one row/column of tiles instead: ctx.fillRect(x, y, w, tile.height)" +
              " repeats horizontally and nowhere else."
            : "") +
          `. Supported: ${known}. ${PATTERN_DOCS}`,
      );
    }
    const { drawable, format, width, height } = patternSourceOf(app, source);

    this.app = app;
    this.Render = app.display.Render;
    this.source = source;
    this.repetition = name;
    this.width = width;
    this.height = height;
    this._repeat = repeat;
    this._drawable = drawable;
    this._format = format;
    // pattern space -> user space, the canvas `CanvasPattern.setTransform`
    // matrix. The picture transform is its inverse, composed with the CTM.
    this._m = [1, 0, 0, 1, 0, 0];
    this._picture = null;
    // what the server currently holds: a fresh picture is untransformed and
    // filtered nearest, so an untransformed fill costs no extra request
    this._applied = [1, 0, 0, 1, 0, 0];
    this._filter = "nearest";
  }

  /**
   * Position/scale/rotate the tile, canvas-style: `matrix` maps pattern
   * space to user space, as `[a, b, c, d, e, f]` or a DOMMatrix-shaped
   * `{a, b, c, d, e, f}`. Translating by the scroll offset is what keeps a
   * grid glued to the content under it.
   */
  setTransform(matrix) {
    const m = Array.isArray(matrix)
      ? matrix
      : [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f];
    if (m.length < 6 || m.some((v) => !Number.isFinite(Number(v)))) {
      throw new Error(
        "CanvasPattern.setTransform: expected [a, b, c, d, e, f] or {a, b, c, d, e, f} of finite numbers",
      );
    }
    this._m = m.slice(0, 6).map(Number);
    return this;
  }

  /** the repeating source Picture, created on first use */
  get picture() {
    if (!this._picture) {
      this._picture = new Picture(this.app, {
        drawable: this._drawable,
        format: this._format,
        repeat: this._repeat,
      });
    }
    return this._picture;
  }

  /** the Picture id, which is all a fill needs of a style */
  get id() {
    return this.picture.id;
  }

  /**
   * Make the server-side mapping match `ctm ∘ patternMatrix`. XRender's
   * picture transform runs the other way — it takes a coordinate in the
   * composite's source space (which every fill here keeps equal to device
   * space) to a texel — so it is the inverse.
   *
   * Returns false when that composition collapses (a zero scale), which
   * paints nothing, exactly as the canvas spec says.
   */
  _sync(ctm) {
    const m = matMultiply(ctm, this._m);
    const inv = matInvert(m);
    if (!inv) return false;
    const a = this._applied;
    if (
      inv[0] !== a[0] ||
      inv[1] !== a[1] ||
      inv[2] !== a[2] ||
      inv[3] !== a[3] ||
      inv[4] !== a[4] ||
      inv[5] !== a[5]
    ) {
      this.Render.SetPictureTransform(this.id, [
        inv[0],
        inv[2],
        inv[4],
        inv[1],
        inv[3],
        inv[5],
        0,
        0,
        1,
      ]);
      this._applied = inv;
    }
    // A tile landing on whole pixels wants its own pixels back, not a blend
    // of them: nearest is both exact and cheaper. Anything else is resampled.
    const filter =
      m[0] === 1 &&
      m[1] === 0 &&
      m[2] === 0 &&
      m[3] === 1 &&
      Number.isInteger(m[4]) &&
      Number.isInteger(m[5])
        ? "nearest"
        : "bilinear";
    if (filter !== this._filter) {
      this.picture.setFilter(filter);
      this._filter = filter;
    }
    return true;
  }

  /** free the repeating picture; the tile it read is the caller's */
  destroy() {
    if (this._picture) {
      this._picture.destroy();
      this._picture = null;
    }
    this._applied = [1, 0, 0, 1, 0, 0];
    this._filter = "nearest";
  }

  [Symbol.dispose]() {
    this.destroy();
  }
}

// register context
Drawable.renderingContextFactory["2d"] = (window) =>
  new RenderingContext2d(window);

export default RenderingContext2d;
export { CanvasGradient, CanvasPattern };
