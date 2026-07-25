# OpenGL rendering context

`wnd.getContext('opengl' [, visual])` returns a context exposing most of the
OpenGL 1.4 fixed-function API over **indirect GLX** — GL commands are
serialized to the X server, no client-side GL library needed.

> ⚠️ Indirect GLX is disabled by default on many modern X servers; you may
> need `+iglx` / `AllowIndirectGLX`. See
> [node-x11#117](https://github.com/sidorares/node-x11/issues/117#issuecomment-214762185).
> `app.display.GLX` is `null` when the extension is unavailable.

```js
const gl = wnd.getContext('opengl');
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

## Notes

- Method names follow the GL C API without the `gl` prefix (`gl.Vertex3f`,
  `gl.MatrixMode`, …); constants likewise (`gl.TRIANGLES`).
- If `visual` is not passed, it is currently discovered by running
  `glxinfo -i -b` (requires `glxinfo`/mesa-utils installed).
- Queries with replies take a node-style callback:
  `gl.GenTextures(1, (err, textures) => ...)`, `gl.Finish(cb)`.
- `gl.SwapBuffers()` swaps the owning window.
- `gl.CreateGLXPixmap(pixmapId)` / `gl.BindTexImage(glxPixmap, buffer)` —
  render-to-texture helpers (experimental).

See `examples/gradient.js`, `examples/glclock.js`, `examples/teapot.js`,
`examples/simpletex.js`.
