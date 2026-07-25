# Fonts and text

The text pipeline is pure JavaScript — no compiled modules:

1. **Lookup** (`lib/fontconfig.js`): a CSS-ish font pattern
   (`family`, `weight`, `style`) is resolved to a font file path by shelling
   out to `fc-match` (fontconfig CLI). Formats opentype.js cannot parse
   (`.ttc` collections) are skipped in favor of the next best match.
2. **Parsing** (`lib/fontface.js`): the file is parsed with
   [opentype.js](https://www.npmjs.com/package/opentype.js).
3. **Rasterization** (`lib/rasterize.js`): glyph outlines are rasterized to
   8-bit alpha bitmaps by a small built-in scanline rasterizer (non-zero
   winding, 4x4 supersampled antialiasing).
4. **Upload**: bitmaps are uploaded to the X server as XRender glyphs
   (`AddGlyphs`) — once per glyph per size. Drawing text afterwards is a
   cheap server-side `CompositeGlyphs32`.

Glyphs are rasterized and uploaded **lazily**, per size, as text is drawn —
not the whole font up front.

## Using CSS-style font names

```js
ctx.font = 'bold italic 40px "DejaVu Sans"';
ctx.fillText('Hello', 10, 50);
```

Requires `fc-match` on the system (any Linux with X11 has it; macOS:
`brew install fontconfig`). Faces are cached per app connection.

## Loading a font file directly

```js
const glyphset = ctx.loadFont('/usr/share/fonts/TTF/DejaVuSans.ttf', 24);
ctx.setFont(glyphset);
ctx.fillText('Hello', 10, 50);
```

No fontconfig involved — useful for bundled fonts and tests.

## FontFace

`FontFace` (exported from the package root) is the underlying primitive:

- `new FontFace(app)`
- `face.loadFont(path)` — parse a `.ttf`/`.otf`/`.woff` file
- `face.upload(size)` → `GlyphSet` — the (lazily filled) server-side glyphset
- `face.getGlyph(size, codepoint)` — rasterized glyph record (`advance` in px)
- `face.ensureGlyphs(size, text)` — upload any missing glyphs, return glyph ids
