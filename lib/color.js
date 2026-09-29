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

// CSS Color 4's rgb() and hsl(), in both the syntaxes it defines: the legacy
// one with a comma between every component, and the modern one with spaces
// and an optional `/ alpha` — `rgb(255 128 0 / 50%)`, which is what a design
// tool copies out today. parse-color reads neither right. The modern syntax
// not at all; a percentage as though it were a byte, so `rgb(100%, 0%, 0%)`
// came out at 39% red; and nothing out of range clamped, so `rgb(300, 0, 0)`
// reached XRender as 1.18. A spelling this does not read still goes to
// parse-color, so nothing it accepted is refused.
const FUNCTIONAL = /^(rgba?|hsla?)\(([^()]*)\)$/i;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const HUE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|grad|rad|turn)?$/i;
const DEGREES = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** A number, or a percentage, as a fraction of `whole`, clamped to 0..1;
 *  NaN when it is neither. */
function fraction(text, whole) {
  if (text.endsWith('%')) {
    const n = text.slice(0, -1);
    return NUMBER.test(n) ? clamp01(Number(n) / 100) : NaN;
  }
  return NUMBER.test(text) ? clamp01(Number(text) / whole) : NaN;
}

function parseFunctional(value) {
  const m = FUNCTIONAL.exec(value);
  if (!m) return null;
  const body = m[2].trim();
  let parts;
  let alpha = null;
  if (body.includes(',')) {
    parts = body.split(',').map((p) => p.trim());
    if (parts.length === 4) alpha = parts.pop();
    else if (parts.length !== 3) return null;
  } else {
    const halves = body.split('/');
    if (halves.length > 2) return null;
    parts = halves[0].trim().split(/\s+/);
    if (parts.length !== 3) return null;
    if (halves.length === 2) alpha = halves[1].trim();
    // `none` is the modern syntax's alone: a missing component, which is 0
    const none = (p) => (p.toLowerCase() === 'none' ? '0' : p);
    parts = parts.map(none);
    if (alpha !== null) alpha = none(alpha);
  }
  const a = alpha === null ? 1 : fraction(alpha, 1);
  let rgb;
  if (m[1][0].toLowerCase() === 'r') {
    rgb = parts.map((p) => fraction(p, 255));
  } else {
    const hue = HUE.exec(parts[0]);
    if (!hue) return null;
    // saturation and lightness are percentages, which the modern syntax
    // also takes as bare numbers
    rgb = hslToRgb(
      Number(hue[1]) * DEGREES[(hue[2] ?? 'deg').toLowerCase()],
      fraction(parts[1], 100),
      fraction(parts[2], 100)
    );
  }
  const out = [rgb[0], rgb[1], rgb[2], a];
  return out.every(Number.isFinite) ? out : null;
}

/** hsl() to sRGB, rounded to bytes as a browser rounds it. parse-color did
 *  the same, give or take one where the exact value is a half and its float
 *  error fell below it — `hsl(-30, …)` and `hsl(330, …)` could differ. */
function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const chroma = s * Math.min(l, 1 - l);
  const channel = (n) => {
    const k = (n + hue / 30) % 12;
    const v = l - chroma * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255) / 255;
  };
  return [channel(0), channel(8), channel(4)];
}

// Each spelling is parsed once. A UI draws with a few dozen colours and sets
// them again on every paint — every box's background, every border, every
// edge of a graph — and a parse is a regular expression and an allocation
// or two: 6% of a 2D graph pan's frame, 3% of a table's. Bounded, and
// dropped whole rather than evicted, since a palette is a few dozen strings
// (react-x11's Cocoa context keeps the same cache for the same reason). The
// caller gets a copy, as it always has: an array handed out is its to keep
// or scale.
const parsed = new Map();
const PARSED_MAX = 512;

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
  let rgba = parsed.get(value);
  if (rgba === undefined) {
    rgba = parseStraight(value);
    if (parsed.size >= PARSED_MAX) parsed.clear();
    parsed.set(value, rgba);
  }
  return rgba && rgba.slice();
}

function parseStraight(value) {
  const v = value.trim();
  if (!v) return null;
  if (v.toLowerCase() === 'transparent') return [0, 0, 0, 0];

  // '#' is ours alone: falling back to parse-color for a hex form we reject
  // is how '#1234567' turns into rgba [18, 52, 86, 7, 1] -> alpha 7.
  const rgba = v.startsWith('#') ? parseHex(v) : (parseFunctional(v) ?? rawRgba(v));
  if (!rgba) return null;
  // NaN would otherwise reach the wire as a garbage fixed-point value
  return rgba.every((c) => Number.isFinite(c)) ? rgba : null;
}

function rawRgba(value) {
  // CSS's names and functions are case-insensitive, and parse-color's
  // tables are lower case: `TOMATO` was not a colour
  const c = parseColorRaw(value.toLowerCase());
  if (!c || !c.rgba) return null;
  const [r, g, b, a] = c.rgba;
  // clamped as CSS clamps: a component past 1 is not a brighter colour,
  // and XRender warns on one
  return [clamp01(r / 255), clamp01(g / 255), clamp01(b / 255), clamp01(a)];
}

/**
 * Parse a CSS colour to a premultiplied `[r, g, b, a]` in 0..1, ready for
 * XRender, or null if `value` is not a colour.
 */
export function cssColor(value) {
  const straight = cssColorStraight(value);
  return straight && premultiply(straight);
}
