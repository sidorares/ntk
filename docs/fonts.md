# Fonts

Font lookup and loading — for shaping, layout and drawing see
[text.md](text.md).

The pipeline is pure JavaScript — no compiled modules:

1. **Lookup** (`lib/fontconfig.js`): a CSS-ish pattern (`family`, `weight`,
   `style`) resolves to font files by shelling out to `fc-match`
   (fontconfig CLI). `fc-match -s` provides the full sorted fallback chain
   including each font's unicode coverage, cached per pattern.
2. **Parsing** (`lib/text/font.js`):
   [fontkit](https://www.npmjs.com/package/fontkit) parses
   `.ttf`/`.otf`/`.woff`/`.ttc` (collection faces are selected by
   postscript name).
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
Matches are cached, and the match for the default pattern (`sans-serif`,
regular weight) is prewarmed with a non-blocking `fc-match` while
`createClient` connects, so the first text layout does not stall on the
spawn. Other patterns still pay one synchronous `fc-match` (~50ms) the
first time they are used.

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

`StaticFontSource` matches with fontconfig-like semantics: requested
families first (in list order), then closest weight and style; every added
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
family-resolution surprises: on a Mac with fontconfig installed,
`fc-match sans-serif` answers Hiragino Sans — a CJK face.

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

### `.woff2` cannot be instantiated

fontkit rebuilds the face from the original stream, which for a WOFF2 is
still Brotli-compressed, so the instance comes back unusable. ntk detects
this and says so at the call rather than letting it surface as a null
dereference deep in shaping — but the fix is to ship the `.ttf`/`.otf` of a
variable font rather than its `.woff2`. Static `.woff2` faces are unaffected;
this is only about instantiating an axis.

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
  `metrics(size)`, `shape(text, size, opts)`, `advanceOf(glyphId, size)`,
  `rasterize(glyphId, size)`
- `Font`, variable faces: `variationAxes` (`{}` when static),
  `variation(settings)` → `Font` (itself when the settings are a no-op),
  and on an instance, `variationOf` / `variationCoords`

`FontManager` and `Font` are exported from the package root; both work
without an X connection (headless measurement/layout).
