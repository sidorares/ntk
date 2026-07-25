import { readFileSync } from 'node:fs';
import opentype from 'opentype.js';

import GlyphSet from './glyphset.js';
import { rasterizePath } from './rasterize.js';

/**
 * A font loaded from a .ttf/.otf file, rasterized in pure JS (opentype.js +
 * lib/rasterize.js) and uploaded to the X server as XRender glyphs.
 *
 * Glyphs are rasterized and uploaded lazily, per size, as text is drawn —
 * not the whole font up front.
 */
export default class FontFace {
  constructor(app) {
    this.app = app;
    this.font = null;
    this._sizes = new Map(); // size -> { glyphset, glyphs: Map<codepoint, glyph>, uploaded: Set<glyphId> }
  }

  loadFont(path) {
    const buf = readFileSync(path);
    this.font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    return this;
  }

  _sizeCache(size) {
    let cache = this._sizes.get(size);
    if (!cache) {
      const glyphset = new GlyphSet(this.app);
      glyphset.fontface = this;
      glyphset.size = size;
      cache = { glyphset, glyphs: new Map(), uploaded: new Set() };
      this._sizes.set(size, cache);
    }
    return cache;
  }

  // rasterize (once) a single codepoint at the given pixel size
  getGlyph(size, codepoint) {
    const cache = this._sizeCache(size);
    let g = cache.glyphs.get(codepoint);
    if (g) return g;

    const glyph = this.font.charToGlyph(String.fromCodePoint(codepoint));
    const advance = (glyph.advanceWidth * size) / this.font.unitsPerEm;
    const bitmap = rasterizePath(glyph.getPath(0, 0, size).commands);

    g = {
      id: glyph.index,
      codepoint,
      advance, // pixels, for measureText
      // XRender glyph info: bitmap and offsets relative to the glyph origin.
      // offX/offY are in 26.6 fixed point (node-x11 divides by 64 on upload).
      width: bitmap ? bitmap.width : 0,
      height: bitmap ? bitmap.height : 0,
      x: bitmap ? -bitmap.left : 0,
      y: bitmap ? -bitmap.top : 0,
      offX: Math.round(advance * 64),
      offY: 0,
      image: bitmap ? bitmap.data : Buffer.alloc(0)
    };
    cache.glyphs.set(codepoint, g);
    return g;
  }

  // make sure every glyph needed for `text` is uploaded to the glyphset;
  // returns the glyph ids in text order
  ensureGlyphs(size, text) {
    const cache = this._sizeCache(size);
    const ids = [];
    const batch = [];
    for (const ch of text) {
      const g = this.getGlyph(size, ch.codePointAt(0));
      ids.push(g.id);
      if (!cache.uploaded.has(g.id)) {
        cache.uploaded.add(g.id);
        // pass a copy: node-x11 AddGlyphs mutates offX/offY and image padding
        batch.push({ ...g });
      }
    }
    cache.glyphset.addGlyphs(batch);
    return ids;
  }

  // returns a GlyphSet ready for RenderingContext2d.setFont()
  upload(size) {
    return this._sizeCache(size).glyphset;
  }
}
