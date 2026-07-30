// Colour parsing, shared by the 2d context and the CSS cascade.
//
// Everything here returns **premultiplied** `[r, g, b, a]` floats in 0..1,
// because that is what XRender takes: a colour reaches the server through
// CreateSolidFill / FillRectangles / gradient stops, all of which read
// premultiplied ARGB, so each of r, g and b must be <= a. Straight (a.k.a.
// unassociated) alpha renders at full brightness instead — red at half alpha
// composites as #ff0000 rather than #800000 — and since x11 3.3.0 a
// component above 1 also warns.
//
// Hex is parsed here rather than handed to parse-color, which does not
// understand CSS hex alpha and fails silently on it:
//
//   parse-color('#00000022')  ->  rgba [0, 0, 0, 34, 1]   five entries, and
//                                 the alpha is still a 0..255 byte
//   parse-color('#0002')      ->  rgba [0, 2, 0, 1]       read as a truncated
//                                 six-digit hex
//
// The first is why `#RRGGBBAA` used to render fully opaque: 34 clamps to 1.
import parseColorRaw from 'parse-color';

/** `[r, g, b, a]` straight -> premultiplied. Opaque colours are unchanged. */
export function premultiply([r, g, b, a]) {
  return a === 1 ? [r, g, b, a] : [r * a, g * a, b * a, a];
}

// #RGB, #RGBA, #RRGGBB, #RRGGBBAA. Five and seven digits are not CSS, so
// they are rejected rather than guessed at.
const HEX = /^#([0-9a-f]{3,8})$/i;

function parseHex(value) {
  const m = HEX.exec(value);
  if (!m) return null;
  const h = m[1];
  const short = h.length === 3 || h.length === 4;
  if (!short && h.length !== 6 && h.length !== 8) return null;
  const part = (i) =>
    short
      ? parseInt(h[i], 16) * 0x11 // 'f' -> 0xff
      : parseInt(h.slice(i * 2, i * 2 + 2), 16);
  const hasAlpha = h.length === 4 || h.length === 8;
  return [part(0) / 255, part(1) / 255, part(2) / 255, hasAlpha ? part(3) / 255 : 1];
}

/**
 * Parse a CSS colour to `[r, g, b, a]` floats in 0..1 with **straight**
 * (unassociated) alpha, or null if it is not a colour.
 *
 * `cssColor` is the one to use for anything heading to XRender. This is for
 * the places that genuinely want unassociated components:
 *
 *  - **OpenGL.** `glClearColor` and material colours take straight alpha;
 *    handing them premultiplied values renders translucent colours dark.
 *  - **Interpolating** two colours. Lerp straight, then premultiply once at
 *    the end — a round trip back to an `rgba()` string only closes if the
 *    components were never scaled.
 */
export function cssColorStraight(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;
  if (v.toLowerCase() === 'transparent') return [0, 0, 0, 0];

  // '#' is ours alone: falling back to parse-color for a hex form we reject
  // is how '#1234567' turns into rgba [18, 52, 86, 7, 1] -> alpha 7.
  const rgba = v.startsWith('#') ? parseHex(v) : rawRgba(v);
  if (!rgba) return null;
  // NaN would otherwise reach the wire as a garbage fixed-point value
  return rgba.every((c) => Number.isFinite(c)) ? rgba : null;
}

function rawRgba(value) {
  const c = parseColorRaw(value);
  if (!c || !c.rgba) return null;
  const [r, g, b, a] = c.rgba;
  return [r / 255, g / 255, b / 255, a];
}

/**
 * Parse a CSS colour to a premultiplied `[r, g, b, a]` in 0..1, ready for
 * XRender, or null if `value` is not a colour.
 */
export function cssColor(value) {
  const straight = cssColorStraight(value);
  return straight && premultiply(straight);
}
