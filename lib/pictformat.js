/**
 * Which RENDER picture format describes a drawable's pixels.
 *
 * A picture format is how the server is told to read and write a drawable:
 * where the red, green, blue and alpha bits are and how many of each. Depth
 * does not name one — a depth-16 visual can be 5:6:5 or 5:5:5 with a spare
 * bit, a depth-24 one can be RGB or BGR, and both 8:8:8:8 and 10:10:10:2 are
 * 32 bits wide. The **visual** is what fixes the layout, so that is what a
 * format has to be picked from (issue #295).
 *
 * The mapping the server keeps is in `QueryPictFormats`' screens/depths/
 * visuals section, which node-x11's parser drops
 * ([node-x11#280](https://github.com/sidorares/node-x11/issues/280)). Until it
 * lands, the mapping is reconstructed here the way the server built it in the
 * first place: a visual's `red_mask`/`green_mask`/`blue_mask` from the
 * connection handshake, matched against the shift/mask pairs of the formats
 * list. Both sides come from the same server, so this is a lookup rather than
 * a guess — the only thing it cannot recover is a format for an *indexed*
 * visual, which has no masks to match on.
 */

/** `type` in a formats-list entry. */
export const PICT_TYPE = { Indexed: 0, Direct: 1 };

/**
 * The fields of a `QueryPictFormats` entry, which node-x11 hands over as a
 * positional array (`x11/lib/ext/render.js`).
 */
const FIELD = {
  id: 0,
  type: 1,
  depth: 2,
  redShift: 3,
  redMask: 4,
  greenShift: 5,
  greenMask: 6,
  blueShift: 7,
  blueMask: 8,
  alphaShift: 9,
  alphaMask: 10,
  colormap: 11
};

/** A formats-list entry as an object, from node-x11's positional array. */
export function parsePictFormats(reply) {
  const list = (Array.isArray(reply) ? reply : reply?.formats) ?? [];
  return list.map((f) => {
    if (!Array.isArray(f)) return f;
    const out = {};
    for (const name in FIELD) out[name] = f[FIELD[name]];
    return out;
  });
}

/** Where a channel's bits sit in a pixel, as one mask over the whole word. */
const channelMask = (shift, mask) => ((mask >>> 0) << shift) >>> 0;

/** How many bits a mask covers. */
function bitCount(mask) {
  let n = 0;
  for (let m = mask >>> 0; m; m >>>= 1) n += m & 1;
  return n;
}

/**
 * The format id for a visual, or `null` where the formats list holds none.
 *
 * The colour masks have to agree exactly; what is left over is the choice
 * between, say, `a8r8g8b8` and `x8r8g8b8`, and the spare bits settle it. A
 * whole byte the channels do not account for is the alpha channel every ARGB
 * visual has; a bit or two — the spare bit of a 5:5:5 in 16, the two of a
 * 10:10:10 in 32 — is padding no client ever wrote, and reading it as alpha
 * would composite a garbage bit as transparency.
 *
 * Depth is matched first and relaxed only if that finds nothing, because the
 * two lists do not always agree on it. A server names the format it created
 * for a visual with that visual's depth, but the fixed formats every RENDER
 * server also publishes carry the *pixel* width instead — `a2r10g10b10` is
 * listed at depth 32, and a 10:10:10 visual is depth 30. Matching masks alone
 * still identifies the layout, which is the part that decides how pixels are
 * read.
 *
 * @param {object} visual a handshake visual (`{ red_mask, green_mask, blue_mask }`)
 * @param {number} depth the depth its `depths` entry is under
 * @param {Array<object>} formats parsed formats list
 * @returns {number|null}
 */
export function matchVisualFormat(visual, depth, formats) {
  const red = (visual?.red_mask ?? 0) >>> 0;
  const green = (visual?.green_mask ?? 0) >>> 0;
  const blue = (visual?.blue_mask ?? 0) >>> 0;
  // An indexed visual (PseudoColor, GrayScale and the static pair) carries no
  // masks: its format is an Indexed one, tied to a colormap this list cannot
  // be matched against. Nothing here can name it, and saying so is better
  // than naming a Direct format whose channels it does not have.
  if (!(red || green || blue)) return null;

  const wantAlpha = depth - (bitCount(red) + bitCount(green) + bitCount(blue)) >= 8;
  // near misses, in the order they would be settled for: same depth but the
  // wrong side of the alpha choice, then the two the same way round again
  // with the depth relaxed
  let sameDepthAlt = null;
  let otherDepth = null;
  let otherDepthAlt = null;

  for (const f of formats) {
    if (f.type !== PICT_TYPE.Direct) continue;
    if (channelMask(f.redShift, f.redMask) !== red) continue;
    if (channelMask(f.greenShift, f.greenMask) !== green) continue;
    if (channelMask(f.blueShift, f.blueMask) !== blue) continue;
    const hasAlpha = (f.alphaMask ?? 0) !== 0;
    if (f.depth === depth) {
      if (hasAlpha === wantAlpha) return f.id;
      sameDepthAlt ??= f.id;
    } else if (hasAlpha === wantAlpha) {
      otherDepth ??= f.id;
    } else {
      otherDepthAlt ??= f.id;
    }
  }
  return sameDepthAlt ?? otherDepth ?? otherDepthAlt;
}

/**
 * visual id -> format id, over every visual the connection was told about.
 *
 * @param {object} display node-x11's display object
 * @param {Array<object>} formats parsed formats list
 * @returns {Map<number, number>}
 */
export function visualFormats(display, formats) {
  const byVisual = new Map();
  for (const screen of display?.screen ?? []) {
    for (const depth in screen.depths ?? {}) {
      for (const visual of Object.values(screen.depths[depth])) {
        const format = matchVisualFormat(visual, Number(depth), formats);
        if (format != null) byVisual.set(visual.vid >>> 0, format);
      }
    }
  }
  return byVisual;
}

/**
 * visual id -> the depth its pixels are, straight from the handshake.
 *
 * @param {object} display node-x11's display object
 * @returns {Map<number, number>}
 */
export function visualDepths(display) {
  const byVisual = new Map();
  for (const screen of display?.screen ?? []) {
    for (const depth in screen.depths ?? {}) {
      for (const visual of Object.values(screen.depths[depth])) {
        byVisual.set(visual.vid >>> 0, Number(depth));
      }
    }
  }
  return byVisual;
}

/**
 * The format a drawable of this depth is read through when its visual is not
 * available — a pixmap, which has no visual at all, or a window whose visual
 * has not been asked for yet.
 *
 * The standard formats node-x11 picks out of the list by their masks. Right
 * for the layouts an X client meets most of the time (8:8:8 colour, 8-bit
 * coverage) and wrong for everything else, which is why it is the fallback
 * and not the answer.
 */
export function formatForDepth(Render, depth) {
  if (depth === 32) return Render.rgba32;
  if (depth === 8) return Render.a8;
  return Render.rgb24;
}
