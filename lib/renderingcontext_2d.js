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
import { clusterBoxes, maskPolicyOf, unionBox } from "./maskcluster.js";
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
  subpathHead,
  subpathTail,
} from "./path.js";
import Picture from "./picture.js";
import { formatForDepth } from "./pictformat.js";
import Pixmap from "./pixmap.js";
import { REGION_DOCS, regionId } from "./region.js";
import { snapFixed16 } from "./precise.js";
import { routeRaster } from "./rasterize.js";
import {
  clipRingToRect,
  clipTrianglesToRect,
  rectsOnSurface,
  WIRE_REACH,
  withinRect,
} from "./cliprect.js";
import { dashPolyline } from "./dash.js";
import {
  blurCoverage,
  cachedShadow,
  shadowPolicyOf,
  shadowReach,
  shadowSigma,
} from "./shadow.js";
import { Surface } from "./surface.js";
import {
  normalizeRadii,
  planShadowTiles,
  shadowTileAlpha,
} from "./shadowtiles.js";
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
  positionedRunsInk,
  roundFrom,
  runId,
  snapOrigin,
} from "./text/glyphs.js";
import { parseFontCached } from "./text/fontshorthand.js";
import { TextLayout } from "./text/layout.js";
import { reorderRuns } from "./text/shape.js";
import { trapezoidize } from "./trapezoid.js";

/**
 * The subpaths of a flattened path that can enclose area, as the flat
 * `[x0, y0, …]` lists both the local rasterizer and the trapezoidizer take,
 * with the edge count the routing policy asks for.
 */
function fillableShapes(polys) {
  const shapes = [];
  let edges = 0;
  for (const p of polys) {
    if (p.pts.length < 6) continue;
    shapes.push(p.pts);
    edges += p.pts.length / 2;
  }
  return { shapes, edges };
}

/** Whether `v` is a whole number, give or take the slack a transform adds. */
function isIntegral(v) {
  return Math.abs(v - Math.round(v)) < 1e-6;
}

/** The overlap of two {x, y, w, h} boxes, or null when they have none. */
function intersectBox(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= x || bottom <= y) return null;
  return { x, y, w: right - x, h: bottom - y };
}

/**
 * Whether no two of a flat `[x, y, w, h, …]` list of whole-pixel rectangles
 * share a pixel — touching edges do not. A sweep along x holding the
 * rectangles it is inside as disjoint y spans in order, so a list that is
 * disjoint, which is the list this is asked about, costs a binary search
 * per rectangle: a chart's per-column spans, an occupancy grid's cells.
 */
function disjointRects(rects) {
  const n = rects.length / 4;
  if (n < 2) return true;
  // events: where a rectangle starts and where it ends, ends first at a tie
  const events = [];
  for (let i = 0; i < n; i++) {
    events.push([rects[i * 4], 1, i], [rects[i * 4] + rects[i * 4 + 2], 0, i]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  // the y spans the sweep is inside, sorted by their top, as rectangle ids
  const active = [];
  const top = (i) => rects[i * 4 + 1];
  const bottom = (i) => rects[i * 4 + 1] + rects[i * 4 + 3];
  const find = (y) => {
    let lo = 0;
    let hi = active.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (top(active[mid]) < y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (const [, starts, i] of events) {
    if (!starts) {
      let at = find(top(i));
      while (active[at] !== i) at++;
      active.splice(at, 1);
      continue;
    }
    const at = find(top(i));
    if (at > 0 && bottom(active[at - 1]) > top(i)) return false;
    if (at < active.length && top(active[at]) < bottom(i)) return false;
    active.splice(at, 0, i);
  }
  return true;
}

/** The device-space ink bounds of a flattened path, unclamped. */
function polysInk(polys) {
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
  return maxX === -Infinity ? null : { minX, minY, maxX, maxY };
}

/** the same list, moved — the shadow's copy of a drawing is the same
 * geometry in the coverage surface's coordinates */
function shiftPolys(polys, dx, dy) {
  return polys.map((poly) => {
    const pts = new Array(poly.pts.length);
    for (let i = 0; i < pts.length; i += 2) {
      pts[i] = poly.pts[i] + dx;
      pts[i + 1] = poly.pts[i + 1] + dy;
    }
    return { ...poly, pts };
  });
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

/** a stable string for a variation setting, for cache keys — two Fonts of
 * one file at different axis positions share a `key`, so the coordinates
 * have to be part of anything keyed on the rendered result */
function variationsKey(variations) {
  if (!variations) return "";
  return Object.keys(variations)
    .sort()
    .map((tag) => `${tag}=${variations[tag]}`)
    .join(",");
}

/**
 * Fallback for a context dropped without `destroy()`, matching Pixmap,
 * Picture and GlyphSet. Only the GCs are freed here: everything else a
 * context owns is a Pixmap or a Picture, which carry their own finalizers,
 * and reaching into them from this one would race those.
 */
const gcRegistry = new FinalizationRegistry(({ X, gcs, regions }) => {
  safeRelease(X, () => {
    for (const gc of gcs) {
      if (!gc) continue;
      X.FreeGC(gc);
      X.ReleaseID(gc);
    }
    for (const { fixes, id } of regions) {
      fixes.DestroyRegion(id);
      X.ReleaseID(id);
    }
  });
});

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
 * `clipRegion()` before anything loaded XFIXES.
 *
 * Not the same failure as a server that *has* no XFIXES (`app.fixes()` throws
 * that one, with a code): here the extension is simply not on the connection
 * yet, and it cannot be fetched from under a synchronous call that has to land
 * in request order with the drawing around it. One await fixes it, and the
 * call that hands back a region is already that await.
 */
function needXFixesError() {
  return new Error(
    "ntk: ctx.clipRegion() needs XFIXES loaded on this connection first.\n" +
      "\n" +
      "Making the region through ntk is that step:\n" +
      "\n" +
      "    const region = await app.createRegion([{ x: 0, y: 0, width: 100, height: 100 }]);\n" +
      "    ctx.clipRegion(region);\n" +
      "\n" +
      "For a region you built through node-x11 yourself, one `await app.fixes()`\n" +
      "anywhere before the first clipRegion() call is enough.\n" +
      "\n" +
      REGION_DOCS,
  );
}

/**
 * A drawable whose depth nothing has established yet, handed to
 * createPattern.
 *
 * Three drawables are like this, and they want different answers. A window
 * or a pixmap adopted by id knows nothing until the request ntk sent for it
 * replies, and `ready` is the wait for exactly that — the visual a window
 * tile's format really comes from among them. A window ntk created with the
 * default `depth: 0` — CopyFromParent — has no reply pending at all, because
 * only the server ever resolved that 0, so its depth has to be asked for.
 * `getGeometry()` covers all of them, which is why it leads.
 */
function unknownDepthError() {
  return new Error(
    "createPattern: the tile's depth is not known yet, so there is no " +
      "picture\nformat to read it through.\n" +
      "\n" +
      "Ask the server for it — the answer is written back to the tile:\n" +
      "\n" +
      "    await tile.getGeometry();\n" +
      "    const pattern = ctx.createPattern(tile, 'repeat');\n" +
      "\n" +
      "For a window or a pixmap adopted by id — `new Window(app, { id })`,\n" +
      "`new Pixmap(app, { id })`, or `ev.window` in a window manager — ntk\n" +
      "has already sent that request: `await tile.ready` waits for the reply\n" +
      "it is expecting rather than asking again, and resolves immediately on\n" +
      "one ntk created. `Pixmap.adopt(app, id)` hands the pixmap over with\n" +
      "this already done. A Surface carries its own depth and needs no wait.\n" +
      `\n${PATTERN_DOCS}`,
  );
}

/**
 * What a pattern tiles: a drawable holding the tile plus the picture format
 * to read it through. A repeating source Picture is created over it rather
 * than the source's own picture being changed, so tiling a `Surface` leaves
 * `drawImage` of that same surface exactly as it was.
 */
function patternSourceOf(app, source) {
  const Render = app.display.Render;

  let drawable = null;
  let width;
  let height;
  let format;
  let coverage = false; // an a8 tile: no colour to paint with (see below)
  if (source instanceof Surface) {
    if (source.app !== app) {
      throw new Error(
        "createPattern: the Surface belongs to a different X connection",
      );
    }
    drawable = source.pixmap;
    coverage = source.format === "a8";
    format = coverage ? Render.a8 : Render.rgba32;
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
    if (!depth) throw unknownDepthError();
    // the tile's visual is what names its format; the depth is the fallback
    // for a drawable that has none (issue #295)
    const visual = drawable.visualId || source.visualId;
    coverage = depth === 8;
    format = app._knownPictFormat?.(visual, depth) ?? formatForDepth(Render, depth);
    width = drawable.width ?? source.width;
    height = drawable.height ?? source.height;
  } else {
    throw new Error(
      "createPattern: expected a Surface, an Image, a Pixmap or a Window as the tile, got " +
        (source === null ? "null" : typeof source),
    );
  }
  if (coverage) {
    throw new Error(
      "createPattern: a coverage (a8) tile has no colour to paint with — XRender would " +
        "sample it as black. Draw the tile into an argb32 Surface and tile that, or keep " +
        `the a8 one and use ctx.drawImage, which paints it in the current fillStyle. ${PATTERN_DOCS}`,
    );
  }
  return { drawable, format, width, height };
}

/**
 * Point a style's picture transform at the transform in force for this
 * paint. Gradients and patterns are both defined in *user* space, so the CTM
 * is part of the mapping — and per the canvas spec it is the CTM at paint
 * time, not the one that happened to be current when the style was made
 * (verified against browsers: a gradient created untransformed and filled
 * after a `translate` moves with the fill, and one created under a translate
 * and filled without it does not).
 *
 * Returns false when nothing would be painted (a singular matrix, or one
 * the wire cannot carry), true for anything else, including every
 * plain-colour style. `width` and `height` are the surface's: the style's
 * source origin is kept on it (`sourceOrigin`).
 */
function prepareStyle(src, m, width, height) {
  return src instanceof CanvasPattern || src instanceof CanvasGradient
    ? src._sync(m, width, height)
    : true;
}

const NO_ORIGIN = Object.freeze([0, 0]);

/**
 * Where a composite samples `src` from, as a device point: each composite
 * that reads a style at its destination's own coordinates passes those
 * coordinates less this as its source offset.
 *
 * A gradient's or a pattern's picture transform is the inverse of the CTM,
 * and sampling it at device coordinates put the CTM's translation, times
 * its downscale, into the transform: a box a fortieth of its size at x
 * 2,200 asked for 88,000, past what 16.16 fixed point carries. `_sync`
 * folds this origin into the transform instead, and puts it where the
 * style's own origin lands, so the translation is small wherever on the
 * surface the style is painted. Everything else — a solid, a picture —
 * samples at device coordinates, from (0, 0).
 */
function sourceOrigin(src) {
  return src instanceof CanvasPattern || src instanceof CanvasGradient
    ? src._origin
    : NO_ORIGIN;
}

/**
 * The origin `_sync` picks for a style whose own origin lands at device
 * (x, y): the nearest whole pixel, kept on the surface. On it, a composite's
 * source offset — its destination's, less this — is within the surface's
 * size of 0, which the 16-bit field carries whatever the transform; and the
 * transform's translation is the style's coordinate there, which for a
 * style painted on the surface is one the fill samples anyway.
 */
function originOn(x, y, width, height) {
  const on = (v, size) => (v > 0 ? Math.min(Math.round(v), size) : 0);
  return [on(x, width), on(y, height)];
}

/**
 * Whether every entry can be written as XRender's 16.16 fixed point, whose
 * whole part is a signed 16-bit number. A picture transform is written that
 * way, and the request encoder throws on an entry past it — out of the paint
 * that asked for it, and out of everything drawn after it in the same frame.
 * Not finite fails too.
 */
function fitsFixed(values) {
  return values.every((v) => Math.abs(v) < 32768);
}

/**
 * What `drawImage` takes as a server-side source: anything that knows its own
 * size and can hand over a `Picture` for this connection.
 *
 * `Image` is client pixels uploaded once; `Surface` is pixels the server drew
 * itself. Neither is special — the contract is the two members, so a caller
 * with its own cache of rendered things can satisfy it without ntk knowing
 * the type. A `RenderingContext2d` does not match — its `picture` is a
 * property rather than a method — and neither does a node-canvas; `drawImage`
 * wraps both in one of these (`contextSource`, `_canvasSource`), so every
 * form of the call treats them as it treats a Surface.
 */
function isPictureSource(image) {
  return (
    image instanceof Image ||
    (image != null &&
      typeof image.picture === "function" &&
      Number.isFinite(image.width) &&
      Number.isFinite(image.height))
  );
}

/** a node-canvas, or anything else whose pixels come from
 * `image.context.getImageData()` */
function isCanvasLike(image) {
  return typeof image?.context?.getImageData === "function";
}

/**
 * `drawImage`'s arguments as the eight numbers of its longest form — the
 * source rectangle, then the destination one — whichever form they came in.
 */
function imageRects(image, args) {
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
  return [sx, sy, sw, sh, dx, dy, dw, dh];
}

/**
 * A 2d context as a `drawImage` source: the picture-source contract over the
 * pixels it has drawn, so that it is drawn exactly as a Surface is.
 *
 * Its picture comes with nothing in the clip slot (`_sourcePicture`). A
 * context drawing into an a8 target is coverage, painted in the current
 * `fillStyle`, as the a8 Surface it is drawing into would be. `_drawable` is
 * for `_drawsFromCopy`.
 */
function contextSource(ctx, app) {
  if (!ctx._picture) throw destroyedSourceError();
  if (ctx.window.app !== app) throw otherConnectionError();
  return {
    width: ctx.width,
    height: ctx.height,
    format: ctx._picture.format === app.display.Render.a8 ? "a8" : undefined,
    picture: () => ctx._sourcePicture(),
    _drawable: ctx._target,
  };
}

function destroyedSourceError() {
  return new Error(
    "drawImage: the 2d context passed as the image has been destroyed — by\n" +
      "ctx.destroy(), along with its window, or at the end of the\n" +
      "Surface.render() call that lent it — so there is nothing to read.\n" +
      "\n" +
      "Draw the Surface itself, or keep a context from getContext('2d') for\n" +
      "as long as you draw from it.",
  );
}

function otherConnectionError() {
  return new Error(
    "drawImage: the 2d context passed as the image draws on another X\n" +
      "connection, and a picture means nothing on a connection that did not\n" +
      "make it. Bring the pixels over through the client:\n" +
      "\n" +
      "    const pixels = await source.getImageData(0, 0, source.width, source.height);\n" +
      "    ctx.drawImage(new Image(pixels), x, y);",
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

// The ops whose result is the destination wherever the mask is zero. Only
// those may have a drawing's mask split into several boxes (maskcluster.js):
// what the split gives up is the gaps between the boxes, and for these ops
// the single-box version would not have changed those pixels either. `copy`,
// `source-in`, `destination-in`, `source-out` and `destination-atop` write
// the source — or nothing — across the whole box, so they keep one.
const MASK_BOUNDED_OPS = [
  "Over",
  "OverReverse",
  "OutReverse",
  "Atop",
  "Xor",
  "Add",
];

// and what they are clustered with instead: one mask, exactly as before
const ONE_MASK = { minSaving: Infinity, maxMasks: 1 };

// How far apart two of a stroke's triangles have to be to start a new piece
// (_trisPieces). Two mask boxes a pixel or two apart are not worth
// splitting — each carries a pixel of antialiasing slack of its own — so
// this only has to be small next to anything `minSaving` would pay for.
const PIECE_SLACK = 2;

// extrude-polyline has no round caps/joins: 'round' extrudes as butt/bevel
// and the missing coverage is unioned in afterwards as triangle-fan disks
// (see _strokePolys)
const LINE_CAP = { butt: "butt", square: "square", round: "butt" };
const LINE_JOIN = { miter: "miter", bevel: "bevel", round: "bevel" };

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
 * Whether a rectangle call draws at all: canvas draws nothing for one with
 * a side that is not finite. The callers then turn a negative size round
 * into the same rectangle drawn the other way, as canvas does. X takes a
 * rectangle's size unsigned and its corner in 16 bits, so a negative size
 * that reached the wire threw from inside the paint.
 */
const IDENTITY_TRANSFORM = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** whether device box `b` (`{ x0, y0, x1, y1 }`) lies inside box `a` */
function boxInside(b, a) {
  return b.x0 >= a.x0 && b.y0 >= a.y0 && b.x1 <= a.x1 && b.y1 <= a.y1;
}

/** whether two `{ x, y, width, height }` boxes share any area — either
 *  may say `w`/`h` for its size, as a clip rect does */
function boxesMeet(a, b) {
  const aw = a.width ?? a.w;
  const ah = a.height ?? a.h;
  const bw = b.width ?? b.w;
  const bh = b.height ?? b.h;
  return a.x < b.x + bw && b.x < a.x + aw && a.y < b.y + bh && b.y < a.y + ah;
}

function finiteRect(x, y, w, h) {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h);
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
    // same for the scratch regions the region-clip path allocates: the
    // finalizer holds the arrays, never the context
    this._regions = [];
    gcRegistry.register(this, { X, gcs: this._gcs, regions: this._regions }, this);

    this.window = window;
    this.display = window.app.display;
    this.Render = this.display.Render;
    this._layoutCache = null;

    // draw into the window's backing pixmap when it has one (double
    // buffering); re-bind when the backing pixmap is reallocated on resize
    this._target = null;
    this._gc = null;
    this._picture = null;
    this._bindTarget();
    // A window or pixmap adopted by id knows neither its depth nor its
    // visual until the requests its constructor sent reply, and an unknown
    // depth binds rgb24 — so a context taken on a depth-32 drawable before
    // they land would silently drop the alpha channel, which is the ordinary
    // case for a compositor taking the overlay window, its clients and their
    // named pixmaps as bare ids (issues #293, #291). Awaiting `ready` first
    // is the explicit fix; re-binding when the answer changes the format is
    // the one that does not need to be known about.
    if (!window.depth && typeof window.ready?.then === "function") {
      window.ready.then(() => this._refreshFormat());
    }
    // The same, for the visual -> format table: it is one round trip on the
    // connection (issue #295), taken while the connection is still being set
    // up, so it is normally here already — this is the case where it is not,
    // and the binding above took the depth's standard format. Where the
    // visual names a different one — a 5:6:5 window, a 10-bit one, a BGR one
    // — that binding is wrong and this is what puts it right.
    if (window.app && !window.app._pictFormats) {
      window.app.pictFormats?.().then(
        () => this._refreshFormat(),
        () => {},
      );
    }
    if (typeof window.on === "function") {
      // Kept, so `destroy` can take them off again: a surface drawn through
      // `render()` gets a context a call, and each one left three listeners
      // on the pixmap — holding the dead context — for as long as the
      // surface lived. A fade redraws its group surface every frame.
      this._onBacking = () => this._bindTarget();
      // masks are sized to the drawable — recreate them after a resize
      this._onResize = () => this._dropMasks();
      // window-backed pictures are freed server-side with the window
      this._onDestroyed = () => {
        if (this._picture && this._target === this.window) {
          this._picture.forget();
          this._picture = null;
        }
      };
      window.on("_backing", this._onBacking);
      window.on("resize", this._onResize);
      window.on("_destroyed", this._onDestroyed);
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
    // Mask cost, for the same reason (issue #264): a drawing whose pieces
    // are scattered pays for the box around all of them unless the mask is
    // split, and neither the pixels nor the split show up anywhere else.
    // `masks` counts mask passes, `pixels` their total area, `split` the
    // drawings that took more than one.
    this.maskStats = { masks: 0, pixels: 0, split: 0 };
    this._stack = [];
    // [{ polys, rule, rect } | { region }] in device space, already stacked.
    // Never mutated in place — save() shares the array with the snapshot and
    // clip() concats a new one — so the two summary flags below only have to
    // be recomputed where it is replaced (_setClips).
    this._clips = [];
    this._hasPolyClip = false; // any entry the a8 mask has to rasterize
    this._hasRegionClip = false; // any XFIXES region entry
    // XFIXES, once clipRegion() has been called on this context, and what
    // the picture is currently clipped by. "No clip" is a state ntk tracks
    // rather than a rectangle it stamps: a caller's region has to survive a
    // drawing that only meant to narrow to a box (issue #292).
    this._fixes = null;
    this._pictureClipped = false;
    // the rectangle the slot holds, when it is a plain one (no region in it),
    // so a second drawing under the same clip can skip re-stamping it; and
    // whether a reset is owed but not yet sent (issue #308)
    this._pictureClipRect = null;
    this._clipStale = false;
    this._regionScratch = null; // region entries intersected, when >1
    this._regionBox = null; // that ∩ the rectangular clip
    this._gco = "source-over";
    this.globalAlpha = 1;
    this.lineCap = "butt";
    this.lineJoin = "miter";
    this.miterLimit = 10;
    this._lineDash = [];
    this._lineDashOffset = 0;

    this._shadowBlur = 0;
    this._shadowOffsetX = 0;
    this._shadowOffsetY = 0;
    // "transparent black" — the spec's default, and the one value that
    // skips the whole shadow path, so an app that never asks for a shadow
    // never pays for one
    this._shadowColor = "rgba(0, 0, 0, 0)";
    this._shadowRgba = [0, 0, 0, 0];

    this.fillStyle = "white";
    this.strokeStyle = "black";
    this.lineWidth = 1;
  }

  /**
   * The picture format the target drawable is read and written through.
   *
   * The visual is what names it — depth alone does not (issue #295) — and
   * the depth is the fallback for a drawable that has no visual to name
   * (a pixmap, an `a8` coverage surface) or whose visual has not been
   * answered for yet.
   */
  _formatFor(depth, visual) {
    return (
      this.window.app?._knownPictFormat?.(visual, depth) ?? formatForDepth(this.Render, depth)
    );
  }

  /** The depth and visual of whatever the context is currently bound to. */
  _targetPixels() {
    const target = this._target;
    return {
      depth: target?.depth ?? this.window.depth,
      // a backing pixmap carries the window's visual; nothing else about a
      // pixmap says what its pixels mean
      visual: target?.visualId || this.window.visualId,
    };
  }

  /**
   * Re-bind if what is now known about the target's pixels names a different
   * format than the picture was built with. Both answers arrive late on an
   * adopted window, and neither costs anything when it changes nothing.
   */
  _refreshFormat() {
    const target = this.window._backing || this.window;
    if (!this._picture || this._target !== target) return;
    const { depth, visual } = this._targetPixels();
    if (this._formatFor(depth, visual) !== this._picture.format) this._bindTarget(true);
  }

  _bindTarget(force = false) {
    const target = this.window._backing || this.window;
    if (this._target === target && !force) return;
    this._target = target;
    this._layoutCache = null; // the new target may be a different depth

    if (!this._gc) {
      // one GC is enough: it stays valid for any drawable of the same
      // screen and depth (the backing pixmap matches the window depth)
      this._gc = this.X.AllocID();
      this._gcs.push(this._gc);
      this.X.CreateGC(this._gc, target.id);
    }
    if (this._picture) this._picture.destroy();
    // a8 targets are coverage, not colour: drawing into one and using the
    // result as a mask is how a monochrome drawing gets rendered once and
    // recoloured on every use (see Surface).
    const { depth, visual } = this._targetPixels();
    const format = this._formatFor(depth, visual);
    // Does the target have a real alpha channel? Only then is "transparent"
    // a colour it can hold, which is what clearRect turns on.
    this._hasAlpha = depth === 32;
    this._picture = new Picture(this.window.app, {
      drawable: target,
      format,
      polyEdge: 1,
      polyMode: 1,
    });
    // a new picture carries no clip; a region one is context state and has to
    // be re-installed on it (this runs on every backing-pixmap reallocation)
    this._pictureClipped = false;
    this._pictureClipRect = null;
    this._invalidatePictureClip();
    this._dropMasks();
  }

  // ------------------------------------------------------------------
  // the picture's clip
  //
  // Two things narrow a drawing server-side: a rectangle from the clip stack
  // (SetPictureClipRectangles, the fast path text and rounded boxes take) and
  // an XFIXES region from clipRegion(). Both land on the same one slot — a
  // Picture holds exactly one client clip — so they go through here, and here
  // is also what puts the slot back afterwards.
  //
  // "Back" is the load-bearing word (issue #292). Undoing a narrow used to
  // mean stamping a full-plane rectangle, which is a clip, not the absence of
  // one: it overwrote whatever else was in the slot. Now the slot's contents
  // are state the context tracks, so a region clip survives a fill or a glyph
  // run that only meant to narrow to a box.
  //
  // Tracking the contents also makes the stamping *lazy* (issue #308). Every
  // rect-clipped fast path brackets its own drawing — set, draw, reset — so
  // two drawings under one clip used to emit a reset immediately followed by
  // an identical set, with nothing in between that reads the slot. Instead
  // the reset is only recorded as owed, `_dst()` flushes it before any
  // drawing that does *not* set its own clip, and a set whose rectangle is
  // already in the slot supersedes it and sends nothing. A rounded box under
  // a damage clip goes from four stamps to one, and a repaint of the same
  // rectangle next frame to none.

  /** Narrow the picture to `rect`, intersected with any region clip. */
  _setPictureClip(rect) {
    const region = this._effectiveRegion();
    if (region === null) {
      const held = this._pictureClipRect;
      // The owed reset (if any) is superseded either way: what follows draws
      // under exactly this rectangle, which is what the slot is about to hold.
      this._clipStale = false;
      if (
        held &&
        held.x === rect.x &&
        held.y === rect.y &&
        held.w === rect.w &&
        held.h === rect.h
      ) {
        return; // already stamped, and nothing since has read the slot
      }
      this.Render.SetPictureClipRectangles(this._picture.id, 0, 0, [
        rect.x,
        rect.y,
        rect.w,
        rect.h,
      ]);
      this._pictureClipped = true;
      // a copy: the caller owns `rect` and _clipRect() hands out fresh ones,
      // but nothing here should depend on that
      this._pictureClipRect = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
      return;
    }
    // region ∩ rectangle, computed by the server: three requests and no round
    // trip, against a full-surface a8 mask for the same answer.
    //
    // Always re-emitted, never skipped: the region is the caller's and they
    // may have edited it — server-side, invisibly to us — since the last
    // drawing, for the same reason _effectiveRegion() is recomputed.
    const box = this._scratchRegion("_regionBox");
    this._fixes.SetRegion(box, [
      { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
    ]);
    this._fixes.IntersectRegion(region, box, box);
    this._fixes.SetPictureClipRegion(this._picture.id, box, 0, 0);
    this._pictureClipped = true;
    this._pictureClipRect = null; // a region is in there, not a plain rect
    this._clipStale = false;
  }

  /**
   * Note that the picture's clip no longer matches what the clip stack says,
   * without sending anything: the next drawing either sets its own clip
   * (which supersedes this) or goes through `_dst()`, which flushes it first.
   *
   * This is what every rect-clipped fast path calls after its drawing, and
   * also what installs a region in the first place — `clipRegion()` and a
   * `restore()` that changes the stack both come through here, so the region
   * is on the picture for every route, including the ones that composite an
   * a8 mask and never touch a clip rectangle.
   */
  _invalidatePictureClip() {
    this._clipStale = true;
  }

  /**
   * Put the picture's clip back to what the clip stack says it is between
   * drawings: the region clip if there is one, nothing otherwise. Sends
   * nothing when the slot already says that.
   */
  _flushPictureClip() {
    if (!this._clipStale) return;
    this._clipStale = false;
    if (!this._picture) return; // destroyed, or a window that went away
    const region = this._effectiveRegion();
    if (region !== null) {
      this._fixes.SetPictureClipRegion(this._picture.id, region, 0, 0);
      this._pictureClipped = true;
      this._pictureClipRect = null;
      return;
    }
    if (!this._pictureClipped) return; // nothing of ours is in the slot
    this._clearPictureClip();
  }

  /** Empty the picture's clip slot. */
  _clearPictureClip() {
    if (this._fixes) {
      // None is the real "no clip"; a rectangle would only be a wider one
      this._fixes.SetPictureClipRegion(this._picture.id, 0, 0, 0);
    } else {
      // Without XFIXES the widest rectangle is all there is, and it has to
      // outlive window growth: the backing pixmap has headroom past the
      // window and growing into it does not rebind the picture, so a reset at
      // today's window size would keep clipping tomorrow's pixels.
      // Coordinates are INT16 — one rect at their maximum covers any drawable.
      this.Render.SetPictureClipRectangles(this._picture.id, 0, 0, [0, 0, 0x7fff, 0x7fff]);
    }
    this._pictureClipped = false;
    this._pictureClipRect = null;
  }

  /**
   * The destination picture id for a drawing request, with any owed clip
   * reset flushed first.
   *
   * Everything that draws into this context's own picture goes through here
   * — including the composites that bypass the set/reset bracket entirely
   * (`_fillRect`, the `clearRect` fast path, the a8-mask routes) — because
   * that is what keeps a lazily-owed reset from leaking a narrower clip into
   * a drawing that never asked for one.
   */
  _dst() {
    this._flushPictureClip();
    return this._picture.id;
  }

  /**
   * The RENDER Picture this context draws through — a real server-side
   * picture a caller can composite from, or hang a clip region on
   * (docs/context-2d.md). Reading it settles the clip slot first, so what an
   * outside request sees is what the clip stack says, not whatever the last
   * fast path left behind.
   */
  get picture() {
    this._flushPictureClip();
    return this._picture;
  }

  /**
   * The picture for a composite that reads this context's pixels — a
   * `drawImage` of the context — with nothing in its clip slot.
   *
   * A clip is drawing state, not part of the pixels: a canvas drawn
   * somewhere gives up all of them, whatever its own context's clip. But
   * glamor — Xorg's modesetting driver, Xwayland — cuts a composite down to
   * its source's clip, where fb (Xvfb, XQuartz) reads past it, and `picture`
   * leaves the slot holding what the clip stack says, a region clip included.
   * So the slot is emptied here, and what it held is owed back: it goes back
   * on before this context next draws, as any reset does.
   */
  _sourcePicture() {
    if (this._pictureClipped) {
      this._clearPictureClip();
      this._clipStale = true;
    }
    return this._picture;
  }

  /**
   * The region the clip stack currently means, or null when it holds no
   * region entry. One entry is used as it is; several are intersected into a
   * scratch region owned by this context.
   *
   * Recomputed rather than cached: the intersection is of regions the caller
   * owns and may edit under us, and nesting region clips is rare enough that
   * a few requests are the cheaper mistake to make.
   */
  _effectiveRegion() {
    if (!this._hasRegionClip) return null;
    let first = null;
    let dst = null;
    for (const entry of this._clips) {
      if (!entry.region) continue;
      if (first === null) {
        first = entry.region;
        continue;
      }
      if (dst === null) {
        dst = this._scratchRegion("_regionScratch");
        this._fixes.CopyRegion(first, dst);
      }
      this._fixes.IntersectRegion(dst, entry.region, dst);
    }
    return dst === null ? first : dst;
  }

  /** One of this context's two scratch regions, allocated on first use. */
  _scratchRegion(slot) {
    if (this[slot] !== null) return this[slot];
    const id = this.X.AllocID();
    this._fixes.CreateRegion(id, []);
    this[slot] = id;
    this._regions.push({ fixes: this._fixes, id });
    return id;
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
    const drawable = this.window;
    if (this._onBacking && typeof drawable?.removeListener === "function") {
      drawable.removeListener("_backing", this._onBacking);
      drawable.removeListener("resize", this._onResize);
      drawable.removeListener("_destroyed", this._onDestroyed);
      this._onBacking = this._onResize = this._onDestroyed = null;
    }

    this._setClips([]);
    this._dropMasks();
    for (const { fixes, id } of this._regions) {
      safeRelease(this.X, () => {
        fixes.DestroyRegion(id);
        this.X.ReleaseID(id);
      });
    }
    this._regions.length = 0;
    this._regionScratch = this._regionBox = null;
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

    if (this._picture) {
      // a picture on a *window* is freed by the server with the window;
      // asking again would raise BadPicture. Same rule as `_destroyed`.
      if (this._target === this.window && !(this.window instanceof Pixmap)) {
        this._picture.forget();
      } else {
        this._picture.destroy();
      }
      this._picture = null;
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
    this.window._markDirty(this._clipRect());
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

  /**
   * Whether text drawn here — `fillText`, `drawGlyphs` and so
   * `TextLayout.draw` — honours `globalAlpha`. Always true: it is here to
   * be asked. ntk used to draw glyphs at full opacity whatever the alpha,
   * and a renderer handed contexts it did not make (another backend's, an
   * older ntk's) has to fade their text some dearer way, such as drawing it
   * on a surface of its own and fading that. Undefined on a context that
   * has never heard of it, which is the answer that keeps it safe.
   */
  get fadesGlyphs() {
    return true;
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
    if (typeof value === "string") {
      // by the string, where the app keeps that index (App#solidPictureOf);
      // an app that only answers solidPicture — a host's own, a test's
      // stand-in — takes the long way below
      const app = this.window.app;
      if (app.solidPictureOf) return app.solidPictureOf(value);
    }
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
    // the picture first: a value that throws leaves the style as it was
    const picture = this._stylePicture(value);
    this._fillStyle = value;
    this._backgroundPicture = picture;
  }

  get fillStyle() {
    return this._fillStyle;
  }

  set strokeStyle(value) {
    // the picture first: a value that throws leaves the style as it was
    const picture = this._stylePicture(value);
    this._strokeStyle = value;
    this._strokePicture = picture;
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
      fontOpticalSizing: this._fontOpticalSizing,
      textRendering: this._textRendering,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
      shadowBlur: this._shadowBlur,
      shadowColor: this._shadowColor,
      shadowRgba: this._shadowRgba,
      shadowOffsetX: this._shadowOffsetX,
      shadowOffsetY: this._shadowOffsetY,
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
    this._fontOpticalSizing = s.fontOpticalSizing;
    this._textRendering = s.textRendering;
    this.textAlign = s.textAlign;
    this.textBaseline = s.textBaseline;
    this._shadowBlur = s.shadowBlur;
    this._shadowColor = s.shadowColor;
    this._shadowRgba = s.shadowRgba;
    this._shadowOffsetX = s.shadowOffsetX;
    this._shadowOffsetY = s.shadowOffsetY;
    this._m = s.m;
    if (s.clips !== this._clips) {
      const hadRegion = this._hasRegionClip;
      this._setClips(s.clips);
      this._rebuildClipMask();
      // a region clip going out of scope (or coming back into it) is a change
      // to the picture's clip, and nothing else will notice it
      if (hadRegion || this._hasRegionClip) this._invalidatePictureClip();
    }
  }

  // ------------------------------------------------------------------
  // shadows (issue #272)
  //
  // The canvas properties, and the three server-side steps behind them: the
  // drawing's coverage into a padded `a8` surface, a separable gaussian over
  // it, and one masked composite in `shadowColor`. See lib/shadow.js for the
  // blur and the cache, and docs/context-2d.md for what an app sees.

  /**
   * Gaussian blur applied to the shadow, in pixels. Canvas-spec units: this
   * is a **diameter**, and the gaussian it names has σ = `shadowBlur / 2`,
   * so a value here looks the same as the same value in a browser.
   *
   * Negative and non-finite values are ignored, as the spec requires.
   */
  set shadowBlur(value) {
    const v = Number(value);
    if (Number.isFinite(v) && v >= 0) this._shadowBlur = v;
  }

  get shadowBlur() {
    return this._shadowBlur;
  }

  /**
   * The shadow's colour. Defaults to fully transparent black, which is the
   * spec's default and the switch that keeps every drawing operation on
   * exactly the path it was on before shadows existed.
   *
   * A value that is not a colour is ignored (the spec's rule), so a
   * mistyped colour leaves the previous shadow rather than throwing from
   * inside a paint.
   */
  set shadowColor(value) {
    let rgba;
    try {
      rgba = parseColor(value);
    } catch {
      return;
    }
    this._shadowColor = value;
    this._shadowRgba = rgba;
  }

  get shadowColor() {
    return this._shadowColor;
  }

  /**
   * How far the shadow is offset. In **device** pixels: the spec puts
   * shadow offsets outside the current transform, so a rotated drawing has
   * an upright shadow, the same way a rotated element's box-shadow is
   * upright in CSS.
   *
   * Offsets are rounded to whole pixels when the shadow is composited. The
   * drawing's own sub-pixel position is preserved either way; what rounds
   * is where its blurred copy lands.
   */
  set shadowOffsetX(value) {
    const v = Number(value);
    if (Number.isFinite(v)) this._shadowOffsetX = v;
  }

  get shadowOffsetX() {
    return this._shadowOffsetX;
  }

  set shadowOffsetY(value) {
    const v = Number(value);
    if (Number.isFinite(v)) this._shadowOffsetY = v;
  }

  get shadowOffsetY() {
    return this._shadowOffsetY;
  }

  /**
   * Is there a shadow to paint at all?
   *
   * A shadow with no offset and no blur still paints — it lands exactly
   * under the drawing, where it shows through anything translucent, which
   * is what the spec says and what browsers do. Only a transparent
   * `shadowColor` (the default) skips the work, so the answer is one array
   * read on every fill of every app that never mentioned shadows.
   */
  _shadowed() {
    return this._shadowRgba[3] > 0 && this.globalAlpha > 0;
  }

  /**
   * The coverage surface's box in device space: the drawing's ink, padded by
   * `reach` on every side so the blur has room to spread into, and clipped
   * to the part of the drawing whose shadow could land on the target at all.
   *
   * That clip is exact rather than a heuristic. A source pixel at `s`
   * spreads to shadow pixels `s + offset ± reach`, so ink further than
   * `reach` outside the target (once the offset is undone) cannot contribute
   * a single pixel of visible shadow — dropping it costs nothing and keeps a
   * shape far off-screen from allocating a surface the size of its own
   * bounding box.
   */
  _shadowBox(ink, reach) {
    const ox = Math.round(this._shadowOffsetX);
    const oy = Math.round(this._shadowOffsetY);
    // a pixel of slack for the antialiased edge, as _clampBBox takes
    const x0 = Math.max(Math.floor(ink.minX) - 1, -ox - reach);
    const y0 = Math.max(Math.floor(ink.minY) - 1, -oy - reach);
    const x1 = Math.min(Math.ceil(ink.maxX) + 1, this.width - ox + reach);
    const y1 = Math.min(Math.ceil(ink.maxY) + 1, this.height - oy + reach);
    if (x1 <= x0 || y1 <= y0) return null;
    return {
      x: x0 - reach,
      y: y0 - reach,
      w: x1 - x0 + reach * 2,
      h: y1 - y0 + reach * 2,
    };
  }

  /**
   * Put this context's drawing state onto the coverage surface's context.
   *
   * `fillStyle` is opaque white and nothing else: an `a8` surface stores
   * coverage, so what is drawn into it has to be at full alpha and takes its
   * colour later, at the composite. `globalAlpha`, the composite op and the
   * clip are deliberately *not* copied — they belong to that composite, not
   * to the shape, and applying them twice would square the alpha.
   */
  _loadShadowState(sctx, dx, dy) {
    // a device-space translation in front of the transform, so a user-space
    // call replayed here lands where the surface expects it. Translation
    // does not change the determinant, so the transform-aware line width
    // in _strokePolys is the same one the real stroke will use.
    sctx._m = matMultiply([1, 0, 0, 1, dx, dy], this._m);
    sctx.fillStyle = "#fff";
    sctx.strokeStyle = "#fff";
    sctx.lineWidth = this.lineWidth;
    sctx.lineCap = this.lineCap;
    sctx.lineJoin = this.lineJoin;
    sctx.miterLimit = this.miterLimit;
    sctx._lineDash = this._lineDash;
    sctx._lineDashOffset = this._lineDashOffset;
    sctx._textStyle = this._textStyle;
    sctx._lastFontString = this._lastFontString;
    sctx._fontVariations = this._fontVariations;
    sctx._fontOpticalSizing = this._fontOpticalSizing;
    sctx._textRendering = this._textRendering;
    sctx.textAlign = this.textAlign;
    sctx.textBaseline = this.textBaseline;
    return sctx;
  }

  /**
   * Composite finished shadow coverage: the surface is the mask,
   * `shadowColor` is the source.
   *
   * Borrowing `fillStyle` for the length of the call is what puts the
   * shadow through the same route a coverage `drawImage` takes — clip,
   * `globalAlpha`, composite op and damage reporting all apply to it exactly
   * as they do to the drawing it belongs to.
   */
  _paintShadow(surface, dx, dy) {
    const style = this._fillStyle;
    const picture = this._backgroundPicture;
    this.fillStyle = this._shadowColor;
    try {
      this._drawCoverage(
        surface.picture(this.window.app),
        0,
        0,
        surface.width,
        surface.height,
        dx,
        dy,
        surface.width,
        surface.height,
        this._op(),
      );
    } finally {
      this._fillStyle = style;
      this._backgroundPicture = picture;
    }
  }

  /**
   * Paint the shadow of one drawing, given its device-space ink bounds and
   * a way to draw it again into the coverage surface.
   *
   * `replay(sctx, dx, dy)` gets a context on that surface with this one's
   * state already on it, and the device offset that maps this context's
   * coordinates into it. Nothing is cached: the geometry of a path has no
   * short name to key it by. Text does, and takes `_shadowOfText` instead.
   */
  _shadowOfDrawing(ink, replay) {
    if (!ink) return;
    const app = this.window.app;
    const policy = shadowPolicyOf(app);
    const sigma = shadowSigma(this._shadowBlur, policy);
    const reach = shadowReach(sigma);
    const box = this._shadowBox(ink, reach);
    if (!box || box.w * box.h > policy.maxPixels) return;

    let surface = new Surface(app, {
      width: box.w,
      height: box.h,
      format: "a8",
    });
    surface.render((sctx) => {
      this._loadShadowState(sctx, -box.x, -box.y);
      replay(sctx, -box.x, -box.y);
    });
    if (sigma > 0) surface = blurCoverage(surface, sigma);
    this._paintShadow(
      surface,
      box.x + Math.round(this._shadowOffsetX),
      box.y + Math.round(this._shadowOffsetY),
    );
    surface.destroy();
  }

  /** the shadow of a path fill or stroke, from its device-space polys */
  _shadowOfPolys(polys, { rule = "nonzero", stroke = false } = {}) {
    const ink = polysInk(polys);
    if (!ink) return;
    if (stroke) {
      // the stroke's ink is the extruded outline, which is not built yet —
      // over-estimate it. Half the width covers the band, the miter limit
      // covers the spike a sharp corner can throw, and the cost of guessing
      // high is blur over a few empty pixels.
      const det = this._m[0] * this._m[3] - this._m[1] * this._m[2];
      const scale = Math.sqrt(Math.abs(det)) || 1;
      const half = (this.lineWidth * scale) / 2;
      const spike =
        this.lineJoin === "miter" ? Math.min(Math.max(this.miterLimit, 1), 10) : 1.5;
      const slack = half * spike + 1;
      ink.minX -= slack;
      ink.minY -= slack;
      ink.maxX += slack;
      ink.maxY += slack;
    }
    this._shadowOfDrawing(ink, (sctx, dx, dy) => {
      const moved = shiftPolys(polys, dx, dy);
      if (stroke) sctx._strokePolys(moved);
      else sctx._fillPolys(moved, rule);
    });
  }

  /**
   * The shadow of a run of text, cached.
   *
   * Text is the one drawing with a short, stable name — the string, the
   * font and the blur — so its coverage is built once and composited on
   * every frame afterwards, which is the difference between a specimen that
   * rebuilds two surfaces and a blur per slider tick and one that does not.
   *
   * The cached copy is position-independent: the run's origin sits at a
   * whole pixel inside the surface, and the composite carries it to wherever
   * the text is. Glyph origins are rounded to whole pixels on the way to the
   * server anyway, so nothing is lost by it.
   *
   * Where it lands is rounded the way `positionGlyphs` rounds a glyph
   * (`roundFrom`), so the shadow moves with its text: drawn whole pixels
   * away, it lands exactly that many pixels away, and a scroll blit can copy
   * it (issue #350). Rounded as one floating-point sum, an anchor on a half
   * pixel went down at x 104 and up at x 152.
   */
  _shadowOfText(text, x, y) {
    const app = this.window.app;
    const policy = shadowPolicyOf(app);
    const sigma = shadowSigma(this._shadowBlur, policy);
    const reach = shadowReach(sigma);
    const style = this._resolvedTextStyle();
    // the same shaping memo fillText draws from, so a shadowed label shapes
    // once per frame rather than twice
    const shaped = app.fonts._shapeCachedWhole(text, style);
    const ink = this._shapedInk(shaped);
    // rounded outwards, with a pixel of antialiasing slack
    const left = Math.ceil(-ink.minX) + 1;
    const right = Math.ceil(ink.maxX) + 1;
    const ascent = Math.ceil(-ink.minY) + 1;
    const descent = Math.ceil(ink.maxY) + 1;
    const width = left + right + reach * 2;
    const height = ascent + descent + reach * 2;
    if (width <= 0 || height <= 0) return;
    // the run's origin inside the surface — whole pixels, so the coverage
    // is the same wherever on the target the text is drawn
    const originX = reach + left;
    const originY = reach + ascent;

    // where the run's origin lands on the target, exactly as fillText puts it
    const [tx, ty] = matApply(this._m, x, y);
    const runX = tx + this._alignOffset(shaped);
    const runY = ty + this._baselineOffset(style.font.metrics(style.size));

    // A run whose padded ink is larger than a shadow surface may be does not
    // get one: fall back to the clipped, uncached path, which sizes itself
    // to the part of the shadow that can actually be seen.
    if (width * height > policy.maxPixels) {
      this._shadowOfDrawing(
        {
          minX: runX + ink.minX,
          maxX: runX + ink.maxX,
          minY: runY + ink.minY,
          maxY: runY + ink.maxY,
        },
        (sctx) => sctx.fillText(text, x, y),
      );
      return;
    }

    const key = [
      text,
      this._lastFontString,
      style.font.key,
      variationsKey(this._fontVariations),
      this._textRendering ?? "",
      sigma,
    ].join("\u0000");
    const surface = cachedShadow(app, key, () => {
      let coverage = new Surface(app, { width, height, format: "a8" });
      coverage.render((sctx) => {
        this._loadShadowState(sctx, 0, 0);
        // the origin is placed by hand, so neither alignment nor the
        // baseline may move it again
        sctx._m = [1, 0, 0, 1, 0, 0];
        sctx.textAlign = "left";
        sctx.textBaseline = "alphabetic";
        sctx.fillText(text, originX, originY);
      });
      if (sigma > 0) coverage = blurCoverage(coverage, sigma);
      return coverage;
    });
    if (!surface) return;
    this._paintShadow(
      surface,
      roundFrom(runX, this._shadowOffsetX) - originX,
      roundFrom(runY, this._shadowOffsetY) - originY,
    );
  }

  /**
   * The shadow of positioned glyph runs, cached — what `drawGlyphs`, and
   * therefore every `TextLayout.draw`, casts (issue #283).
   *
   * A paragraph gets **one** coverage surface, not one per line: the runs
   * already carry their own baselines, so they all go into the same surface
   * exactly as they all go into the same glyph composite. Nothing is
   * re-shaped — the caller handed us the runs, which is why this path is
   * cheaper than `_shadowOfText`, not dearer.
   *
   * The cached copy is position-independent, as `fillText`'s is: geometry is
   * stored relative to the first run's origin and the composite carries it
   * to wherever the text is drawn. The key is that relative geometry plus
   * the identity of each run, so the same string laid out to two widths —
   * same runs, different line origins — is two shadows, and re-drawing one
   * layout is one lookup no matter how many glyphs are in it.
   *
   * @param {Array<{run, x, y, textRendering?}>} positioned device-space runs
   */
  _shadowOfGlyphs(positioned) {
    if (!positioned.length) return;
    const app = this.window.app;
    const policy = shadowPolicyOf(app);
    const sigma = shadowSigma(this._shadowBlur, policy);
    const reach = shadowReach(sigma);

    // Run origins relative to the first, rounded: whole-pixel offsets are
    // what the bitmap glyph path draws at anyway, and they keep the key
    // stable as the paragraph moves — `(x + a) - (x + b)` is not exactly
    // `a - b` in floating point, and an origin-dependent key would miss the
    // cache on every scroll. Rounding alone does not absorb that where
    // `a - b` is on a half pixel: the difference came to a hair under it at
    // x 104 and exactly on it at x 152, and rounded two ways. So both
    // origins are snapped first, as `positionGlyphs` snaps them (issue
    // #350), and snapped origins subtract exactly.
    const ax = positioned[0].x;
    const ay = positioned[0].y;
    const sx = snapOrigin(ax);
    const sy = snapOrigin(ay);
    const local = positioned.map((p) => ({
      run: p.run,
      x: Math.round(snapOrigin(p.x) - sx),
      y: Math.round(snapOrigin(p.y) - sy),
      textRendering: p.textRendering,
    }));
    const key = `${local
      .map((p) => `${runId(p.run)},${p.x},${p.y},${p.textRendering ?? ""}`)
      .join("\u0000")}\u0000${sigma}`;

    let ink = null;
    const surface = cachedShadow(app, key, () => {
      ink = positionedRunsInk(local);
      if (!ink) return null; // a line of spaces inks nothing
      const box = {
        x: Math.floor(ink.minX) - 1 - reach,
        y: Math.floor(ink.minY) - 1 - reach,
      };
      box.w = Math.ceil(ink.maxX) + 1 + reach - box.x;
      box.h = Math.ceil(ink.maxY) + 1 + reach - box.y;
      if (box.w * box.h > policy.maxPixels) return null;
      let coverage = new Surface(app, {
        width: box.w,
        height: box.h,
        format: "a8",
      });
      coverage.render((sctx) => {
        this._loadShadowState(sctx, 0, 0);
        // the origins are already device-space and placed by hand
        sctx._m = [1, 0, 0, 1, 0, 0];
        sctx._drawGlyphsDevice(
          this.Render.PictOp.Over,
          sctx._backgroundPicture,
          local.map((p) => ({ ...p, x: p.x - box.x, y: p.y - box.y })),
        );
      });
      if (sigma > 0) coverage = blurCoverage(coverage, sigma);
      // where the anchor sits inside the surface — whole pixels, so the
      // composite below can carry it anywhere
      coverage._shadowOrigin = { x: -box.x, y: -box.y };
      return coverage;
    });
    if (surface) {
      // anchored as fillText's shadow is, so it moves with the text
      const origin = surface._shadowOrigin;
      this._paintShadow(
        surface,
        roundFrom(ax, this._shadowOffsetX) - origin.x,
        roundFrom(ay, this._shadowOffsetY) - origin.y,
      );
      return;
    }
    if (!ink) return;
    // Padded ink larger than a shadow surface may be: fall back to the
    // clipped, uncached path, which sizes itself to the part of the shadow
    // that can actually be seen — the same escape `_shadowOfText` takes.
    this._shadowOfDrawing(
      {
        minX: ax + ink.minX,
        maxX: ax + ink.maxX,
        minY: ay + ink.minY,
        maxY: ay + ink.maxY,
      },
      (sctx, dx, dy) =>
        sctx._drawGlyphsDevice(
          this.Render.PictOp.Over,
          sctx._backgroundPicture,
          positioned.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })),
        ),
    );
  }

  /** the shadow of a `fill()`/`stroke()`-shaped call, from its arguments */
  _shadowOfPath(args, stroke) {
    if (stroke) {
      const polys =
        args[0] instanceof Path2D
          ? flattenPath(args[0]._cmds, this._m)
          : flattenPath(this._path._cmds, null);
      this._shadowOfPolys(polys, { stroke: true });
      return;
    }
    if (
      !(args[0] instanceof Path2D) &&
      this._tiledShadow(this._path._shapes, args[0] === "evenodd")
    ) {
      return;
    }
    const { polys, rule } = this._polysFor(args);
    this._shadowOfPolys(polys, { rule });
  }

  /**
   * The shadow of a `drawImage`, from the destination rectangle its
   * arguments describe.
   *
   * The image is drawn again into the coverage surface rather than its alpha
   * being read out: an `a8` destination *is* the alpha channel, so an
   * ordinary composite of the image onto one leaves exactly the coverage the
   * shadow needs — including a translucent image's soft edges, and whatever
   * scaling or transform the call asked for.
   */
  _shadowOfImage(image, args) {
    const iw = image?.width;
    const ih = image?.height;
    if (!Number.isFinite(iw) || !Number.isFinite(ih)) return;
    let rect;
    if (args.length >= 8) rect = args.slice(4, 8);
    else if (args.length >= 4) rect = args.slice(0, 4);
    else rect = [args[0] ?? 0, args[1] ?? 0, iw, ih];
    const [dx, dy, dw, dh] = rect;
    if (!(dw > 0) || !(dh > 0)) return;
    const corners = [
      matApply(this._m, dx, dy),
      matApply(this._m, dx + dw, dy),
      matApply(this._m, dx, dy + dh),
      matApply(this._m, dx + dw, dy + dh),
    ];
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    this._shadowOfDrawing(
      {
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minY: Math.min(...ys),
        maxY: Math.max(...ys),
      },
      (sctx) => sctx.drawImage(image, ...args),
    );
  }

  /** the shadow of an axis-aligned rectangle in user space */
  _shadowOfRect(x, y, w, h, stroke) {
    if (!stroke && this._tiledShadow(this._withShape([], x, y, w, h, 0), false)) {
      return;
    }
    const tmp = new Path2D();
    tmp.rect(x, y, w, h);
    this._shadowOfPolys(flattenPath(tmp._cmds, this._m), { stroke });
  }

  /**
   * The shadow of a fill whose path is `shapes` — one rect or rounded rect,
   * or, filled evenodd, one inside another: the frame an inset box shadow
   * is cast around — drawn from a tile (lib/shadowtiles.js). A tile has a
   * short name where a path has none, so it is made once and kept with the
   * other shadow coverage (`cachedShadow`), and a repaint of any part of
   * the shadow composites that part of it. False for anything else, and
   * for a shadow a tile cannot draw; the caller then blurs it as before.
   */
  _tiledShadow(shapes, evenodd) {
    if (!shapes?.length || !(this._shadowBlur > 0)) return false;
    if (!shadowPolicyOf(this.window.app).tiles) return false;
    if (shapes.length === 1) return this._shadowFromTile(shapes[0], null);
    if (shapes.length !== 2 || !evenodd) return false;
    const [p, q] = shapes;
    if (boxInside(q, p)) return this._shadowFromTile(p, q);
    if (boxInside(p, q)) return this._shadowFromTile(q, p);
    return false;
  }

  _shadowFromTile(outer, inner) {
    const ox = Math.round(this._shadowOffsetX);
    const oy = Math.round(this._shadowOffsetY);
    const snap = (r) => ({
      x0: Math.round(r.x0) + ox,
      y0: Math.round(r.y0) + oy,
      x1: Math.round(r.x1) + ox,
      y1: Math.round(r.y1) + oy,
      corners: r.corners,
    });
    const o = snap(outer);
    // a shape with nothing in it casts nothing
    if (!(o.x1 > o.x0 && o.y1 > o.y0)) return true;
    let hole = inner && snap(inner);
    if (hole && !(hole.x1 > hole.x0 && hole.y1 > hole.y0)) hole = null;
    const plan = planShadowTiles(o, hole, this._shadowBlur);
    if (!plan) return false;
    const { x, y, width, height } = plan.bounds;
    // a composite's corner goes over in 16 bits: a shadow that reaches past
    // them is drawn the old way, whose box is clamped to what can show
    if (x < -WIRE_REACH || y < -WIRE_REACH) return false;
    if (x + width > WIRE_REACH || y + height > WIRE_REACH) return false;
    if (!(x < this.width && y < this.height && x + width > 0 && y + height > 0)) {
      return true;
    }
    const clip = this._clipRect();
    if (clip && !boxesMeet(plan.bounds, clip)) return true;
    const app = this.window.app;
    const tile = cachedShadow(app, `tile|${plan.key}`, () =>
      this._shadowTile(plan),
    );
    if (!tile) return false;
    const picture = tile.picture(app);
    const style = this._fillStyle;
    const background = this._backgroundPicture;
    this.fillStyle = this._shadowColor;
    try {
      const op = this._op();
      for (const [sx, sy, sw, sh, dx, dy, dw, dh] of plan.pieces) {
        if (clip && !boxesMeet({ x: dx, y: dy, width: dw, height: dh }, clip)) {
          continue;
        }
        // a piece drawn at its own size reads the tile as it is: undo the
        // transform the last stretched one left on the picture
        if (sw === dw && sh === dh && picture._tileScaled) {
          this.Render.SetPictureTransform(picture.id, IDENTITY_TRANSFORM);
          picture.setFilter("nearest");
          picture._tileScaled = false;
        } else if (sw !== dw || sh !== dh) {
          picture._tileScaled = true;
        }
        this._drawCoverage(picture, sx, sy, sw, sh, dx, dy, dw, dh, op);
      }
    } finally {
      this._fillStyle = style;
      this._backgroundPicture = background;
    }
    return true;
  }

  /** A tile's coverage on an `a8` surface: made here, uploaded once. */
  _shadowTile(plan) {
    const app = this.window.app;
    const { width, height } = plan;
    const surface = new Surface(app, { width, height, format: "a8" });
    const alpha = shadowTileAlpha(plan);
    // PutImage wants each row padded to 4 bytes
    const stride = (width + 3) & ~3;
    let data;
    if (stride === width) {
      data = Buffer.from(alpha.buffer, alpha.byteOffset, alpha.length);
    } else {
      data = Buffer.alloc(stride * height);
      for (let y = 0; y < height; y++) {
        Buffer.from(alpha.buffer, alpha.byteOffset + y * width, width).copy(
          data,
          y * stride,
        );
      }
    }
    const X = this.X;
    // one upload GC per app for depth 8, as image.js keeps one for 32
    let gc = app._coverageUploadGC;
    if (!gc) {
      gc = app._coverageUploadGC = X.AllocID();
      X.CreateGC(gc, surface.pixmap.id);
    }
    const maxBytes = ((app.display.max_request_length ?? 65535) - 8) * 4;
    const rowsPerBand = Math.max(1, Math.floor(maxBytes / stride));
    for (let y = 0; y < height; y += rowsPerBand) {
      const rows = Math.min(rowsPerBand, height - y);
      X.PutImage(
        2,
        surface.pixmap.id,
        gc,
        width,
        rows,
        0,
        y,
        0,
        8,
        data.subarray(y * stride, (y + rows) * stride),
      );
    }
    return surface;
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

  /** The shapes the default path is so far — none for an empty one, null
   *  once it is anything but rects and rounded rects (Path2D `_shapes`). */
  _shapesSoFar() {
    return this._path._cmds.length === 0 ? [] : this._path._shapes;
  }

  /**
   * `shapes` and one more, in device space: a rect, or a rounded rect with
   * `radii` as `roundRect` takes them. Null where the list already was, or
   * where the transform rotates, skews or mirrors — a tile is drawn upright
   * — or the box is not a finite one.
   */
  _withShape(shapes, x, y, w, h, radii) {
    if (!shapes || !finiteRect(x, y, w, h)) return null;
    const [a, b, c, d, e, f] = this._m;
    if (b !== 0 || c !== 0 || !(a > 0) || !(d > 0)) return null;
    if (w < 0) {
      x += w;
      w = -w;
    }
    if (h < 0) {
      y += h;
      h = -h;
    }
    const corners = normalizeRadii(w, h, radii).map((r) => ({
      x: r.x * a,
      y: r.y * d,
    }));
    return [
      ...shapes,
      {
        x0: a * x + e,
        y0: d * y + f,
        x1: a * (x + w) + e,
        y1: d * (y + h) + f,
        corners,
      },
    ];
  }

  rect(x, y, w, h) {
    const shapes = this._shapesSoFar();
    const tmp = new Path2D();
    tmp.rect(x, y, w, h);
    this._path.addPath(tmp, this._m);
    this._path._shapes = this._withShape(shapes, x, y, w, h, 0);
  }

  roundRect(x, y, w, h, radii) {
    const shapes = this._shapesSoFar();
    const tmp = new Path2D();
    tmp.roundRect(x, y, w, h, radii);
    const wasEmpty = this._path._cmds.length === 0;
    this._path.addPath(tmp, this._m);
    // Path2D draws a box of negative extent as a plain rect
    this._path._shapes = this._withShape(
      shapes,
      x,
      y,
      w,
      h,
      w < 0 || h < 0 ? 0 : radii,
    );
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

  /**
   * The shapes a `w`×`h` picture whose pixel (0, 0) is device (-dx, -dy)
   * is sent, in device space: `_rasterizePolys` trapezoidizes them for the
   * server, and the local route hands the same ones to the rasterizer, so
   * that both rasterize one geometry (lib/precise.js).
   *
   * Trapezoids are 16.16 fixed point, and a coordinate past 32,767 throws
   * out of the paint (lib/cliprect.js). They go on the wire in device space
   * with the picture's offset beside them, which the server adds, so a
   * shape has to be in reach both in device space and in the picture's.
   * One that is not is cut to the picture first, a pixel to spare on every
   * side: nothing outside the picture is ever composited. One in reach
   * goes as it came, for the server to clip.
   */
  _wireShapes(shapes, dx = 0, dy = 0, w = this.width, h = this.height) {
    const x0 = -dx - 1;
    const y0 = -dy - 1;
    const x1 = w - dx + 1;
    const y1 = h - dy + 1;
    const rx0 = Math.max(-WIRE_REACH, -WIRE_REACH - dx);
    const ry0 = Math.max(-WIRE_REACH, -WIRE_REACH - dy);
    const rx1 = Math.min(WIRE_REACH, WIRE_REACH - dx);
    const ry1 = Math.min(WIRE_REACH, WIRE_REACH - dy);
    let fitted = null;
    for (let i = 0; i < shapes.length; i++) {
      const shape = shapes[i];
      if (withinRect(shape, rx0, ry0, rx1, ry1)) {
        if (fitted) fitted.push(shape);
        continue;
      }
      if (!fitted) fitted = shapes.slice(0, i);
      const ring = clipRingToRect(shape, x0, y0, x1, y1);
      if (ring.length >= 6) fitted.push(ring);
    }
    return fitted ?? shapes;
  }

  _rasterizePolys(
    picture,
    shapes,
    rule,
    dx = 0,
    dy = 0,
    w = this.width,
    h = this.height,
  ) {
    if (!shapes.length) return;
    // In device space and on the 16.16 grid, with the offset into the
    // picture left to the request: these are the numbers PreciseRasterizer
    // rasterizes when the same mask is drawn here, so the two routes agree
    // to the byte. An offset folded into the coordinates instead rounds
    // differently from one added to them on the wire.
    const traps = trapezoidize(this._wireShapes(shapes, dx, dy, w, h), 0, 0, [], rule);
    for (let i = 0; i < traps.length; i++) traps[i] = snapFixed16(traps[i]);
    // stay under the server's maximum request size
    const chunk = 4000 * 6;
    for (let i = 0; i < traps.length; i += chunk) {
      this.Render.AddTraps(picture.id, dx, dy, traps.slice(i, i + chunk));
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
  _uploadCoverage(job, b, out, edges, route) {
    const rasterizer = this.window.app.rasterizer;
    if (!rasterizer) return false;
    const where =
      route ?? routeRaster(b.w, b.h, edges, this.window.app.rasterPolicy);
    if (where !== "local") return false;

    // Rasterized over the whole box, as always, so a drawing that clips
    // split across passes — a pan's strips, a full repaint — gets the same
    // coverage in every one of them, byte for byte. Only `out`, the part the
    // clip lets through, goes on the wire (issue #372).
    const coverage = rasterizer.rasterize({ ...job, width: b.w, height: b.h });
    if (!coverage) return false;

    // X wants scanlines padded to 4 bytes; the rasterizer contract is
    // unpadded rows. When the part sent is the whole box and its width is
    // already a multiple of 4 — which every power-of-two icon box is — the
    // coverage goes out as a view over the rasterizer's own bytes, with no
    // copy at all.
    const stride = (out.w + 3) & ~3;
    let data;
    if (out.w === b.w && out.h === b.h && stride === b.w) {
      data = Buffer.isBuffer(coverage)
        ? coverage
        : Buffer.from(coverage.buffer, coverage.byteOffset, coverage.length);
    } else {
      data = Buffer.alloc(stride * out.h);
      const left = out.x - b.x;
      const top = out.y - b.y;
      for (let y = 0; y < out.h; ++y) {
        const from = coverage.byteOffset + (top + y) * b.w + left;
        Buffer.from(coverage.buffer, from, out.w).copy(data, y * stride);
      }
    }
    this.X.PutImage(
      2,
      this.fillMaskDrawable.id,
      this._maskGC(),
      out.w,
      out.h,
      out.x,
      out.y,
      0,
      8,
      data,
    );
    return true;
  }

  /**
   * Device-space bounding box of one flat `[x0, y0, …]` point list, with a
   * pixel of slack for the antialiased edge, clamped to the surface. Null
   * when nothing lands on it.
   */
  _pointsBBox(pts) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      if (pts[i] < minX) minX = pts[i];
      if (pts[i] > maxX) maxX = pts[i];
      if (pts[i + 1] < minY) minY = pts[i + 1];
      if (pts[i + 1] > maxY) maxY = pts[i + 1];
    }
    if (maxX === -Infinity) return null;
    return this._clampBBox(minX, minY, maxX, maxY);
  }

  /** the same over every subpath of a flattened path, as one box */
  _polysBBox(polys) {
    let out = null;
    for (const poly of polys) {
      const b = this._pointsBBox(poly.pts);
      if (!b) continue;
      out = out ? unionBox(out, b) : b;
    }
    return out;
  }

  /**
   * A drawing's own extent: its box with the same pixel of slack as
   * `_clampBBox`, and *not* clamped to the surface — what its masks are
   * clustered and routed by (`_fillPolys`, the stroke's mask path).
   *
   * Which rasterizer draws a mask — ours or the server's — has to be a
   * property of the drawing, never of where it lands. The two antialias
   * differently, so a route taken from the part the surface shows changed
   * as the drawing moved: a stroke whose cap had just left the surface had
   * three triangles fewer to count, went to the other rasterizer, and came
   * out up to ten levels different along its whole length — a pan's copy
   * of it one way, the strip beside it the other. Clamping and culling
   * decide how much work a mask is, never how it is drawn.
   */
  _rawBox(minX, minY, maxX, maxY) {
    const x = Math.floor(minX) - 1;
    const y = Math.floor(minY) - 1;
    return { x, y, w: Math.ceil(maxX) + 1 - x, h: Math.ceil(maxY) + 1 - y };
  }

  /** `_rawBox` of one flat `[x0, y0, …]` point list; null for none. */
  _pointsExtent(pts) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      if (pts[i] < minX) minX = pts[i];
      if (pts[i] > maxX) maxX = pts[i];
      if (pts[i + 1] < minY) minY = pts[i + 1];
      if (pts[i + 1] > maxY) maxY = pts[i + 1];
    }
    if (!(maxX >= minX && maxY >= minY)) return null;
    return this._rawBox(minX, minY, maxX, maxY);
  }

  /** `_rawBox` over every subpath of a flattened path; null for none. */
  _polysExtent(polys) {
    let out = null;
    for (const poly of polys) {
      const b = this._pointsExtent(poly.pts);
      if (!b) continue;
      out = out ? unionBox(out, b) : b;
    }
    return out;
  }

  /**
   * Where a drawing whose own box is `box` is rasterized (`routeRaster`),
   * sized by as much of it as the surface could ever show — each side no
   * longer than the surface's, and its edges in the same proportion —
   * rather than by the part it shows now: a route that depends only on the
   * drawing's size and complexity is the same wherever the drawing lands
   * (`_rawBox`). Counting every edge of a stroke that runs far past the
   * surface sent it through the mask more often than the part it shows
   * earned: a fifth more bytes a frame for a hundred such strokes.
   */
  _routeFor(box, edges) {
    const w = Math.min(box.w, this.width);
    const h = Math.min(box.h, this.height);
    return routeRaster(
      w,
      h,
      (edges * w * h) / (box.w * box.h),
      this.window.app.rasterPolicy,
    );
  }

  /** the part of a box on the surface; null where there is none */
  _onSurface(b) {
    const x = Math.max(0, b.x);
    const y = Math.max(0, b.y);
    const w = Math.min(this.width, b.x + b.w) - x;
    const h = Math.min(this.height, b.y + b.h) - y;
    if (w <= 0 || h <= 0) return null;
    return { x, y, w, h };
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

  /**
   * The mask boxes one drawing's pieces are painted through: one per cluster
   * of them, whose union is the drawing's bounding box.
   *
   * Everything the mask does is bounded to those boxes rather than to the
   * whole surface. On the wire it makes no difference — a Composite request
   * is the same size either way — but it is the difference between the
   * server touching a 34x34 box and a 400x400 one per fill. Where the pieces
   * are *scattered*, their union is a poor bound in the same way, and
   * `clusterBoxes` cuts it into the few boxes the ink is actually in (see
   * maskcluster.js). Stale mask content outside a box is never composited,
   * so clearing only the boxes is safe.
   */
  _maskClusters(pieces, op) {
    const clusters = clusterBoxes(
      pieces,
      this._maskBounded(op) ? maskPolicyOf(this.window.app) : ONE_MASK,
    );
    if (clusters.length > 1) this.maskStats.split++;
    return clusters;
  }

  /** whether `op` leaves the destination alone where the mask is zero */
  _maskBounded(op) {
    this._boundedOps ??= new Set(
      MASK_BOUNDED_OPS.map((name) => this.Render.PictOp[name]),
    );
    return this._boundedOps.has(op);
  }

  /**
   * The tail every masked fill and stroke ends in: coverage for one box into
   * the scratch a8 mask, scaled by `alpha`, intersected with the clip, and
   * the source composited through it.
   *
   * `job` is what a Rasterizer takes minus the box (docs/context-2d.md) —
   * `{ polys, rule }` or `{ triangles }`; `server` rasterizes the same
   * geometry into the mask server-side, for when the local rasterizer is not
   * the cheaper route or declines.
   *
   * @returns {boolean} whether anything was composited
   */
  _paintThroughMask(b, job, { edges, route, src, op, alpha, server }) {
    const R = this.Render;
    // Everything is bounded to the part of the box the clip lets through:
    // the clip's rectangle, or the extents of a stack with a path in it —
    // the coverage rasterized and uploaded, the clip applied, the composite.
    // A stroke across a rounded pane used to upload its whole box through
    // the mask to paint a few rows of it (issue #372). The mask content
    // outside `out` is stale by the same argument as outside `b`, and a box
    // the clip rejects outright needs no coverage at all. A stack whose mask
    // was dropped by restore() may still hold a poly, and the mask comes
    // back on demand. A region clip needs nothing here: the picture carries
    // it, and it applies to the composite below like any other.
    const clip = this._hasPolyClip ? this._clipExtents() : this._clipRect();
    let out = b;
    if (clip) {
      out = intersectBox(b, clip);
      if (!out) return false;
    }
    if (this._hasPolyClip) this._requireClipMask();
    if (
      !this._uploadCoverage({ ...job, dx: -b.x, dy: -b.y }, b, out, edges, route)
    ) {
      R.FillRectangles(
        R.PictOp.Src,
        this.fillMask.id,
        [0, 0, 0, 0],
        [out.x, out.y, out.w, out.h],
      );
      server();
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
    // gradient/pattern, sampled at the same offset from its own origin
    const [ox, oy] = sourceOrigin(src);
    R.Composite(
      op,
      src.id,
      this.fillMask.id,
      this._dst(),
      out.x - ox,
      out.y - oy,
      out.x,
      out.y,
      out.x,
      out.y,
      out.w,
      out.h,
    );
    this.maskStats.masks++;
    this.maskStats.pixels += out.w * out.h;
    return true;
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
    if (!prepareStyle(src, this._m, this.width, this.height)) return;

    // one box per subpath, so a path holding disjoint ones can be masked as
    // the pieces it is rather than as the box around all of them — each the
    // subpath's own box, on the surface or not (`_rawBox`)
    const shapes = [];
    const pieces = [];
    for (const p of polys) {
      if (p.pts.length < 6) continue;
      const b = this._pointsExtent(p.pts);
      if (!b) continue;
      shapes.push(p.pts);
      pieces.push(b);
    }
    if (!shapes.length) return;

    this._ensureFillMask();
    let painted = false;
    for (const cluster of this._maskClusters(pieces, op)) {
      // Routed by every subpath of the cluster, and rasterized from the
      // ones the surface shows, over the part of them it shows: a subpath
      // wholly off it adds nothing to the winding of a pixel outside its
      // own box.
      const flat = [];
      let box = null;
      let edges = 0;
      let drawn = 0;
      for (const i of cluster.items) {
        edges += shapes[i].length / 2;
        const shown = this._onSurface(pieces[i]);
        if (!shown) continue;
        flat.push(shapes[i]);
        drawn += shapes[i].length / 2;
        box = box ? unionBox(box, shown) : shown;
      }
      if (!box) continue;
      // what the server would be sent for the surface-sized mask, so that
      // drawn here it comes out the same
      const wire = this._wireShapes(flat);
      painted =
        this._paintThroughMask(
          box,
          { polys: wire, rule },
          {
            edges: drawn,
            route: this._routeFor(cluster, edges),
            src,
            op,
            alpha,
            server: () => this._rasterizePolys(this.fillMask, wire, rule),
          },
        ) || painted;
    }
    if (painted) this._markDirty();
  }

  _strokePolys(polys, { src = null } = {}) {
    src = src ?? this._strokePicture;
    if (this.globalAlpha <= 0) return;
    if (!prepareStyle(src, this._m, this.width, this.height)) return;
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
    // what a dash beyond cannot be seen: the surface, grown by how far a
    // miter or a square cap reaches from the point it is drawn at
    // (lib/dash.js)
    const reach = (thickness / 2) * Math.max(this.miterLimit, 1.5) + 2;
    const view = [-reach, -reach, this.width + reach, this.height + reach];

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
    // An open subpath that ends where it began, heading the way it began —
    // a full circle from arc(), which leaves its subpath open. Stroked
    // open, each end got a cap square to its own chord, and a flattened
    // curve's first and last chords point a chord's angle apart: a wedge
    // of ink went missing outside the seam, a hairline across every
    // stroked ring, and doubled inside it. Where the two ends meet head to
    // tail the caps and a join are the same ink, so it is stroked as the
    // loop it is. A path that comes back to its start at a corner keeps
    // its caps, as the spec gives them.
    const smoothLoop = (poly, pts) => {
      const n = pts.length;
      if (n < 4) return false;
      const [fx, fy] = pts[0];
      const [lx, ly] = pts[n - 1];
      if (Math.abs(fx - lx) > 1e-6 || Math.abs(fy - ly) > 1e-6) return false;
      const [hx, hy] = (poly.head && subpathHead(poly)) ?? [
        pts[1][0] - fx,
        pts[1][1] - fy,
      ];
      const [tx, ty] = (poly.tail && subpathTail(poly)) ?? [
        lx - pts[n - 2][0],
        ly - pts[n - 2][1],
      ];
      const lengths = Math.hypot(hx, hy) * Math.hypot(tx, ty);
      return lengths > 0 && (hx * tx + hy * ty) / lengths > 1 - 1e-9;
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
      const closed = poly.closed || smoothLoop(poly, pts);

      if (!dash) {
        extrudeRun(pts, closed);
        continue;
      }
      const dashed = dashPolyline(pts, closed, dash, dashOffset, view);
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
      if (
        !Number.isFinite(
          tris[i] + tris[i + 1] + tris[i + 2] + tris[i + 3] + tris[i + 4] + tris[i + 5],
        )
      ) {
        continue;
      }
      if (w < i) for (let k = 0; k < 6; k++) tris[w + k] = tris[i + k];
      w += 6;
    }
    if (w < tris.length) tris.length = w;
    if (!tris.length) return;
    // On the 16.16 grid the wire carries, once, for every route below: the
    // server rasterizes these numbers, and so does PreciseRasterizer when
    // the stroke is drawn here (lib/precise.js)
    for (let i = 0; i < tris.length; i++) tris[i] = snapFixed16(tris[i]);

    const op = this._op();
    // round-cap/join disks overlap the stroke body; overlapping coverage
    // must accumulate in the clamped a8 mask (single composite) or a
    // semi-transparent stroke style would double-blend at the overlaps
    const direct =
      !hasRound &&
      this.globalAlpha >= 1 &&
      // a region clip stays on the picture and needs nothing here; a
      // rectangle or a mask does
      !this._hasPolyClip &&
      !this._clipRect() &&
      op === this.Render.PictOp.Over;
    const chunk = 4000 * 6;
    if (direct) {
      const [ox, oy] = sourceOrigin(src);
      this._cullTris(tris);
      if (!tris.length) return;
      const cut = this._wireCut(tris);
      if (cut !== tris) {
        tris.length = 0;
        for (let i = 0; i < cut.length; i++) tris.push(cut[i]);
        if (!tris.length) return;
      }
      for (let i = 0; i < tris.length; i += chunk) {
        const batch = tris.slice(i, i + chunk);
        // RENDER aligns the source with the *first triangle's first vertex*,
        // not with the destination: the source is sampled at
        // (srcX + x - floor(tris[0].x)). Passing that vertex back is what
        // makes source coordinates equal destination coordinates, the same
        // convention drawGlyphRuns and compositeTraps use — without it every
        // non-constant stroke style (a gradient, a pattern) is offset by
        // wherever the stroke happens to start, and shifts as it moves.
        // Less the style's own origin, as every fill samples it.
        this.Render.Triangles(
          op,
          src.id,
          Math.floor(batch[0]) - ox,
          Math.floor(batch[1]) - oy,
          this._dst(),
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
    // Bounded to the stroke's islands, for the same reason _fillPolys is: on
    // the wire a Composite is the same size either way, but this branch runs
    // once per stroke, and a wall of 400 round-capped icons is 3200 of them.
    // Clearing and compositing the whole surface each time was ~6 Gpx a frame
    // and took 1.9 s on XQuartz where the bounded version takes 37 ms
    // (react-x11#148). Stale mask content outside the boxes is never
    // composited, so clearing only them is safe.
    //
    // The islands are the whole stroke's, on the surface or not, and so are
    // the clusters and the route each is drawn by (`_rawBox`); only the
    // triangles the surface shows are rasterized.
    this._ensureFillMask();
    const pieces = this._trisPieces(tris);
    if (!pieces.length) return;
    let painted = false;
    for (const cluster of this._maskClusters(pieces, op)) {
      let edges = 0;
      for (const i of cluster.items) {
        edges += (pieces[i].end - pieces[i].start) / 2;
      }
      const batch = this._trisBatch(tris, pieces, cluster);
      if (!batch.length) continue;
      // the mask over what is drawn, as tight as it always was
      const box = this._pointsBBox(batch);
      if (!box) continue;
      painted =
        this._paintThroughMask(
          box,
          { triangles: batch },
          {
            edges: batch.length / 2,
            route: this._routeFor(cluster, edges),
            src,
            op,
            alpha: this.globalAlpha,
            server: () => {
              const opaque = this.createSolidPicture(0, 0, 0, 1);
              for (let i = 0; i < batch.length; i += chunk) {
                this.Render.Triangles(
                  this.Render.PictOp.Add,
                  opaque.id,
                  0,
                  0,
                  this.fillMask.id,
                  this.Render.a8,
                  batch.slice(i, i + chunk),
                );
              }
            },
          },
        ) || painted;
    }
    if (painted) this._markDirty();
  }

  /**
   * A stroke's triangle soup as the islands it is made of: consecutive
   * triangles are coalesced while they stay within `PIECE_SLACK` of each
   * other, which collapses a polyline — body, caps, join disks and all —
   * into one piece and leaves a batch of separate strokes as one piece each.
   * Each piece carries the `[start, end)` span of `tris` it owns.
   *
   * Coalescing is always safe: merging boxes can only widen a mask, while
   * splitting overlapping coverage apart is what would double-blend it —
   * and `clusterBoxes` cannot split overlapping boxes anyway. So this is a
   * linear pre-pass whose only job is to hand the clustering a handful of
   * boxes instead of thousands of triangles.
   *
   * Each piece is its own box (`_rawBox`), on the surface or not: the
   * clusters and the routes are the stroke's, and the surface only bounds
   * the work (`_trisBatch`).
   */
  _trisPieces(tris) {
    const pieces = [];
    let open = null;
    const close = () => {
      if (!open) return;
      const b = this._rawBox(open.minX, open.minY, open.maxX, open.maxY);
      pieces.push({ ...b, start: open.start, end: open.end });
      open = null;
    };
    for (let i = 0; i < tris.length; i += 6) {
      const minX = Math.min(tris[i], tris[i + 2], tris[i + 4]);
      const maxX = Math.max(tris[i], tris[i + 2], tris[i + 4]);
      const minY = Math.min(tris[i + 1], tris[i + 3], tris[i + 5]);
      const maxY = Math.max(tris[i + 1], tris[i + 3], tris[i + 5]);
      if (
        open &&
        minX - PIECE_SLACK <= open.maxX &&
        open.minX - PIECE_SLACK <= maxX &&
        minY - PIECE_SLACK <= open.maxY &&
        open.minY - PIECE_SLACK <= maxY
      ) {
        if (minX < open.minX) open.minX = minX;
        if (maxX > open.maxX) open.maxX = maxX;
        if (minY < open.minY) open.minY = minY;
        if (maxY > open.maxY) open.maxY = maxY;
        open.end = i + 6;
        continue;
      }
      close();
      open = { minX, minY, maxX, maxY, start: i, end: i + 6 };
    }
    close();
    return pieces;
  }

  /**
   * One cluster's triangles, gathered from its pieces: less those wholly
   * off the surface, which add nothing on either route — the rasterizer
   * would walk their rows only for their edges to cancel on the border
   * column, and the server would be sent them only to clip them away — and
   * cut to the wire's reach (`_wireCut`). The soup itself when the cluster
   * is all of it and all of it is on the surface: the common case, one
   * polyline in view, and worth not copying.
   */
  _trisBatch(tris, pieces, cluster) {
    const { items } = cluster;
    const inside =
      cluster.x >= -1 &&
      cluster.y >= -1 &&
      cluster.x + cluster.w <= this.width + 1 &&
      cluster.y + cluster.h <= this.height + 1;
    if (
      inside &&
      items.length === 1 &&
      pieces[items[0]].start === 0 &&
      pieces[items[0]].end === tris.length
    ) {
      return this._wireCut(tris);
    }
    const out = [];
    for (const i of items) {
      for (let k = pieces[i].start; k < pieces[i].end; ++k) out.push(tris[k]);
    }
    if (!inside) this._cullTris(out);
    return this._wireCut(out);
  }

  /**
   * Leave out, in place, every triangle wholly off the surface: nothing of
   * it can land on it, and a zoomed graph has hundreds of edges past the
   * window every frame.
   */
  _cullTris(tris) {
    const right = this.width + 1;
    const bottom = this.height + 1;
    let w = 0;
    for (let i = 0; i < tris.length; i += 6) {
      const ax = tris[i];
      const ay = tris[i + 1];
      const bx = tris[i + 2];
      const by = tris[i + 3];
      const cx = tris[i + 4];
      const cy = tris[i + 5];
      if (
        (ax < -1 && bx < -1 && cx < -1) ||
        (ay < -1 && by < -1 && cy < -1) ||
        (ax > right && bx > right && cx > right) ||
        (ay > bottom && by > bottom && cy > bottom)
      ) {
        continue;
      }
      if (w < i) for (let k = 0; k < 6; k++) tris[w + k] = tris[i + k];
      w += 6;
    }
    if (w < tris.length) tris.length = w;
    return tris;
  }

  /**
   * Triangles are 16.16 fixed point, and the source origin a direct stroke
   * hands the server is 16 bits: a stroke that reaches that far is cut to
   * the surface first (lib/cliprect.js), a pixel to spare on every side, so
   * what the surface shows is drawn exactly as before. One that does not
   * goes as it came, for the server to clip — the same array.
   */
  _wireCut(tris) {
    if (withinRect(tris, -WIRE_REACH, -WIRE_REACH, WIRE_REACH, WIRE_REACH)) {
      return tris;
    }
    return clipTrianglesToRect(tris, -1, -1, this.width + 1, this.height + 1);
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
   *   order; `x`/`y` is the run's baseline origin in **user space** — the
   *   current transform applies to it, as it does to every other drawing
   *   call. `run` is
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
   * The transform moves each run's origin, exactly as `fillText` moves its
   * anchor; the glyphs themselves are not rotated or scaled by it (size the
   * font via `ctx.font`, or `run.size`, instead). Advances and `dx`/`dy` are
   * therefore device pixels on both calls. Without this, a `TextLayout`
   * drawn into a translated context — which is every react-x11 canvas that
   * is not at the window's origin — landed at the untransformed coordinates
   * and was then cut by the clip, while the neighbouring `fillRect` and
   * `drawImage` moved (issue #280).
   *
   * The shadow state applies too, as it does to `fillText`: one blurred
   * coverage surface for the whole call, cached on the runs' identity and
   * relative positions, painted under the glyphs (issue #283). A paragraph
   * whose spans change colour draws as several calls, and — as several
   * `fillText`s would — casts a shadow per call.
   *
   * So does `globalAlpha`, to the glyphs and their shadow both, as it does
   * to every fill: at 0 nothing is drawn, not even the shadow.
   */
  drawGlyphs(op, src, positioned) {
    if (this.globalAlpha <= 0) return;
    const m = this._m;
    if (!matIsIdentity(m)) {
      positioned = positioned.map((p) => {
        const [x, y] = matApply(m, p.x, p.y);
        return { ...p, x, y };
      });
    }
    if (this._shadowed()) this._shadowOfGlyphs(positioned);
    this._drawGlyphsDevice(op, src, positioned);
  }

  /**
   * `drawGlyphs` with the origins already in device space — the primitive
   * under it, for callers that place glyphs themselves (`fillText`, which
   * has to add the alignment and baseline offsets *after* the transform,
   * because glyph advances are device pixels).
   *
   * CompositeGlyphs writes straight to the destination picture, so it has
   * no way to consult our clip mask — text drawn through it used to spill
   * out of clipped boxes while every fill and stroke stayed inside. With a
   * clip active, render the glyph coverage into the scratch a8 mask
   * instead, intersect that with the clip, and paint the real source
   * through the result — the same shape as _fillPolys. A rectangular clip
   * takes the server-side fast path below instead of the mask.
   *
   * Nor has it a mask slot for `globalAlpha`, which is why text used to be
   * drawn at full opacity whatever it was. A solid source takes the alpha
   * in its colour, as `fillRect`'s does, and the glyphs go the way they
   * always went; a gradient or a pattern has no one colour to fold it
   * into, and paints through the scratch mask with the alpha in there.
   */
  _drawGlyphsDevice(op, src, positioned) {
    if (this.globalAlpha <= 0) return;
    const app = this.window.app;
    if (!prepareStyle(src, this._m, this.width, this.height)) return;
    const faded = this._fadedSource(src);
    if (faded && !this._hasPolyClip) {
      // Fast path: a rectangular clip is something the server can do itself.
      // Two small requests around the ordinary glyph composite, instead of
      // clearing and compositing a full-surface a8 mask three times — which
      // costs the same on the wire but many times the pixel work. No clip
      // stack at all, or only a region one, needs neither: the picture is
      // already carrying whatever applies.
      const rect = this._clipRect();
      if (rect) {
        if (rect.w === 0 || rect.h === 0) return;
        this._setPictureClip(rect);
      }
      drawGlyphRuns(
        app,
        op,
        faded.id,
        this._dst(),
        positioned,
        rect ?? { x: 0, y: 0, w: this.width, h: this.height },
        sourceOrigin(faded),
      );
      if (rect) this._invalidatePictureClip();
      this._markDirty();
      return;
    }
    const R = this.Render;
    const alpha = faded ? 1 : this.globalAlpha;
    const surface = { x: 0, y: 0, w: this.width, h: this.height };
    this._paintThroughScratch(op, faded ?? src, alpha, (white, mask) =>
      drawGlyphRuns(app, R.PictOp.Over, white, mask, positioned, surface),
    );
  }

  /**
   * Trapezoid coverage under the clip — `drawGlyphs` for vector shapes that
   * are already trapezoidized (KaTeX radicals and rules go this way).
   * Without it they composite straight to the destination picture and spill
   * out of clipped boxes, which is what glyphs used to do. `globalAlpha`
   * applies as it does to glyphs, so a radical fades with the formula.
   */
  drawTraps(op, src, traps) {
    if (!traps.length || this.globalAlpha <= 0) return;
    const app = this.window.app;
    if (!prepareStyle(src, this._m, this.width, this.height)) return;
    const faded = this._fadedSource(src);
    if (faded && !this._hasPolyClip) {
      const rect = this._clipRect();
      if (rect) {
        if (rect.w === 0 || rect.h === 0) return;
        this._setPictureClip(rect);
      }
      compositeTraps(
        app,
        op,
        faded.id,
        this._dst(),
        traps,
        undefined,
        undefined,
        sourceOrigin(faded),
      );
      if (rect) this._invalidatePictureClip();
      this._markDirty();
      return;
    }
    const alpha = faded ? 1 : this.globalAlpha;
    this._paintThroughScratch(op, faded ?? src, alpha, (white, mask) =>
      compositeTraps(app, this.Render.PictOp.Over, white, mask, traps),
    );
  }

  /**
   * `src` with `globalAlpha` folded into it: the source itself at full
   * opacity, and at less, a solid of its colour with all four premultiplied
   * components scaled — which is compositing it at that opacity, for any op
   * (`_foldedColor`). Null when there is an alpha to apply and no colour to
   * fold it into: a gradient, a pattern, a picture of the caller's, or a
   * solid from a host whose `solidPicture` does not say what it paints with
   * (App#solidPicture does).
   */
  _fadedSource(src) {
    const a = this.globalAlpha;
    if (a >= 1) return src;
    const c = src._rgba;
    if (!c) return null;
    return this.createSolidPicture(c[0] * a, c[1] * a, c[2] * a, c[3] * a);
  }

  /**
   * Paint `src` through coverage the server draws into the scratch a8 mask:
   * how glyphs and trapezoids reach the surface when their own composite
   * cannot carry what applies to it — a clip that is not a rectangle, or a
   * `globalAlpha` with no colour to fold into.
   *
   * `drawCoverage(white, mask)` composites the coverage into the mask, with
   * a solid white source: what that leaves in an a8 picture is exactly the
   * coverage. `alpha` scales it, the clip cuts it — the clip mask for a
   * stack with a path in it, the picture's clip rectangle for one of
   * rectangles — and `src` is composited through the result.
   */
  _paintThroughScratch(op, src, alpha, drawCoverage) {
    const R = this.Render;
    const rect = this._clipRect();
    if (rect && (rect.w === 0 || rect.h === 0)) return;
    const clipMask = this._hasPolyClip ? this._requireClipMask() : null;
    this._ensureFillMask();
    this._glyphSource ??= this.createSolidPicture(1, 1, 1, 1);
    R.FillRectangles(
      R.PictOp.Src,
      this.fillMask.id,
      [0, 0, 0, 0],
      [0, 0, this.width, this.height],
    );
    drawCoverage(this._glyphSource.id, this.fillMask.id);
    if (alpha < 1) {
      // In with a constant color scales the a8 coverage by that alpha
      R.FillRectangles(
        R.PictOp.In,
        this.fillMask.id,
        [0, 0, 0, alpha],
        [0, 0, this.width, this.height],
      );
    }
    if (clipMask) {
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
      this._setPictureClip(rect);
    }
    const [ox, oy] = sourceOrigin(src);
    R.Composite(
      op,
      src.id,
      this.fillMask.id,
      this._dst(),
      -ox,
      -oy,
      0,
      0,
      0,
      0,
      this.width,
      this.height,
    );
    if (rect) this._invalidatePictureClip();
    this._markDirty();
  }

  /**
   * The cheap form of a direct composite, when there is one: the box to
   * composite over and what belongs in its mask slot, with no surface-sized
   * a8 mask anywhere (issue #307).
   *
   * Neither thing `_compositeMask()` puts in a mask is really mask work.
   * A **rectangular clip** is a smaller composite box: for an op that leaves
   * the destination alone where the mask is zero, zeroing the mask outside
   * the rectangle and never compositing there are the same picture — and a
   * rect clip is an integer rectangle stamped as binary coverage, so the two
   * agree pixel for pixel rather than approximately. **`globalAlpha`** is a
   * 1x1 solid, which is that alpha everywhere the server samples it, for the
   * price of no pixels at all. A **region** clip needs neither: the picture
   * carries it, and it applies to the composite like any other.
   *
   * What is left needing a mask is what genuinely needs one: a
   * non-rectangular clip entry, or an op that writes where the mask is zero
   * — `copy`, `source-in`, `destination-in`, `source-out` and
   * `destination-atop` cover the whole composite box, so a shrunk box would
   * leave behind the pixels the mask path clears.
   *
   * `box` is the composite's destination box in device coordinates. Callers
   * pass their own arguments through, so it is only intersected when it is
   * integral: clip rectangles are integers and caller coordinates are not
   * necessarily, and rounding one here could land a pixel away from where
   * the mask path draws.
   *
   * @returns {{box: ?object, mask: number}|null} the box to composite over —
   * null when the clip rejects it whole and nothing should be drawn — and
   * the mask slot for it; or null when this route does not apply and the
   * caller has to fall back to `_compositeMask()`.
   */
  _boxedComposite(box, op) {
    if (this._hasPolyClip) return null;
    let out = box;
    const clip = this._clipRect();
    if (clip) {
      if (!this._maskBounded(op)) return null;
      if (![box.x, box.y, box.w, box.h].every(isIntegral)) return null;
      out = intersectBox(box, clip);
    }
    return { box: out, mask: this._alphaMask() };
  }

  /**
   * `globalAlpha` as something to put in a mask slot: a 1x1 solid, which is
   * that alpha over any box the server samples it across, or 0 when there is
   * no alpha to apply. The surface-sized a8 `_compositeMask()` fills for the
   * same answer is pure pixel work.
   */
  _alphaMask() {
    if (this.globalAlpha >= 1) return 0;
    return this.createSolidPicture(0, 0, 0, this.globalAlpha).id;
  }

  /**
   * The composite's own box, as somewhere to put pixels: `box` grown to
   * whole pixels and clamped to the surface, or the whole surface when the
   * caller has no box to give.
   *
   * Growing outward rather than rounding is the safe direction — the mask
   * has to cover every pixel the composite samples, and a pixel of slack
   * outside it is never read.
   */
  _maskBox(box) {
    // no box, or one the caller never normalized: the whole surface, which
    // is what this always used to be
    if (!box || !(box.w > 0) || !(box.h > 0))
      return { x: 0, y: 0, w: this.width, h: this.height };
    const x = Math.max(0, Math.floor(box.x));
    const y = Math.max(0, Math.floor(box.y));
    const right = Math.min(this.width, Math.ceil(box.x + box.w));
    const bottom = Math.min(this.height, Math.ceil(box.y + box.h));
    if (right <= x || bottom <= y) return { x: 0, y: 0, w: 0, h: 0 };
    return { x, y, w: right - x, h: bottom - y };
  }

  // combined clip ∩ globalAlpha mask for direct composites (rect/image
  // fast paths); returns a picture id or 0. Reuses the fill scratch mask.
  //
  // The fallback, not the common case: `_boxedComposite` above answers for a
  // rect-only clip stack without materializing anything, and every caller
  // here asks it first. A **region** clip needs nothing either — the picture
  // carries it, and the mask must not try to hold it.
  //
  // `box` is the destination box of the composite the mask is for, in device
  // coordinates. The composite samples the mask over that box and nowhere
  // else, so both writes here take it instead of the whole surface (issue
  // #313): a translucent fill inside a rounded-corner clip used to stamp the
  // alpha across the full surface and intersect the clip across it again,
  // per fill, for pixels nothing reads. Stale content outside the box is
  // fine — every caller re-stamps the scratch unconditionally, so there is
  // no reuse to preserve.
  _compositeMask(box) {
    const clipMask =
      this._hasPolyClip || this._clipRect() ? this._requireClipMask() : null;
    if (this.globalAlpha >= 1) return clipMask ? clipMask.id : 0;
    this._ensureFillMask();
    const b = this._maskBox(box);
    if (b.w === 0 || b.h === 0) return this.fillMask.id; // nothing is sampled
    this.Render.FillRectangles(
      this.Render.PictOp.Src,
      this.fillMask.id,
      [0, 0, 0, this.globalAlpha],
      [b.x, b.y, b.w, b.h],
    );
    if (clipMask) {
      this.Render.Composite(
        this.Render.PictOp.In,
        clipMask.id,
        0,
        this.fillMask.id,
        b.x,
        b.y,
        0,
        0,
        b.x,
        b.y,
        b.w,
        b.h,
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
    if (!finiteRect(x, y, w, h)) return;
    if (w < 0) {
      x += w;
      w = -w;
    }
    if (h < 0) {
      y += h;
      h = -h;
    }
    const alpha = this._hasAlpha;
    if (matIsIdentity(this._m) && !this._hasPolyClip && !this._clipRect()) {
      // the part of it the surface has, as `_fillRect` fills it
      const onSurface = rectsOnSurface([x, y, w, h], this.width, this.height);
      if (!onSurface.length) return;
      this.Render.FillRectangles(
        this.Render.PictOp.Src,
        this._dst(),
        alpha ? [0, 0, 0, 0] : [1, 1, 1, 1],
        onSurface,
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
    if (!finiteRect(x, y, w, h)) return;
    if (w < 0) {
      x += w;
      w = -w;
    }
    if (h < 0) {
      y += h;
      h = -h;
    }
    if (this._shadowed()) this._shadowOfRect(x, y, w, h, false);
    this._fillRect(x, y, w, h);
  }

  /** fillRect minus the shadow — the batch in `fillRects` paints one shadow
   * for the whole list and then draws the rectangles through here */
  _fillRect(x, y, w, h) {
    if (matIsIdentity(this._m)) {
      // On whole pixels, each edge rounded on its own (see rectsOnSurface):
      // the wire truncates x and width separately, so rectangles that met
      // at a fractional edge left a row of neither between them. Whole, a
      // rectangle under a rectangular clip also keeps the bounded
      // composite below instead of building a mask.
      if (
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        !Number.isInteger(w) ||
        !Number.isInteger(h)
      ) {
        const x0 = Math.round(x);
        const y0 = Math.round(y);
        w = Math.round(x + w) - x0;
        h = Math.round(y + h) - y0;
        x = x0;
        y = y0;
        if (!(w > 0 && h > 0)) return;
      }
      // X coordinates and sizes are 16 bits, and a coordinate past 32,767
      // throws out of the paint (lib/cliprect.js): a rectangle that reaches
      // past the surface is filled as the part of it the surface has.
      if (x < 0 || y < 0 || x + w > this.width || y + h > this.height) {
        const x0 = Math.max(x, 0);
        const y0 = Math.max(y, 0);
        const x1 = Math.min(x + w, this.width);
        const y1 = Math.min(y + h, this.height);
        if (!(x1 > x0 && y1 > y0)) return;
        x = x0;
        y = y0;
        w = x1 - x0;
        h = y1 - y0;
      }
      const style = this._backgroundPicture;
      if (!prepareStyle(style, this._m, this.width, this.height)) return;
      const op = this._op();
      // A rectangular clip is a smaller rectangle to fill, not a mask — this
      // was the one drawing path that still built a surface-sized a8 for one
      // (issue #307), and a renderer filling a window background inside a
      // damage clip pays it every frame. Source, mask and destination
      // coordinates all shift with the box, so a gradient or a pattern stays
      // where it was and only the ink outside the clip goes away.
      const direct =
        w > 0 && h > 0 ? this._boxedComposite({ x, y, w, h }, op) : null;
      if (direct && !direct.box) return; // the clip rejects the fill whole
      const box = direct ? direct.box : { x, y, w, h };
      const [ox, oy] = sourceOrigin(style);
      this.Render.Composite(
        op,
        style.id,
        direct ? direct.mask : this._compositeMask(box),
        this._dst(),
        box.x - ox,
        box.y - oy,
        box.x,
        box.y,
        box.x,
        box.y,
        box.w,
        box.h,
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
   * Under a clip that is not a rectangle, rectangles that do not overlap
   * still cost three requests however many there are
   * (`_fillRectsThroughClip`). Gradient/Picture styles, transforms, and
   * overlapping rectangles or `copy` under a non-rectangular clip fall back
   * to that `fillRect` loop, so the answer is always right and only the
   * request count varies.
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

    // one shadow for the batch, not one per rectangle: the shadow of a
    // group of rectangles is their combined coverage blurred once, and N
    // separate shadows would darken every overlap
    if (this._shadowed()) {
      const rectPath = new Path2D();
      for (let i = 0; i < flat.length; i += 4) {
        rectPath.rect(flat[i], flat[i + 1], flat[i + 2], flat[i + 3]);
      }
      this._shadowOfPolys(flattenPath(rectPath._cmds, this._m), {});
    }

    const clip = this._clipRect();
    if (
      !matIsIdentity(this._m) ||
      !isPlainColor(this._fillStyle) ||
      (this._hasPolyClip && !this._fillRectsThroughClip(flat))
    ) {
      for (let i = 0; i < flat.length; i += 4)
        this._fillRect(flat[i], flat[i + 1], flat[i + 2], flat[i + 3]);
      return;
    }
    if (this._hasPolyClip) return;
    if (clip && (clip.w === 0 || clip.h === 0)) return; // clipped away
    // the part of each the surface has, as `_fillRect` fills it: the wire's
    // coordinates are 16 bits
    const onSurface = rectsOnSurface(flat, this.width, this.height);
    if (!onSurface.length) return;
    const R = this.Render;
    if (clip) this._setPictureClip(clip);
    // globalAlpha folds into the premultiplied colour — scaling all four
    // components is exactly what compositing at that opacity means, for
    // any composite op (the mask slot would only scale the source the same
    // way)
    const color = this._foldedColor(this._fillStyle);
    // stay under the server's maximum request size
    const chunk = 10000 * 4;
    for (let i = 0; i < onSurface.length; i += chunk) {
      R.FillRectangles(
        this._op(),
        this._dst(),
        color,
        i === 0 && onSurface.length <= chunk
          ? onSurface
          : onSurface.slice(i, i + chunk),
      );
    }
    if (clip) this._invalidatePictureClip();
    this._markDirty();
  }

  /**
   * `fillRects` under a clip that is not a rectangle — a rounded card, a
   * path: every rectangle's coverage into the scratch a8 mask with one
   * `FillRectangles`, `globalAlpha` and the clip applied to it once each,
   * and the style composited through it once. One rectangle at a time is a
   * composite through the clip each, and a chart's marks inside a rounded
   * box a zoom had put off the pixel grid were sixty thousand of them a
   * frame (issue #374).
   *
   * Only where that is the loop's picture. The rectangles must not overlap:
   * the loop blends a pixel once per rectangle over it, at the clip's
   * coverage each time, so where two overlap on the clip's antialiased edge
   * it is darker than one blend through the mask — and where they do not,
   * every pixel is blended once either way, whatever the colour's alpha.
   * And the operator must leave the destination alone where the mask is
   * zero: `copy` clears every pixel of its box the mask misses, the gaps
   * between the rectangles here. The rectangles reach the mask as the wire
   * carries every box, in whole pixels truncated toward zero, which is what
   * `_fillRect`'s composites are cut to as well.
   *
   * @returns {boolean} whether the rectangles were drawn here
   */
  _fillRectsThroughClip(flat) {
    const R = this.Render;
    const op = this._op();
    if (!this._maskBounded(op)) return false;
    const rects = [];
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < flat.length; i += 4) {
      // on whole pixels, each edge rounded as `_fillRect` rounds it, and the
      // part of it on the surface: the wire's coordinates are 16 bits
      const left = Math.round(flat[i]);
      const top = Math.round(flat[i + 1]);
      const x = Math.max(0, left);
      const y = Math.max(0, top);
      const w = Math.min(this.width, Math.round(flat[i] + flat[i + 2])) - x;
      const h = Math.min(this.height, Math.round(flat[i + 1] + flat[i + 3])) - y;
      if (w <= 0 || h <= 0) continue;
      rects.push(x, y, w, h);
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x + w > x1) x1 = x + w;
      if (y + h > y1) y1 = y + h;
    }
    if (!disjointRects(rects)) return false;
    const style = this._backgroundPicture;
    if (!prepareStyle(style, this._m, this.width, this.height)) return true;
    // the box they cover, on the surface: nothing outside it is sampled
    const bx = Math.max(0, x0);
    const by = Math.max(0, y0);
    const bw = Math.min(this.width, x1) - bx;
    const bh = Math.min(this.height, y1) - by;
    if (!(bw > 0 && bh > 0)) return true;
    this._ensureFillMask();
    const mask = this.fillMask.id;
    R.FillRectangles(R.PictOp.Src, mask, [0, 0, 0, 0], [bx, by, bw, bh]);
    // stay under the server's maximum request size
    const chunk = 10000 * 4;
    for (let i = 0; i < rects.length; i += chunk) {
      R.FillRectangles(
        R.PictOp.Src,
        mask,
        [0, 0, 0, this.globalAlpha < 1 ? this.globalAlpha : 1],
        i === 0 && rects.length <= chunk ? rects : rects.slice(i, i + chunk),
      );
    }
    R.Composite(
      R.PictOp.In,
      this._requireClipMask().id,
      0,
      mask,
      bx,
      by,
      0,
      0,
      bx,
      by,
      bw,
      bh,
    );
    const [ox, oy] = sourceOrigin(style);
    R.Composite(
      op,
      style.id,
      mask,
      this._dst(),
      bx - ox,
      by - oy,
      bx,
      by,
      bx,
      by,
      bw,
      bh,
    );
    this._markDirty();
    return true;
  }

  strokeRect(x, y, w, h) {
    if (!finiteRect(x, y, w, h)) return;
    if (w < 0) {
      x += w;
      w = -w;
    }
    if (h < 0) {
      y += h;
      h = -h;
    }
    if (this._shadowed()) this._shadowOfRect(x, y, w, h, true);
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
    if (this._shadowed()) this._shadowOfPath(args, false);
    if (this._tryRoundRectFill(args)) return;
    const { polys, rule } = this._polysFor(args);
    this._fillPolys(polys, rule);
  }

  stroke(...args) {
    if (this._shadowed()) this._shadowOfPath(args, true);
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
    if (this._hasPolyClip) return this._shapeMiss("clip-mask");
    const clip = this._clipRect();

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
    if (this._hasPolyClip) return this._shapeMiss("clip-mask");
    const clip = this._clipRect();

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
    if (clip) this._setPictureClip(clip);
    if (corners.length) {
      const page = getShapeGlyphPage(app);
      page.ensure(corners);
      const items = [];
      for (const spec of corners) {
        const e = page.entry(spec.key);
        items.push({
          gs: e.gs,
          lid: e.lid,
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
        this._dst(),
        0,
        encoded.gsid,
        items[0].x,
        items[0].y,
        encoded.elts,
      );
      trimShapeGlyphs(app);
    }
    if (rects.length) {
      R.FillRectangles(R.PictOp.Over, this._dst(), color, rects);
    }
    if (clip) this._invalidatePictureClip();
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
    // A rectangle of no area is still one, and clips everything: what a box
    // of no height clips its content to, a menu at `max-height: 0`. Taken
    // for a path, it built the mask the size of the surface, and every
    // rectangle clipped inside it was intersected into that mask; the
    // intersection of an empty one is empty, and every consumer draws
    // nothing through that, as where two rectangles do not meet.
    if (!(w > 0 && h > 0)) {
      return Number.isFinite(w) && Number.isFinite(h)
        ? { x: 0, y: 0, w: 0, h: 0 }
        : null;
    }
    // Server clip rectangles are integers, so a fractional edge could only
    // be honoured by rounding — which would differ from the mask path's
    // antialiased edge by up to a pixel. Rare, so leave those to the mask
    // rather than quietly changing what they look like.
    if (![x, y, w, h].every(isIntegral)) return null;
    return {
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h),
    };
  }

  /**
   * Intersection of the rectangular part of the clip stack, or null when
   * there is none — either because the stack is empty or because something
   * in it is not a rectangle, and then the a8 mask owns the whole stack.
   *
   * Region entries are transparent here. They are not rectangles and never
   * become one: the picture carries them, which is a different slot from
   * this and composes with it (see _setPictureClip).
   */
  _clipRect() {
    if (this._hasPolyClip) return null;
    let out = null;
    for (const entry of this._clips) {
      const r = entry.rect;
      if (!r) continue; // a region entry
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
    if (!out) return null;
    // clamp into the surface: the server rejects out-of-range rectangles
    const x = Math.max(0, Math.min(out.x, this.width));
    const y = Math.max(0, Math.min(out.y, this.height));
    const w = Math.max(0, Math.min(out.x + out.w, this.width) - x);
    const h = Math.max(0, Math.min(out.y + out.h, this.height) - y);
    return { x, y, w, h };
  }

  /**
   * The box the clip stack lets anything through, in device pixels on the
   * surface: the intersection of its rectangles and of its paths' bounding
   * boxes. Null when the stack holds no shape — region entries are the
   * picture's, as in `_clipRect` — and an empty box when it holds a path
   * that lands nowhere. What a drawing through the a8 mask is bounded to
   * (issue #372). Cached against the stack, which is replaced on every
   * change rather than edited.
   */
  _clipExtents() {
    if (this._extentsOf === this._clips) return this._extents;
    let out = null;
    for (const entry of this._clips) {
      if (entry.region) continue;
      const box = entry.rect ?? (entry.bbox ??= this._polysBBox(entry.polys));
      const next = box && (out ? intersectBox(out, box) : box);
      if (!next) {
        out = { x: 0, y: 0, w: 0, h: 0 };
        break;
      }
      out = next;
    }
    if (out) {
      const x = Math.max(0, Math.min(out.x, this.width));
      const y = Math.max(0, Math.min(out.y, this.height));
      const w = Math.max(0, Math.min(out.x + out.w, this.width) - x);
      const h = Math.max(0, Math.min(out.y + out.h, this.height) - y);
      out = { x, y, w, h };
    }
    this._extentsOf = this._clips;
    this._extents = out;
    return out;
  }

  /**
   * Replace the clip stack and re-derive what kinds of entry are in it.
   *
   * The two flags are what the drawing paths branch on, so they are computed
   * once per change rather than scanned per drawing — and the stack is only
   * ever replaced, never appended to in place, because save() hands the same
   * array to its snapshot.
   */
  _setClips(next) {
    this._clips = next;
    let poly = false;
    let region = false;
    for (const entry of next) {
      if (entry.region) region = true;
      else if (!entry.rect) poly = true;
    }
    this._hasPolyClip = poly;
    this._hasRegionClip = region;
  }

  clip(...args) {
    const { polys, rule } = this._polysFor(args);
    const entry = { polys, rule, rect: RenderingContext2d._rectOfPolys(polys) };
    // copy-on-write: earlier save() snapshots keep their own clip list
    this._setClips(this._clips.concat([entry]));

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
   * Intersect the clip with a server-side XFIXES region — a rectangle set the
   * X server owns, which is how X describes damage from an expose, a window's
   * SHAPE, or the area a compositor has left after subtracting the windows in
   * front of this one. `app.createRegion(rects)` makes one (lib/region.js).
   *
   * Scoped like `clip()`: `restore()` takes it off again, and nothing else
   * does. It intersects with rectangular and path clips in either order.
   *
   * The region is in **device pixels** and ignores the current transform —
   * unlike `clip()`, whose path goes through it. A region is a set of integer
   * rectangles, so there is no honest way to rotate or scale one; a caller who
   * wants it moved can `region.translate(dx, dy)`, which the server does.
   *
   * Unlike installing the region on `ctx.picture` yourself, this is a clip ntk
   * knows about: the fast paths that narrow the picture to a rectangle around
   * a glyph run or a fill restore *to* it afterwards, instead of overwriting
   * it with a full-plane rectangle (issue #292).
   *
   * @param {Region|number|{id: number}} region
   */
  clipRegion(region) {
    const id = regionId(region);
    const fixes = this._fixes || this.window.app._fixes;
    if (!fixes) throw needXFixesError();
    this._fixes = fixes;
    this._setClips(this._clips.concat([{ region: id }]));
    this._invalidatePictureClip();
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
    // region entries are the picture's clip, not the mask's business
    const shapes = this._clips.filter((entry) => !entry.region);
    if (!shapes.length) {
      R.FillRectangles(
        R.PictOp.Src,
        this.clipMask.id,
        [0, 0, 0, 1],
        [0, 0, this.width, this.height],
      );
      return;
    }
    const first = shapes[0];
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
    for (let i = 1; i < shapes.length; i++) this._intersectClip(shapes[i]);
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
      this._rasterizePolys(
        tmpMask,
        fillableShapes(entry.polys).shapes,
        entry.rule,
        -bb.x,
        -bb.y,
        bb.w,
        bb.h,
      );
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
    const { shapes, edges } = fillableShapes(entry.polys);
    if (!shapes.length) return false;
    // routed by the clip's own extent, as a fill is (`_rawBox`), and
    // rasterized over the part of it on the surface
    if (this._routeFor(this._polysExtent(entry.polys) ?? bb, edges) !== "local")
      return false;

    const coverage = rasterizer.rasterize({
      // what the AddTraps fallback in _applyPolyClip would send
      polys: this._wireShapes(shapes, -bb.x, -bb.y, bb.w, bb.h),
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
    // nothing to draw, and at globalAlpha 0 nothing to shape it for
    if (!text || this.globalAlpha <= 0) return;
    if (this._shadowed()) this._shadowOfText(text, x, y);
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
    // already device space: the anchor went through the matrix above, and
    // the offsets and advances added to it are device pixels
    this._drawGlyphsDevice(
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
  /**
   * Ink extents of a shaped run, relative to its origin: the loop behind
   * `measureText`'s actual bounding box, shared with the shadow path so a
   * shadowed `fillText` does not shape its text a second time to find out
   * how big its coverage surface has to be.
   */
  _shapedInk(shaped) {
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
    return { minX, maxX, minY, maxY };
  }

  measureText(text) {
    const style = this._resolvedTextStyle();
    const shaped = this.window.app.fonts.shape(String(text ?? ""), style);
    const { minX, maxX, minY, maxY } = this._shapedInk(shaped);
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
    const parsed = parseFontCached(val);
    if (!parsed) return;
    const style = {
      // the whole list, so a letter the first family lacks is set in the
      // next one the font names, as CSS sets it (`FontManager.match`)
      family: parsed.families.join(","),
      weight: parsed.weight,
      style: parsed.style,
      size: parsed.size,
      variations: this._fontVariations,
      opticalSizing: this._fontOpticalSizing,
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
   * CSS's `font-optical-sizing`: `'auto'` (the default) sets a face's `opsz`
   * axis at the size the text is drawn at, `'none'` leaves it wherever the
   * font file's default is.
   *
   * `'auto'` is what the CSS initial value has always been and what a
   * reader expects — small text set in the family's Text cut, headlines in
   * its Display cut — so this is the escape hatch, not the switch that
   * turns the feature on. Reach for it when the size the canvas is drawing
   * at is not the size the text is *read* at (a canvas scaled up by a
   * transform, glyphs measured for something else), and pin the axis with
   * `fontVariationSettings = { opsz: … }` when the answer is a specific
   * optical size rather than the file's default.
   *
   * Order-independent, like `fontVariationSettings`: setting it re-resolves
   * the face already in force.
   */
  set fontOpticalSizing(val) {
    this._fontOpticalSizing = val === "none" ? "none" : "auto";
    if (this._textStyle) this.font = this._lastFontString;
  }

  get fontOpticalSizing() {
    return this._fontOpticalSizing ?? "auto";
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
    // Every position and extent is a WebIDL `long`, as `| 0` makes one: NaN
    // and infinities are 0, a fraction goes toward 0. A fraction reached
    // the typed-array copies below and threw.
    x |= 0;
    y |= 0;
    dirtyX |= 0;
    dirtyY |= 0;
    dirtyWidth = dirtyWidth === undefined ? width : dirtyWidth | 0;
    dirtyHeight = dirtyHeight === undefined ? height : dirtyHeight | 0;
    // the spec normalises negative extents by moving the origin
    if (dirtyWidth < 0) {
      dirtyX += dirtyWidth;
      dirtyWidth = -dirtyWidth;
    }
    if (dirtyHeight < 0) {
      dirtyY += dirtyHeight;
      dirtyHeight = -dirtyHeight;
    }
    let sx = Math.max(0, dirtyX);
    let sy = Math.max(0, dirtyY);
    let sw = Math.min(width, dirtyX + dirtyWidth) - sx;
    let sh = Math.min(height, dirtyY + dirtyHeight) - sy;
    if (!(sw > 0) || !(sh > 0)) return;
    // and only the part the surface has: X takes the corner in 16 bits, and
    // image data put a million pixels away threw
    const left = Math.max(x + sx, 0);
    const top = Math.max(y + sy, 0);
    const right = Math.min(x + sx + sw, this.width);
    const bottom = Math.min(y + sy + sh, this.height);
    if (!(right > left) || !(bottom > top)) return;
    sx = left - x;
    sy = top - y;
    sw = right - left;
    sh = bottom - top;

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
  _beginDirectComposite(box) {
    const rect = this._clipRect();
    if (!rect) {
      // a poly clip is the only thing left that needs a mask; without one
      // there is nothing to apply here but the alpha. The mask it does need
      // is bounded to `box`, the destination box of the composite it is for
      // — the only pixels of it the server samples (issue #313).
      const mask = this._hasPolyClip
        ? this._compositeMask(box)
        : this._alphaMask();
      return { mask, clipped: false, empty: false };
    }
    if (rect.w === 0 || rect.h === 0)
      return { mask: 0, clipped: false, empty: true };
    this._setPictureClip(rect);
    return { mask: this._alphaMask(), clipped: true, empty: false };
  }

  _endDirectComposite(state) {
    if (!state.clipped) return;
    this._invalidatePictureClip();
  }

  /** The source colour for a coverage composite, with `globalAlpha` folded
   * into it. The mask slot is taken by the coverage, so the alpha has to go
   * somewhere — and a 1x1 solid is free, where a surface-sized alpha mask is
   * not. Falls back to the fill picture for gradients, which have no single
   * colour to fold into; `_drawCoverage` routes those through the scratch.
   *
   * All four components are scaled, not the alpha alone: the colour is
   * premultiplied, and one whose alpha shrank under unchanged components is
   * brighter than it can be — `#0000ff` at 0.5 over black came out
   * `#0000ff`, where `fillRect` draws `#000080`. */
  _coverageSource() {
    const style = this._fillStyle;
    if (this.globalAlpha >= 1 || !isPlainColor(style)) {
      return this._backgroundPicture;
    }
    const c = this._foldedColor(style);
    return this.createSolidPicture(c[0], c[1], c[2], c[3]);
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
    // Coverage the surface has none of is drawn as nothing. X takes the
    // destination's corner in 16 bits, and a shadow thrown past it — an
    // offset of 65,535, or text a million pixels away with its shadow —
    // threw out of the paint. A NaN destination fails the test too.
    if (!(dx < this.width && dy < this.height && dx + dw > 0 && dy + dh > 0)) return;
    const R = this.Render;
    // the coverage is painted in the current fillStyle, on both branches
    // below — a gradient/pattern whose transform collapsed paints nothing
    const style = this._backgroundPicture;
    if (!prepareStyle(style, this._m, this.width, this.height)) return;
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
      // the edge clamped, as drawImage's scaled path explains
      R.ChangePicture(picture.id, { repeat: 2 }); // Repeat.Pad
    }
    // with a transform in place the mask is already sampled from (sx, sy)
    const mx = scaled ? 0 : sx;
    const my = scaled ? 0 : sy;

    const rect = this._clipRect();
    // the mask slot can hold exactly one picture, so anything that cannot be
    // folded into the colour or handed to the server as a clip rectangle has
    // to be intersected into the scratch mask first
    const scratch =
      this._hasPolyClip ||
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
      if (this._hasPolyClip) {
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
        this._setPictureClip(rect);
      }
      // The scratch mask is surface-sized and surface-aligned — the coverage
      // went into it at (dx, dy) — so it is sampled at the destination
      // offset, and a gradient or pattern at that offset from its origin.
      // Reading the mask from (0, 0) draws a dw x dh window out of the wrong
      // part of a full-surface picture: the region just cleared to zero, so
      // nothing paints at all unless dx and dy are both zero.
      const [ox, oy] = sourceOrigin(style);
      R.Composite(
        op,
        style.id,
        this.fillMask.id,
        this._dst(),
        dx - ox,
        dy - oy,
        dx,
        dy,
        dx,
        dy,
        dw,
        dh,
      );
      if (rect) this._invalidatePictureClip();
    } else if (!rect || (rect.w > 0 && rect.h > 0)) {
      if (rect) this._setPictureClip(rect);
      // the source is a 1x1 repeating solid (offset irrelevant) or the fill
      // style, sampled at the destination's offset from its own origin,
      // exactly as in _fillPolys
      const src = this._coverageSource();
      const [ox, oy] = sourceOrigin(src);
      R.Composite(
        op,
        src.id,
        picture.id,
        this._dst(),
        dx - ox,
        dy - oy,
        mx,
        my,
        dx,
        dy,
        dw,
        dh,
      );
      if (rect) this._invalidatePictureClip();
    }

    if (scaled) {
      // restore defaults so the cached surface stays reusable as-is
      R.SetPictureTransform(picture.id, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
      picture.setFilter("nearest");
      R.ChangePicture(picture.id, { repeat: 0 }); // Repeat.None
    }
    this._markDirty();
  }

  /**
   * Draw an image, with the three canvas signatures:
   *
   *   ctx.drawImage(image, dx, dy)
   *   ctx.drawImage(image, dx, dy, dWidth, dHeight)
   *   ctx.drawImage(image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight)
   *
   * `image` is an ntk `Image` (see `loadImage()` — PNG/JPEG decoded
   * client-side, uploaded to the server once and composited from there), a
   * `Surface`, anything else with a size and a `picture(app)`, another
   * RenderingContext2d, or a node-canvas-like object. Every one of them is
   * drawn the same way: cropped, scaled server-side with bilinear filtering,
   * under the current transform, clipped, faded by `globalAlpha` and
   * composited with `globalCompositeOperation`.
   */
  drawImage(image, ...args) {
    // A context and a node-canvas are drawn from a picture of their pixels,
    // as a Surface is. A context used to be composited whole at (0, 0), with
    // Over, whatever the call asked for.
    if (image instanceof RenderingContext2d) {
      image = contextSource(image, this.window.app);
    } else if (!isPictureSource(image) && isCanvasLike(image)) {
      const source = this._canvasSource(image);
      try {
        this.drawImage(source, ...args);
      } finally {
        source.destroy();
      }
      return;
    }
    if (!isPictureSource(image)) return;
    const rects = imageRects(image, args);
    if (this._drawsFromCopy(image, rects)) {
      this._drawFromCopy(image, rects);
      return;
    }
    if (this._shadowed()) this._shadowOfImage(image, args);

    const [sx, sy, sw, sh, dx, dy, dw, dh] = rects;
    if (!(dw > 0) || !(dh > 0) || !(sw > 0) || !(sh > 0)) return;
    const app = this.window.app;
    const op = this._op();

    if (!matIsIdentity(this._m)) {
      this._drawImageTransformed(image, sx, sy, sw, sh, dx, dy, dw, dh, op);
      return;
    }

    if (image.format === "a8") {
      const picture = image.picture(app);
      this._drawCoverage(picture, sx, sy, sw, sh, dx, dy, dw, dh, op);
      return;
    }

    const state = this._beginDirectComposite({ x: dx, y: dy, w: dw, h: dh });
    if (state.empty) return;
    // only now that the clip has had its say: a node-canvas uploads here
    const picture = image.picture(app);
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
      // Bilinear sampling at the rim reads half a source pixel past the
      // image, and a picture's default repeat reads transparent there: an
      // upscaled image faded into whatever it was drawn over across its
      // outer pixels — three of them for a 15-pixel swatch drawn at 96.
      // The canvas spec's drawImage clamps to the image's edge, and so do
      // browsers; RepeatPad is that. Only on this axis-aligned path, whose
      // composite box is the destination rectangle exactly: under a
      // rotation the box is the bounding box, and pad would paint its
      // corners.
      this.Render.ChangePicture(picture.id, { repeat: 2 }); // Repeat.Pad
      this.Render.Composite(
        op,
        picture.id,
        mask,
        this._dst(),
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
      this.Render.ChangePicture(picture.id, { repeat: 0 }); // Repeat.None
    } else {
      this.Render.Composite(
        op,
        picture.id,
        mask,
        this._dst(),
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
  }

  /**
   * A node-canvas-like source as a picture source: its pixels are uploaded
   * on first use, which is after the clip has had its say, so a draw the clip
   * rejects uploads nothing (issue #307). `destroy()` frees the upload once
   * the composites that read it are queued — X executes requests in order, so
   * the server is done with it by the time it reads the frees.
   */
  _canvasSource(image) {
    const app = this.window.app;
    const { width, height } = image;
    let pixmap = null;
    let picture = null;
    return {
      width,
      height,
      picture: () => {
        if (picture) return picture;
        const imageData = image.context.getImageData(0, 0, width, height);
        // node-canvas hands over straight RGBA, and the rgba32 picture below
        // is premultiplied — this used to swap the channels and stop there,
        // which composited translucent images at full brightness
        const data = fromStraightRgba(
          imageData.data,
          pixelLayout(this.display, 32),
          width,
          height,
        );
        pixmap = new Pixmap(app, { depth: 32, width, height });
        picture = new Picture(app, {
          drawable: pixmap,
          format: this.Render.rgba32,
        });
        // One upload GC per app rather than one per call, the same sharing
        // Image.picture does: a GC is valid for any drawable of the same
        // screen and depth. This used to allocate a GC, a pixmap and a
        // picture every time and free none of them, so drawing a node-canvas
        // source in an animation loop leaked three server resources a frame.
        let gc = app._imageUploadGC;
        if (!gc) {
          gc = app._imageUploadGC = this.X.AllocID();
          this.X.CreateGC(gc, pixmap.id);
        }
        this.X.PutImage(2, pixmap.id, gc, width, height, 0, 0, 0, 32, data);
        return picture;
      },
      destroy: () => {
        picture?.destroy();
        pixmap?.destroy();
      },
    };
  }

  /**
   * Whether `drawImage` has to read a copy of the image rather than its
   * picture, because the picture holds pixels the draw must not read.
   *
   * Its own, first: the drawable this context draws into — the context
   * itself, another context on the same drawable, or a Surface drawn from
   * inside its own `render()`. A composite that reads the pixels it writes
   * sees its own output on the servers that work row by row — pixman, so
   * Xvfb and XQuartz, and glamor too, which hands a picture drawn onto its
   * own pixmap to pixman — and anything drawn lower than it was read from
   * came out smeared, each row read after a row above it had been written
   * there. A canvas draws from the pixels as they were before the call.
   *
   * Then a window's, past its edge: the backing pixmap is larger than the
   * window, and a draw that scales the image up, or puts it under a
   * transform, filters across the edge into the background colour there,
   * where the canvas clamps to the edge pixel (see the scaled path above).
   */
  _drawsFromCopy(image, rects) {
    const drawable = image instanceof Surface ? image.pixmap : image._drawable;
    if (!drawable) return false;
    if (drawable.id === this._target?.id) return true;
    const [, , sw, sh, , , dw, dh] = rects;
    const acrossEdge = dw > sw || dh > sh || !matIsIdentity(this._m);
    return (
      acrossEdge &&
      (drawable.width > image.width || drawable.height > image.height)
    );
  }

  /**
   * `drawImage` from a copy of the part of the image it reads: the source
   * rectangle and the pixel around it bilinear filtering reads, cut at the
   * image's edge. The copy is taken before a shadow is drawn, which would
   * otherwise land on the pixels it is a shadow of. It is argb32, which
   * holds any source of 8 bits a channel exactly, or a8 for coverage.
   */
  _drawFromCopy(image, rects) {
    const [sx, sy, sw, sh, dx, dy, dw, dh] = rects;
    if (!(dw > 0) || !(dh > 0) || !(sw > 0) || !(sh > 0)) return;
    const x0 = Math.max(0, Math.floor(sx) - 1);
    const y0 = Math.max(0, Math.floor(sy) - 1);
    const x1 = Math.min(image.width, Math.ceil(sx + sw) + 1);
    const y1 = Math.min(image.height, Math.ceil(sy + sh) + 1);
    if (!(x1 > x0 && y1 > y0)) return; // the crop holds none of the image
    const width = x1 - x0;
    const height = y1 - y0;
    const app = this.window.app;
    const R = this.Render;
    const coverage = image.format === "a8";
    const pixmap = new Pixmap(app, { depth: coverage ? 8 : 32, width, height });
    const picture = new Picture(app, {
      drawable: pixmap,
      format: coverage ? R.a8 : R.rgba32,
    });
    try {
      R.Composite(
        R.PictOp.Src,
        image.picture(app).id,
        0,
        picture.id,
        x0,
        y0,
        0,
        0,
        0,
        0,
        width,
        height,
      );
      const copy = {
        width,
        height,
        format: image.format,
        picture: () => picture,
      };
      this.drawImage(copy, sx - x0, sy - y0, sw, sh, dx, dy, dw, dh);
    } finally {
      // queued behind the composites that read it
      picture.destroy();
      pixmap.destroy();
    }
  }

  // general-affine drawImage: fold CTM + dest rect + source offset into the
  // source picture transform and composite over the transformed bbox
  _drawImageTransformed(image, sx, sy, sw, sh, dx, dy, dw, dh, op) {
    // maps source-local (u, v) in [0..sw)x[0..sh) to device coordinates
    const M = matMultiply(this._m, [dw / sw, 0, 0, dh / sh, dx, dy]);
    const inv = matInvert(M);
    if (!inv) return;
    // The inverse's linear part is how many source pixels one device pixel
    // steps across, and it goes on the wire as 16.16 fixed point. Past
    // 32,767 the image is drawn at under 1/32,768 of its size: less than a
    // pixel across for any image X can hold, and nothing to see.
    if (!fitsFixed(inv.slice(0, 4))) return;

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

    // Device -> source sample, measured from the bounding box's corner: the
    // corner's device position is folded into the transform, and the
    // composite's source origin is its box's offset from that corner. With
    // the source origin at device coordinates instead, the translation was
    // the device position times the downscale — a 50x30 thumbnail of a
    // 2000x1200 image at x 2,200 is 88,000, past what 16.16 carries, and
    // the encoder threw. From the corner it is the source coordinate the
    // corner samples: the image's own size or so, wherever on the surface it
    // is drawn. The corner is the unclipped one, so a clip that narrows the
    // box below samples the same points the mask route does.
    const [a, b, c, d] = inv;
    const e = a * x0 + c * y0 + inv[4] + sx;
    const f = b * x0 + d * y0 + inv[5] + sy;
    // A corner out of reach even so is a draw near the limit above, or an
    // image over 20,000 pixels across under a rotation; it is not drawn,
    // rather than thrown out of the paint.
    if (!fitsFixed([e, f])) return;

    // A rectangular clip shrinks the box instead of becoming a mask (issue
    // #307). Decided before the picture transform is installed, so a draw
    // the clip rejects does not have to put it back.
    const bbox = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const direct = this._boxedComposite(bbox, op);
    if (direct && !direct.box) return;
    const box = direct ? direct.box : bbox;

    const picture = image.picture(this.window.app);
    this.Render.SetPictureTransform(picture.id, [a, c, e, b, d, f, 0, 0, 1]);
    picture.setFilter("bilinear");
    this.Render.Composite(
      op,
      picture.id,
      direct ? direct.mask : this._compositeMask(box),
      this._dst(),
      box.x - x0,
      box.y - y0,
      box.x,
      box.y,
      box.x,
      box.y,
      box.w,
      box.h,
    );
    this.Render.SetPictureTransform(picture.id, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    picture.setFilter("nearest");
    this._markDirty();
  }
}

/**
 * The fill/stroke style the `create*Gradient` methods return: colour stops
 * along a line, between two circles, or around a point, backed by one
 * XRender gradient picture.
 *
 * Its coordinates are **user space**, like every other coordinate a caller
 * gives the context, and are resolved against the transform in force when
 * the gradient is *painted* — the picture transform is that CTM's inverse,
 * installed by `_sync` before each use, exactly as a pattern's is. A
 * gradient made for a node's own coordinates therefore keeps painting in
 * them after the context is translated to that node's origin (issue #271).
 *
 * The picture is created on first use and freed by the GC, through
 * `Picture`'s finalizer.
 */
/** How far from the origin a gradient's own points and radii may reach and
 *  still be carried in 16.16 fixed point, with room to spare. */
const GRADIENT_REACH = 16384;

class CanvasGradient {
  constructor(type, ctx, p0, p1, p2, p3, p4, p5) {
    this.type = type;
    this.stops = [];
    this.ctx = ctx;
    this._id = null;
    // how much smaller than asked the picture was made, to fit the wire
    this._scale = 1;
    this._picture = null;
    // what the server currently holds: a fresh gradient picture is
    // untransformed, so an untransformed fill costs no extra request
    this._applied = [1, 0, 0, 1, 0, 0];
    // the device point fills sample it from (`sourceOrigin`), set with the
    // transform it belongs with
    this._origin = NO_ORIGIN;

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

    // XRender takes a gradient's points and radii in 16.16 fixed point, and
    // a coordinate past 32,767 overflows the word it is written into. A
    // gradient that reaches further is made at a scale that fits, and
    // `_sync` scales the picture transform to match: the same colours land
    // on the same pixels.
    // Geometry that is not finite, which canvas refuses when the gradient
    // is made, is taken as 0 rather than thrown out of the paint using it.
    const f = (v) => (Number.isFinite(v) ? v : 0);
    const [x0, y0, x1, y1, r0, r1] = [this.x0, this.y0, this.x1, this.y1, this.r0, this.r1].map(f);
    let reach = Math.max(Math.abs(x0), Math.abs(y0));
    if (this.type !== "conical") reach = Math.max(reach, Math.abs(x1), Math.abs(y1));
    if (this.type === "radial") reach = Math.max(reach, Math.abs(r0), Math.abs(r1));
    const k = reach > GRADIENT_REACH ? reach / GRADIENT_REACH : 1;
    // the id is the gradient's only once the picture exists: one kept after
    // the request threw named a picture the server never made, in every
    // fill after it
    const id = X.AllocID();
    switch (this.type) {
      case "linear":
        Render.LinearGradient(
          id,
          [x0 / k, y0 / k],
          [x1 / k, y1 / k],
          this.stops,
        );
        break;
      case "radial":
        Render.RadialGradient(
          id,
          [x0 / k, y0 / k],
          [x1 / k, y1 / k],
          r0 / k,
          r1 / k,
          this.stops,
        );
        break;
      case "conical":
        Render.ConicalGradient(
          id,
          [x0 / k, y0 / k],
          f(this.angle),
          this.stops,
        );
        break;
      default:
        throw new Error("unknown gradient type");
    }
    this._id = id;
    this._scale = k;
    // Past the outermost stop a gradient clamps to that stop's colour, as
    // the canvas and CSS specs say — which is XRender's RepeatPad, not the
    // RepeatNone (transparent) a gradient picture is born with. Without it
    // an app has to place its gradient exactly on the fill or lose the
    // corners. The in-process JS server pads unconditionally, so only a real
    // server can tell the difference.
    Render.ChangePicture(this._id, { repeat: 2 }); // Repeat.Pad
    // wrap with picture so FreePicture is invoked on gc via FinalizationRegistry
    this._picture = new Picture(this.ctx.window.app, { id: this._id });
    return this._id;
  }

  /**
   * Make the server-side mapping match the CTM this paint runs under. The
   * gradient's own coordinates are user space and every fill samples the
   * source at device coordinates less `_origin`, so the picture transform —
   * which takes a source coordinate to a gradient one — is the CTM's
   * inverse, from that origin.
   *
   * Returns false when the CTM collapses (a zero scale), which paints
   * nothing, exactly as the canvas spec says.
   */
  _sync(ctm, width = 0, height = 0) {
    let inv = matInvert(ctm);
    if (!inv) return false;
    const id = this.id; // lazily creates the picture
    // a gradient made smaller to fit the wire (see `id`) is sampled that
    // much nearer its origin
    const k = this._scale;
    if (k !== 1) inv = inv.map((v) => v / k);
    // sampled from where user space's origin lands (`sourceOrigin`)
    const origin = originOn(ctm[4], ctm[5], width, height);
    inv = matMultiply(inv, [1, 0, 0, 1, origin[0], origin[1]]);
    // the transform is 16.16 fixed point too: one that cannot be carried
    // fills nothing, rather than throwing the rest of the paint away
    if (!fitsFixed(inv)) return false;
    this._origin = origin;
    const a = this._applied;
    if (
      inv[0] !== a[0] ||
      inv[1] !== a[1] ||
      inv[2] !== a[2] ||
      inv[3] !== a[3] ||
      inv[4] !== a[4] ||
      inv[5] !== a[5]
    ) {
      this.ctx.Render.SetPictureTransform(id, [
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
    return true;
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
    this._origin = NO_ORIGIN;
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
   * space less `_origin`) to a texel — so it is the inverse, from that
   * origin.
   *
   * Returns false when that composition collapses (a zero scale), which
   * paints nothing, exactly as the canvas spec says.
   */
  _sync(ctm, width = 0, height = 0) {
    const m = matMultiply(ctm, this._m);
    let inv = matInvert(m);
    if (!inv) return false;
    // sampled from where the tile's origin lands (`sourceOrigin`)
    const origin = originOn(m[4], m[5], width, height);
    inv = matMultiply(inv, [1, 0, 0, 1, origin[0], origin[1]]);
    // A tile that repeats is the same a whole number of tiles along, so the
    // translation — the texel the origin samples — is taken to the first
    // tile. A grid scrolled 100,000 pixels has its origin far off the
    // surface and samples texels 100,000 along; from the first tile they
    // are in reach of the wire.
    const period =
      this._repeat === 1 ? 1 : this._repeat === 3 ? 2 : 0; // Normal, Reflect
    if (period && this.width > 0 && this.height > 0) {
      const pw = this.width * period;
      const ph = this.height * period;
      inv[4] -= pw * Math.floor(inv[4] / pw);
      inv[5] -= ph * Math.floor(inv[5] / ph);
    }
    // 16.16 fixed point, as a gradient's is: one that cannot be carried
    // fills nothing rather than throwing the rest of the paint away
    if (!fitsFixed(inv)) return false;
    this._origin = origin;
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
