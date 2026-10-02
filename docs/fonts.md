# Fonts

Font lookup and loading — for shaping, layout and drawing see
[text.md](text.md).

The pipeline is pure JavaScript — no compiled modules:

1. **Lookup** (`lib/fontconfig.js`): a CSS-ish pattern (`family`, `weight`,
   `style`) resolves to font files by shelling out to `fc-match`
   (fontconfig CLI). `fc-match -s` provides the full sorted fallback chain
   including each font's unicode coverage, cached per pattern.
2. **Parsing** (`lib/text/font.js`):
   [fontkit](https://github.com/foliojs/fontkit) parses
   `.ttf`/`.otf`/`.woff`/`.woff2`/`.ttc` (collection faces are selected by
   postscript name). ntk runs the
   [windowkit fork](https://github.com/windowkit/fontkit), for fixes
   upstream has not released, and carries its build in `lib/vendor/`
   rather than installing it: fontkit's own dependencies are ntk's.
3. **Rasterization** (`lib/rasterize.js`): glyph outlines are rasterized to
   8-bit alpha bitmaps by a small built-in scanline rasterizer (non-zero
   winding, signed-area accumulation — antialiasing is exact analytic
   coverage rather than sampled, so there is no quality dial and no size at
   which it is worth turning down).
4. **Upload**: bitmaps go to the X server as XRender glyphs (`AddGlyphs`) —
   once per glyph per (face, size), shared across all windows of the
   connection. Drawing afterwards is a cheap server-side `CompositeGlyphs`
   (~1 byte per glyph). Very large or animated sizes skip this cache and
   render as trapezoids instead — see
   [text.md](text.md#the-vector-trapezoid-text-path).

Glyphs are rasterized and uploaded **lazily**, as text is drawn — never a
whole font up front.

## Using CSS-style font names

```js
ctx.font = 'bold italic 40px "DejaVu Sans", sans-serif';
ctx.fillText('Hello', 10, 50);
```

Requires `fc-match` on the system and font files for it to find. A Linux
desktop has both; a slim container, a single-file build and stock macOS do
not — see [Environments without fontconfig](#environments-without-fontconfig).
Matches are cached, and the default family (`sans-serif`) is prewarmed in
the four faces text is set in — regular, bold, italic, bold italic — with
non-blocking `fc-match` runs started while `createClient` connects, so the
first text layout does not stall on them. The answers are written to files,
and wait there until a layout asks for one. A layout that asks before the
loop has run (the first frame's, which holds it) takes a prewarm's answer
rather than spawning `fc-match` again, and a face no text is set in is
never read at all. Even a face that is set in is read only as far as its
first line: an answer is the whole fallback chain with each face's coverage,
634 KB for `sans-serif` on a Linux desktop, and the rest of it is read when
a character first falls back. Beside the chains, a prewarm asks fontconfig
for the one face it would pick for the face a layout will ask for first,
which it answers in about half the time (15 ms against 30 here). That makes
a family warmed while its component renders ready by its first layout. The
first time any other family is
used, its four faces start together the same way — but that first use still
waits for them, so a caller that knows a family is coming can start it
earlier with `app.fonts.prewarm(family)`: a code editor's monospace, asked
for before its first render, is ready by its first layout. The family is
spelled the way a layout spells it, so `'"JetBrains Mono", monospace'` warms
what text set in that list asks for. A face outside the four still pays one
synchronous `fc-match` the first time it is used, unless it is named:
`app.fonts.prewarm(family, [{ weight: 500 }])` starts that face alone — the
medium a menu is set in. The matches a prewarm starts run side by side from
one child process, because it is the spawn that costs the app: Node forks
the whole process to start a child, at a cost that grows with its heap —
four spawns took 33 ms of the main thread at 260 MB, and one shell starting
the same four took 8. A glyph
fallback asks for the pattern of the face it falls back from, so the list
that face's match or prewarm fetched answers it. And `fc-match` is spawned
by the path it was found at rather than by its name: spawned by name on
macOS, the system's search for it spawns in every `PATH` directory ahead of
the one holding it, which took a spawn from 15 ms to 45 on a typical
developer's `PATH`.

On macOS, `sans-serif` resolves to Helvetica, as it does in Safari, Chrome
and Firefox there, rather than to whatever fontconfig answers for it.
Homebrew's fontconfig ranks every face with "Sans" in its name first for that
generic, and on a Mac the first of them is Hiragino Sans — a Japanese face
whose Cyrillic, Greek, `…` and `—` are full-width, so a word like "Мост" was
set as four em-wide cells. The advances were the font's own; the face was the
wrong one. ntk names Helvetica ahead of the generic in the pattern it hands
`fc-match`, so a character Helvetica lacks still falls back through
fontconfig's own `sans-serif` list — CJK to Hiragino, as before. Every other
family, and every other platform, reaches `fc-match` as written.

A weight is translated onto fontconfig's scale, where regular is 80 and
black is 210, by fontconfig's own table — the one it reads every face's OS/2
weight through, so 400 is 80, 700 is 200 and 350 is 55 — and a weight
between two of its entries is as far between theirs, rounded to a whole
number: `font-weight: 450` asks for 90, halfway from regular to medium.
Weights up to 100 ask for thin, and 1000 for extrablack, 215.

The face is the one CSS's font matching picks
([CSS Fonts 4 §5.2](https://www.w3.org/TR/css-fonts-4/#font-style-matching)),
as a browser's is: the normal width first, then the style — italic, then
oblique, then upright, for an italic ask — and then the weight, looking in a
direction first: from the weight asked up to 500 and then lighter for 400 to
500, lighter first below 400, heavier first above 500. Fontconfig alone takes
the face *nearest* the weight, after the slant and before the width, and the
two differ where a weight sits between two a family has, on the side CSS
does not look first: 520 in Arial is its regular to fontconfig and its bold
to CSS, 420 in Helvetica Neue its regular and its medium, 800 in Avenir Next
its bold and its heavy, and 900 in Helvetica Neue its condensed black and its
bold. One `fc-match` cannot say which weights a family has — `fc-match -s`
leaves out every face whose coverage the faces before it already give, which
is the rest of a family — so the first prewarm's child also lists every face
once, with `fc-list`: 45 ms for 1,900 faces on a Mac, beside the matches and
spawning nothing of the app's. Most faces never read it. Where fontconfig
answered with the weight asked for, or with a face nothing CSS tries first
could be nearer than — 500 in Helvetica, whose regular is nearer than a 500
would be — its face is CSS's already. A face that does read the listing costs
a layout about a millisecond, once a family, or waits for the listing if it
is asked for in the 45 ms it takes. The family is the one the pattern named:
`Avenir Next Ultra Light`, the name two of Avenir Next's faces also go by, is
those two. A weight a variable font's axis holds is set on the axis, as
before. Where there is no `fc-list` — it ships beside `fc-match` in every
fontconfig package — the face is fontconfig's nearest.

Text layout is synchronous, so it always pays that cost inline. Code that
can await — a font picker matching as the user types, a preferences page —
should ask the source instead, and not block the event loop at all:

```js
const source = app.fonts.source;                       // or defaultFontSource()
const candidates = await source.matchSortedAsync({ family: 'Iosevka' });
```

The spawn runs off the event loop and seeds the same cache, so a later
layout for that pattern is a cache hit. Every source implements it, including
`StaticFontSource` (which resolves immediately), so the calling code does not
have to know which one it is holding.

## Loading a font file directly

```js
const font = app.fonts.load('./assets/Inter.ttf');
ctx.font = '24px Inter';           // registered families win over fontconfig
// or bypass matching entirely:
app.fonts.shape('Hello', { font, size: 24 });
```

`app.fonts.load(path, opts)` accepts `{ postscriptName }` to pick a `.ttc`
face, `{ family }` to register under an alias, and `{ weight, style }` to
override what the file reports.

Faces loaded into one family are matched as the font sources match theirs:
the style asked for, italic or upright, and then the weight CSS's font
matching picks, looking in a direction first as
[described above](#using-css-style-font-names): up to 500 and then lighter
for 400 to 500, lighter first below 400, heavier first above 500. So a
regular and a bold loaded this way set 520 in the bold, as the same two
files do found through fontconfig or handed over as a
[font spec](#pluggable-font-sources), where `load` used to take the face
*nearest* the weight. A variable face loaded without a `weight` holds every
weight on its `wght` axis; a `weight` passed to `load` is the face's, as
`@font-face`'s descriptor is, so a variable face loaded at 400 is matched as
a face at 400 (and still drawn at the weight asked for). Faces alike in all
of that go to the one loaded first, and of a family list, the first family
with a face loaded is the one matched.

## Pluggable font sources

Step 1 (lookup) is pluggable. All system-font resolution goes through a
**FontSource** — by default `FontconfigFontSource`, the `fc-match` behavior
described above. Environments without a shell or filesystem (a browser
bundle, a hermetic test) swap in another source; steps 2–4 are pure JS and
work unchanged.

```js
import { createClient, StaticFontSource, setDefaultFontSource } from 'ntk';

const source = new StaticFontSource();
source.add(dejavuSansBytes);                          // Uint8Array of a .ttf/.otf/.woff
source.add(dejavuBoldBytes, { weight: 700 });         // metadata overrides are optional
source.alias('sans-serif', 'DejaVu Sans');

const app = await createClient({ fontSource: source });   // per-app
// or per-manager:            new FontManager({ source })
// or process-wide (also covers widget-internal managers):
setDefaultFontSource(source);
```

All three of those also take a **font spec** — a shorthand for the same
thing, when the fonts are files or bytes you already have:

```js
await createClient({ fontSource: '/app/fonts' });     // every face in a directory
await createClient({ fontSource: './Inter.ttf' });    // one file
await createClient({ fontSource: [bytes, more] });    // bytes, no filesystem
await createClient({ fontSource: 'system' });         // the default, said out loud
```

`createFontSource(spec)` is that resolution on its own, and it is idempotent
— a FontSource passes straight through — which is why the same value works
everywhere a source does.

`StaticFontSource` matches as the system path does: requested families
first (in list order), then within a family the style — italic or upright,
as asked — and then the weight CSS's font matching picks, looking in a
direction first as [described above](#using-css-style-font-names): up to 500
and then lighter for 400 to 500, lighter first below 400, heavier first
above 500. So a family of a regular and a bold sets 520 in the bold whether
fontconfig found it or the app handed it over, where this source used to
take the face *nearest* the weight. A variable face added without a `weight`
holds every weight on its `wght` axis; a `weight` passed to `add` is the
face's, as `@font-face`'s descriptor is, so a variable face added at 400 is
matched as a face at 400 (and still drawn at the weight asked for). Faces
alike in all of that come back in the order they were added. Every added
face doubles as a fallback candidate with real coverage data, so
per-codepoint fallback behaves exactly like the system path.

A source is any object with:

- `matchSorted({ family, weight, style })` → non-empty array of candidates,
  best first — the fallback chain. `family` may be a comma-separated list.
  A candidate is
  `{ key?, path?, data?, font?, postscriptName?, family?, families? }` — one
  of `path` (font file, node only), `data` (font file bytes) or `font` (an
  open `Font`) says how to open it; `family`/`families` say what to call it
  (see [Naming a match](#naming-a-match)).
- `matchSortedAsync({ family, weight, style })` → a promise for the same
  list. Layout always uses the synchronous one; this is the entry point for
  an app that can await, and it rejects with the same `ERR_NTK_NO_FONTS`
  rather than deferring the failure to a blocking call.
- `covers(candidate, codepoint)` → boolean *(optional)* — cheap coverage
  pre-filter for fallback; when absent, candidates are opened and checked
  with `hasGlyph()`.

### Naming a match

Every candidate carries the family name its source already knew, so a match
list can be *shown* — a font picker, a specimen, or a diagnostic answering
"which face did `sans-serif` actually resolve to" — without opening the
files:

```js
const ranked = app.fonts.source.matchSorted({ family: 'sans-serif' });
for (const c of ranked.slice(0, 5)) console.log(c.family, '—', c.path);
```

- `family` — the name to display. From fontconfig this is the first name in
  its family list, which is the one it leads with for the current locale.
- `families` — every name the face answers to, in fontconfig's order.
  Families are a list there: `Hiragino Sans`, `ヒラギノ角ゴシック` and the
  style-suffixed forms of both are one face. A `StaticFontSource` candidate
  has a one-element list.

Neither field is needed to *choose* a font — the machinery matches on paths
and coverage — which is why the cost matters: naming the list by opening it
is ~1.2ms per file, and `sans-serif` matches 139 faces on a stock macOS box.
fontconfig hands both names over in the same call as the rest of the match.

A picker showing that list is also the caller that should not be blocking on
it: `matchSortedAsync` returns the same named candidates without the
synchronous spawn.

Related environment hooks: `app.fonts.load()` accepts font bytes as well as
a path, and `loadImage()` accepts encoded bytes — so an app that ships its
own assets never has to reach the filesystem through ntk.

## Environments without fontconfig

The default lookup needs two things from the host: the **`fc-match` binary**,
and **font files** for it to find. **ntk ships neither.** Which typefaces an
app draws with is the app's decision, so the toolkit has no fonts of its own
to fall back on.

Both are missing more often than a desktop suggests:

| | |
| --- | --- |
| `node:*-slim`, `*-alpine` | neither, until you install them |
| `gcr.io/distroless/*`, `scratch` | no package manager to install them with |
| single-executable builds | one file, shipped to a machine you do not control |
| kiosk / embedded images | fonts trimmed for size |
| CI runners | often have fontconfig and no font packages |
| stock macOS | 370-odd fonts in `/System/Library/Fonts` and no `fc-match` — it arrives with Homebrew or XQuartz |

They are missing **independently**: a `fonts-*` package does not pull in
fontconfig, and fontconfig does not pull in fonts. An image that picked up
`libfontconfig1` through cairo or pango still has no `fc-match` CLI. Each
combination gets its own message, all of them carrying `code:
'ERR_NTK_NO_FONTS'`:

```
ntk: no fonts available — the fc-match CLI (fontconfig) is not installed here.
…
```

Catch it if you would rather show something than crash:

```js
try {
  app.fonts.match('sans-serif');
} catch (err) {
  if (err.code === 'ERR_NTK_NO_FONTS') showFontSetupScreen();
  else throw err;
}
```

### Where there is a package manager, install one

This is the honest first answer and it needs no ntk API at all:

```dockerfile
RUN apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core
# Alpine: apk add fontconfig font-dejavu
```

Two lines against any amount of application code. Note that
`fonts-dejavu-core` ships six faces and no italics; add `fonts-dejavu-extra`
if you draw italic text.

### Otherwise, hand ntk the faces

Copy the fonts in and point at them. No fontconfig, nothing to install:

```dockerfile
COPY fonts/ /app/fonts/
```

```js
const app = await createClient({ fontSource: '/app/fonts' });
```

A directory is read once, at connect — so a wrong path is a rejected
`createClient` rather than a surprise inside your first paint. Entries are
sorted by name before anything is parsed, because the filesystem must never
be what decides which face `sans-serif` lands on. Subdirectories need
`{ fonts: dir, recursive: true }`.

**Point it at your own faces, not at a system font tree.** Every file found
is parsed and then held for the life of the process, which is right for the
handful an app ships and wrong for `/usr/share/fonts` — on macOS a single
`Apple Color Emoji.ttc` is 188 MB. Past 64 files ntk stops and says so;
`maxFiles` raises it if you mean it.

### Single-executable builds

A SEA resolves built-in modules only, so there is nothing to read at runtime
and no optional font package to import — the faces have to be *in* the
binary, as assets:

```json
{ "main": "app.cjs", "output": "app",
  "assets": { "DejaVuSans.ttf": "./fonts/DejaVuSans.ttf" } }
```

```js
const sea = process.getBuiltinModule('node:sea');
const app = await createClient({ fontSource: [sea.getRawAsset('DejaVuSans.ttf')] });
```

`getRawAsset` hands back an `ArrayBuffer` with no copy. Name the keys
explicitly rather than enumerating them: `getAsset`/`getRawAsset` are
available from Node 20.12, but `getAssetKeys()` only from 22.20.

### Generic families

`sans-serif`, `serif` and `monospace` are what every widget default asks for,
so a source built from a spec infers them: `monospace` from the font's own
metrics (`isFixedPitch`, then whether `i` and `W` are the same width — fonts
lie about the flag), `sans-serif` and `serif` from the family name in the
font's `name` table, never the filename.

A generic with no evidence is deliberately **left unaliased** rather than
guessed at. Inspect what was decided, and override it:

```js
const source = createFontSource('/app/fonts');
source.aliases;   // { 'sans-serif': 'dejavu sans', monospace: 'dejavu sans mono' }

await createClient({ fontSource: { fonts: '/app/fonts', alias: { serif: 'Charter' } } });
```

Explicit aliases always win. A hand-built `StaticFontSource` infers nothing
unless it calls `inferGenerics()`.

### Two things that surprise people

**Registering fonts is not the same as replacing the source.**
`app.fonts.load()` wins for the exact family string you register it under —
and nothing else:

```js
app.fonts.load('/app/fonts/DejaVuSans.ttf', { family: 'sans-serif' });
ctx.font = '16px sans-serif';   // fine
ctx.font = '16px Arial';        // still goes to the source, and still fails
```

The same is true of any codepoint that face lacks: a bullet or a curly quote
sends ntk to the source for a fallback. Where there is no source to ask, that
now draws `.notdef` — a visible empty box — instead of throwing, but the way
to actually get those glyphs is to give the source the fonts.

**A `.ttc` collection contributes its first face only** when found by path or
directory scan. Name the others explicitly:

```js
fontSource: [{ path: './Iosevka.ttc', postscriptName: 'Iosevka-Term' }]
```

And a `/usr/share/fonts` that is not empty can still yield "no fonts": ntk
reads `.ttf`, `.otf`, `.woff`, `.woff2`, `.ttc` and `.dfont`, and bitmap
`.pcf`/`.bdf` fonts are not among them.

### The determinism dividend

Supplying the faces buys more than portability. ntk's rasterizer has no
hinting and computes exact analytic coverage, and a `StaticFontSource` never
borrows a face from the host — so with a fixed set of fonts, text rasterizes
to identical bytes on every machine. That is the precondition for
image-snapshot testing an ntk app, and it is also the fix for
family-resolution surprises: whatever a machine's fontconfig makes of
`sans-serif` — Homebrew's answers Hiragino Sans, a CJK face, which is why ntk
names Helvetica first there ([above](#using-css-style-font-names)) — a static
source never asks it.

The guarantee holds across machines **at a pinned ntk version**, not across
versions — the rasterizer has shifted text antialiasing before. Pin ntk
exactly in a snapshot suite. System fonts make ntk *run*; they never make it
reproducible.

## Variable fonts

A variable font is one file with a continuous design space — an axis per
degree of freedom, `wght` from 100 to 900 being the common one — and a
static *instance* of it is that design cut at a point. ntk instantiates on
demand, and **a numeric weight is already an axis coordinate**:

```js
ctx.font = '460 40px monelogics'; // wght 460 — not "the nearest face"
```

Nothing else is required. Hand ntk a variable file through any font source
and `weight` drives its `wght` axis, so a family with one file behaves like
a family with nine faces — and like nine hundred, since the weights between
the named instances are the point of an axis.

The other axes are named directly, in a style or on the context:

```js
ctx.fontVariationSettings = '"wdth" 87.5'; // or { wdth: 87.5 }
app.fonts.match('Recursive', { weight: 500, variations: { slnt: -8 } });
new TextLayout(app.fonts, spans, { family: 'Inter', variations: { opsz: 32 } });
```

A span may carry its own, so one paragraph can move an axis mid-line.
Settings for axes a font does not have are ignored and values are clamped to
each axis's range, so any of this is safe to set without checking first —
and `font.variationAxes` is there when you want to (`{}` for a static face).

### Optical size follows the size

`opsz` is the second axis a style drives without naming it. A face with an
optical-size axis is drawn at the size it is *set* at — small text in the
family's Text cut, headlines in its Display cut — which is what CSS does
with `font-optical-sizing: auto`, its initial value:

```js
ctx.font = '13px "SF Pro"'; // opsz 13, clamped into the axis
ctx.font = '96px "SF Pro"'; // opsz 96
```

This matters more than it sounds like it does. The only San Francisco
fontconfig can see on a stock macOS box is `SFNS.ttf`, a variable file whose
`opsz` axis runs 17–96 and **defaults to 28** — a display cut. Without a
coordinate, every 13px menu label, button and list row was set in display
letterforms: tighter tracking, smaller apertures, lighter stems, visibly not
what the same font looks like in a native menu beside it. Inter, Roboto
Flex, Newsreader and most recent variable text families ship the axis too.

Three ways to take it over, in the order they win:

```js
// 1. name the axis, as CSS's font-variation-settings does
ctx.fontVariationSettings = { opsz: 17 };
// 2. turn it off — the face stays at whatever its file defaults to
ctx.fontOpticalSizing = 'none';
// 3. give the axis a different size from the glyphs
app.fonts.match('Inter', { size: 26, opticalSize: 13 });
```

The third is for callers that have already multiplied by a device scale.
`size` on the lookup path is CSS px, so a 13px label pre-scaled for a 2×
display arrives as 26 and would pick a display cut; pass the unscaled size
as `opticalSize` and keep the scaled one for the glyphs. `opticalSize` and
`opticalSizing` are style fields like `variations` — a `TextLayout` span may
carry either.

Clamping does the rest, and does it well: 13 against SF's `17..96` lands on
17, which is exactly where Apple's own Text cut sits.

### What it costs

An instance is a font in its own right: its own shaping, its own rasterized
glyphs, its own server-side glyphset. So the design is that **nothing
happens until something is drawn**:

- instantiating touches tables, never glyphs;
- glyphs rasterize one at a time, on first use, at the size drawn — the same
  per-`(face, size)` page every static face uses, keyed by a font key that
  carries the coordinates, so two points of an axis never collide;
- a coordinate on its own axis default returns the base face rather than a
  copy of it, and equal coordinates return the same instance;
- coordinates are rounded to two decimals, so a slider handing over
  `459.9999999` does not mint a face `460` will never hit again.

Both caches are bounded. Client-side, a face keeps its 64 most recent
instances; server-side, glyph pages are already under the `cacheBytes`
budget of `app.textPolicy`. An app animating an axis therefore reaches a
steady state instead of growing, and dropping an instance strands nothing:
the key is derived from the coordinates, so the same point re-instantiated
finds the same page.

What this does *not* do is quantize for you. A slider bound straight to
`wght` with `step={1}` really will ask for 801 distinct faces as it is
dragged, and each is a legitimate rasterization at a size you are drawing.
Step the control, not the font.

### Any container instantiates

A variable font is instantiated out of whatever ntk reads it from: `.ttf`
and `.otf`, and `.woff` and `.woff2`, which is how a variable web font is
nearly always served. The instance is the same font whichever it came in —
the tests compare every glyph of one across the three.

fontkit does not do that by itself. It cuts an instance by reading the file
again as a plain sfnt, which neither container is: a WOFF has another
directory and a WOFF2 is Brotli-compressed, so the instance came back with
no tables and threw at the first character drawn — a web page set in a
variable font drew nothing at any weight but the file's default. So a
variable face that arrives in a container is read from the sfnt inside it
(`lib/text/sfnt.js`): a WOFF's tables inflated, a WOFF2's decompressed and
its `glyf` and `loca` written back from the streams the format keeps them
as. That is done once, when the face is opened — 10 ms for Geist's 70 KB
variable WOFF2 — and costs the font's uncompressed size in memory, which
fontkit holds for a WOFF2 it has read anyway.

A static face stays in its container: nothing is asked of it that the
container does not answer. A container that cannot be taken apart — a
WOFF2 whose `hmtx` is transformed, which fontkit does not read either —
stays too, and `variation()` says so at the call: `cannot instantiate a
variation of …`.

## Font objects and matching

- `createFontSource(spec)` → `FontSource` — resolve a font spec; idempotent,
  and `null`/`undefined` pass through
- `StaticFontSource`: `add(bytes, opts)`, `alias(generic, family)`,
  `inferGenerics()`, `aliases`, `skipped` (files a spec could not parse)
- `app.fonts.match(family, { weight, style, size, variations, opticalSize,
  opticalSizing })` → `Font` — `size` drives `opsz` (CSS px);
  `opticalSizing: 'none'` leaves that axis alone
- `app.fonts.fallbackFor(codepoint, family, opts)` → `Font | null` — best
  installed font covering a codepoint (fontconfig coverage data, confirmed
  against the parsed font)
- `Font`: `familyName`, `postscriptName`, `unitsPerEm`, `hasGlyph(cp)`,
  `glyphIdFor(cp)` → `number | null` (unshaped cmap lookup, `null` where
  the face lacks the codepoint — see [text.md](text.md#glyph-runs)),
  `drawable` (whether a glyph can be made from the face at all: `glyf`,
  `CFF `/`CFF2`, `sbix` or `COLR`/`CPAL`. A face that is not, such as a
  bitmap-only colour emoji font, answers `hasGlyph` false for everything,
  and `match()` hands out the best candidate that is),
  `metrics(size)`, `shape(text, size, opts)`, `advanceOf(glyphId, size)`,
  `rasterize(glyphId, size)`
- `Font`, variable faces: `variationAxes` (`{}` when static),
  `variation(settings)` → `Font` (itself when the settings are a no-op),
  and on an instance, `variationOf` / `variationCoords`

`FontManager` and `Font` are exported from the package root; both work
without an X connection (headless measurement/layout).
