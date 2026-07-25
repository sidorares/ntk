import parseFontStyle from 'canvas-fontstyle';
import extrudePolyline from 'extrude-polyline';
import parseColorRaw from 'parse-color';
import PNLTRI from 'pnltri';

import Drawable from './drawable.js';
import FontFace from './fontface.js';
import { listFontsSync } from './fontconfig.js';
import Picture from './picture.js';
import Pixmap from './pixmap.js';

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

    // TODO lazily create via getter
    if (!window._gc) {
      window._gc = X.AllocID();
      X.CreateGC(window._gc, window.id);
    }

    this.window = window;
    this.Render = window.app.display.Render;
    // TODO: support a8
    const format = window.depth === 32 ? this.Render.rgba32 : this.Render.rgb24;

    this.picture = new Picture(window.app, {
      drawable: window,
      format,
      polyEdge: 1,
      polyMode: 1
    });

    this._solidPictures = new Map();
    this.fillMask = null;
    this.fillMaskDrawable = null;
    this.clipMask = null;
    this.clipMaskDrawable = null;
    this._glyphSet = null;
    this._lastFontString = null;
    this._currentPath = [];
    this._currentPoly = null;

    this.fillStyle = 'white';
    this.strokeStyle = 'black';
    this.lineWidth = 1;
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
    this.X.PutImage(2, this.window.id, this.window._gc, data.width, data.height, x, y, 0, 24, data.data);
  }

  clearRect(x, y, w, h) {
    this.Render.FillRectangles(this.Render.PictOp.Src, this.picture.id, [1, 1, 1, 1], [x, y, w, h]);
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
  }

  fillText(text, x, y) {
    text = String(text ?? '');
    if (!this._glyphSet) this.font = DEFAULT_FONT;
    const gs = this._glyphSet;
    const ids = gs.fontface.ensureGlyphs(gs.size, text);
    const glyphs = String.fromCharCode(...ids);
    this.Render.CompositeGlyphs32(
      this.Render.PictOp.Over,
      this._backgroundPicture.id,
      this.picture.id,
      0,
      gs.id,
      0, 0,
      [[x, y, glyphs]]
    );
  }

  measureText(text) {
    if (!this._glyphSet) this.font = DEFAULT_FONT;
    const gs = this._glyphSet;
    let width = 0;
    let height = 0;
    for (const ch of String(text)) {
      const g = gs.fontface.getGlyph(gs.size, ch.codePointAt(0));
      width += g.advance;
      if (g.height > height) height = g.height;
    }
    return { width, height };
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
  }

  _setFace(face, size) {
    const glyphSet = face.upload(size);
    glyphSet.fontface = face;
    this._glyphSet = glyphSet;
  }

  _setFont(weight, style, size, unit, family) {
    const app = this.window.app;
    if (!app._fontCache) app._fontCache = new Map();
    const key = `${family}:${weight}:${style}`;
    let face = app._fontCache.get(key);
    if (!face) {
      const match = listFontsSync({ family, style, weight });
      face = new FontFace(app);
      face.loadFont(match.path);
      app._fontCache.set(key, face);
    }
    this._setFace(face, size);
  }

  set font(val) {
    if (!val || typeof val !== 'string') return;
    const font = parseFontStyle(val);
    if (!font) return;
    this._lastFontString = val;
    this._setFont(font.weight, font.style, font.size, font.unit, font.family);
  }

  get font() {
    return this._lastFontString || DEFAULT_FONT;
  }

  // load a font directly from a .ttf/.otf file path
  loadFont(path, size) {
    const face = new FontFace(this.window.app);
    face.loadFont(path);
    const gs = face.upload(size);
    gs.fontface = face;
    return gs;
  }

  setFont(glyphSet) {
    this._glyphSet = glyphSet;
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
    this.X.GetImage(2, this.window.id, x, y, w, h, 0xffffffff, cb);
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
