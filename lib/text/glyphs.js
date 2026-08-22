import GlyphSet from '../glyphset.js';
import Picture from '../picture.js';
import Pixmap from '../pixmap.js';
import { fontPageToken, sharedGlyphsFor } from '../sharedglyphs.js';
import { trapezoidize } from '../trapezoid.js';

/**
 * Text rendering policy — the bitmap/vector routing thresholds and the
 * server-side glyph cache budget. Override per app via `app.textPolicy`
 * (partial objects are fine, e.g. `app.textPolicy = { vectorFrom: Infinity }`
 * to opt out of the vector path entirely). See docs/text.md.
 *
 * - `bitmapMax` — at or below this pixel size glyphs always render through
 *   cached server-side bitmaps (upload once, ~1 byte per glyph per draw).
 * - `vectorFrom` — above this size glyphs render as trapezoids every draw:
 *   bitmap uploads scale with size² (a full Latin set at 256px is ~2.4MB of
 *   server cache per face) while outlines scale with ~√size.
 * - Between the two, bitmaps are used unless the size is fractional or the
 *   face shows no size reuse across recent draws (continuous zoom/pinch
 *   animation) — the cases where per-size caches never amortize.
 * - `cacheBytes` — LRU budget for uploaded glyph bitmaps per connection;
 *   least-recently-drawn (face, size) pages are freed server-side
 *   (FreeGlyphSet) so transient sizes don't accumulate.
 * - `textRendering` — an app-wide default for the per-run property of the
 *   same name (see `routeForRendering`). Left undefined the thresholds
 *   decide, which is what almost every app wants; `'geometricPrecision'`
 *   here is the blunt instrument for a window that is all display text.
 *   A run that names its own always wins.
 */
export const DEFAULT_TEXT_POLICY = {
  bitmapMax: 128,
  vectorFrom: 256,
  cacheBytes: 8 << 20,
  textRendering: undefined
};

function policyOf(app) {
  return app.textPolicy ? { ...DEFAULT_TEXT_POLICY, ...app.textPolicy } : DEFAULT_TEXT_POLICY;
}

/** a fresh AddGlyphs object — fresh per call because node-x11 mutates what
 *  it is given (pads rows, divides offX by 64); the source bitmap survives */
function uploadGlyph(lid, bitmap, adv) {
  return {
    id: lid,
    width: bitmap ? bitmap.width : 0,
    height: bitmap ? bitmap.height : 0,
    // XRender GLYPHINFO places the image at origin - (x, y); node-x11
    // packs -x and +y, so x here is the bitmap's left bearing and y its
    // (negated, y-down) top — i.e. the ascent above the baseline
    x: bitmap ? bitmap.left : 0,
    y: bitmap ? -bitmap.top : 0,
    // node-x11 AddGlyphs expects 26.6 fixed point and divides by 64
    offX: adv * 64,
    offY: 0,
    image: bitmap ? bitmap.data : Buffer.alloc(0)
  };
}

/**
 * Server-side glyph cache for one (font face, pixel size) pair.
 *
 * Wire-efficiency design (see docs/text.md):
 *
 * - Glyph ids inside an XRender glyphset are client-assigned. We assign
 *   **compact sequential ids** (0, 1, 2, …) in upload order instead of using
 *   font glyph indices, so CompositeGlyphs can use the 8-bit encoding
 *   (1 byte per glyph) for the first 256 distinct glyphs of a face/size —
 *   which covers virtually all Latin text — and 16-bit after that.
 * - Each glyph's rounded nominal advance is baked into the glyph itself
 *   (`offX`), so the server advances the pen automatically and runs of
 *   unkerned text need no per-glyph position data at all.
 * - Bitmaps upload lazily, once per glyph, batched into one AddGlyphs
 *   request per draw that introduces new glyphs — and, when the display's
 *   shared glyph directory is live (docs/shared-glyphs.md), re-bind to the
 *   display-wide set so other ntk processes skip the work entirely.
 */
export class GlyphPage {
  constructor(app, font, size) {
    this.app = app;
    this.font = font;
    this.size = size;
    // With shared glyphs off this page is exactly what it always was: a
    // private set from birth. With them on, the set is minted lazily — a
    // page that resolves entirely from the directory never creates one.
    this.glyphset = sharedGlyphsFor(app) ? null : new GlyphSet(app);
    this.entries = new Map(); // font glyph id -> { lid, adv, gs }
    this.bytes = 0; // privately uploaded bitmap bytes, for the LRU budget
    this._lids = 0; // next private lid (dense, upload order)
    this._maxLid = -1; // widest id this page composites, private or shared
    this._privateCount = 0; // entries still bound to the private set
    this._shared = undefined; // SharedPage binding, resolved on first ensure
  }

  /** number of bits per glyph needed to address this page's ids */
  get bits() {
    return this._maxLid > 255 ? 16 : 8;
  }

  /**
   * Ensure all glyphs of a shaped run are drawable; returns nothing.
   *
   * New glyphs are rasterized and sent in a single AddGlyphs request to the
   * page's private set — this draw's pixels never wait on anything. When the
   * shared directory is live they are also asked about (docs/shared-glyphs.md):
   * the reply re-binds their entries to the display-wide set — uploading the
   * retained bitmap only when this process was first to need the glyph — and
   * once nothing private remains the private set is freed. Every later draw
   * of those glyphs, in this process and every other, is then pure
   * CompositeGlyphs. A page that wants the shared entries *before* first
   * paint warms up front: see `warmSharedGlyphs`.
   */
  ensure(glyphs) {
    let batch = null;
    let ask = null;
    const shared = this._sharedBinding();
    for (const g of glyphs) {
      if (this.entries.has(g.id)) continue;
      const lid = this._lids++;
      if (lid >= 65536) {
        // 2^16 distinct glyphs at one size — not reachable in practice
        // (fonts cap at 65535 glyphs) but fail loudly rather than corrupt
        throw new Error('glyph page overflow');
      }
      const adv = Math.round(this.font.advanceOf(g.id, this.size));
      const bitmap = this.font.rasterize(g.id, this.size);
      if (!this.glyphset) this.glyphset = new GlyphSet(this.app);
      if (lid > this._maxLid) this._maxLid = lid;
      this.entries.set(g.id, { lid, adv, gs: this.glyphset.id, private: true });
      this._privateCount++;
      if (!batch) batch = [];
      batch.push(uploadGlyph(lid, bitmap, adv));
      this.bytes += bitmap ? bitmap.data.length : 0;
      if (shared && shared.open) {
        if (!ask) ask = [];
        ask.push({ key: g.id, payload: { bitmap, adv } });
      }
    }
    if (batch) this.glyphset.addGlyphs(batch);
    if (ask) shared.ask(ask);
  }

  entry(fontGlyphId) {
    return this.entries.get(fontGlyphId);
  }

  /** the shared side of this page, bound on first use; null when the
   *  feature is off or the font's bytes cannot be content-addressed */
  _sharedBinding() {
    if (this._shared !== undefined) return this._shared;
    const client = sharedGlyphsFor(this.app);
    const token = client ? fontPageToken(this.font, this.size) : null;
    this._shared = token
      ? client.bindPage({
          token,
          indices: true, // member keys are the font glyph indices themselves
          makeGlyph: (key, payload, lid) => {
            // absent from the shared set: upload the bitmap retained at
            // mint time, or rasterize now on the warm path (which retained
            // nothing precisely because the glyph was expected to be there)
            const bitmap =
              payload.bitmap !== undefined ? payload.bitmap : this.font.rasterize(key, this.size);
            return uploadGlyph(lid, bitmap, payload.adv);
          },
          adopt: (key, lid, gsid, payload) => this._adoptShared(key, lid, gsid, payload)
        })
      : null;
    return this._shared;
  }

  /** re-bind one glyph to the shared set (confirmed present, or uploaded by
   *  us); drop the private set once nothing composites from it any more */
  _adoptShared(key, lid, gsid, payload) {
    const prev = this.entries.get(key);
    this.entries.set(key, { lid, adv: payload.adv, gs: gsid });
    if (lid > this._maxLid) this._maxLid = lid;
    if (prev && prev.private && --this._privateCount === 0 && this.glyphset) {
      // ordered after any CompositeGlyphs already issued, like the LRU's
      // frees; new glyphs during a directory outage mint a fresh set
      this.glyphset.destroy();
      this.glyphset = null;
      this.bytes = 0;
      this._lids = 0;
    }
  }

  /** free the server-side glyphset and shared alias (LRU eviction / shutdown) */
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

/** per-app page cache: pages (and their server glyphsets) are shared by all
 *  windows/pixmaps of a connection. Access refreshes LRU order. */
export function getGlyphPage(app, font, size) {
  if (!app._glyphPages) app._glyphPages = new Map();
  const key = `${font.key}@${size}`;
  let page = app._glyphPages.get(key);
  if (page) {
    // Map iteration order is insertion order — re-insert to mark recent
    app._glyphPages.delete(key);
  } else {
    page = new GlyphPage(app, font, size);
  }
  app._glyphPages.set(key, page);
  return page;
}

/**
 * Warm one (font, size) page from the shared glyph directory before first
 * paint (docs/shared-glyphs.md): resolve `text`'s glyphs into shared-set
 * entries so that the first draw of already-shared text rasterizes nothing
 * and uploads nothing — the cold-start win a synchronous first `fillText`
 * cannot have, since it cannot wait for the directory's answer and falls
 * back to a private upload for exactly one frame instead.
 *
 * Glyphs the directory has never seen are rasterized here and uploaded once,
 * which is the same work the first draw would have done. Resolves `true`
 * when the page ended up bound to the shared cache; `false` means the
 * feature is off or degraded and drawing will use the private path — either
 * way the following draws are correct.
 *
 * @param {App} app
 * @param {Font} font
 * @param {number} size pixel size
 * @param {string} text whose glyphs to warm (shaped with defaults)
 * @returns {Promise<boolean>}
 */
export async function warmSharedGlyphs(app, font, size, text) {
  if (!sharedGlyphsFor(app)) return false;
  const page = getGlyphPage(app, font, size);
  const shared = page._sharedBinding();
  if (!shared || !shared.open) return false;
  const ask = [];
  const seen = new Set();
  for (const g of font.shape(String(text), size).glyphs) {
    if (page.entries.has(g.id) || seen.has(g.id)) continue;
    seen.add(g.id);
    ask.push({ key: g.id, payload: { adv: Math.round(font.advanceOf(g.id, size)) } });
  }
  if (ask.length) await shared.ask(ask);
  return shared.open && shared.bound;
}

/**
 * Evict least-recently-used glyph pages until uploaded bitmaps fit the
 * policy budget. `inUse` pages (referenced by requests queued this draw)
 * are never evicted. Freeing is safe request-ordering-wise: FreeGlyphSet is
 * queued after any CompositeGlyphs already issued on this connection.
 */
export function trimGlyphPages(app, policy = policyOf(app), inUse = null) {
  const pages = app._glyphPages;
  if (!pages) return;
  let total = 0;
  for (const page of pages.values()) total += page.bytes;
  for (const [key, page] of pages) {
    if (total <= policy.cacheBytes) break;
    if (inUse && inUse.has(page)) continue;
    pages.delete(key);
    total -= page.bytes;
    page.destroy();
  }
}

const MAX_ELT_GLYPHS = 254; // 255 is the glyphset-switch marker

/**
 * Encode positioned glyphs into a minimal CompositeGlyphs elt list.
 *
 * `items` are visual-order glyphs with absolute integer device positions:
 *   { gs: glyphsetId, lid: localGlyphId, adv: storedIntAdvance, x, y }
 *
 * The encoder tracks the server-side pen (which auto-advances by each
 * glyph's stored `adv`) and emits position data only when the desired
 * position deviates from it — i.e. at the start, on kerning/mark offsets,
 * on subpixel-rounding drift, and at glyphset switches. Plain text costs
 * 1 byte per glyph (8-bit ids) plus a single 8-byte elt header.
 *
 * @returns {{ gsid, bits, elts }|null} arguments for Render.CompositeGlyphs;
 *   elts strings ride on the initial pen, arrays are [dx, dy, string],
 *   numbers switch glyphsets (node-x11 wire format). Null when empty.
 */
export function encodeGlyphItems(items, bits) {
  if (items.length === 0) return null;
  const elts = [];
  const gsid = items[0].gs;
  let curGs = gsid;
  let penX = 0;
  let penY = 0;
  let cur = null; // { dx, dy, str }

  for (const item of items) {
    if (item.gs !== curGs) {
      if (cur) {
        elts.push([cur.dx, cur.dy, cur.str]);
        cur = null;
      }
      elts.push(item.gs);
      curGs = item.gs;
    }
    if (!cur || item.x !== penX || item.y !== penY || cur.str.length >= MAX_ELT_GLYPHS) {
      if (cur) elts.push([cur.dx, cur.dy, cur.str]);
      cur = { dx: item.x - penX, dy: item.y - penY, str: '' };
      penX = item.x;
      penY = item.y;
    }
    cur.str += String.fromCharCode(item.lid);
    penX += item.adv;
  }
  if (cur) elts.push([cur.dx, cur.dy, cur.str]);
  return { gsid, bits, elts };
}

/**
 * Compute device positions for shaped runs — the single source of truth for
 * where each glyph's origin lands, shared by the renderer and by tests that
 * verify server output pixel-by-pixel.
 *
 * `positioned` is an array of { run, x, y } where `run` comes from
 * Font.shape()/shapeText() (already in visual order) and x/y is the run's
 * baseline origin in device space.
 *
 * @returns {Array<{run, glyph, x, y}>} integer glyph-origin positions
 */
export function positionGlyphs(positioned) {
  const out = [];
  for (const { run, x, y } of positioned) {
    let cursor = x;
    for (const g of run.glyphs) {
      out.push({ run, glyph: g, x: Math.round(cursor + g.dx), y: Math.round(y - g.dy) });
      cursor += g.ax;
    }
  }
  return out;
}

/**
 * Ink extents of positioned runs, in whatever coordinates their origins are
 * given in — the union of every glyph's bounding box, laid out exactly as
 * `positionGlyphs` lays it out (pen at `x`, glyph at `pen + dx`, `y - dy`,
 * pen advanced by `ax`).
 *
 * Returns `null` when nothing inks: a run of spaces has extents but no
 * bounding box, and neither does an empty array. Blank glyphs report an
 * empty `cbox` (`minX` infinite), which the comparisons below drop on their
 * own.
 *
 * This is what sizes a glyph shadow's coverage surface — the run-shaped
 * counterpart of the context's `_shapedInk`, which measures one shaped
 * string from its own origin.
 *
 * @param {Array<{run, x, y}>} positioned
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}|null}
 */
export function positionedRunsInk(positioned) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { run, x, y } of positioned) {
    let cursor = x;
    for (const g of run.glyphs) {
      const e = run.font.glyphExtents(g.id, run.size);
      const gx = cursor + g.dx;
      const gy = y - g.dy;
      cursor += g.ax;
      if (gx + e.minX < minX) minX = gx + e.minX;
      if (gx + e.maxX > maxX) maxX = gx + e.maxX;
      if (gy + e.minY < minY) minY = gy + e.minY;
      if (gy + e.maxY > maxY) maxY = gy + e.maxY;
    }
  }
  return minX <= maxX && minY <= maxY ? { minX, minY, maxX, maxY } : null;
}

// Identity, not content, for anything that wants to name a run cheaply.
// A shaped run is immutable and shared — the shaping memo hands the same
// object back, and a TextLayout holds on to the ones its lines are made of
// — so a small integer per object is a complete name for the glyphs in it,
// bought at O(1) instead of O(glyphs). Weak, so naming a run keeps nothing
// alive.
const runIds = new WeakMap();
let nextRunId = 0;

/**
 * A stable small integer for one run object, for cache keys that would
 * otherwise have to serialize its glyphs. Runs built fresh on every draw
 * (rather than kept, as a `TextLayout` keeps them) get a fresh id each time
 * and so never hit such a cache — which is the honest answer, since nothing
 * cheap can tell them apart.
 */
export function runId(run) {
  let id = runIds.get(run);
  if (id === undefined) runIds.set(run, (id = ++nextRunId));
  return id;
}

/**
 * Decide how a (face, size) renders: cached bitmap glyphs or per-draw
 * trapezoids. See DEFAULT_TEXT_POLICY for the reasoning; the middle band
 * additionally watches a small ring of recently drawn sizes per face — a
 * continuously animated size (zoom/pinch) never repeats, so it routes to
 * vector where per-size caches would leak a glyphset every frame.
 *
 * @returns {'bitmap'|'vector'}
 */
/**
 * CSS's `text-rendering`, as far as it means anything here: a run's own
 * answer to which glyph path it takes, overriding the size thresholds.
 *
 * - `geometricPrecision` — the vector path, always. Outlines are flattened
 *   at the exact size and glyph origins are not rounded, so advances land
 *   where shaping put them. This is what display text wants, and what any
 *   text whose shape is being animated wants: a variable font's axis moves
 *   advances by fractions of a pixel, and on the bitmap path those fractions
 *   accumulate silently until a glyph crosses a rounding boundary and jumps
 *   a whole pixel on its own. It is also the path that caches nothing, so
 *   an axis under a slider stops minting a glyph page per step.
 * - `optimizeSpeed` — the bitmap path, always. Cached server-side glyphs at
 *   any size, for text that is large but static.
 * - `auto` (the default, and anything unrecognized) — the size thresholds
 *   and the churn ring decide, as before.
 *
 * `optimizeLegibility` is accepted and means `auto`: ntk has no hinting to
 * turn on, so promising anything by it would be a lie.
 */
export function routeForRendering(textRendering) {
  if (textRendering === 'geometricPrecision') return 'vector';
  if (textRendering === 'optimizeSpeed') return 'bitmap';
  return null; // auto: ask the thresholds
}

export function routeGlyphSize(app, font, size, policy = policyOf(app), textRendering) {
  // Inlined rather than a call to `routeForRendering`: this is the first
  // thing every run of every draw does, and the overwhelmingly common answer
  // is "nobody asked". One `??` and one comparison get us past it.
  const asked = textRendering ?? policy.textRendering;
  if (asked !== undefined && asked !== 'auto') {
    const route = routeForRendering(asked);
    if (route) return route;
  }
  if (size <= policy.bitmapMax) return 'bitmap';
  if (size > policy.vectorFrom) return 'vector';

  // The ring answers "is this face being drawn at something it has drawn
  // recently, or is it churning?" — so it has to be keyed by the thing that
  // stays put while the churn happens.
  //
  // For a variable font that is the *base* face, not the instance: every
  // point on an axis is a Font of its own, with its own key, so an animated
  // axis handed each step a fresh empty ring and the churn was invisible —
  // it read as eight unrelated faces each drawn once. Keyed by the base and
  // recording the instance alongside the size, an axis sweep and a size
  // sweep look like what they both are, and a page of static text at one
  // weight still reuses its entry on every frame.
  if (!app._sizeRings) app._sizeRings = new Map();
  // A face with no instances behind it keeps the old ring exactly: its key
  // is already constant across the ring, so the size alone identifies a
  // glyph page and the entries stay numbers. Only a variable instance pays
  // for the composite key, and only in this band — text at or below
  // `bitmapMax` returned above without touching any of it.
  const base = font.variationOf;
  let ring = app._sizeRings.get(base ? base.key : font.key);
  if (!ring) {
    ring = [];
    app._sizeRings.set(base ? base.key : font.key, ring);
  }
  // what a glyph page is keyed by, which is exactly what has to repeat for
  // caching to pay for itself
  const entry = base ? `${font.key}@${size}` : size;
  const reused = ring.includes(entry);
  // dedupe consecutive entries so one frame drawing many runs at one size
  // occupies a single slot — the ring then spans ~8 distinct frames
  if (ring[ring.length - 1] !== entry) {
    ring.push(entry);
    if (ring.length > 8) ring.shift();
  }

  if (!Number.isInteger(size)) return 'vector';
  if (!reused && new Set(ring).size >= 6) return 'vector'; // size churn: animating
  return 'bitmap';
}

/**
 * Draw shaped runs. Routes each run through the bitmap path (cached
 * server-side glyphs, one CompositeGlyphs request) or the vector path
 * (one AddTraps + Composite through a shared scratch a8 mask) according to
 * `routeGlyphSize`.
 *
 * @param {App} app
 * @param {number} op Render.PictOp
 * @param {number} srcId source picture (fill color/gradient)
 * @param {number} dstId destination picture
 * @param {Array<{run, x, y}>} positioned visual-order runs with baseline origins
 */
export function drawGlyphRuns(app, op, srcId, dstId, positioned) {
  const policy = policyOf(app);
  let bitmap = positioned;
  let vector = null;
  for (let i = 0; i < positioned.length; i++) {
    const { run } = positioned[i];
    if (
      routeGlyphSize(app, run.font, run.size, policy, positioned[i].textRendering) === 'vector'
    ) {
      if (!vector) {
        vector = [];
        bitmap = positioned.slice(0, i);
      }
      vector.push(positioned[i]);
    } else if (vector) {
      bitmap.push(positioned[i]);
    }
  }
  if (bitmap.length) drawBitmapGlyphRuns(app, op, srcId, dstId, bitmap, policy);
  if (vector) drawVectorGlyphRuns(app, op, srcId, dstId, vector);
}

function drawBitmapGlyphRuns(app, op, srcId, dstId, positioned, policy) {
  const Render = app.display.Render;
  const items = [];
  let bits = 8;
  const pages = new Map();
  for (const { run } of positioned) {
    const page = getGlyphPage(app, run.font, run.size);
    page.ensure(run.glyphs);
    pages.set(run, page);
  }
  for (const page of pages.values()) {
    if (page.bits > bits) bits = page.bits;
  }
  for (const pos of positionGlyphs(positioned)) {
    const page = pages.get(pos.run);
    const e = page.entry(pos.glyph.id);
    items.push({ gs: e.gs, lid: e.lid, adv: e.adv, x: pos.x, y: pos.y });
  }
  const encoded = encodeGlyphItems(items, bits);
  if (!encoded) return;
  // srcX/srcY align the source with the FIRST glyph's origin (RENDER spec);
  // passing that origin itself makes source coordinates equal destination
  // coordinates, so gradient fill styles line up with canvas space
  Render.CompositeGlyphs(
    encoded.bits,
    op,
    srcId,
    dstId,
    0,
    encoded.gsid,
    items[0].x,
    items[0].y,
    encoded.elts
  );
  trimGlyphPages(app, policy, new Set(pages.values()));
}

// AddTraps length field is a plain 16-bit request length (no BigReq in
// node-x11's encoder): stay well under 65535 4-byte units per request
const MAX_TRAPS_PER_REQUEST = 6000;

/**
 * Vector glyph path (issue #45): flatten outlines at the exact (fractional)
 * size, trapezoidate, accumulate every glyph of the draw into one scratch a8
 * mask with a single batched AddTraps, then one Composite to the target.
 * Nothing is cached server-side, so continuously animated sizes cost no
 * cache memory; wire bytes scale with outline complexity (~√size), which
 * beats size²-scaling bitmap uploads above ~128-256px.
 *
 * Positions are intentionally NOT rounded to whole pixels — fractional
 * advances and origins keep zoom animations smooth.
 */
function drawVectorGlyphRuns(app, op, srcId, dstId, positioned) {
  // unrounded glyph origins + ink bounding box
  const placed = [];
  let minX = Infinity;
  let minY = Infinity;
  for (const { run, x, y } of positioned) {
    let cursor = x;
    for (const g of run.glyphs) {
      const gx = cursor + g.dx;
      const gy = y - g.dy;
      cursor += g.ax;
      const e = run.font.glyphExtents(g.id, run.size);
      if (!Number.isFinite(e.minX) || e.maxX <= e.minX) continue; // blank glyph
      placed.push({ run, glyph: g, x: gx, y: gy });
      if (gx + e.minX < minX) minX = gx + e.minX;
      if (gy + e.minY < minY) minY = gy + e.minY;
    }
  }
  if (placed.length === 0) return;

  const bx = Math.floor(minX) - 1;
  const by = Math.floor(minY) - 1;

  const traps = [];
  for (const p of placed) {
    trapezoidize(p.run.font.outline(p.glyph.id, p.run.size), p.x - bx, p.y - by, traps);
  }
  compositeTraps(app, op, srcId, dstId, traps, bx, by);
}

/**
 * Rasterize trapezoids (relative to (bx, by) device coordinates) into the
 * shared scratch a8 mask with batched AddTraps requests, then Composite the
 * source through it onto the destination. Shared by the vector glyph path
 * and by widgets that fill arbitrary outlines (e.g. TeX radicals).
 *
 * When bx/by are omitted they are derived from the trapezoid bounds (the
 * trap coordinates are then treated as absolute device coordinates).
 */
export function compositeTraps(app, op, srcId, dstId, traps, bx, by) {
  if (traps.length === 0) return;
  const Render = app.display.Render;

  let maxX = -Infinity;
  let maxY = -Infinity;
  if (bx === undefined) {
    let minX = Infinity;
    let minY = Infinity;
    for (let i = 0; i < traps.length; i += 6) {
      if (traps[i] < minX) minX = traps[i];
      if (traps[i + 3] < minX) minX = traps[i + 3];
      if (traps[i + 1] > maxX) maxX = traps[i + 1];
      if (traps[i + 4] > maxX) maxX = traps[i + 4];
      if (traps[i + 2] < minY) minY = traps[i + 2];
      if (traps[i + 5] > maxY) maxY = traps[i + 5];
    }
    bx = Math.floor(minX);
    by = Math.floor(minY);
    const shifted = new Array(traps.length);
    for (let i = 0; i < traps.length; i += 6) {
      shifted[i] = traps[i] - bx;
      shifted[i + 1] = traps[i + 1] - bx;
      shifted[i + 2] = traps[i + 2] - by;
      shifted[i + 3] = traps[i + 3] - bx;
      shifted[i + 4] = traps[i + 4] - bx;
      shifted[i + 5] = traps[i + 5] - by;
    }
    traps = shifted;
    maxX -= bx;
    maxY -= by;
  } else {
    for (let i = 0; i < traps.length; i += 6) {
      if (traps[i + 1] > maxX) maxX = traps[i + 1];
      if (traps[i + 4] > maxX) maxX = traps[i + 4];
      if (traps[i + 5] > maxY) maxY = traps[i + 5];
    }
  }
  const bw = Math.max(1, Math.ceil(maxX));
  const bh = Math.max(1, Math.ceil(maxY));

  const mask = scratchMask(app, bw, bh);
  Render.FillRectangles(Render.PictOp.Src, mask.picture.id, [0, 0, 0, 0], [0, 0, bw, bh]);
  for (let i = 0; i < traps.length; i += MAX_TRAPS_PER_REQUEST * 6) {
    Render.AddTraps(mask.picture.id, 0, 0, traps.slice(i, i + MAX_TRAPS_PER_REQUEST * 6));
  }
  // src coords = dst coords (see drawBitmapGlyphRuns) so gradients line up
  Render.Composite(op, srcId, mask.picture.id, dstId, bx, by, 0, 0, bx, by, bw, bh);
  releaseScratchMask(app);
}

// One connection-wide scratch a8 pixmap for trap masks, grown as needed and
// dropped again when a huge draw would otherwise pin megabytes server-side.
const SCRATCH_KEEP_AREA = 1 << 21; // ~2MB of a8

function scratchMask(app, w, h) {
  let s = app._trapScratch;
  if (!s || s.width < w || s.height < h) {
    if (s) {
      s.picture.destroy();
      s.pixmap.destroy();
    }
    const width = Math.max(w, s ? s.width : 0);
    const height = Math.max(h, s ? s.height : 0);
    const pixmap = new Pixmap(app, { depth: 8, width, height });
    const picture = new Picture(app, { drawable: pixmap, format: app.display.Render.a8 });
    s = { pixmap, picture, width, height };
    app._trapScratch = s;
  }
  return s;
}

function releaseScratchMask(app) {
  const s = app._trapScratch;
  if (s && s.width * s.height > SCRATCH_KEEP_AREA) {
    s.picture.destroy();
    s.pixmap.destroy();
    app._trapScratch = null;
  }
}
