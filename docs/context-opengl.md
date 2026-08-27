# OpenGL rendering context (indirect GLX)

`wnd.getContext('opengl' [, config])` returns a context exposing most of the
OpenGL 1.4 fixed-function API over **indirect GLX** — GL commands are
serialized to the X server, no client-side GL library needed.

> ⚠️ Indirect GLX is disabled by default on many modern X servers; you may
> need `+iglx` / `AllowIndirectGLX`. See
> [node-x11#117](https://github.com/sidorares/node-x11/issues/117#issuecomment-214762185)
> and [Why setup fails](#why-setup-fails) below.
> `app.display.GLX` is `null` when the extension is unavailable.

> **There is a second backend.** [Direct rendering](context-gles.md) draws on
> the GPU and hands the server a finished buffer: GLSL shaders, and no GL
> traffic per frame — on a local connection to a server with DRI3, which is
> most Linux desktops including the ones that refuse indirect GLX. This page
> describes the backend ntk uses by default, and the only one that works over
> a network. [`glPolicy`](context-gles.md#glpolicy) chooses between them, and
> `getContext('opengl')` obeys it.

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
{ visual, depth, class, doubleBuffer, depthSize, samples, fbconfig, screen, config }
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
It rejects with a message naming the constraints when nothing matches. Both
paths filter on every attribute the server reports, multisampling included:
a `SAMPLES: 4` this display has no config for is a rejection, never a config
without sample buffers handed back as though the request had been met.

`samples` on the result is the colour samples per pixel that config has — 0
for none, and `null` only when the spec pinned `visual`, where no fbconfig
was consulted to know. `gl.samples` carries the same number on the context.
The direct backend answers the same question with the same field, where the
answer is always 0 for now: see
[Multisampling](context-gles.md#multisampling).

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
gl.samples; // its samples per pixel (0 until the config is resolved)
```

A failed setup rejects `gl.ready`, records `gl.error`, drops the queued
commands and warns on the console.

## Why setup fails

Every error from `chooseGLXConfig` and from the context setup carries a
`code` from `GLXError`, and usually a `hint` — the multi-line remedy the
console warning prints. Branch on the code; the message is for humans.

| `err.code` | what happened |
| --- | --- |
| `GLX_NO_EXTENSION` | the server has no GLX at all (built without it, or `-extension GLX`) |
| `GLX_INDIRECT_DISABLED` | GLX is there, but the server refuses indirect contexts |
| `GLX_NO_CONFIG` | no visual or fbconfig matches the requested attributes |
| `GLX_CONTEXT_FAILED` | anything else in setup (a rejected `MakeCurrent`, …) |

```js
import { GLXError } from 'ntk';

const gl = wnd.getContext('opengl', glx);
try {
  await gl.ready;
} catch (err) {
  if (err.code === GLXError.INDIRECT_DISABLED) showSoftwareFallback(err.hint);
  else throw err;
}
```

`GLX_INDIRECT_DISABLED` is the one you will actually hit. It is worth
knowing what it looks like from the outside: the extension is present,
`QueryVersion` says GLX 1.4, `GetFBConfigs` offers a full set of configs,
and `chooseGLXConfig` returns a perfectly good visual. Only `CreateContext`
is refused, with `BadValue`. That is the sole signal, which is why ntk sends
`CreateContext` on its own and waits for it, instead of going on to
`MakeCurrent` and reporting the `GLXBadContext` that follows from a context
that was never created.

To get a server that allows it:

```sh
Xwayland :5 +iglx &   # nested, under Wayland
Xephyr :5 +iglx &     # nested, under X
DISPLAY=:5 node your-app.js
```

On Xorg, `+iglx` on the command line or `Option "AllowIndirectGLX" "on"`;
on XQuartz, `defaults write org.xquartz.X11 enable_iglx -bool true`.

One caveat worth setting expectations on: current Linux distro X servers
often ship with the indirect GL *engine* gone even when `+iglx` is accepted.
Contexts are created and nothing rasterizes, and some builds (Ubuntu 24.04's
Xvfb and Xwayland among them) segfault on indirect `MakeCurrent`. XQuartz
still has a working indirect path.

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
