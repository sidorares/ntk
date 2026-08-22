// Rounded-rectangle fast path (issue #211): the server-side corner-glyph
// cache and the geometry helpers behind it.
//
// A recognized `fill()`/`stroke()` of an axis-aligned rounded rect is not
// rasterized as a polygon at all: its only curved ink — the corners — is
// emitted as XRender *glyphs* (the one path every server accelerates, cached
// server-side after first use), and the straight runs between them as
// FillRectangles. The 2d context owns the recognition and the emission
// (lib/renderingcontext_2d.js); this module owns the cache and the corner
// bitmaps.
//
// The pieces partition the pixels: corner glyphs own their integer-cut
// boxes, rects own the strips between, and no pixel is painted twice — which
// is what makes translucent colours safe with no mask format and no
// accumulation tricks. Each corner rasterizes the true geometry inside its
// region through the same ellipse lowering and coverage accumulator the
// polygon fallback uses, so the two routes agree to the last antialiased
// step.
//
// Corners are the whole cache: keyed by (kind, rx, ry, borderWidth, corner),
// so width and height are *not* in the key — an animating progress bar or
// pill keeps all its glyphs while the rects stretch. The server additionally
// deduplicates glyph bitmaps across clients by content hash, so every app
// using the same radii shares storage.
//
// Mirrored corners: only the top-left corner of a (kind, rx, ry, bw) family
// is ever rasterized; the other three are byte-level mirror flips of that
// bitmap (see `orientCorner`). RENDER has no per-glyph transform, so the
// *server* still needs all four bitmaps — the flip saves the three extra
// rasterizations and makes the four corners of a box pixel-exact mirror
// images of each other, which direct per-corner rasterization does not
// guarantee (floating-point coverage accumulation is not symmetric under
// reflection).

import GlyphSet from './glyphset.js';
import { ellipseSegments, flattenPath } from './path.js';
import { rasterizePolys } from './rasterize.js';
import { SHAPE_PAGE_TOKEN, sharedGlyphsFor } from './sharedglyphs.js';

/**
 * Shape rendering policy, overridable per app via `app.shapePolicy`
 * (partial objects are fine — `app.shapePolicy = { maxRadius: 0 }` disables
 * the fast path entirely, which is also what `NTK_NO_SHAPE_GLYPHS=1` does).
 *
 * - `maxRadius` — corners with a radius (or stroke-band extent) above this
 *   fall back to the polygon route. Glyph-atlas behaviour past ~64px is
 *   driver-specific; the conservative default keeps every plausible widget
 *   inside and every atlas happy.
 * - `cacheBytes` — budget for uploaded corner bitmaps per connection. A
 *   design system's whole population is 8 glyphs x r^2 bytes per (r, bw) —
 *   typically 10-20KB — so even this small budget is generous. Exceeding it
 *   (an adversarial animated-radius load) resets the page; steady states
 *   never do.
 */
export const DEFAULT_SHAPE_POLICY = {
  maxRadius: 64,
  cacheBytes: 256 << 10
};

const envDisabled =
  typeof process !== 'undefined' && process.env && process.env.NTK_NO_SHAPE_GLYPHS;

export function shapePolicyOf(app) {
  const policy = app.shapePolicy
    ? { ...DEFAULT_SHAPE_POLICY, ...app.shapePolicy }
    : DEFAULT_SHAPE_POLICY;
  return envDisabled ? { ...policy, maxRadius: 0 } : policy;
}

// corner codes, also the two flip bits: bit 0 = mirrored in x, bit 1 = in y
export const TL = 0;
export const TR = 1;
export const BL = 2;
export const BR = 3;

/** cache key of one corner glyph. `bw` is 0 for fills. */
export function cornerKey(kind, rx, ry, bw, corner) {
  return `${kind}|${rx}|${ry}|${bw}|${corner}`;
}

/**
 * Rasterize the top-left master bitmap of a corner family.
 *
 * kind 'fill': the quarter disc — the corner box is rx x ry with the ellipse
 * centred on its bottom-right point; everything inside the arc has full
 * coverage, so the box's straight cut edges land on interior pixels.
 *
 * kind 'stroke': the quarter ring — the stroke band around a corner of path
 * radius `r = rx` with line width `bw`. The box is K x K, K = ceil(r + bw/2),
 * anchored on the *outer* corner of the band; the ink is the annulus sector
 * plus the straight band continuations out to the box edges, so the box
 * edges cut the band where its pixels are fully covered whatever half-pixel
 * the arc ends on (a 1px border's path sits on half-integers).
 *
 * The arc is lowered exactly the way the polygon fallback lowers it —
 * `ellipseSegments` cubics flattened by `flattenPath` at the default
 * tolerance, rasterized by the same coverage accumulator — so the fast path
 * agrees with the fallback to the last antialiased step.
 *
 * @returns {{ w, h, stride, data: Uint8Array }} unpadded w x h coverage
 */
export function rasterizeCornerMaster(kind, rx, ry, bw) {
  let w;
  let h;
  let cmds;
  if (kind === 'fill') {
    w = rx;
    h = ry;
    const arc = ellipseSegments(rx, ry, rx, ry, 0, Math.PI, Math.PI * 1.5);
    cmds = [
      { type: 'M', x: arc.start.x, y: arc.start.y }, // (0, ry)
      ...arc.cmds, // -> (rx, 0)
      { type: 'L', x: rx, y: ry },
      { type: 'Z' }
    ];
  } else {
    const r = rx;
    const ro = r + bw / 2;
    const ri = r - bw / 2;
    const K = Math.ceil(ro);
    w = K;
    h = K;
    const outer = ellipseSegments(ro, ro, ro, ro, 0, Math.PI, Math.PI * 1.5);
    // the inner arc runs backwards, closing the ring; at ri = 0 it collapses
    // to the centre point and the ink is the whole quarter disc
    const inner = ellipseSegments(ro, ro, ri, ri, 0, Math.PI * 1.5, Math.PI, true);
    cmds = [
      { type: 'M', x: 0, y: K },
      { type: 'L', x: 0, y: ro },
      ...outer.cmds, // -> (ro, 0)
      { type: 'L', x: K, y: 0 },
      { type: 'L', x: K, y: bw },
      { type: 'L', x: inner.start.x, y: inner.start.y }, // (ro, bw)
      ...inner.cmds, // -> (bw, ro)
      { type: 'L', x: bw, y: K },
      { type: 'Z' }
    ];
  }
  const polys = [];
  for (const poly of flattenPath(cmds)) if (poly.pts.length >= 6) polys.push(poly.pts);
  const data = rasterizePolys(polys, w, h, 'nonzero');
  return { w, h, stride: (w + 3) & ~3, data };
}

/**
 * One oriented corner bitmap from the top-left master: a byte-level mirror
 * flip, padded to the 4-byte row stride AddGlyphs wants. Flipping bytes
 * rather than re-rasterizing mirrored geometry keeps the four corners exact
 * mirror images and costs a copy instead of a coverage accumulation.
 */
export function orientCorner(master, corner) {
  const { w, h, stride, data } = master;
  const out = Buffer.alloc(stride * h);
  const flipX = (corner & 1) !== 0;
  const flipY = (corner & 2) !== 0;
  for (let y = 0; y < h; y++) {
    const srow = (flipY ? h - 1 - y : y) * w;
    const orow = y * stride;
    if (flipX) {
      for (let x = 0; x < w; x++) out[orow + x] = data[srow + (w - 1 - x)];
    } else {
      out.set(data.subarray(srow, srow + w), orow);
    }
  }
  return out;
}

/** a fresh AddGlyphs object per call — node-x11 mutates its input; the
 *  oriented bitmap buffer itself is never written to and can be retained */
function uploadCorner(lid, image, stride, height) {
  return {
    id: lid,
    // width is the padded stride, like the text page: node-x11 then
    // ships the buffer as-is instead of re-padding a copy, and the spare
    // zero columns composite as no-ops under Over
    width: stride,
    height,
    // x/y 0: the glyph's top-left lands exactly on its elt position
    x: 0,
    y: 0,
    // corners do not advance a pen. node-x11 expects offX/offY in 26.6
    // fixed point and mutates the objects it is given, which is why
    // these are fresh one-shot objects (see AGENTS.md)
    offX: 0,
    offY: 0,
    image
  };
}

/**
 * Server-side cache of corner glyphs — one page per app, all radii and
 * border widths together, mirroring `GlyphPage` for text (text/glyphs.js).
 *
 * Local ids are compact and sequential so CompositeGlyphs uses the 8-bit
 * encoding for the first 256 distinct corners (a shape population never
 * leaves it in practice); new corners upload lazily in one AddGlyphs batch
 * per draw that introduces any — and, when the display's shared glyph
 * directory is live (docs/shared-glyphs.md), re-bind to the display-wide
 * corner page so every ntk app shares four glyphs per (radius, band width).
 */
export class ShapeGlyphPage {
  constructor(app) {
    this.app = app;
    // private from birth when shared glyphs are off; minted lazily when on
    // (a page resolving entirely from the directory never creates one) —
    // exactly the arrangement GlyphPage has (text/glyphs.js)
    this.glyphset = sharedGlyphsFor(app) ? null : new GlyphSet(app);
    this.entries = new Map(); // cornerKey -> { lid, gs }
    this.bytes = 0; // privately uploaded bitmap bytes, for the cache budget
    this._lids = 0; // next private lid
    this._maxLid = -1; // widest id this page composites, private or shared
    this._privateCount = 0; // entries still bound to the private set
    this._shared = undefined; // SharedPage binding, resolved on first ensure
  }

  /** bits per glyph id needed to address this page */
  get bits() {
    return this._maxLid > 255 ? 16 : 8;
  }

  /**
   * Ensure the corners of one drawing are uploaded. `specs` is
   * [{ key, kind, rx, ry, bw, corner }] — a spec whose key is present costs
   * a Map hit and nothing else. Within one batch the top-left master of each
   * (kind, rx, ry, bw) family rasterizes once and the other corners mirror
   * it (see `orientCorner`).
   *
   * With the shared directory live, new corners are also asked about — the
   * `cornerKey()` string goes on the wire verbatim as the member key
   * (docs/shared-glyphs.md) — and their entries re-bind to the display-wide
   * page on the reply, so every ntk app's boxes of one radius share four
   * glyphs per (r, bw) across the whole display.
   */
  ensure(specs) {
    let batch = null;
    let masters = null;
    let ask = null;
    const shared = this._sharedBinding();
    for (const spec of specs) {
      if (this.entries.has(spec.key)) continue;
      const lid = this._lids++;
      if (lid >= 65536) {
        // 2^16 corners on one connection — unreachable (the cache budget
        // resets the page long before), but fail loudly rather than corrupt
        throw new Error('shape glyph page overflow');
      }
      const mkey = `${spec.kind}|${spec.rx}|${spec.ry}|${spec.bw}`;
      if (!masters) masters = new Map();
      let master = masters.get(mkey);
      if (!master) {
        master = rasterizeCornerMaster(spec.kind, spec.rx, spec.ry, spec.bw);
        masters.set(mkey, master);
      }
      const image = orientCorner(master, spec.corner);
      if (!this.glyphset) this.glyphset = new GlyphSet(this.app);
      if (lid > this._maxLid) this._maxLid = lid;
      this.entries.set(spec.key, { lid, gs: this.glyphset.id, private: true });
      this._privateCount++;
      if (!batch) batch = [];
      batch.push(uploadCorner(lid, image, master.stride, master.h));
      this.bytes += image.length;
      if (shared && shared.open) {
        if (!ask) ask = [];
        ask.push({ key: spec.key, payload: { image, stride: master.stride, height: master.h } });
      }
    }
    if (batch) this.glyphset.addGlyphs(batch);
    if (ask) shared.ask(ask);
  }

  entry(key) {
    return this.entries.get(key);
  }

  /** the shared side of this page; null when the feature is off */
  _sharedBinding() {
    if (this._shared !== undefined) return this._shared;
    const client = sharedGlyphsFor(this.app);
    this._shared = client
      ? client.bindPage({
          token: SHAPE_PAGE_TOKEN,
          indices: false, // member keys are cornerKey() strings, verbatim
          makeGlyph: (key, payload, lid) =>
            uploadCorner(lid, payload.image, payload.stride, payload.height),
          adopt: (key, lid, gsid) => this._adoptShared(key, lid, gsid)
        })
      : null;
    return this._shared;
  }

  /** re-bind one corner to the shared set; drop the private set once
   *  nothing composites from it any more */
  _adoptShared(key, lid, gsid) {
    const prev = this.entries.get(key);
    this.entries.set(key, { lid, gs: gsid });
    if (lid > this._maxLid) this._maxLid = lid;
    if (prev && prev.private && --this._privateCount === 0 && this.glyphset) {
      this.glyphset.destroy();
      this.glyphset = null;
      this.bytes = 0;
      this._lids = 0;
    }
  }

  /** free the server-side glyphset and shared alias (budget reset / shutdown) */
  destroy() {
    if (this.glyphset) this.glyphset.destroy();
    this.glyphset = null;
    if (this._shared) this._shared.destroy();
    this._shared = undefined;
    this.entries.clear();
    this.bytes = 0;
    this._lids = 0;
    this._maxLid = -1;
    this._privateCount = 0;
  }
}

/** the per-app page, created on first use */
export function getShapeGlyphPage(app) {
  if (!app._shapeGlyphPage) app._shapeGlyphPage = new ShapeGlyphPage(app);
  return app._shapeGlyphPage;
}

/**
 * Enforce the cache budget after a draw. Corner populations are so small
 * that per-glyph LRU would be bookkeeping for its own sake — over budget
 * (an adversarial animated-radius load) the whole page resets and the
 * corners still in use re-upload on the next draw, bounding server memory
 * at `cacheBytes` plus one animation step. FreeGlyphSet is queued after any
 * CompositeGlyphs already issued, so mid-frame resets are ordering-safe.
 */
export function trimShapeGlyphs(app, policy = shapePolicyOf(app)) {
  const page = app._shapeGlyphPage;
  if (page && page.bytes > policy.cacheBytes) {
    page.destroy();
    app._shapeGlyphPage = null;
  }
}

/**
 * The strips of a rounded-rect fill that are not corner glyphs, as a flat
 * FillRectangles list. Rows are cut at every corner-box edge; each band
 * spans between the corner boxes that reach it. Uniform radii produce the
 * classic 3 bands; fully general per-corner radii at most 5.
 *
 * `c` holds the effective corner box sizes { tlw, tlh, trw, trh, blw, blh,
 * brw, brh } (zero for square corners). Caller guarantees same-edge sums fit
 * (normalizeRadii does) and that diagonally opposite boxes do not overlap.
 */
export function roundRectBandRects(x, y, w, h, c) {
  const cuts = [...new Set([0, c.tlh, c.trh, h - c.blh, h - c.brh, h])]
    .filter((v) => v >= 0 && v <= h)
    .sort((a, b) => a - b);
  const rects = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const y0 = cuts[i];
    const y1 = cuts[i + 1];
    if (y1 <= y0) continue;
    const left = Math.max(y0 < c.tlh ? c.tlw : 0, y1 > h - c.blh ? c.blw : 0);
    const right = Math.max(y0 < c.trh ? c.trw : 0, y1 > h - c.brh ? c.brw : 0);
    const bandW = w - left - right;
    if (bandW > 0) rects.push(x + left, y + y0, bandW, y1 - y0);
  }
  return rects;
}

// process-wide observability: every bail-out is a silent perf cliff, so the
// counters are always collected (cheap increments) and printed at exit under
// NTK_DEBUG_SHAPES=1. Contexts carry their own copies for per-surface
// inspection (ctx.shapeStats).
export const shapeGlyphCounters = { hits: 0, misses: {} };

export function countShapeMiss(reason) {
  shapeGlyphCounters.misses[reason] = (shapeGlyphCounters.misses[reason] || 0) + 1;
}

export function countShapeHit() {
  shapeGlyphCounters.hits++;
}

if (
  typeof process !== 'undefined' &&
  process.env &&
  process.env.NTK_DEBUG_SHAPES &&
  typeof process.on === 'function'
) {
  process.on('exit', () => {
    const { hits, misses } = shapeGlyphCounters;
    const parts = Object.entries(misses).map(([k, v]) => `${k}: ${v}`);
    console.error(
      `ntk shapes: ${hits} fast-path draws, misses { ${parts.join(', ')} }`
    );
  });
}
