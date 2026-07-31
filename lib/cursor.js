import { safeRelease } from './cleanup.js';

// Friendly (CSS-cursor-ish) name -> glyph index in the standard X11 'cursor'
// font (X11/cursorfont.h). Each cursor occupies two glyphs: the shape at the
// even index and its mask at index + 1, which is why every value here is even.
export const cursorShapes = {
  default: 68, // XC_left_ptr
  arrow: 68, // XC_left_ptr
  text: 152, // XC_xterm
  pointer: 60, // XC_hand2
  hand: 60, // XC_hand2
  wait: 150, // XC_watch
  move: 52, // XC_fleur
  crosshair: 34, // XC_crosshair
  'ew-resize': 108, // XC_sb_h_double_arrow
  'ns-resize': 116, // XC_sb_v_double_arrow
  'nwse-resize': 14, // XC_bottom_right_corner
  'nesw-resize': 12, // XC_bottom_left_corner
  'col-resize': 108, // XC_sb_h_double_arrow
  'row-resize': 116, // XC_sb_v_double_arrow
  grab: 58, // XC_hand1
  help: 92, // XC_question_arrow
  'not-allowed': 0 // XC_X_cursor
};

/**
 * The invisible cursor, spelled as CSS spells it. It is a name but not a
 * shape: the 'cursor' font has no glyph meaning "no cursor", so this one is
 * built from an empty bitmap instead of looked up. Kept out of
 * `cursorShapes` for exactly that reason — every value in there is a glyph
 * index, and this has none.
 */
export const BLANK_CURSOR = 'none';

/** Every name `setCursor` accepts, for the error message and for docs. */
export const cursorNames = [...Object.keys(cursorShapes), BLANK_CURSOR];

/**
 * Resolve a friendly cursor name (see `cursorShapes`) or a raw cursor-font
 * glyph index to the glyph index. Throws on unknown names so typos surface
 * immediately instead of silently keeping the old cursor. `'none'` is a
 * valid cursor name but not a glyph, so it never reaches here — see
 * `CursorCache.get`.
 */
export function resolveCursorShape(nameOrShape) {
  if (typeof nameOrShape === 'number') {
    if (!Number.isInteger(nameOrShape) || nameOrShape < 0) {
      throw new Error(`invalid cursor shape id: ${nameOrShape}`);
    }
    return nameOrShape;
  }
  const shape = cursorShapes[nameOrShape];
  if (shape === undefined) {
    throw new Error(
      `unknown cursor name '${nameOrShape}' — valid names: ${cursorNames.join(', ')}`
    );
  }
  return shape;
}

/**
 * Per-App cache of cursors created from the standard X11 'cursor' font.
 * Cursors are server-side resources, so one is created per shape and reused
 * for every window of the connection; `app.close()` disposes the cache.
 * Accessed via `app.cursors` (lazily created) — user code normally never
 * touches this directly, `wnd.setCursor(name)` goes through it.
 */
export class CursorCache {
  constructor(app) {
    this.X = app.X;
    this._font = 0; // the 'cursor' font, opened on first use
    this._byShape = new Map(); // glyph index -> cursor xid
    this._blank = 0; // the invisible cursor, built on first use
  }

  /** cursor xid for a friendly name or raw glyph index, creating it on first use */
  get(nameOrShape) {
    if (nameOrShape === BLANK_CURSOR) return this.blank();
    const shape = resolveCursorShape(nameOrShape);
    const cached = this._byShape.get(shape);
    if (cached) return cached;

    const X = this.X;
    if (!this._font) {
      this._font = X.AllocID();
      X.OpenFont(this._font, 'cursor');
    }
    const cid = X.AllocID();
    // per X convention the mask glyph follows the shape glyph in the cursor
    // font; black foreground on white background (RGB is 16 bit per channel)
    const black = { R: 0, G: 0, B: 0 };
    const white = { R: 0xffff, G: 0xffff, B: 0xffff };
    X.CreateGlyphCursor(cid, this._font, this._font, shape, shape + 1, black, white);
    this._byShape.set(shape, cid);
    return cid;
  }

  /**
   * The invisible cursor, created once per connection. Hiding the pointer is
   * not the same thing as X's cursor None, which means *inherit the parent's*
   * — for a top-level window that is the root's cursor, so the pointer stays
   * on screen. A cursor whose mask is empty is the way to hide it: mask bits
   * that are 0 are not drawn, so a 1x1 all-zero mask draws nothing at all.
   */
  blank() {
    if (this._blank) return this._blank;
    const X = this.X;
    const pid = X.AllocID();
    // depth 1 — CreateCursor takes bitmaps, not pixmaps of the window depth
    X.CreatePixmap(pid, X.display.screen[0].root, 1, 1, 1);
    // a freshly created pixmap's contents are *undefined* per the protocol,
    // so it has to be cleared. Skipping this is how the recipe ends up
    // hiding the cursor on one server and drawing a stray pixel on another
    const gc = X.AllocID();
    X.CreateGC(gc, pid, { foreground: 0 });
    X.PolyFillRectangle(pid, gc, [0, 0, 1, 1]);
    X.FreeGC(gc);
    X.ReleaseID(gc);

    const cid = X.AllocID();
    const black = { R: 0, G: 0, B: 0 };
    // source and mask are the same empty bitmap; the colours are immaterial
    // when nothing is drawn, but the request needs them
    X.CreateCursor(cid, pid, pid, black, black, 0, 0);
    // the cursor keeps its own copy of the bitmaps, so the pixmap goes now
    // rather than living as long as the connection
    X.FreePixmap(pid);
    X.ReleaseID(pid);
    this._blank = cid;
    return cid;
  }

  /** free the server-side cursors (and the font); safe to call repeatedly */
  dispose() {
    const X = this.X;
    for (const cid of this._byShape.values()) {
      safeRelease(X, () => {
        X.FreeCursor(cid);
        X.ReleaseID(cid);
      });
    }
    this._byShape.clear();
    if (this._blank) {
      const cid = this._blank;
      this._blank = 0;
      safeRelease(X, () => {
        X.FreeCursor(cid);
        X.ReleaseID(cid);
      });
    }
    if (this._font) {
      const fid = this._font;
      this._font = 0;
      safeRelease(X, () => {
        X.CloseFont(fid);
        X.ReleaseID(fid);
      });
    }
  }
}
