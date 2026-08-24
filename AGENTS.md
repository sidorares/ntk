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
- a **direct rendering context** — shader GL on the GPU with no pixels on
  the socket, where the optional `x11-dri` addon and a local server that can
  take it are both there. Two flavors behind one contract: OpenGL ES 2 with
  frames handed over as dma-buf descriptors via DRI3 + Present (Linux), and
  CGL drawing into the window surface the server exports via Apple-DRI
  (macOS/XQuartz). Off by default; `glPolicy` chooses (docs/context-gles.md)

### Direction

1. Keep growing toward "write simple X11 UIs with the APIs you know from the
   web" — canvas 2d parity first (paths/Path2D, transforms, save/restore,
   clip, `globalAlpha`, Porter-Duff `globalCompositeOperation` and shadows
   are done; still missing: line dashes, round caps/joins, text under
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
lib/surface.js             Surface: pixmap + Picture, drawn once and
                           composited many times; a8 coverage surfaces take
                           their colour from the drawing context
lib/drawable.js            EventEmitter base + getContext() registry
lib/events_map.js          X event code <-> browser-ish event name tables
                           (incl. FocusIn/FocusOut as 'focus'/'blur')
lib/keyboard.js            key event -> keysym/codepoint: XKB group from the
                           event state, CapsLock only on cased keys
lib/xi2.js                 XI2 device events: which types can be selected,
                           absolute scroll valuators -> wheel deltas (per
                           device, seeded), XI2 event -> core-shaped ntk event
lib/clipboard.js           app.clipboard: ICCCM selection/clipboard transfer
                           (CLIPBOARD/PRIMARY, required targets, INCR both
                           ways, multi-format ownership, acquire/release
                           and conversion timestamps)
lib/xembed.js              XEmbed: XEmbedSocket (embedder), XEmbedPlug
                           (client), the focus proxy and the _XEMBED_INFO
                           encoding; plain reparenting for clients that
                           speak no XEmbed (xterm -into, mpv --wid)
lib/renderingcontext_2d.js canvas-like context (XRender); CanvasGradient
lib/path.js                Path2D, SVG path-data parser, affine matrices,
                           adaptive bezier flattening
lib/renderingcontext_opengl.js  indirect GLX context (queues GL commands
                           until MakeCurrent's context tag arrives)
lib/glx.js                 GLX visual/fbconfig discovery (app.chooseGLXConfig)
lib/gl.js                  which GL backend, and whether it can: glPolicy,
                           the x11-dri probe, GLError, app.glCapabilities(),
                           the direct flavor per platform (dri3 / appledri)
lib/renderingcontext_gles.js    direct rendering context, dri3 flavor
                           (OpenGL ES 2 on the GPU); also wraps the 'opengl'
                           factory so that name dispatches on glPolicy
lib/glswapchain.js         its buffers: dma-buf -> DRI3 pixmap -> Present,
                           recycled on IdleNotify, generations across resizes
lib/appledri.js            the Apple-DRI protocol binding (XQuartz's
                           direct-rendering extension): requests, replies,
                           the SurfaceNotify event, the extension errors
lib/renderingcontext_cgl.js     direct rendering context, appledri flavor
                           (CGL into the server-exported window surface);
                           wraps 'opengl' above the gles module's dispatch
lib/renderingcontext_x11.js     raw core-X drawing context
lib/picture.js             XRender Picture wrapper (+ blur filter)
lib/pictformat.js          which RENDER picture format describes a drawable:
                           visual -> format, matched on the channel masks
                           the handshake and QueryPictFormats agree on, with
                           the depth-based standard formats as the fallback
lib/region.js              XFIXES Region wrapper: the server-side rectangle
                           sets X uses for damage/shapes, and the clip
                           ctx.clipRegion() installs on a picture
lib/shadow.js              canvas shadows: the blur (sigma = shadowBlur/2,
                           run as two separable passes), the coverage
                           surfaces it needs and their per-connection cache
lib/glyphset.js            XRender GlyphSet wrapper (+ referenceTo: alias an
                           existing set, possibly another client's)
lib/sharedglyphs.js        cross-process shared glyph cache, client half:
                           discovery via the _NTK_GLYPHD manager selection,
                           the ensure/added property RPC, the XID-reuse
                           fence, per-page bindings (docs/shared-glyphs.md)
lib/glyphdirectory.js      its directory half: claims the selection, single
                           writer of compact lids, presence bits, generations
lib/glyphdwire.js          the _NTK_GLYPHD property payload codecs
lib/rasterize.js           pure-JS coverage rasterizer (signed-area
                           accumulation): glyph outlines and path/stroke
                           geometry -> a8; the pluggable Rasterizer seam and
                           the local/server routing policy
lib/maskcluster.js         one drawing's pieces -> the few mask boxes their
                           ink is really in: the gap partition that keeps a
                           path of N scattered subpaths off one union-sized
                           mask (maskPolicy)
lib/trapezoid.js           polygon -> XRender trapezoids (non-zero/even-odd;
                           vector text and all 2d path fills)
lib/fontconfig.js          font matching + fallback chain via fc-match CLI
lib/text/fontsource.js     pluggable FontSource seam and the font-spec
                           resolver: FontconfigFontSource
                           (default), StaticFontSource (data-based, browser-
                           safe), process-wide default override
lib/text/font.js           Font: fontkit face — metrics, coverage, shaping
lib/text/fontmanager.js    FontManager (app.fonts): match/load/fallback
lib/text/shape.js          bidi (UAX#9) + itemization + shaping pipeline
lib/text/layout.js         TextLayout: UAX#14 wrapping, alignment, spans
lib/text/glyphs.js         glyph pages (compact ids) + CompositeGlyphs encoder,
                           bitmap/vector routing policy, glyph-page LRU
lib/image.js               Image: PNG/JPEG decode (pngjs/jpeg-js), server upload cache
lib/widgets/svgview.js     SvgView widget: static SVG via Path2D + 2d context
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

## ICCCM and EWMH live here, not in node-x11

node-x11 owns the wire protocol; ntk owns the conventions layered on top of
it. Concretely, **everything about window-manager properties is ours**: the
`WM_SIZE_HINTS` and `WM_HINTS` struct packing (flags word included),
`WM_PROTOCOLS` membership, `WM_TRANSIENT_FOR`, `_NET_WM_*`, `_NET_SUPPORTED`
probing, `_MOTIF_WM_HINTS`, and the ICCCM selection/INCR machinery already in
`lib/clipboard.js`.

Do not file these upstream — node-x11 has declined them three times
([#177](https://github.com/sidorares/node-x11/issues/177) "part of xlib but
not core protocol", [#191](https://github.com/sidorares/node-x11/issues/191),
[#87](https://github.com/sidorares/node-x11/issues/87)) and its AGENTS.md now
records the boundary. The rule of thumb: if a wrong byte is something the X
server would reject, it is node-x11's; if only a *window manager* could
notice, it is ours.

What that means in practice:

- **Use `wnd.sendClientMessage(type, data, { target, mask, format })`** — the
  wrapper over node-x11's `X.SendClientMessage(destination, wid, type,
  format, data[, eventMask][, cb])`, which takes an atom *name*, caps the
  word list at what the 32-byte event holds and defaults the mask to `0`.
  That default is the one messages aimed at another client's own window
  (WM_PROTOCOLS, XEmbed, XDND, SelectionNotify) need; root-window EWMH
  messages pass `SubstructureRedirect|SubstructureNotify` explicitly. Note
  node-x11's own default is the opposite way round.
  **Use `x11.packEvent(ev)`** (x11 >= 3.4) rather than hand-packing 32-byte
  buffers for anything else. `SendEvent` also takes an event object
  directly, which is how `sendConfigureNotify`, the clipboard's
  SelectionNotify and the XEmbed focus proxy's key forwarding are built.
- **A property writer must set its flag bit.** The failure mode of these
  structs is silence: `WM_NORMAL_HINTS` with `flags = 0` is a legal property
  meaning "I declared nothing", and nothing anywhere errors. Never write a
  field without its flag, and never fabricate a companion field the caller did
  not supply (`minWidth` alone must not imply `minHeight: 0`).
- **Atom-list properties are read-modify-write.** `WM_PROTOCOLS` and
  `_NET_WM_STATE` accumulate; a `ChangeProperty(Replace)` with one atom
  silently drops whatever else was there.
- **Mapped windows ask, unmapped windows write.** EWMH 7.7: change
  `_NET_WM_STATE` on a mapped window with a ClientMessage to the root, and on
  an unmapped one by writing the property directly.
- **Endianness:** `lib/` decodes property payloads with `readUInt32LE` /
  `Uint32Array` and that is fine — but not for the reason it looks like.
  node-x11 declares the *host* byte order in its connection hello
  (`display.byte_order`, x11 >= 3.4) and then encodes every request LSBFirst
  anyway, so a big-endian host yields a connection that is already garbage
  before any property reaches us. `App`'s constructor rejects such a
  connection outright; do not add MSBFirst decode paths here, because there
  is no working MSBFirst connection for them to run on.

## Hard constraints

- **Dependencies:** use external dependencies if they are maintained, easy
  to install, portable and don't add too much weight. Native (node-gyp)
  modules fail the easy-to-install/portable bar — for those capabilities
  find a JS implementation, shell out to a universally-available CLI (like
  `fc-match`), or implement it in `lib/` (like `rasterize.js`); this is why
  weak-napi (→ `FinalizationRegistry`), freetype2 (→ fontkit + own
  rasterizer), harfbuzz (→ fontkit shaping), fribidi (→ bidi-js) and
  font-scanner (→ fc-match) were removed/avoided. The flip side: don't
  hand-roll what a maintained library does better — the in-repo markdown
  parser and syntax highlighter were subtly wrong (e.g. intra-word `_`
  emphasis) and became thin adapters over `marked` and `highlight.js` before
  leaving ntk altogether.
  **The one native module here is `x11-dri`, and it is an `optionalDependency`
  that nothing imports statically** (`lib/gl.js` reaches it through
  `nodeRequire()` inside a try/catch). It does not fail the portability bar
  because its absence costs nothing: `npm install ntk` never needs a
  toolchain — it ships prebuilt binaries and npm skips an optional dependency
  that will not install — no code path touches it under the default
  `glPolicy`, and where it is missing the direct backend reports
  `GL_NO_ADDON` and GL runs through indirect GLX exactly as before. That is
  the bar any future native dependency has to clear: optional, lazily
  reached, and with a working answer for every machine that does not have it.
  What it buys cannot be had in JS at all — only a GPU driver can produce a
  dma-buf.
- **ESM**, Node >= 18.19. No TypeScript for now (a possible later migration —
  keep JSDoc accurate instead). `process.getBuiltinModule` (Node >= 20.16) is
  reached through `lib/builtin.js`, which falls back to `createRequire` below
  that. `Symbol.dispose`/`using` (Node >= 20.4) degrade gracefully on 18: the
  method is parked but inert, and `destroy()` + the GC fallback still run.
- **Browser-bundleable lib/**: never statically import node builtins in
  `lib/` — fetch them lazily via `builtin('node:...')` (which wraps
  `process.getBuiltinModule` behind a capability check) and route
  environment-dependent behavior through the pluggable hooks (FontSource for
  font lookup, `createClient({ glxVisual })`) so browser playgrounds can substitute
  implementations. The only sanctioned static node imports are `node:events`
  in `drawable.js` and `node:module` in `builtin.js` (enforced by
  test/packaging.test.js).
- Server-side resources (windows, pixmaps, pictures, glyphsets) must offer
  `destroy()`, `Symbol.dispose` and a `FinalizationRegistry` GC fallback.

## An error you hit is an error a consumer will hit

Whenever an error turns up while researching, benchmarking or sketching —
even in throwaway code, even when it was your own mistake — stop and ask two
questions:

1. **Can a consumer reach this?** If the answer is yes, you have found a bug
   report before anyone filed it. Ambient facts about the machine — a missing
   CLI, an absent display, an unset variable, a permission — are the ones to
   look hardest at, because your box is not the deployment target.
2. **Can the error say what to do about it?** Turn it into a fix
   instruction, the diagnostics needed to work out the fix, or a link to the
   page that explains it. Say what was expected, what was found, and what to
   change.

A raw error from a layer the consumer never called is the failure mode to
watch for: it names something they have never heard of, arrives from a stack
that mentions nothing they wrote, and gives them nothing to search for. The
worked example is issue #121 — a missing `fc-match` surfaced as `spawnSync
fc-match ENOENT`, thrown from inside the first text layout, naming neither
ntk nor fonts nor a remedy. It now names the cause, the fix, the cheaper
alternative and the doc page, and carries a `code` so a host can branch on it
rather than match message text.

This is not a licence to rewrite every throw. The bar:

- **The consumer can hit it**, on some machine, in some supported
  environment. A failure only reachable by editing ntk is not one.
- **They can act on what it says.** If there is nothing they could do
  differently, extra prose is noise — fix the bug instead.
- **The remedy is specific.** "Pass a custom fontSource" is a hint; a
  four-line snippet, the `apt-get` line and a URL is a fix. Long messages are
  fine when they are thrown once into a situation the reader does not yet
  understand.
- **Recommend the cheapest real fix first**, even when it is not ours. A
  library that hides a two-line Dockerfile answer to advertise its own API is
  not being helpful.
- **Distinguish "your environment has nothing" from "your call is wrong"**,
  and give the first an error `code` when anything upstream may need to
  degrade rather than crash.

Where the fix is more than a sentence, the message links to `docs/` and a
test asserts that anchor still exists — a URL in a string literal is the one
kind of doc link nothing else in CI checks.

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
  recipe: draw into a pixmap, read back with `getImageData` (straight RGBA,
  ready to hand to `pngjs`) and save — same pattern as
  `test/smoke-canvas.test.js`.

## Releases

Releases are automated with release-please (`.github/workflows/release.yml`):
merging to `master` maintains a release PR; merging that PR tags a GitHub
release and publishes to npm via OIDC trusted publishing (no token secrets).

- **Use conventional commit messages** (`feat:`, `fix:`, `feat!:` /
  `BREAKING CHANGE:`, `chore:`, `docs:`) — release-please derives the next
  version and the changelog from them. PR squash-merge titles must follow the
  same convention (repo settings enforce squash-merge; GitHub merge commits
  would double-count entries in release-please's changelog).
- **No nested parentheses in the commit body.** release-please parses the
  whole message with `@conventional-commits/parser`, whose grammar rejects
  them — `foo(a, b)` is fine, `foo(a, () => {})` is not, so a code fence
  with a callback in it is enough to break it. A commit it cannot parse is
  **silently skipped**: the workflow goes green, `commits: 0`, and no
  release PR appears (this happened to #85 → the empty re-record commit
  e523667, and again to #103 → 9fdbe38). Squash-merge puts the PR
  description in the body, so this applies to PR descriptions too.
- **Keep a parenthetical short enough to survive the wrap.** The same grammar
  rejects a `(` still open at the end of a line, and squash-merge wraps the
  body at 72 columns — so an aside that is whole in the PR description can
  arrive at release-please split across two lines. That is what skipped #278,
  over a one-line `*(rendered by this branch: ...)*` caption 106 characters
  long — restored, as #85 and #103 were, by an empty commit.
- **CI checks this for you** — the `release-message` job runs
  `npm run check-release-message` over the title and body the squash would
  produce, using release-please's own parser, and names the line and column
  it chokes on. It checks the message twice, as written and wrapped, because
  the wrap is invisible until the merge. Whether a given nested call trips
  the grammar depends on its surroundings, so do not try to predict it from
  the rules above: the same construct that broke #103 parses fine inside a
  fenced block. Run the script locally against a file if you want to check
  before pushing.

## Gotchas

- node-x11's `Render.AddGlyphs` expects glyph `offX`/`offY` in 26.6 fixed
  point and **mutates** the glyph objects passed to it (divides by 64, pads
  rows) — `GlyphPage.ensure` builds fresh one-shot objects for each upload
  for this reason.
- **Never recover a content width by subtracting a padding you added.**
  `width + pad - pad` is not the identity in floating point: at size 16 a
  natural width of 48.953125 comes back as 48.95312499999999. A layout handed a
  `maxWidth` a few ULPs below a token's own measured width sees a token *wider
  than its container* and force-breaks it, so a `value` header renders as
  `valu` over `e` — on some fonts and not others, depending on nothing but
  whether the width survives the round trip. Carry the content width alongside
  the outer width instead. This bit ntk's own table layout, and is the kind of
  thing any consumer laying out columns on `TextLayout` will hit.
- **`TextLayout`'s width is not monotonic in `maxWidth`,** so laying a cell out
  at a tiny `maxWidth` is *not* a min-content probe. `_forceBreak`
  (`lib/text/layout.js:131`) splits a token wider than the container whenever a
  single cluster fits and lets it overflow whole when none does, so the test
  face at 16px measuring `value` reports 42.1 at `maxWidth` 1–8 and 13.4 at 16 — a
  fragment. For min-content, measure each whitespace-delimited token
  unconstrained; an unconstrained token cannot be broken. Pinned by a test, so
  the probe does not come back as an obvious simplification.
- `getImageData`/`putImageData` speak straight (non-premultiplied) RGBA, as
  the canvas spec does; `lib/imagedata.js` owns the conversion to and from
  the drawable's layout. `readPixels` is the raw escape hatch. Never assume
  BGRA — that is only what an LSBFirst server with the standard visual masks
  happens to want.
- Colors in XRender are premultiplied `[r, g, b, a]` floats 0..1.
- A `Window` constructed with an existing `{ id }` returns a cached instance
  if one exists; geometry arrives async (`_readyPromise`).
- The open X connection keeps the event loop alive — tests must
  `await app.close()`.
- Indirect GLX is disabled on many modern servers; GL examples may need
  server flags. `app.display.GLX` is `null` when missing — don't assume it.
