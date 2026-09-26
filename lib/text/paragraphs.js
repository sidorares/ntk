// A paragraph's layout work that does not depend on the width, kept
// (`TextLayout`): its spans with their faces resolved, its bidi levels, and
// its text cut at UAX#14 break opportunities into shaped tokens. A layout at
// another width — every step of a window resize, and the widths a flexbox
// asks a paragraph about on the way — needs all of that again, and only the
// line fill after it depends on the width: on a 600 KB document, 62% of a
// resize's layout time went on redoing it.
//
// A paragraph is filed under its text and direction, and found by comparing
// every field of every span and of the base style against copies of the ones
// it was made from. Every field, because a caller's own markers ride on its
// spans into the line runs (see `TextLayout`), and the runs of a kept
// paragraph carry the kept spans: two paragraphs that differ only in a link's
// target must not share one.
//
// Bounded the way the shaping memo is (`FontManager#_shapeCached`): two
// generations, here by characters, so a working set up to twice
// `PARAGRAPH_GENERATION` survives a relayout — a whole long document, laid
// out at a new width a frame — and what neither generation used is dropped.

/** How many characters of paragraphs a generation holds. */
export const PARAGRAPH_GENERATION = 1 << 19;

/**
 * The shortest paragraph worth keeping, in code units. Shorter text does not
 * ask the cache at all: a label's preparation is a few microseconds and the
 * lookup and copies about one of them, while a label is seldom laid out at
 * a second width. Kept, a UI's labels mounted a quarter slower and a ticking
 * counter redrew a quarter slower, to save nothing; the paragraphs a resize
 * lays out again are a document's, and those are longer than this.
 */
export const PARAGRAPH_MIN_CHARS = 64;

/** Whether `content` is long enough to keep (`PARAGRAPH_MIN_CHARS`), counted
 *  without building anything. */
export function worthKeeping(content) {
  if (typeof content === 'string') return content.length >= PARAGRAPH_MIN_CHARS;
  let chars = 0;
  for (const span of content) {
    const text = span.text;
    chars += typeof text === 'string' ? text.length : String(text ?? '').length;
    if (chars >= PARAGRAPH_MIN_CHARS) return true;
  }
  return false;
}

export class ParagraphCache {
  constructor(limit = PARAGRAPH_GENERATION) {
    this._limit = limit;
    // direction -> text -> the paragraphs of that text, in two generations
    this._now = new Map();
    this._before = new Map();
    this._chars = 0;
  }

  /**
   * What a paragraph is filed under within its direction: its text. A span
   * list's text is joined once per list and remembered by the list — a
   * caller that lays one paragraph out at many widths hands over the same
   * list each time, and the same string then hashes once, not once a
   * lookup. A list changed in place keeps its old key and misses: `find`
   * compares every field before it answers, so a key can only lose a
   * paragraph, never find the wrong one.
   */
  keyOf(content) {
    if (typeof content === 'string') return content;
    let text = joined.get(content);
    if (text === undefined) {
      text = '';
      for (const span of content) text += span.text;
      joined.set(content, text);
    }
    return text;
  }

  /** The kept paragraph made from exactly these inputs, or undefined. */
  find(key, direction, content, style) {
    const dir = direction ?? '';
    const now = this._now.get(dir)?.get(key);
    const hit = now && pick(now, content, style);
    if (hit) return hit.paragraph;
    const kept = pick(this._before.get(dir)?.get(key), content, style);
    if (!kept) return undefined;
    this._add(dir, key, kept);
    return kept.paragraph;
  }

  /** Keep a paragraph `TextLayout` made, with copies of what it was made
   *  from: nothing done to the inputs afterwards can change what finds it. */
  keep(key, direction, content, style, paragraph) {
    const spans = typeof content === 'string' ? content : content.map((span) => ({ ...span }));
    this._add(direction ?? '', key, { spans, style: { ...style }, paragraph });
  }

  /** Drop everything — the faces a paragraph resolved may not be the ones
   *  its family matches now. */
  clear() {
    this._now = new Map();
    this._before = new Map();
    this._chars = 0;
  }

  _add(dir, key, entry) {
    const chars = entry.paragraph.text.length + 1;
    if (this._chars + chars > this._limit) {
      this._before = this._now;
      this._now = new Map();
      this._chars = 0;
    }
    let texts = this._now.get(dir);
    if (!texts) {
      texts = new Map();
      this._now.set(dir, texts);
    }
    const list = texts.get(key);
    if (list) list.push(entry);
    else texts.set(key, [entry]);
    this._chars += chars;
  }
}

// a span list's text, joined once (`ParagraphCache#keyOf`)
const joined = new WeakMap();

/** The entry among `list` made from these spans and this base style. */
function pick(list, content, style) {
  if (!list) return undefined;
  outer: for (const entry of list) {
    if (typeof content === 'string') {
      if (entry.spans !== content) continue;
    } else {
      const spans = entry.spans;
      if (typeof spans === 'string' || spans.length !== content.length) continue;
      for (let i = 0; i < content.length; i++) {
        if (!sameFields(spans[i], content[i])) continue outer;
      }
    }
    if (sameFields(entry.style, style)) return entry;
  }
  return undefined;
}

/**
 * Whether two objects have the same own fields with the same values. Every
 * field, so that one added to a span later cannot be left out; the values a
 * span holds are compared as they are — a face, a feature map or a marker
 * object by identity — which can only miss, never find the wrong paragraph.
 */
function sameFields(a, b) {
  let fields = 0;
  for (const name in a) {
    if (!(name in b) || !Object.is(a[name], b[name])) return false;
    fields++;
  }
  for (const _ in b) fields--;
  return fields === 0;
}
