import * as fontkit from 'fontkit';

import { flatten, rasterizePath } from '../rasterize.js';

// Axis coordinates are rounded to this many decimals before anything is
// instantiated or cached. Every distinct coordinate is a font in its own
// right — its own rasterized glyphs, its own server-side glyphset — so the
// precision of the number that reaches here is the precision of the cache,
// and a slider handing over 459.9999999997 must not mint a face that
// 460 will never hit again. Two decimals is far finer than any axis is
// perceptible at, and makes the coordinate that reaches fontkit and the
// coordinate in the key the same number by construction.
const AXIS_DECIMALS = 2;
const round = (v) => Number(v.toFixed(AXIS_DECIMALS));

// Instances kept per base font. Reached only by an app driving an axis
// continuously — an animation, a drag — where the tail is cold by
// definition; a design system's handful of weights never approaches it.
// Server-side glyph pages have their own byte budget (text/glyphs.js), and
// evicting a Font here does not strand them: the key is derived from the
// coordinates, so re-instantiating the same point produces the same key and
// finds the same page.
const MAX_INSTANCES = 64;

/**
 * Clamp `settings` into a font's design space: drop axes it does not have,
 * clamp the rest to their range, round, and drop anything left sitting on
 * its own default (the base font already *is* the default instance).
 *
 * @returns {object|null} the coordinates to instantiate, or null for "this
 *   font already is that instance"
 */
export function normalizeVariations(settings, axes) {
  if (!settings || !axes) return null;
  const coords = {};
  let any = false;
  for (const tag of Object.keys(settings).sort()) {
    const axis = axes[tag];
    if (!axis) continue; // a font that has no such axis is not wrong, just flat
    const value = Number(settings[tag]);
    if (!Number.isFinite(value)) continue;
    const clamped = round(Math.min(axis.max, Math.max(axis.min, value)));
    if (clamped === round(axis.default)) continue;
    coords[tag] = clamped;
    any = true;
  }
  return any ? coords : null;
}

/** Canonical cache key for normalized coordinates: `wdth=87.5,wght=460`. */
export function variationKey(coords) {
  if (!coords) return '';
  return Object.keys(coords)
    .sort()
    .map((tag) => `${tag}=${coords[tag]}`)
    .join(',');
}

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

  /**
   * Open a font from in-memory bytes (no filesystem — works in browser
   * bundles). `key` becomes the stable cache key; defaults to a key derived
   * from the font's postscript name.
   *
   * @param {Uint8Array|Buffer} data font file bytes
   * @param {object} [opts] { key, postscriptName (face of a .ttc) }
   */
  static fromData(data, { key, postscriptName } = {}) {
    const buf = Buffer.isBuffer(data)
      ? data
      : Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length);
    let fk = fontkit.create(buf);
    if (fk.fonts) {
      fk =
        (postscriptName && fk.fonts.find((f) => f.postscriptName === postscriptName)) ||
        fk.fonts[0];
    }
    const font = new Font(fk, null, postscriptName);
    font.key = key ?? `mem:#${fk.postscriptName || ''}`;
    return font;
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

  /**
   * The variation axes this face offers, keyed by OpenType tag:
   * `{ wght: { name, min, default, max } }`. `{}` for a static font, so
   * `Object.keys(font.variationAxes).length` is the "is this variable?"
   * question and needs no other API.
   */
  get variationAxes() {
    return this.fk.variationAxes ?? {};
  }

  /**
   * A static instance of this face at a point in its design space — the
   * thing a variable font is *for*. `font.variation({ wght: 460 })` is the
   * `font-variation-settings: "wght" 460` of CSS.
   *
   * Instances are ordinary `Font`s from here on: they shape, measure and
   * rasterize like any face, and because the key is derived from the
   * coordinates they get their own glyph page and their own server-side
   * glyphset. That is what keeps the axis honest — leave the key alone and
   * every instance of one file collides in the glyph cache, so the whole
   * axis renders as whichever coordinate got there first.
   *
   * Nothing is rasterized here. Instantiating is a table-level operation;
   * glyphs are still rasterized one at a time, on first use, at the size
   * they are drawn at.
   *
   * Settings for axes this font does not have are ignored, values are
   * clamped to each axis's range, and coordinates that land on their own
   * default return **this font** rather than a redundant copy of it.
   *
   * @param {object} settings axis tag -> value, e.g. `{ wght: 460 }`
   * @returns {Font} the instance, or `this` when the settings are a no-op
   */
  variation(settings) {
    const coords = normalizeVariations(settings, this.variationAxes);
    if (!coords) return this;
    const suffix = variationKey(coords);

    if (!this._variations) this._variations = new Map();
    const cached = this._variations.get(suffix);
    if (cached) {
      // Map iterates in insertion order: re-inserting a hit moves it to the
      // tail, so the eviction below drops the least recently asked for
      this._variations.delete(suffix);
      this._variations.set(suffix, cached);
      return cached;
    }

    const instance = new Font(this._instantiate(coords), this.path, this.postscriptName);
    instance.key = `${this.key}|${suffix}`;
    /** the face this was cut from, for callers walking back to the axes */
    instance.variationOf = this;
    instance.variationCoords = coords;

    this._variations.set(suffix, instance);
    if (this._variations.size > MAX_INSTANCES) {
      const oldest = this._variations.keys().next().value;
      this._variations.delete(oldest);
    }
    return instance;
  }

  /**
   * fontkit's instancing, with the one failure it has turned into something
   * that says what to do about it.
   *
   * `getVariation` rebuilds the face from the original stream at the
   * original directory offset. For a WOFF2 that stream is still
   * Brotli-compressed, so the copy comes back with a directory parsed out of
   * compressed bytes — no `cmap`, and a `Cannot read properties of undefined
   * (reading 'tables')` from somewhere deep in shaping, at the first
   * character drawn rather than here. Checking the instance is well-formed
   * costs one property read and moves the report to the call that caused it.
   */
  _instantiate(coords) {
    const instance = this.fk.getVariation(coords);
    if (!instance?.directory?.tables?.cmap) {
      throw new Error(
        `ntk: cannot instantiate a variation of ${this.postscriptName || this.key}` +
          (this.fk.type ? ` (${this.fk.type})` : '') +
          '. fontkit can only instantiate axes from an uncompressed font — ' +
          'ship the .ttf/.otf of a variable font rather than its .woff2. ' +
          'See docs/fonts.md#variable-fonts'
      );
    }
    return instance;
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
   * scanline rasterizer expects.
   */
  rasterize(glyphId, size) {
    return rasterizePath(this._pathCommands(glyphId, size));
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
