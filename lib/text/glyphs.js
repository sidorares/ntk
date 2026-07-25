import GlyphSet from '../glyphset.js';

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
 *   request per draw that introduces new glyphs.
 */
export class GlyphPage {
  constructor(app, font, size) {
    this.app = app;
    this.font = font;
    this.size = size;
    this.glyphset = new GlyphSet(app);
    this.entries = new Map(); // font glyph id -> { lid, adv }
  }

  /** number of bits per glyph needed to address this page's ids */
  get bits() {
    return this.entries.size <= 256 ? 8 : 16;
  }

  /**
   * Ensure all glyphs of a shaped run are uploaded; returns nothing.
   * New glyphs are rasterized and sent in a single AddGlyphs request.
   */
  ensure(glyphs) {
    let batch = null;
    for (const g of glyphs) {
      if (this.entries.has(g.id)) continue;
      const lid = this.entries.size;
      if (lid >= 65536) {
        // 2^16 distinct glyphs at one size — not reachable in practice
        // (fonts cap at 65535 glyphs) but fail loudly rather than corrupt
        throw new Error('glyph page overflow');
      }
      const adv = Math.round(this.font.advanceOf(g.id, this.size));
      const bitmap = this.font.rasterize(g.id, this.size);
      this.entries.set(g.id, { lid, adv });
      if (!batch) batch = [];
      batch.push({
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
      });
    }
    if (batch) this.glyphset.addGlyphs(batch);
  }

  entry(fontGlyphId) {
    return this.entries.get(fontGlyphId);
  }
}

/** per-app page cache: pages (and their server glyphsets) are shared by all
 *  windows/pixmaps of a connection */
export function getGlyphPage(app, font, size) {
  if (!app._glyphPages) app._glyphPages = new Map();
  const key = `${font.key}@${size}`;
  let page = app._glyphPages.get(key);
  if (!page) {
    page = new GlyphPage(app, font, size);
    app._glyphPages.set(key, page);
  }
  return page;
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
 * Draw shaped runs. Uploads any missing glyphs, then issues a single
 * CompositeGlyphs request (with in-request glyphset switches when runs use
 * different faces/sizes).
 *
 * @param {App} app
 * @param {number} op Render.PictOp
 * @param {number} srcId source picture (fill color/gradient)
 * @param {number} dstId destination picture
 * @param {Array<{run, x, y}>} positioned visual-order runs with baseline origins
 */
export function drawGlyphRuns(app, op, srcId, dstId, positioned) {
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
    items.push({ gs: page.glyphset.id, lid: e.lid, adv: e.adv, x: pos.x, y: pos.y });
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
}
