# ntk API documentation

ntk is a node.js desktop UI toolkit for X11: thin wrappers around
[node-x11](https://github.com/sidorares/node-x11) exposing familiar,
browser-like APIs — DOM-style events, an HTML canvas-like 2d context
(backed by the XRender extension, so composition happens server-side)
and an OpenGL 1.4-style context over indirect GLX.

These documents describe the public API surface. **They must be kept in
sync with the code** — any change to a public API requires updating the
matching file here (see AGENTS.md).

## Sections

- [Getting started](getting-started.md) — installation, requirements, first window
- [App](app.md) — connecting to the X server, the `App` factory object,
  extension discovery (`composite`/`damage`/`xfixes`/`shape`/`xinput`)
- [Window](window.md) — window creation, properties, methods, events,
  keyboard input, smooth scrolling (XI2), frame pacing / event coalescing,
  `requestAnimationFrame`
- [Pixmap](pixmap.md) — offscreen drawables
- [Clipboard](clipboard.md) — `app.clipboard.write()/read()/clear()`:
  transfer over the CLIPBOARD/PRIMARY selections (ICCCM), multi-format
  ownership, INCR both ways
- [XEmbed](xembed.md) — `XEmbedSocket` / `XEmbedPlug`: putting another
  client's window inside yours (and yours inside someone else's), including
  the plain-reparenting path `xterm -into` and `mpv --wid` need
- [2d rendering context](context-2d.md) — canvas-like drawing API over XRender,
  including region clips (`ctx.clipRegion`) and the XFIXES `Region` objects
  `app.createRegion()` hands back
- [Images](images.md) — PNG/JPEG loading (`loadImage`), the `Image` object,
  `drawImage`
- [Surface](surface.md) — draw once, composite many times; a8 coverage
  surfaces for drawings that take their colour from the caller, and
  `blurCoverage`, the blur baked into pixels rather than left as a filter the
  server re-runs per composite
- [Fonts](fonts.md) — font lookup, loading, rasterization pipeline
- [Text](text.md) — shaping (kerning/bidi/fallback), TextLayout,
  wire-efficiency design, the vector (trapezoid) path for large/animated sizes
- [Shared glyphs](shared-glyphs.md) — the display-wide glyph cache: every
  ntk process on one X server shares rasterized glyphs through a
  `_NTK_GLYPHD` directory (design, protocol, config, prior art)
- [SVG widget](svg.md) — `SvgView`: static SVG rendering through the 2d
  context (shapes, gradients, transforms, `use`), plus `Path2D`/SVG path data
- [OpenGL rendering context](context-opengl.md) — indirect GLX / OpenGL 1.4 API
- [Direct rendering](context-gles.md) — shader GL on the GPU with no pixels on
  the socket: DRI3 + Present on Linux, Apple-DRI + CGL on macOS/XQuartz;
  `glPolicy` and what makes it available
- [Raw X11 rendering context](context-x11.md) — core X drawing requests
- [Resource management](resource-management.md) — `using` / `Symbol.dispose`, GC-based cleanup
- [Packaging](packaging.md) — bundling to one file, and shipping a single
  executable (what has to stay out of the module graph for that to work)
- [Headless X server](xserver.md) — run ntk against node-x11's pure-JS X
  server (XRender built in since x11 3.1.0) — no DISPLAY needed
