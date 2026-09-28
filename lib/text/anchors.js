// fontkit's mark attachment, for a face whose tables leave an anchor out.
//
// A mark-to-base, mark-to-ligature or mark-to-mark subtable holds an anchor
// for each base (ligature component, earlier mark) and mark class, and the
// OpenType spec lets one be NULL: that subtable attaches no mark of that
// class to that glyph. HarfBuzz answers "not applied", and the lookup's next
// subtable gets its turn. fontkit reads the NULL's coordinates and throws
// `Cannot read properties of null (reading 'xCoordinate')` out of a layout,
// and faces ship them: Noto Sans Bold holds 2,822, DejaVu Sans Mono 198 (a
// Lithuanian Į̃ reaches one), Amiri, Noto Naskh Arabic and FreeSerif
// thousands. Upstream that is foliojs/fontkit#367; #374 returns early
// instead, which ends the crash but still counts the subtable as applied.
//
// Answering "not applied" means wrapping the processor's `applyLookup`,
// which runs for every glyph at every lookup: 2% of shaping a word the
// first time. So a face pays it only from the first NULL its text reaches.
// Until then `applyAnchor` alone is watched — it runs when a mark attaches —
// and a NULL there abandons the layout (`NO_ANCHOR`), which `Font#_layout`
// shapes again with the wrapper in. Abandoning loses nothing: fontkit keeps
// no state from a layout but the tables it decoded, which a second one
// reads the same.

/**
 * Thrown through fontkit's layout from a NULL anchor, and caught here or in
 * `Font#_layout`. One error, made once: a face can reach NULLs many times a
 * word, and a fresh error would take a stack trace each time. It says what
 * happened to anything that calls a watched face's `layout` directly.
 */
export const NO_ANCHOR = new Error(
  'a mark attachment subtable has a NULL anchor for this glyph and mark class: ' +
    "shaped through ntk's Font, that is a subtable that did not apply"
);

/** The face's GPOS processor, where fontkit shapes it through GPOS; else null. */
function processorOf(fk) {
  try {
    return fk._layoutEngine?.engine?.GPOSProcessor ?? null;
  } catch {
    return null;
  }
}

/**
 * Watch a face's mark attachment for a NULL anchor, which then abandons the
 * layout it is reached in with `NO_ANCHOR`.
 *
 * @param {object} fk a fontkit font
 * @returns {boolean} whether there is anything to watch: false for a face
 *   fontkit does not position through GPOS
 */
export function watchAnchors(fk) {
  const gpos = processorOf(fk);
  if (!gpos || typeof gpos.applyAnchor !== 'function') return false;
  if (Object.hasOwn(gpos, 'applyAnchor')) return true;
  const applyAnchor = gpos.applyAnchor;
  gpos.applyAnchor = function (markRecord, baseAnchor, baseGlyphIndex) {
    if (baseAnchor == null || markRecord.markAnchor == null) throw NO_ANCHOR;
    return applyAnchor.call(this, markRecord, baseAnchor, baseGlyphIndex);
  };
  return true;
}

/**
 * From here on a subtable that reaches a NULL anchor is one that did not
 * apply, so the lookup's next subtable is tried, as HarfBuzz tries it.
 *
 * @param {object} fk a fontkit font `watchAnchors` has been handed
 */
export function tolerateAnchors(fk) {
  const gpos = processorOf(fk);
  if (!gpos || Object.hasOwn(gpos, 'applyLookup')) return;
  const applyLookup = gpos.applyLookup;
  gpos.applyLookup = function (lookupType, table) {
    try {
      return applyLookup.call(this, lookupType, table);
    } catch (err) {
      if (err === NO_ANCHOR) return false;
      throw err;
    }
  };
}
