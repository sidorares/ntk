import parseFontStyle from 'canvas-fontstyle';
import extrudePolyline from 'extrude-polyline';
import parseColorRaw from 'parse-color';

import Drawable from './drawable.js';
import { Image } from './image.js';
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
import { drawGlyphRuns } from './text/glyphs.js';
import { TextLayout } from './text/layout.js';
import { reorderRuns } from './text/shape.js';
import { trapezoidize } from './trapezoid.js';

const DEFAULT_FONT = '20px sans-serif';

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

// extrude-polyline has no round caps/joins; degrade to the closest shape
const LINE_CAP = { butt: 'butt', square: 'square', round: 'square' };
const LINE_JOIN = { miter: 'miter', bevel: 'bevel', round: 'bevel' };

function parseColor(value) {
  if (Array.isArray(value)) return value;
  const c = parseColorRaw(value);
  return [c.rgba[0] / 255, c.rgba[1] / 255, c.rgba[2] / 255, c.rgba[3]];
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

    this.window = window;
    this.Render = window.app.display.Render;

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

    this.fillStyle = 'white';
    this.strokeStyle = 'black';
    this.lineWidth = 1;
  }

  _bindTarget() {
    const target = this.window._backing || this.window;
    if (this._target === target) return;
    this._target = target;

    if (!this._gc) {
      // one GC is enough: it stays valid for any drawable of the same
      // screen and depth (the backing pixmap matches the window depth)
      this._gc = this.X.AllocID();
      this.X.CreateGC(this._gc, target.id);
    }
    if (this.picture) this.picture.destroy();
    // TODO: support a8
    const depth = target.depth ?? this.window.depth;
    const format = depth === 32 ? this.Render.rgba32 : this.Render.rgb24;
    this.picture = new Picture(this.window.app, {
      drawable: target,
      format,
      polyEdge: 1,
      polyMode: 1
    });
    this._dropMasks();
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
    if (typeof this.window._markDirty === 'function') this.window._markDirty();
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

  /**
   * Core fill: rasterize device-space polys into the scratch a8 mask,
   * scale by globalAlpha, intersect with the clip, composite the source.
   */
  _fillPolys(polys, rule, { src = null, op = null, alpha = null } = {}) {
    if (!polys.length) return;
    src = src ?? this._backgroundPicture;
    op = op ?? this._op();
    alpha = alpha ?? this.globalAlpha;
    if (alpha <= 0) return;

    this._ensureFillMask();
    this.Render.FillRectangles(this.Render.PictOp.Src, this.fillMask.id, [0, 0, 0, 0], [0, 0, this.width, this.height]);
    this._rasterizePolys(this.fillMask, polys, rule);

    if (alpha < 1) {
      // In with a constant color scales the a8 coverage by that alpha
      this.Render.FillRectangles(this.Render.PictOp.In, this.fillMask.id, [0, 0, 0, alpha], [0, 0, this.width, this.height]);
    }
    if (this.clipMask) {
      this.Render.Composite(
        this.Render.PictOp.In,
        this.clipMask.id,
        0,
        this.fillMask.id,
        0, 0, 0, 0, 0, 0,
        this.width,
        this.height
      );
    }
    this.Render.Composite(op, src.id, this.fillMask.id, this.picture.id, 0, 0, 0, 0, 0, 0, this.width, this.height);
    this._markDirty();
  }

  _strokePolys(polys, { src = null } = {}) {
    src = src ?? this._strokePicture;
    if (this.globalAlpha <= 0) return;
    // approximate transform-aware line width by the average scale factor
    const det = this._m[0] * this._m[3] - this._m[1] * this._m[2];
    const thickness = this.lineWidth * (Math.sqrt(Math.abs(det)) || 1);
    const stroke = extrudePolyline({
      thickness,
      cap: LINE_CAP[this.lineCap] || 'butt',
      join: LINE_JOIN[this.lineJoin] || 'miter',
      miterLimit: this.miterLimit
    });

    const tris = [];
    for (const poly of polys) {
      const pts = [];
      for (let i = 0; i < poly.pts.length; i += 2) pts.push([poly.pts[i], poly.pts[i + 1]]);
      if (poly.closed) pts.push([poly.pts[0], poly.pts[1]]);
      if (pts.length < 2) continue;
      const mesh = stroke.build(pts);
      for (const tri of mesh.cells) {
        for (let i = 0; i < 3; ++i) {
          tris.push(mesh.positions[tri[i]][0], mesh.positions[tri[i]][1]);
        }
      }
    }
    if (!tris.length) return;

    const op = this._op();
    const direct = this.globalAlpha >= 1 && !this.clipMask && op === this.Render.PictOp.Over;
    const chunk = 4000 * 6;
    if (direct) {
      for (let i = 0; i < tris.length; i += chunk) {
        this.Render.Triangles(op, src.id, 0, 0, this.picture.id, this.Render.a8, tris.slice(i, i + chunk));
      }
      this._markDirty();
      return;
    }

    // render coverage into the scratch mask, then composite through it so
    // the stroke honors clip / globalAlpha / composite op
    this._ensureFillMask();
    this.Render.FillRectangles(this.Render.PictOp.Src, this.fillMask.id, [0, 0, 0, 0], [0, 0, this.width, this.height]);
    const opaque = this.createSolidPicture(0, 0, 0, 1);
    for (let i = 0; i < tris.length; i += chunk) {
      this.Render.Triangles(this.Render.PictOp.Add, opaque.id, 0, 0, this.fillMask.id, this.Render.a8, tris.slice(i, i + chunk));
    }
    if (this.globalAlpha < 1) {
      this.Render.FillRectangles(this.Render.PictOp.In, this.fillMask.id, [0, 0, 0, this.globalAlpha], [0, 0, this.width, this.height]);
    }
    if (this.clipMask) {
      this.Render.Composite(this.Render.PictOp.In, this.clipMask.id, 0, this.fillMask.id, 0, 0, 0, 0, 0, 0, this.width, this.height);
    }
    this.Render.Composite(op, src.id, this.fillMask.id, this.picture.id, 0, 0, 0, 0, 0, 0, this.width, this.height);
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
  clip(...args) {
    const { polys, rule } = this._polysFor(args);
    const entry = { polys, rule };
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
    drawGlyphRuns(app, this.Render.PictOp.Over, this._backgroundPicture.id, this.picture.id, positioned);
    this._markDirty();
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

  createImageData(w, h) {
    return {
      width: w,
      height: h,
      data: Buffer.alloc(w * h * 4)
    };
  }

  // TODO: remove, add drawImage
  putImageData(data, x, y) {
    // todo: use constants
    this.X.PutImage(2, this._target.id, this._gc, data.width, data.height, x, y, 0, 24, data.data);
    this._markDirty();
  }

  getImageData(x, y, w, h, cb) {
    // reads the backing pixmap on double-buffered windows: always valid,
    // even where the window is occluded on screen
    this.X.GetImage(2, this._target.id, x, y, w, h, 0xffffffff, cb);
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
  drawImage(image, ...args) {
    if (image instanceof Image) {
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

      const mask = this._compositeMask();
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
      this._markDirty();
      return;
    }

    const sWidth = image.width;
    const sHeight = image.height;
    const sx = 0;
    const sy = 0;

    // TODO: allow to draw Window, Pixmap, Picture
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
      // rgba -> bgra
      const data = Buffer.alloc(imageData.data.length);
      for (let i = 0; i < data.length; i += 4) {
        data[i + 2] = imageData.data[i];
        data[i + 1] = imageData.data[i + 1];
        data[i] = imageData.data[i + 2];
        data[i + 3] = imageData.data[i + 3]; // multiply source alpha by context globalAlpha?
      }

      const pixmap = new Pixmap(this.window.app, { depth: 32, width: sWidth, height: sHeight });
      const picture = new Picture(this.window.app, { drawable: pixmap, format: this.Render.rgba32 });
      pixmap._gc = this.X.AllocID();
      this.X.CreateGC(pixmap._gc, pixmap.id);
      this.X.PutImage(2, pixmap.id, pixmap._gc, sWidth, sHeight, sx, sy, 0, 32, data);

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
