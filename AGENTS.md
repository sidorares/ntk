# AGENTS.md

Guidance for AI agents (and humans) working on this repository.

## What this project is

**ntk** is a node.js desktop UI toolkit for X11. It wraps
[node-x11](https://github.com/sidorares/node-x11) (a pure-JS X protocol
client) with familiar, modern API concepts:

- browser-style events (`mousedown`, `keydown`, `expose`, …) on windows
- an HTML-canvas-like **2d context** backed by the XRender extension —
  composition, gradients and glyph drawing happen **server-side**
- a webgl-ish **opengl context** over indirect GLX (OpenGL 1.4 command
  serialization, no client GL library)

### Direction

1. Keep growing toward "write simple X11 UIs with the APIs you know from the
   web" — canvas 2d parity first (paths/Path2D, transforms, save/restore,
   clip, `globalAlpha` and Porter-Duff `globalCompositeOperation` are done;
   still missing: line dashes, round caps/joins, shadows, text under
   rotation/scale, blend-mode composite ops), webgl-like ideas where they
   fit.
2. This library is intended to become the host for a **separate react
   renderer** project (react-x11). Do not add react integration here, but
   keep the architecture renderer-friendly: retained `Window` objects with
   declarative `setState()`, cheap child-window creation, deterministic
   resource cleanup, events that carry their target object.

## Layout

```
lib/index.js               createClient() -> App; package entry (ESM)
lib/app.js                 App: one X connection, window/pixmap factory
lib/window.js              Window (extends Drawable): events, geometry, WM bits
lib/pixmap.js              offscreen drawable
lib/drawable.js            EventEmitter base + getContext() registry
lib/events_map.js          X event code <-> browser-ish event name tables
lib/renderingcontext_2d.js canvas-like context (XRender); CanvasGradient
lib/path.js                Path2D, SVG path-data parser, affine matrices,
                           adaptive bezier flattening
lib/renderingcontext_opengl.js  indirect GLX context
lib/renderingcontext_x11.js     raw core-X drawing context
lib/picture.js             XRender Picture wrapper (+ blur filter)
lib/glyphset.js            XRender GlyphSet wrapper
lib/rasterize.js           pure-JS glyph outline -> a8 bitmap rasterizer
lib/trapezoid.js           polygon -> XRender trapezoids (non-zero/even-odd;
                           vector text and all 2d path fills)
lib/fontconfig.js          font matching + fallback chain via fc-match CLI
lib/text/fontsource.js     pluggable FontSource seam: FontconfigFontSource
                           (default), StaticFontSource (data-based, browser-
                           safe), process-wide default override
lib/text/font.js           Font: fontkit face — metrics, coverage, shaping
lib/text/fontmanager.js    FontManager (app.fonts): match/load/fallback
lib/text/shape.js          bidi (UAX#9) + itemization + shaping pipeline
lib/text/layout.js         TextLayout: UAX#14 wrapping, alignment, spans
lib/text/glyphs.js         glyph pages (compact ids) + CompositeGlyphs encoder,
                           bitmap/vector routing policy, glyph-page LRU
lib/image.js               Image: PNG/JPEG decode (pngjs/jpeg-js), server upload cache
lib/widgets/css.js         CSS for HtmlView: parse (postcss), cascade, computed styles
lib/widgets/htmlview.js    HtmlView widget: htmlparser2 DOM + yoga-layout boxes
lib/widgets/markdown.js    markdown parsing (adapter over marked)
lib/widgets/mermaid.js     mermaid fences: mermaid-package parser (headless,
                           lazy) + native dagre/sequence layout and drawing
lib/widgets/markdownview.js  MarkdownView widget (highlighted + math fences)
lib/widgets/highlight.js   fence syntax highlighting (adapter over highlight.js)
lib/widgets/svgview.js     SvgView widget: static SVG via Path2D + 2d context
lib/widgets/tex.js         KaTeX-based TexView widget / layoutTex
test/                      node:test suite (see below)
docs/                      public API documentation
examples/                  runnable examples (own package.json, ESM)
website/                   Docusaurus docs site + browser playground
                           (self-contained package; syncs docs/ at build,
                           bundles ntk + the JS X server with esbuild,
                           deployed by .github/workflows/deploy-docs.yml;
                           `cd website && npm test` pixel-checks all demos)
```

Rendering contexts self-register on import:
`Drawable.renderingContextFactory[name]` — `lib/index.js` imports them for
their side effects.

## Hard constraints

- **Dependencies:** use external dependencies if they are maintained, easy
  to install, portable and don't add too much weight. Native (node-gyp)
  modules fail the easy-to-install/portable bar — for those capabilities
  find a JS implementation, shell out to a universally-available CLI (like
  `fc-match`), or implement it in `lib/` (like `rasterize.js`); this is why
  weak-napi (→ `FinalizationRegistry`), freetype2 (→ fontkit + own
  rasterizer), harfbuzz (→ fontkit shaping), fribidi (→ bidi-js) and
  font-scanner (→ fc-match) were removed/avoided. The flip side: don't
  hand-roll what a maintained library does better — the original in-repo
  markdown parser and syntax highlighter were subtly wrong (e.g. intra-word
  `_` emphasis) and are now thin adapters over `marked` and `highlight.js`,
  the same way math rendering uses `katex`.
- **ESM**, Node >= 20.19. No TypeScript for now (a possible later migration —
  keep JSDoc accurate instead).
- **Browser-bundleable lib/**: never statically import node builtins in
  `lib/` — fetch them lazily via `process.getBuiltinModule('node:...')`
  behind a capability check, and route environment-dependent behavior
  through the pluggable hooks (FontSource for font lookup, `configureTex`
  for KaTeX assets, HtmlView's `loadResource`, `createClient({ glxVisual })`)
  so browser playgrounds can substitute implementations.
- Server-side resources (windows, pixmaps, pictures, glyphsets) must offer
  `destroy()`, `Symbol.dispose` and a `FinalizationRegistry` GC fallback.

## Docs must stay in sync

`docs/` documents the entire public API surface, split by area with an index
in `docs/README.md`. **Any change to public API behavior, signatures, events
or supported options MUST update the corresponding file in `docs/` in the
same change.** New public modules get a new docs file plus an index entry.
README.md holds only the pitch and short samples — details belong in docs/.

## Testing

- `npm test` — `node --test`; pure unit tests (rasterizer, event maps,
  fontconfig) plus an end-to-end smoke suite (`test/smoke.test.js`) that
  talks to a real X server and verifies pixels via `GetImage`, and a fully
  hermetic suite (`test/xserver.test.js`) that runs ntk against node-x11's
  pure-JS X server (RENDER built in since x11 3.1.0) — no display, no
  fontconfig (docs/xserver.md).
- X-dependent tests skip automatically when `$DISPLAY` is absent/unreachable.
  Locally: any X server (XQuartz works). CI runs `xvfb-run -a npm test`
  (`.github/workflows/ci.yml`).
- When touching rendering code, extend the smoke test with a pixel-level
  assertion — that is what caught real bugs during modernization.

## Pull requests

- When a PR contains changes that can be easily detected by eye (rendering,
  widgets, layout), try to include screenshots/pictures **rendered by the
  PR's own code** in the PR description. Commit the images under `docs/img/`
  on the PR branch and reference them with
  `https://raw.githubusercontent.com/sidorares/ntk/<commit-sha>/docs/img/…`
  URLs (SHA-pinned links survive squash-merge branch deletion). Headless
  recipe: draw into a pixmap, read back with `getImageData` (BGRA order) and
  save with `pngjs` — same pattern as `test/smoke-canvas.test.js`.

## Releases

Releases are automated with release-please (`.github/workflows/release.yml`):
merging to `master` maintains a release PR; merging that PR tags a GitHub
release and publishes to npm via OIDC trusted publishing (no token secrets).

- **Use conventional commit messages** (`feat:`, `fix:`, `feat!:` /
  `BREAKING CHANGE:`, `chore:`, `docs:`) — release-please derives the next
  version and the changelog from them. PR squash-merge titles must follow the
  same convention (repo settings enforce squash-merge; GitHub merge commits
  would double-count entries in release-please's changelog).

## Gotchas

- node-x11's `Render.AddGlyphs` expects glyph `offX`/`offY` in 26.6 fixed
  point and **mutates** the glyph objects passed to it (divides by 64, pads
  rows) — `GlyphPage.ensure` builds fresh one-shot objects for each upload
  for this reason.
- `getImageData` returns BGRA byte order.
- Colors in XRender are premultiplied `[r, g, b, a]` floats 0..1.
- A `Window` constructed with an existing `{ id }` returns a cached instance
  if one exists; geometry arrives async (`_readyPromise`).
- The open X connection keeps the event loop alive — tests must
  `await app.close()`.
- Indirect GLX is disabled on many modern servers; GL examples may need
  server flags. `app.display.GLX` is `null` when missing — don't assume it.
