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
- [Window](window.md) — window creation, properties, methods and events
- [Pixmap](pixmap.md) — offscreen drawables
- [2d rendering context](context-2d.md) — canvas-like drawing API over XRender
- [Fonts and text](fonts.md) — font lookup, loading, rasterization pipeline
- [OpenGL rendering context](context-opengl.md) — indirect GLX / OpenGL 1.4 API
- [Raw X11 rendering context](context-x11.md) — core X drawing requests
- [Resource management](resource-management.md) — `using` / `Symbol.dispose`, GC-based cleanup
