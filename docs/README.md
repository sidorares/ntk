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
- [App](app.md) — connecting to the X server, the `App` factory object
- [Window](window.md) — window creation, properties, methods, events,
  keyboard input, frame pacing / event coalescing, `requestAnimationFrame`
- [Pixmap](pixmap.md) — offscreen drawables
- [Clipboard](clipboard.md) — `app.clipboard.write()/read()`: text transfer
  over the CLIPBOARD/PRIMARY selections (ICCCM), INCR-aware reads
- [2d rendering context](context-2d.md) — canvas-like drawing API over XRender
- [Images](images.md) — PNG/JPEG loading (`loadImage`), the `Image` object,
  `drawImage`
- [Fonts](fonts.md) — font lookup, loading, rasterization pipeline
- [Text](text.md) — shaping (kerning/bidi/fallback), TextLayout, MarkdownView,
  wire-efficiency design, the vector (trapezoid) path for large/animated sizes
- [TeX / math](tex.md) — KaTeX-based formula rendering: `layoutTex`, `TexView`,
  markdown math fences
- [HTML widget](html.md) — `HtmlView`: static HTML + CSS subset, yoga-layout
  flexbox/block layout, links, images, the resource-loading safety model
- [SVG widget](svg.md) — `SvgView`: static SVG rendering through the 2d
  context (shapes, gradients, transforms, `use`), plus `Path2D`/SVG path data
- [OpenGL rendering context](context-opengl.md) — indirect GLX / OpenGL 1.4 API
- [Raw X11 rendering context](context-x11.md) — core X drawing requests
- [Resource management](resource-management.md) — `using` / `Symbol.dispose`, GC-based cleanup
- [Packaging](packaging.md) — bundling to one file, and shipping a single
  executable (what has to stay out of the module graph for that to work)
- [Headless X server](xserver.md) — run ntk against node-x11's pure-JS X
  server (XRender built in since x11 3.1.0) — no DISPLAY needed
