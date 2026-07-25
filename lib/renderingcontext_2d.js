import parseFontStyle from 'canvas-fontstyle';
import extrudePolyline from 'extrude-polyline';
import parseColorRaw from 'parse-color';
import PNLTRI from 'pnltri';

import Drawable from './drawable.js';
import Picture from './picture.js';
import Pixmap from './pixmap.js';
import { drawGlyphRuns } from './text/glyphs.js';
import { TextLayout } from './text/layout.js';
import { reorderRuns } from './text/shape.js';

const DEFAULT_FONT = '20px sans-serif';

function parseColor(value) {
  if (Array.isArray(value)) return value;
  const c = parseColorRaw(value);
  return [c.rgba[0] / 255, c.rgba[1] / 255, c.rgba[2] / 255, c.rgba[3]];
}

const cubicAt = (p0, p1, p2, p3, t) => {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
};

/**
 * Canvas-like 2d rendering context backed by the XRender extension: most
 * operations (composition, gradients, text composition) happen server-side.
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
    this._currentPath = [];
    this._currentPoly = null;

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

  // TODO: remove, add drawImage
  putImageData(data, x, y) {
    // todo: use constants
    this.X.PutImage(2, this._target.id, this._gc, data.width, data.height, x, y, 0, 24, data.data);
    this._markDirty();
  }

  clearRect(x, y, w, h) {
    this.Render.FillRectangles(this.Render.PictOp.Src, this.picture.id, [1, 1, 1, 1], [x, y, w, h]);
    this._markDirty();
  }

  fillRect(x, y, w, h) {
    const mask = this.clipMask ? this.clipMask.id : 0;
    this.Render.Composite(
      this.Render.PictOp.Over,
      this._backgroundPicture.id,
      mask,
      this.picture.id,
      x, y,
      x, y,
      x, y,
      w, h
    );
    this._markDirty();
  }

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
   */
  fillText(text, x, y) {
    text = String(text ?? '');
    if (!text) return;
    const style = this._resolvedTextStyle();
    const app = this.window.app;
    const shaped = app.fonts.shape(text, style);
    const ox = x + this._alignOffset(shaped);
    const oy = y + this._baselineOffset(style.font.metrics(style.size));

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

  beginPath() {
    this._currentPoly = null;
    this._currentPath = [];
  }

  moveTo(x, y) {
    if (this._currentPoly) {
      this._currentPath.push(this._currentPoly);
    }
    this._currentPoly = [{ x, y }];
  }

  lineTo(x, y) {
    if (!this._currentPoly) throw new Error('lineTo called before moveTo()');
    const pt = this._currentPoly[this._currentPoly.length - 1];
    const d = Math.abs(pt.x - x) + Math.abs(pt.y - y);
    if (d > 0.5) this._currentPoly.push({ x, y });
  }

  bezierCurveTo(x1, y1, x2, y2, x, y) {
    const lastPt = this._currentPoly[this._currentPoly.length - 1];
    const xs = [lastPt.x, x1, x2, x];
    const ys = [lastPt.y, y1, y2, y];
    const step = bcurveStep(xs[0], ys[0], xs[1], ys[1], xs[2], ys[2], xs[3], ys[3]);
    for (let t = 0; t < 1; t += step) {
      this.lineTo(cubicAt(xs[0], xs[1], xs[2], xs[3], t), cubicAt(ys[0], ys[1], ys[2], ys[3], t));
    }
  }

  closePath() {
    if (this._currentPoly) this._currentPath.push(this._currentPoly);
    this._currentPoly = null;
  }

  scale(s) {
    const m = [s, 0, 0, 0, s, 0, 0, 0, 1];
    this.Render.SetPictureTransform(this.picture.id, m);
  }

  _rasterizePath(picture) {
    // TODO: compare with https://www.npmjs.com/package/cdt2d
    const maxWidth = 65535;
    const path = this._currentPath;

    const trapezoider = new PNLTRI.Trapezoider(new PNLTRI.PolygonData(path));
    trapezoider.trapezoide_polygon();
    const traps = trapezoider.queryStructure.trapArray;
    let trapSegments = [];
    traps.forEach((trap) => {
      const high = [-maxWidth, maxWidth, trap.vHigh.y];
      const low = [-maxWidth, maxWidth, trap.vLow.y];
      if (trap.lseg) {
        high[0] = xCoordOfSegmentAtY(trap.lseg, trap.vHigh);
        low[0] = xCoordOfSegmentAtY(trap.lseg, trap.vLow);
      }
      if (trap.rseg) {
        high[1] = xCoordOfSegmentAtY(trap.rseg, trap.vHigh);
        low[1] = xCoordOfSegmentAtY(trap.rseg, trap.vLow);
      }
      if (
        trap.depth === 1 &&
        high[1] !== maxWidth &&
        low[1] !== maxWidth &&
        high[0] !== -maxWidth &&
        low[1] !== -maxWidth
      ) {
        trapSegments = trapSegments.concat(low, high);
      }
    });
    this.Render.AddTraps(picture.id, 0, 0, trapSegments);
  }

  stroke() {
    this.closePath();

    const t = [];
    const stroke = extrudePolyline({
      thickness: this.lineWidth,
      miterLimit: 10
    });

    for (const poly of this._currentPath) {
      const polyline = poly.map((pt) => [pt.x, pt.y]);
      const mesh = stroke.build(polyline);
      for (const tri of mesh.cells) {
        for (let i = 0; i < 3; ++i) {
          t.push(mesh.positions[tri[i]][0], mesh.positions[tri[i]][1]);
        }
      }
    }
    // TODO: mask
    this.Render.Triangles(
      this.Render.PictOp.Over,
      this._strokePicture.id,
      0, 0,
      this.picture.id,
      this.Render.a8,
      t
    );
    this._markDirty();
  }

  clip() {
    if (!this.clipMask) {
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
    this.Render.FillRectangles(1, this.clipMask.id, [0, 0, 0, 0], [0, 0, this.width, this.height]);
    this._rasterizePath(this.clipMask);
  }

  fill() {
    this.closePath();

    // TODO: perf: use shape bounding box instead of compositing over whole width x height canvas

    if (!this.fillMask) {
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
    // TODO: apply global alpha here?
    this.Render.FillRectangles(1, this.fillMask.id, [0, 0, 0, 0], [0, 0, this.width, this.height]);
    this._rasterizePath(this.fillMask);

    // TODO apply transformation to background position?

    // intersect with clipping area
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
    // draw background using resulting image as mask
    this.Render.Composite(
      this.Render.PictOp.Over,
      this._backgroundPicture.id,
      this.fillMask.id,
      this.picture.id,
      0, 0, 0, 0, 0, 0,
      this.width,
      this.height
    );
    this._markDirty();
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

  getImageData(x, y, w, h, cb) {
    // reads the backing pixmap on double-buffered windows: always valid,
    // even where the window is occluded on screen
    this.X.GetImage(2, this._target.id, x, y, w, h, 0xffffffff, cb);
  }

  // void ctx.drawImage(image, dx, dy);
  // void ctx.drawImage(image, dx, dy, dWidth, dHeight);
  // void ctx.drawImage(image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight);
  // image: drawable, node-canvas Canvas, node-canvas Image
  drawImage(image) {
    const sWidth = image.width;
    const sHeight = image.height;
    const sx = 0;
    const sy = 0;

    // TODO: allow to draw Canvas.Image, Window, Pixmap, Picture
    if (image instanceof RenderingContext2d) {
      // TODO: if need to scale, set transform
      // TODO: respect globalAlpha ( use solid transparent mask )
      // TODO: respect global compositing blend mode
      this.Render.Composite(
        this.Render.PictOp.Over,
        image.picture.id,
        0,
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

      // TODO: respect globalCompositeOperation and globalAlpha
      const mask = this.clipMask ? this.clipMask.id : 0;
      this.Render.Composite(
        this.Render.PictOp.Over,
        picture.id,
        mask,
        this.picture.id,
        0, 0, 0, 0, 0, 0,
        this.width,
        this.height
      );
      this._markDirty();
    }
  }

  // not implemented (yet) parts of the canvas api
  arc() {}
  save() {}
  restore() {}
  translate() {}
}

// TODO: this is my heuristic. Do some more research
function bcurveStep(x0, y0, x1, y1, x2, y2, x, y) {
  const minX = Math.min(x, x0, x1, x2);
  const maxX = Math.max(x, x0, x1, x2);
  const minY = Math.min(y, y0, y1, y2);
  const maxY = Math.max(y, y0, y1, y2);
  const dt = 1 / Math.max(maxX - minX, maxY - minY);
  return dt > 0.2 ? 0.2 : dt;
}

// from https://github.com/jahting/pnltri.js/blob/master/test/TestHelpers.js#L132
function xCoordOfSegmentAtY(seg, crossPt) {
  if (seg.vTo.y === seg.vFrom.y) return crossPt.x;
  return (
    seg.vFrom.x +
    ((seg.vTo.x - seg.vFrom.x) * (crossPt.y - seg.vFrom.y)) / (seg.vTo.y - seg.vFrom.y)
  );
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
