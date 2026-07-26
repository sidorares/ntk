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
   winding, 4x4 supersampled antialiasing; 2x2 above 96px where the extra
   samples are invisible).
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

Requires `fc-match` on the system (any Linux with X11 has it; macOS:
`brew install fontconfig`). Matches are cached.

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

`StaticFontSource` matches with fontconfig-like semantics: requested
families first (in list order), then closest weight and style; every added
face doubles as a fallback candidate with real coverage data, so
per-codepoint fallback behaves exactly like the system path.

A source is any object with:

- `matchSorted({ family, weight, style })` → non-empty array of candidates,
  best first — the fallback chain. `family` may be a comma-separated list.
  A candidate is `{ key?, path?, data?, font?, postscriptName? }` — one of
  `path` (font file, node only), `data` (font file bytes) or `font` (an
  open `Font`).
- `covers(candidate, codepoint)` → boolean *(optional)* — cheap coverage
  pre-filter for fallback; when absent, candidates are opened and checked
  with `hasGlyph()`.

Related environment hooks: `app.fonts.load()` accepts font bytes as well as
a path, `loadImage()` accepts encoded bytes, `HtmlView` takes a
`loadResource` callback, and TeX rendering accepts injected KaTeX assets
via `configureTex({ katex, fonts })` ([tex.md](tex.md)).

## Font objects and matching

- `app.fonts.match(family, { weight, style })` → `Font`
- `app.fonts.fallbackFor(codepoint, family, opts)` → `Font | null` — best
  installed font covering a codepoint (fontconfig coverage data, confirmed
  against the parsed font)
- `Font`: `familyName`, `postscriptName`, `unitsPerEm`, `hasGlyph(cp)`,
  `metrics(size)`, `shape(text, size, opts)`, `rasterize(glyphId, size)`

`FontManager` and `Font` are exported from the package root; both work
without an X connection (headless measurement/layout).
