# Text: shaping, layout and the markdown widget

The text stack is pure JavaScript end to end and is designed around one
goal: **correct, fully shaped text with the least possible traffic to the
X server**.

```
lib/text/font.js         Font: one parsed face — metrics, coverage, shaping,
                         glyph rasterization (fontkit)
lib/text/fontmanager.js  FontManager (`app.fonts`): matching, custom fonts,
                         per-codepoint fallback, shaping/layout entry points
lib/text/shape.js        bidi (UAX#9) → font itemization → OpenType shaping
lib/text/layout.js       TextLayout: UAX#14 line breaking, wrapping, alignment
lib/text/glyphs.js       server glyph cache + CompositeGlyphs encoder
lib/widgets/markdown.js  markdown parsing (adapter over `marked`)
lib/widgets/markdownview.js  MarkdownView widget
```

## Quick start

```js
const ctx = wnd.getContext('2d');

// canvas-style: shaped automatically (kerning, ligatures, bidi, fallback)
ctx.font = '20px "DejaVu Sans", sans-serif';
ctx.fillText('The quick brown fox — الثعلب البني السريع — 素早い茶色の狐', 16, 40);

// layout extension: wrap to a container width without drawing
const layout = ctx.layoutText(longText, { maxWidth: wnd.width - 32, lineHeight: 1.35 });
console.log(layout.lines.length, layout.height);
layout.draw(ctx, 16, 60);
```

![shaped text with a gradient fill and a wrapped mixed-direction paragraph](img/text-rendering.png)

## The pipeline

1. **Match** — `app.fonts.match(family, { weight, style })` resolves CSS-ish
   patterns to font files via the `fc-match` CLI (present on any system with
   X11). Comma-separated family lists work natively. Fonts registered with
   `app.fonts.load(path)` take priority. `.ttc` collections are supported
   (faces are selected by postscript name).
2. **Bidi** — [bidi-js](https://www.npmjs.com/package/bidi-js) computes
   UAX#9 embedding levels; text splits into direction runs.
3. **Itemize** — each direction run splits again wherever the primary font
   lacks a glyph: `app.fonts.fallbackFor(codepoint)` walks the fontconfig
   fallback chain (using fontconfig's own coverage data, so candidate files
   are only opened to confirm) and picks the best font that covers the
   character. The primary font always wins when it covers a char, keeping
   fallback runs minimal.
4. **Shape** — [fontkit](https://www.npmjs.com/package/fontkit) applies
   OpenType GSUB/GPOS: kerning, ligatures, contextual forms for complex
   scripts (Arabic joining etc.). RTL runs come back in visual order.
5. **Rasterize + upload** — new glyphs are rasterized by the built-in
   scanline rasterizer (`lib/rasterize.js`) and uploaded once per
   (face, size) with a single batched `AddGlyphs` request. Coverage is
   computed by signed-area accumulation, so antialiasing is exact at every
   size and costs the same.
6. **Composite** — drawing sends one `CompositeGlyphs` request; the server
   does all the actual blending.

Very large or continuously animated sizes take a different route — see
[the vector text path](#the-vector-trapezoid-text-path) below.

## Wire efficiency

XRender glyph ids are client-assigned, and ntk exploits that:

- Glyphs get **compact sequential ids** (0, 1, 2, …) per glyphset, so the
  8-bit `CompositeGlyphs8` encoding (1 byte per glyph) applies until a
  face/size has uploaded more than 256 distinct glyphs, and 16-bit after
  that. Font glyph indices (which would force 32-bit) never hit the wire.
- Each glyph's rounded advance is **baked into the glyph** at upload, so the
  server moves the pen itself. Position data is emitted only when the shaped
  position deviates from the server pen: at run starts, kern pairs, mark
  offsets and rounding-drift corrections. A line of plain text costs one
  8-byte elt header plus 1 byte per glyph.
- Mixed faces/sizes in one draw (font fallback, styled spans) use in-request
  **glyphset switch** entries (12 bytes) instead of separate requests.
- Uploaded bitmaps are cached per app connection (`app._glyphPages`) and
  shared by every window and pixmap; re-drawing text costs no uploads. The
  cache is LRU-bounded (default 8MB of uploaded bitmap bytes): when the
  budget is exceeded, the least-recently-drawn (face, size) page is freed
  server-side with `FreeGlyphSet`, so transient sizes don't accumulate.
- `TextLayout` memoizes shaping per word, so re-wrapping on window resize
  re-uses shaped glyphs and sends only composition requests. `ctx.fillText`
  draws through the same memo, so repainting a label shapes it once, not
  once per frame. The memo is LRU-bounded (4000 entries): on overflow the
  least-recently-used half is dropped, so what is on screen stays shaped.

For scale: a 60-character line of 16px Latin text is ~70 bytes of
`CompositeGlyphs` after warm-up. The one-time glyph upload for a full
Latin face at 16px is a few kilobytes.

## The vector (trapezoid) text path

Bitmap glyph uploads scale with size² while outline complexity scales with
roughly √size: measured on a serif face, the wire-size crossover is at
≈96–128px for Latin and ≈130–190px for dense CJK, and at 256px a full Latin
set costs ~2.4MB of server-side cache per face. Uploads amortize for text
that is drawn repeatedly — but never for *continuously animated* sizes
(zoom/pinch), where every frame is a new (face, size) page.

So `drawGlyphRuns` routes each run (issue #45):

- **size ≤ 128px** — cached bitmap glyphs, unconditionally (status quo);
- **size > 256px** — trapezoids by default: the glyph outline is flattened
  at the exact size, decomposed into trapezoids (`lib/trapezoid.js`) and
  rendered server-side with one batched `AddTraps` + `Composite` through a
  shared scratch a8 mask per draw. Nothing is cached server-side;
- **in between** — bitmaps, unless the size is fractional or a small
  per-face ring of recently drawn sizes shows no reuse (an animation in
  flight). Both signals route to vector, and an animation that settles
  flips back to bitmaps on the next frame.

Vector-path positioning is *not* rounded to whole pixels, so fractional
sizes and fractional pen positions animate smoothly (the bitmap path rounds
both, which is correct for static UI text).

The thresholds and the cache budget are per-app configurable:

```js
app.textPolicy = {
  bitmapMax: 128,        // ≤ this: always bitmaps
  vectorFrom: 256,       // > this: always trapezoids (Infinity to opt out)
  cacheBytes: 8 << 20    // LRU budget for uploaded glyph bitmaps
};
```

Partial objects are fine — unset keys keep their defaults
(`DEFAULT_TEXT_POLICY` in `lib/text/glyphs.js`).

## API

### `app.fonts` → FontManager

- `match(family, { weight, style })` → `Font` — system-font resolution
  (fontconfig by default) with registered fonts first. `family` may be a
  comma-separated list.
- `load(pathOrData, { postscriptName, family, weight, style })` → `Font` —
  register a font file, given a path or its bytes (bundled/custom fonts;
  issue-16-style usage):

  ```js
  app.fonts.load('./assets/Inter.ttf');
  ctx.font = '16px Inter';
  ```

- `fallbackFor(codepoint, family, opts)` → `Font | null`
- `shape(text, style)` → shaped runs (see below)
- `layout(content, style, options)` → `TextLayout`

`FontManager` is exported from the package root and works without an X
connection — measurement and layout are fully headless. System lookup goes
through a pluggable FontSource (`new FontManager({ source })`) — see
[fonts.md](fonts.md#pluggable-font-sources).

### `Font`

`familyName`, `postscriptName`, `unitsPerEm`, `metrics(size)` →
`{ ascent, descent, lineGap, lineHeight, capHeight, xHeight }` (px,
descent positive-down), `hasGlyph(cp)`, `shape(text, size, opts)`,
`rasterize(glyphId, size)`.

### Shaping

```js
const shaped = app.fonts.shape('عالم hello', { family: 'sans-serif', size: 24 });
// { text, width, baseLevel, runs: [ { font, size, direction, level, width,
//     glyphs: [{ id, ax, dx, dy, codePoints }], text } ] }  (logical order)
```

`reorderRuns(runs)` (from `lib/text/shape.js`) gives visual order.
`style.features` passes OpenType feature tags through to fontkit
(e.g. `['smcp']`); `style.direction` forces the paragraph direction.

### `TextLayout`

```js
const layout = app.fonts.layout(content, style, {
  maxWidth: 400,      // target container width (the requested extension)
  align: 'start',     // left | right | center | start | end
  lineHeight: 1.35,   // multiplier over natural font line height
  direction: 'auto',  // base paragraph direction
  maxLines: 2,        // cap the line count (default: unlimited)
  overflow: 'clip'    // clip | ellipsis — what the cap looks like
});
```

`content` is a string or styled spans:

```js
app.fonts.layout([
  { text: 'warning: ', weight: 700, color: 'red' },
  { text: 'something happened' }
], { family: 'sans-serif', size: 16 }, { maxWidth: 300 });
```

Results are inspectable before drawing: `layout.width`, `layout.height`,
`layout.truncated`, `layout.lines[] = { x, y, height, baseline, width,
ascent, descent, runs, start, end }` where `runs[] = { x, width, run, span,
start, end }` in visual order (`start`/`end` are the logical UTF-16 ranges
the line/run covers). `layout.draw(ctx, x, y)` draws, batching consecutive
same-color runs into single requests.

Line breaking is UAX#14 (`linebreak` package); `\n` forces breaks; a word
wider than `maxWidth` force-breaks at the widest grapheme prefix that fits;
trailing whitespace at line ends is stripped (and doesn't count against
`maxWidth` during fitting, CSS-style).

#### Line boxes and leading

A line has two rectangles, and which one you want depends on what you are
drawing:

| | |
| --- | --- |
| the **line box** | `y` to `y + height`. Boxes tile the layout exactly, so they sum to `layout.height`. This is the selection band, and what hit testing divides on. |
| the **glyphs** | `baseline - ascent` to `baseline + descent`. This is the ink, and what a caret should match. |

The difference between them is the **leading**, and it is split evenly above
and below the text — half-leading, as in
[CSS Inline Layout 3](https://www.w3.org/TR/css-inline-3/#inline-height).
That is what makes a single line sit visually centred in a box measured from
`layout.height`, which is what a button or a list row does:

```js
const layout = app.fonts.layout(label, style, { lineHeight: 1.5 });
// no manual offset: the text is already centred in layout.height
layout.draw(ctx, x, y + (rowHeight - layout.height) / 2);
```

Leading appears even at `lineHeight: 1`, because a font's natural line
height is `ascent + descent + lineGap` and the gap is real — 8 px at 16 px
for some UI faces. A `lineHeight` small enough to make the box shorter than
the glyphs gives negative leading, and the text overflows evenly on both
sides; CSS does the same.

#### Capping lines, and eliding

`maxLines` bounds the line count; `overflow` says what the cut looks like.
The card title, the list row and the one-line label are all the same option
pair — single-line elision is just `maxLines: 1`:

```js
const layout = app.fonts.layout(title, style, {
  maxWidth: 320,
  maxLines: 2,
  overflow: 'ellipsis'
});

if (layout.truncated) showTooltip(title);   // there was more to say
```

- **`overflow: 'clip'`** (the default) keeps the first `maxLines` lines and
  drops the rest. `layout.height` counts only the kept lines, so a
  fixed-height container matches what it shows.
- **`overflow: 'ellipsis'`** additionally rebuilds the last kept line so
  that content plus `…` fits `maxWidth`. Content is dropped from the
  **logical** end and the shortened tail is re-shaped, because kerning and
  ligatures across the cut change widths, and in a mixed-direction line the
  visually-last run is not the logically-last one.
- **`layout.truncated`** says whether anything was dropped — the signal for
  a tooltip, an expander, or a "show more" affordance. It is `true` for a
  `'clip'` cut as well.

Details worth knowing before relying on it:

- The ellipsis takes the **paragraph** direction, not the direction of the
  text it follows, which is where a neutral at the end of a paragraph
  resolves under UAX#9. It sits at the right of an LTR line and at the
  **left** of an RTL one.
- It is shaped in the style of the line's logically-trailing span, so a line
  ending in a larger or bolder run gets a matching ellipsis. That span is
  picked before the cut — picking it after would make the ellipsis width
  depend on a cut that depends on the ellipsis width.
- When neither the span's font nor any fallback covers U+2026, three
  periods stand in. Drawing the real character through a font that lacks it
  would produce a `.notdef` box, which is a poor way to say "there is more".
- Cuts land on grapheme-cluster boundaries, so a combining mark is never
  separated from its base and an emoji ZWJ sequence is never halved.
- Whitespace at the cut is dropped rather than left in front of the
  ellipsis.
- If the ellipsis alone is wider than `maxWidth` it is still drawn, and the
  line overflows — the same call CSS makes. A truncation with no visible
  marker is worse than a narrow overflow.
- For caret purposes the ellipsis stands for the text it replaces:
  `indexAt` anywhere on it returns the last visible index, and
  `caretPosition` for an index past the cut clamps there.

#### Caret positioning and hit testing

For editors and text inputs, `TextLayout` maps logical text positions to
visual caret geometry and back — bidi-, ligature- and trailing-whitespace-
aware, so there is no need to measure `text.slice(0, caret)` prefixes
(which drifts across kerning/shaping boundaries and breaks in mixed-
direction text):

```js
const layout = app.fonts.layout(text, { family: 'sans-serif', size: 16 });

// logical code-point index -> visual caret geometry
const { x, y, height, line } = layout.caretPosition(caretIndex);
ctx.fillRect(x, y, 1, height); // draw the caret

// click-to-caret: layout-box coordinates -> code-point index
const index = layout.indexAt(clickX, clickY);
```

- `caretPosition(index)` → `{ x, y, height, line }`. `index` is a logical
  **code-point** index in `[0, codePointCount]` (out of range clamps —
  count code points with `Array.from(text).length`, not `text.length`).
  `x` is the caret's visual x within the layout box (alignment included),
  `y` the top of the **glyphs**, `height` their `ascent + descent`, `line`
  the line index. The caret tracks the text rather than the line box, so it
  stays locked to the glyphs whatever the leading; for a full-height
  selection band use `line.y` and `line.height` instead.
- `indexAt(x, y)` → logical code-point index of the caret boundary nearest
  to layout-box coordinates: the line is picked by `y` (clamping above the
  first / below the last line), then the nearest boundary by `x` in visual
  order — a click past the midpoint of a glyph cluster snaps to its far
  edge. Inverse of `caretPosition` up to the bidi boundary ambiguity below.

Conventions:

- **Mixed-direction lines** use the bidi levels and visual run order the
  layout already computed for drawing. At a direction boundary a single
  caret is reported, at the trailing edge of the character logically
  *before* the index (at a line start: the leading edge of the following
  character). The indices on either side of a direction boundary may
  therefore map to the same x — the standard single-caret compromise.
- **Ligature/cluster interiors** (one glyph carrying several code points)
  interpolate proportionally by code-point count across the cluster's
  advance; `indexAt` rounds to the nearest interpolated boundary.
- **Trailing whitespace** stripped from a line end still advances the
  caret: positions inside it extend past the visual line edge on the
  paragraph-direction side (`caretPosition(i + 1).x > caretPosition(i).x`
  holds for `'a   '` in LTR).
- **Line breaks**: the index of a `\n` itself sits at the end of its line;
  the index after it belongs to the next line. An index at a soft-wrap
  boundary maps to the start of the wrapped line. (A final `\n` does not
  create a trailing empty line — the layout has none.)

### 2d context

- `ctx.font` — CSS shorthand; `ctx.textAlign`, `ctx.textBaseline`
- `ctx.fillText(text, x, y)` / `ctx.measureText(text)` (canvas-style
  TextMetrics: `width`, `actualBoundingBox*`, `fontBoundingBox*`)
- `ctx.layoutText(content, options)` → `TextLayout` with the current
  `ctx.font` as base style

### `MarkdownView`

```js
import { createClient, MarkdownView } from 'ntk';
const view = new MarkdownView(wnd, { theme: { size: 15, linkColor: '#0b61c9' } });
view.setMarkdown('# Hello\n\nSome *markdown*.');
wnd.map(); // renders on expose, re-wraps on resize
```

Parsing is CommonMark + GFM via [marked](https://marked.js.org). Rendered
blocks: headings, paragraphs, fenced code, blockquotes, nested
ordered/unordered lists, `---` rules, and GFM tables (natural column
widths, per-column `:--`/`:-:`/`--:` alignment, shrink-and-wrap when the
table is wider than the window). Inlines: `**strong**`, `*em*`, `` `code` `` (with
background), `[links](url)` (colored + underlined); images render as links
to their source.
All layout — wrapping, font selection per style, spacing — runs through
`TextLayout`; drawing batches glyphs per color.

Fenced code blocks are **syntax highlighted** through
[highlight.js](https://highlightjs.org) (the `common` build: ~36 languages
plus their aliases — `js`/`ts`, `json`, `python`, `shell`, `c`/`cpp`,
`java`, `go`, `rust`, `css`, `sql`, `html`/`xml`, …), adapted to flat
tokens by `lib/widgets/highlight.js` (exported as `highlightCode`).
Unknown tags render plain. Colors come from `theme.codeTheme`, a map from
token kind (`keyword`, `literal`, `string`, `number`, `comment`, `tag`,
`attr`, `function`) to color — partial overrides merge with the defaults.

Fences tagged `math`, `tex`, `latex` or `katex` render as **display-mode
formulas** via KaTeX (centered, at 1.21× the base size like katex.css);
a formula that fails to parse falls back to a plain code block. See
[tex.md](tex.md).

Links are clickable. Every `draw()` records the device-space rectangles of
rendered links; `view.linkAt(x, y)` returns the href under a point (or
null). In window mode a left-button `mousedown` is resolved automatically
and forwarded to `view.onLink(href, event)` — set it via the `onLink`
constructor option or assign the property; standalone embedders call
`linkAt` from their own event handlers. Navigation semantics (opening
files, browsers, history) are the embedder's job —
[examples/markdown.js](../examples/markdown.js) is a small documentation
browser built this way.

Headless/embedded use: `new MarkdownView(null, { fonts })`, then
`view.layout(width)` → content height, `view.draw(ctx, x, y)`. Layout is
synchronous throughout, so one pass is enough — nothing arrives later.

`TextLayout` note for widget authors: spans keep unknown fields through
layout normalization, and line runs expose their span (`run.span`), so
markers attached to spans (like MarkdownView's `_href`) can be read back
per positioned run after layout.

![the markdown widget rendering examples/markdown.js](img/markdown-widget.png)

## Design notes: revisiting the old issues (2015–2018)

The text issues in the tracker predate this stack; here is how they
resolved in 2026:

- **#12 harfbuzz, #35 fontkit-as-substitute** — fontkit's layout engine
  (a JS port of harfbuzz's shapers, including the universal shaping engine)
  is used for all shaping. It is pure JS — no native module, no WASM blob —
  and handles kerning, ligatures and Arabic-class contextual shaping. For
  the most demanding Indic edge cases harfbuzz remains the gold standard;
  if that gap ever matters, `harfbuzzjs` (WASM) can slot in behind the same
  `Font.shape()` interface.
- **#13 fribidi** — replaced by `bidi-js`, a pure-JS UAX#9 implementation.
  No native dependency needed.
- **#11 char coverage / #18 substituteFont** — both asked for
  `font-manager` (a native module). Solved instead with fontconfig's CLI:
  `fc-match -s --format '%{file}\t%{postscriptname}\t%{charset}\n'` returns
  the whole fallback chain *with coverage data* in one ~50ms call (cached).
  `fontkit.hasGlyphForCodePoint` confirms before use.
- **#16 custom fonts api** — `app.fonts.load(path)`, mirroring
  node-canvas's `registerFont`.
- **#14/#25/#34 vector outlines for large sizes** — superseded by **#45**,
  which replaced the old premise with measured crossovers and is now
  implemented: bitmaps stay the default where reuse amortizes uploads
  (≤128px, and any size that repeats), trapezoids take over for very large
  and continuously animated sizes. See
  [the vector text path](#the-vector-trapezoid-text-path).

x11 dependency: already at the latest published release (3.1.0 — brings the
pure-JS X server with RENDER used by [headless runs](xserver.md) and the
playground).
