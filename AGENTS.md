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
   web" — canvas 2d parity first (missing: `arc`, `save`/`restore`,
   transforms, `globalAlpha`, `globalCompositeOperation`), webgl-like ideas
   where they fit.
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
lib/renderingcontext_opengl.js  indirect GLX context
lib/renderingcontext_x11.js     raw core-X drawing context
lib/picture.js             XRender Picture wrapper (+ blur filter)
lib/glyphset.js            XRender GlyphSet wrapper
lib/rasterize.js           pure-JS glyph outline -> a8 bitmap rasterizer
lib/fontconfig.js          font matching + fallback chain via fc-match CLI
lib/text/font.js           Font: fontkit face — metrics, coverage, shaping
lib/text/fontmanager.js    FontManager (app.fonts): match/load/fallback
lib/text/shape.js          bidi (UAX#9) + itemization + shaping pipeline
lib/text/layout.js         TextLayout: UAX#14 wrapping, alignment, spans
lib/text/glyphs.js         glyph pages (compact ids) + CompositeGlyphs encoder
lib/widgets/markdown.js    dependency-free markdown parser
lib/widgets/markdownview.js  MarkdownView widget
test/                      node:test suite (see below)
docs/                      public API documentation
examples/                  runnable examples (own package.json, ESM)
```

Rendering contexts self-register on import:
`Drawable.renderingContextFactory[name]` — `lib/index.js` imports them for
their side effects.

## Hard constraints

- **Pure-JS dependencies only.** No node-gyp/native modules. If a capability
  seems to need a compiled module, find a JS implementation, shell out to a
  universally-available CLI (like `fc-match`), or implement it in `lib/`
  (like `rasterize.js`). This is why weak-napi (→ `FinalizationRegistry`),
  freetype2 (→ fontkit + own rasterizer), harfbuzz (→ fontkit shaping),
  fribidi (→ bidi-js) and font-scanner (→ fc-match) were removed/avoided.
- **ESM**, Node >= 20.19. No TypeScript for now (a possible later migration —
  keep JSDoc accurate instead).
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
  talks to a real X server and verifies pixels via `GetImage`.
- X-dependent tests skip automatically when `$DISPLAY` is absent/unreachable.
  Locally: any X server (XQuartz works). CI runs `xvfb-run -a npm test`
  (`.github/workflows/ci.yml`).
- When touching rendering code, extend the smoke test with a pixel-level
  assertion — that is what caught real bugs during modernization.

## Releases

Releases are automated with release-please (`.github/workflows/release.yml`):
merging to `master` maintains a release PR; merging that PR tags a GitHub
release and publishes to npm via OIDC trusted publishing (no token secrets).

- **Use conventional commit messages** (`feat:`, `fix:`, `feat!:` /
  `BREAKING CHANGE:`, `chore:`, `docs:`) — release-please derives the next
  version and the changelog from them. PR squash-merge titles must follow the
  same convention.
- `release-please-config.json` currently pins `release-as: 3.0.0` to
  bootstrap the first modernized release — remove that key after 3.0.0 ships.

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
