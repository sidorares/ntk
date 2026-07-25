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
   winding, 4x4 supersampled antialiasing).
4. **Upload**: bitmaps go to the X server as XRender glyphs (`AddGlyphs`) —
   once per glyph per (face, size), shared across all windows of the
   connection. Drawing afterwards is a cheap server-side `CompositeGlyphs`
   (~1 byte per glyph).

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

## Font objects and matching

- `app.fonts.match(family, { weight, style })` → `Font`
- `app.fonts.fallbackFor(codepoint, family, opts)` → `Font | null` — best
  installed font covering a codepoint (fontconfig coverage data, confirmed
  against the parsed font)
- `Font`: `familyName`, `postscriptName`, `unitsPerEm`, `hasGlyph(cp)`,
  `metrics(size)`, `shape(text, size, opts)`, `rasterize(glyphId, size)`

`FontManager` and `Font` are exported from the package root; both work
without an X connection (headless measurement/layout).
