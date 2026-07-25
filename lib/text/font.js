import * as fontkit from 'fontkit';

import { flatten, rasterizePath } from '../rasterize.js';

/**
 * A single font face (one entry of a .ttc collection, or a whole .ttf/.otf),
 * parsed with fontkit. Wraps everything the text pipeline needs:
 *
 * - metrics scaled to a pixel size
 * - unicode coverage queries (`hasGlyph`)
 * - shaping (`shape`): OpenType GSUB/GPOS — kerning, ligatures, contextual
 *   forms for complex scripts — via fontkit's layout engine
 * - glyph rasterization to a8 bitmaps for XRender upload
 *
 * Fonts are cheap-ish to open (tables parse lazily) and are cached by the
 * FontManager — always obtain them via `app.fonts`.
 */
export default class Font {
  constructor(fkFont, path, postscriptName) {
    this.fk = fkFont;
    this.path = path;
    /** stable cache key for glyph pages and font caches */
    this.key = `${path}#${postscriptName || fkFont.postscriptName || ''}`;
  }

  static loadSync(path, postscriptName) {
    let fk = fontkit.openSync(path);
    // select the face of a .ttc/.dfont collection (first face by default);
    // don't pass the name to openSync — for single variable fonts it would
    // be misread as a named variation instance
    if (fk.fonts) {
      fk =
        (postscriptName && fk.fonts.find((f) => f.postscriptName === postscriptName)) ||
        fk.fonts[0];
    }
    return new Font(fk, path, postscriptName);
  }

  get familyName() {
    return this.fk.familyName;
  }

  get postscriptName() {
    return this.fk.postscriptName;
  }

  get unitsPerEm() {
    return this.fk.unitsPerEm;
  }

  scale(size) {
    return size / this.fk.unitsPerEm;
  }

  /**
   * Pixel-space metrics for a font size. `ascent`/`capHeight`/`xHeight` are
   * positive (above baseline), `descent` is positive (below baseline).
   */
  metrics(size) {
    const s = this.scale(size);
    const ascent = this.fk.ascent * s;
    const descent = -this.fk.descent * s;
    const lineGap = this.fk.lineGap * s;
    return {
      ascent,
      descent,
      lineGap,
      lineHeight: ascent + descent + lineGap,
      capHeight: this.fk.capHeight * s,
      xHeight: this.fk.xHeight * s
    };
  }

  hasGlyph(codepoint) {
    return this.fk.hasGlyphForCodePoint(codepoint);
  }

  /**
   * Shape a run of text: returns glyphs with pixel-space positioning.
   * RTL runs come back in visual (left-to-right drawing) order.
   *
   * @param {string} text single-direction, single-font run
   * @param {number} size pixel size
   * @param {object} [opts] { direction: 'ltr'|'rtl', features, script, language }
   * @returns {{font, size, direction, width, glyphs: Array<{id, ax, dx, dy, codePoints}>}}
   *   ax = advance, dx/dy = drawing offset from pen position (y up = positive dy)
   */
  shape(text, size, opts = {}) {
    const run = this.fk.layout(text, opts.features, opts.script, opts.language, opts.direction);
    const s = this.scale(size);
    const glyphs = new Array(run.glyphs.length);
    let width = 0;
    for (let i = 0; i < run.glyphs.length; i++) {
      const pos = run.positions[i];
      const g = {
        id: run.glyphs[i].id,
        ax: pos.xAdvance * s,
        dx: pos.xOffset * s,
        dy: pos.yOffset * s,
        codePoints: run.glyphs[i].codePoints
      };
      width += g.ax;
      glyphs[i] = g;
    }
    return { font: this, size, direction: run.direction, width, glyphs };
  }

  /** nominal (unshaped) advance of a glyph id, in pixels */
  advanceOf(glyphId, size) {
    return this.fk.getGlyph(glyphId).advanceWidth * this.scale(size);
  }

  /** glyph bounding box in pixels relative to the baseline origin, y-down */
  glyphExtents(glyphId, size) {
    const s = this.scale(size);
    const b = this.fk.getGlyph(glyphId).cbox;
    return { minX: b.minX * s, maxX: b.maxX * s, minY: -b.maxY * s, maxY: -b.minY * s };
  }

  /**
   * Rasterize a glyph to an 8-bit alpha bitmap (or null for blank glyphs).
   * Converts fontkit's y-up font-unit path to the y-down pixel commands the
   * scanline rasterizer expects. Above 96px supersampling drops from 4x4 to
   * 2x2 — visually indistinguishable at that size, 4x cheaper to rasterize.
   */
  rasterize(glyphId, size) {
    return rasterizePath(this._pathCommands(glyphId, size), size > 96 ? 2 : 4);
  }

  /**
   * Glyph outline as flattened closed polygons in y-down pixel space
   * relative to the baseline origin — input for the vector (trapezoid)
   * glyph path. Empty array for blank glyphs.
   */
  outline(glyphId, size) {
    return flatten(this._pathCommands(glyphId, size));
  }

  /** fontkit y-up font-unit path -> y-down pixel-space M/L/Q/C/Z commands */
  _pathCommands(glyphId, size) {
    const s = this.scale(size);
    const commands = [];
    for (const c of this.fk.getGlyph(glyphId).path.commands) {
      const a = c.args;
      switch (c.command) {
        case 'moveTo':
          commands.push({ type: 'M', x: a[0] * s, y: -a[1] * s });
          break;
        case 'lineTo':
          commands.push({ type: 'L', x: a[0] * s, y: -a[1] * s });
          break;
        case 'quadraticCurveTo':
          commands.push({ type: 'Q', x1: a[0] * s, y1: -a[1] * s, x: a[2] * s, y: -a[3] * s });
          break;
        case 'bezierCurveTo':
          commands.push({
            type: 'C',
            x1: a[0] * s,
            y1: -a[1] * s,
            x2: a[2] * s,
            y2: -a[3] * s,
            x: a[4] * s,
            y: -a[5] * s
          });
          break;
        case 'closePath':
          commands.push({ type: 'Z' });
          break;
      }
    }
    return commands;
  }
}
