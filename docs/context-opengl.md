# OpenGL rendering context

`wnd.getContext('opengl' [, config])` returns a context exposing most of the
OpenGL 1.4 fixed-function API over **indirect GLX** — GL commands are
serialized to the X server, no client-side GL library needed.

> ⚠️ Indirect GLX is disabled by default on many modern X servers; you may
> need `+iglx` / `AllowIndirectGLX`. See
> [node-x11#117](https://github.com/sidorares/node-x11/issues/117#issuecomment-214762185).
> `app.display.GLX` is `null` when the extension is unavailable.

```js
// a GLX drawable must use a visual the context was created for — choose it
// before the window exists
const glx = await app.chooseGLXConfig({ DEPTH_SIZE: 24 });
const wnd = app.createWindow({ width: 400, height: 300, visual: glx.visual, depth: glx.depth });
wnd.map();

const gl = wnd.getContext('opengl', glx);
gl.ClearColor(0.3, 0.3, 0.3, 0.0);
gl.Clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
gl.Begin(gl.TRIANGLES);
gl.Color3f(1, 0, 0);
gl.Vertex3f(-1, -1, 0);
gl.Vertex3f(1, -1, 0);
gl.Vertex3f(0, 1, 0);
gl.End();
gl.SwapBuffers();
```

## Choosing a visual

`app.chooseGLXConfig(spec)` resolves with

```js
{ visual, depth, class, doubleBuffer, depthSize, fbconfig, screen, config }
```

`visual` and `depth` go to `createWindow` (which also creates a matching
colormap, see [window.md](window.md)); the whole object goes to
`getContext('opengl', config)`.

`spec` holds GLX attribute constraints by name — `DEPTH_SIZE`,
`DOUBLEBUFFER`, `RED_SIZE`, `ALPHA_SIZE`, `STENCIL_SIZE`, `SAMPLES`, … Size
attributes mean "at least"; `null` means "don't care". The defaults are
`{ DOUBLEBUFFER: true, DEPTH_SIZE: 16, RED_SIZE: 8, GREEN_SIZE: 8, BLUE_SIZE: 8 }`.
Two more keys are ntk's own: `screen` (default 0) and `visual` (pin a visual
id and skip the search).

The search asks the server: `GetFBConfigs` first, falling back to the GLX 1.2
`GetVisualConfigs` — no `glxinfo` shell-out, so it works headlessly and in CI.
It rejects with a message naming the constraints when nothing matches.

`getContext('opengl')` without a config picks one itself, preferring a config
for the visual the window already has. That keeps the short form working, but
a window created without a GLX visual can be rejected by strict servers —
choose the visual first when you can.

## Setup is asynchronous, the API is not

Two round trips stand between `getContext('opengl')` and a usable context:
the visual query, and `MakeCurrent` — whose reply is the **context tag** that
every GLX `Render` request has to carry (passing the context XID instead
fails every draw with `GLXBadContextTag`).

GL calls made before that are queued and replayed, in order, as soon as the
context is current, so the example above needs no `await`. When you do want
to know:

```js
await gl.ready; // resolves with the context, rejects if setup failed
gl.contextTag; // the tag MakeCurrent returned (0 until ready)
gl.contextId; // the GLX context XID
gl.config; // the config in use
```

A failed setup (no GLX, no matching visual, indirect GLX disabled) rejects
`gl.ready`, records `gl.error`, drops the queued commands and warns on the
console.

## Notes

- Method names follow the GL C API without the `gl` prefix (`gl.Vertex3f`,
  `gl.MatrixMode`, …); constants likewise (`gl.TRIANGLES`).
- Queries with replies take a node-style callback:
  `gl.GenTextures(1, (err, textures) => ...)`, `gl.Finish(cb)`.
- Commands are buffered and flushed as few `Render` requests as possible;
  `gl.Render()` flushes explicitly, and requests with replies
  (`SwapBuffers`, `Finish`, display-list calls) flush first.
- `gl.SwapBuffers()` swaps the owning window.
- Display lists (`gl.NewList`/`gl.EndList`/`gl.CallList`) are the way to keep
  geometry server-side — immediate-mode vertices cost one command each, per
  frame, on the wire.
- `gl.CreateGLXPixmap(pixmapId)` / `gl.BindTexImage(glxPixmap, buffer)` /
  `gl.ReleaseTexImage(glxPixmap, buffer)` — render-to-texture helpers
  (experimental).
- `gl.destroy()` (or `Symbol.dispose`) releases the context; the window keeps
  its drawable.
- `createClient({ glxVisual })` still pins a visual id for environments that
  want to bypass the query entirely.

See `examples/gradient.js`, `examples/glclock.js`, `examples/teapot.js`,
`examples/simpletex.js`.
