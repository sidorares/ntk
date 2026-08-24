# Direct rendering: shader GL on the GPU

ntk can draw a window's contents on the GPU with no pixels on the socket, no
GL commands on the socket, and a modern shader pipeline instead of a
fixed-function one.

This is the **direct** backend. The other one, [indirect
GLX](context-opengl.md), serializes GL commands into the X connection and is
what ntk has always used. They are different pipelines with different APIs,
and which one a window gets is [`glPolicy`](#glpolicy) — whose default is
still `indirect`, so nothing changes until you ask.

The direct backend comes in two *flavors*, one per platform, behind one
context contract and one `gl` API:

- **`dri3`** (Linux): OpenGL ES 2 on a DRM render node, finished frames
  handed to the server as dma-buf descriptors over DRI3 + Present.
- **`appledri`** ([macOS/XQuartz](#macos)): the server exports the window's
  WindowServer surface over the Apple-DRI extension, and a CGL context draws
  straight into it — Apple's GL-on-Metal, ES2-compatible, so the same
  shaders compile.

Draw code does not choose between them: `getContext('opengl')` picks the
flavor for the platform, and everything below applies to both except where a
flavor is named. The Linux flavor is described first; [macOS](#macos) covers
what differs.

![A shaded cube in an ntk window, its faces patterned by a fragment shader](img/direct-gl-cube.png)

The pattern above is computed per fragment from the interpolated position —
the kind of thing the fixed-function pipeline has no way to express, and the
reason this backend exists.

```js
const app = await createClient({ glPolicy: 'auto' });

const config = await app.chooseGLConfig({ DEPTH_SIZE: 24 });
const wnd = app.createWindow({
  width: 640,
  height: 480,
  visual: config.visual,
  depth: config.depth,
  backingStore: false // GL draws the window itself; it needs no pixmap
});
wnd.on('expose', draw); // see "Draw on expose" below
wnd.map();

const gl = wnd.getContext('opengl', config);
await gl.ready; // the whole path is proven, or this rejects with a reason
draw(); // an expose that raced `ready` had nothing to present into yet

function draw() {
  gl.makeCurrent();
  gl.viewport(0, 0, wnd.width, wnd.height);
  gl.clearColor(0.05, 0.06, 0.12, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  // ... shaders, buffers, draws ...
  gl.SwapBuffers();
}
```

## How it works (the `dri3` flavor)

```
GPU (DRM render node)                     X server
---------------------                     --------
draw with GL ES 2 into a GBM buffer
swap()  ->  dma-buf fd  --- fd over the unix socket (DRI3) --->  pixmap
Present.Pixmap(window, pixmap)  --------- flip or copy, at a vblank
                     <----- PresentIdleNotify  (the buffer is ours again)
```

The descriptor is passed **once per buffer**. Every later frame drawn into
that buffer is a single `Present.Pixmap` request naming a pixmap the server
already holds, so a frame costs one request whatever its resolution — the
`test/gl-direct-live.test.js` case that counts imports at the protocol seam is
there to keep it that way.

Three pieces have to be in place, and all three are checked before anything is
created:

| piece | what it is | where it comes from |
| --- | --- | --- |
| `x11-dri` | the GPU context (GBM + EGL) and the dma-buf export | optional dependency, prebuilt for linux x64/arm64 |
| DRI3 | turns a dma-buf into a pixmap | the X server (Xorg + glamor, Xwayland) |
| Present | shows a pixmap, and says when its buffer is free | the X server |

`x11-dri` is a native addon, so ntk depends on it *optionally*: it is never
required to install or run ntk, nothing imports it until a policy asks for
direct rendering, and its absence is one of the reasons `direct` can be
false. Mesa's `libgbm`/`libEGL`/`libGLESv2` are `dlopen()`ed at run time, so
there is nothing to rebuild when they change.

## glPolicy

Set it on `createClient`, as a mode string or an object:

```js
createClient({ glPolicy: 'auto' });
createClient({ glPolicy: { mode: 'auto', maxInFlight: 3 } });
```

| mode | meaning |
| --- | --- |
| `'indirect'` | **default** — indirect GLX, the backend ntk has always used |
| `'auto'` | direct where it is available, indirect otherwise |
| `'direct'` | direct or nothing: `getContext` throws rather than quietly running a fixed-function pipeline instead |
| `'off'` | no GL at all |

The default is not `auto` because the two backends expose **different GL
APIs** (below), and switching one under an app that never asked would break
its draw code. Opt in per app, or per run:

```sh
NTK_GL_POLICY=direct npm start    # overrides whatever the app passed
```

The environment wins deliberately — its job is running one build both ways.

Object form knobs, over `DEFAULT_GL_POLICY`:

| key | default | meaning |
| --- | --- | --- |
| `mode` | `'indirect'` | as above |
| `devicePath` | `null` | which render node to draw on; `null` picks the first usable one |
| `maxInFlight` | `2` | presents outstanding before a frame waits for a buffer |
| `linearFallback` | `true` | retry a refused buffer once with a linear layout, which is what makes rendering on one GPU and displaying on another work |

The three knobs below `mode` describe dma-buf machinery the `appledri`
flavor does not have — it ignores them silently.

## What is available, and why not

```js
const caps = await app.glCapabilities();
// { direct: true, indirect: true, flavor: 'dri3',
//   device: '/dev/dri/renderD128', reason: null }
// — and on macOS/XQuartz: { direct: true, flavor: 'appledri', device: null }
```

`reason` is an `Error` whose `code` is one of `GLError` — branch on the code,
not the message:

| code | meaning | remedy |
| --- | --- | --- |
| `GL_NO_ADDON` | `x11-dri` is not installed | `npm install x11-dri` |
| `GL_NO_DRIVER` | the platform libraries are missing — `libgbm`/`libEGL`/`libGLESv2` on Linux, libXplugin/OpenGL.framework on macOS — or the platform has no direct path | install Mesa / install XQuartz; elsewhere direct rendering does not exist |
| `GL_NO_DEVICE` | no readable `/dev/dri/renderD*` (Linux) | map the device into the container, or join the `render` group |
| `GL_REMOTE_DISPLAY` | a TCP or forwarded display | direct rendering is local-only; use indirect over a network |
| `GL_NO_FD_PASSING` | local display, but this runtime cannot pass a descriptor (`dri3` flavor only) | run under Node — Bun does not implement the internal x11 uses |
| `GL_NO_DRI3` | the server has no DRI3/Present | Xvfb, Xephyr and XQuartz have none (XQuartz has [its own path](#macos)) |
| `GL_NO_APPLEDRI` | macOS, and the server has no usable Apple-DRI | is the display an XQuartz server? |
| `GL_NO_WINDOWSERVER` | macOS, but no WindowServer session — SSH | run from the logged-in GUI session |
| `GL_IMPORT_FAILED` | the server refused the buffer | usually different DRM devices — set `devicePath` |
| `GL_CONTEXT_FAILED` | GPU context setup failed | the message says what did |
| `GL_DISABLED` | `glPolicy: 'off'` | — |

The probe runs during `createClient()` whenever the policy could choose
direct, which is what lets `getContext()` pick a backend synchronously
afterwards. Under the default policy it does not run at all, so an app that
never asked pays nothing for it — but it also means that raising the policy
*after* connecting needs one `await app.glCapabilities()` before a context can
be created.

### Runtimes

The `dri3` flavor needs a runtime that can send a file descriptor over a
unix socket, because that is how DRI3 hands the server a buffer. `x11` does
it through Node's internal `process.binding('pipe_wrap')`, so:

| runtime | direct (`dri3`) | direct (`appledri`) | indirect |
| --- | --- | --- | --- |
| Node | yes | yes | yes |
| Bun | **no** — `process.binding('pipe_wrap')` is not implemented | yes — no descriptor ever crosses the socket | yes |

Under Bun on Linux the capability probe reports `GL_NO_FD_PASSING` and
`'auto'` falls back to indirect GLX, which needs no descriptor passing at
all. Nothing else about the display has to change.

## The API is not the GLX one

| | direct | indirect (`'opengl'`) |
| --- | --- | --- |
| pipeline | OpenGL ES 2.0 (`dri3`) / desktop GL, ES2-compatible (`appledri`) | OpenGL 1.x fixed-function |
| naming | `gl.clearColor`, `gl.drawArrays` | `gl.ClearColor`, `gl.Begin` |
| shaders | **yes**, GLSL ES 1.00 | none — the protocol encodes no shader objects |
| geometry | VBOs, `drawArrays`/`drawElements` | immediate mode + display lists |
| reach | local connections, Linux or macOS/XQuartz, a GPU | any server allowing indirect contexts |

Code that runs on either branches on `gl.backend`, which is `'direct'` or
`'indirect'`:

```js
if (gl.backend === 'direct') gl.clear(gl.COLOR_BUFFER_BIT);
else gl.Clear(gl.COLOR_BUFFER_BIT);
```

`getContext('opengl')` is the backend-neutral name and obeys the policy.
`getContext('gles')` asks for the Linux direct flavor by name and
`getContext('cgl')` for the macOS one; each throws where its flavor is not
the one available — useful when the code wants no silent substitution.
Direct contexts also carry `gl.flavor` (`'dri3'` or `'appledri'`) for the
rare code that cares which pipeline is under it.

The ES 2 surface is whatever `x11-dri` exposes, which is the core of ES 2
(shaders, programs, uniforms, buffers, attributes, draws, `readPixels`) and
**not yet textures, framebuffer objects, blending or scissoring**. Adding an
entry point is a small wrapper in that package.

### Context lifetime

- **One GPU context per app and pixel format** on the `dri3` flavor.
  Programs, buffers and other GL objects are shared between surfaces on a
  connection, the way they are between canvases in a browser tab, and
  exactly one surface is current at a time. (The `appledri` flavor owns one
  CGL context per window instead — see [macOS](#macos); code that caches GL
  resources by the `gl` object identity is correct on both.)
- `gl.makeCurrent()` binds this context's surface and picks up a resize —
  call it at the top of every frame. Individual `gl.*` calls also bind if
  another surface stole currency, so a stray call cannot draw into the wrong
  window.
- `gl.destroy()` releases the surface, its pixmaps and its event selection.
  The shared GPU context belongs to the connection and is released by
  `app.close()`.

### Frames and back pressure

- `gl.SwapBuffers()` (or `gl.swapBuffers()`) shows the frame just drawn. It
  returns `false` when the frame could not go out because every buffer is
  still with the server.
- `gl.canRender()` is the same question asked before drawing, and
  `gl.onFrameAvailable = fn` fires when the answer becomes yes again. A draw
  loop that respects both never renders frames that have nowhere to go:

  ```js
  gl.onFrameAvailable = () => wnd.requestAnimationFrame(draw);

  function draw() {
    if (!gl.canRender()) return; // onFrameAvailable will call back
    // ... draw ...
    gl.SwapBuffers();
    wnd.requestAnimationFrame(draw);
  }
  ```

- Presents are sent with `targetMsc: 0` and no `Option.Copy`, so the server
  shows them at the next vblank and may flip rather than copy. Frame *pacing*
  is still the window's frame clock ([window.md](window.md)); the swap chain
  only bounds how many frames can be in flight.
- The `appledri` flavor keeps the same contract with different machinery
  underneath: there is no swap chain and the server applies no backpressure,
  so each `SwapBuffers()` closes the `canRender()` gate itself for one
  display period and `onFrameAvailable` reopens it. A loop written as above
  runs at ~display rate on both flavors.

### Draw on expose

A `Present` to a window that is not yet viewable is discarded — there is
nowhere to put it — so a frame drawn immediately after `map()` never appears,
and a window that gets uncovered has nothing to redraw itself from. A GL
window has no backing store to serve those from, which is why every GL app
draws on expose:

```js
wnd.on('expose', draw); // adding the listener is what selects Exposure
wnd.map();
```

## macOS

XQuartz never implemented DRI3 — its direct rendering is the **Apple-DRI**
extension, and it runs the transfer the other way round. Where DRI3 is
client-allocates-and-pushes, Apple-DRI is server-exports-and-attaches:

```
this process                              X server (XQuartz)
------------                              ------------------
apple.clientId()  --- AppleDRICreateSurface(win, cid) --->  exports the
                  <-------------- key[2] ----------------   window's surface
ctx.attach(key)      (import surface + bind a CGL context)
gl draws straight into the window's backing store
ctx.flush()          (CGLFlushDrawable — the WindowServer composites)
                  <--- AppleDRISurfaceNotify ------------   moved / resized /
                                                            destroyed
```

After the attach, nothing crosses the X socket per frame — no pixels, no
descriptors, no requests. Rendering is the real GPU (Apple's GL-on-Metal;
`gl.renderer` reports the chip), and the same `gl` API and the same GLSL ES
1.00 shaders as the Linux flavor. The pieces:

| piece | what it is | where it comes from |
| --- | --- | --- |
| `x11-dri` >= 0.5.0 | the WindowServer handshake, the surface import and the CGL context | the same optional dependency, prebuilt for macOS arm64 |
| Apple-DRI | exports a window's surface to a local process | the X server — XQuartz only |
| a GUI session | the WindowServer connection surfaces are imported into | log in at the machine; SSH sessions report `GL_NO_WINDOWSERVER` |

The protocol half — the requests, the reply layouts and the
`AppleDRISurfaceNotify` event — is pure JS in `lib/appledri.js`; the halves
that cannot be (Xplugin, CGL) are the addon's `dri.apple` namespace.

What differs from the `dri3` flavor, beyond the wire:

- **The surface exists only while the window is mapped.** The context is
  created synchronously and `gl.*` works immediately (shaders compile,
  FBOs render), but `gl.ready` settles — and `canRender()` first turns
  true — after `map()`, when the server has a physical window to export.
  Unmapping destroys the surface (`AppleDRISurfaceNotify` says so) and the
  context re-attaches by itself on the next map. The draw-on-expose pattern
  above absorbs all of this without extra code.
- **One CGL context per window**, not a shared one per app: a CGL context
  attaches to exactly one surface. GL resources are therefore per-window on
  this flavor; cache them by the `gl` object identity and both flavors are
  handled.
- **The GL dialect is desktop 4.1 core with `ARB_ES2_compatibility`**, not
  ES: GLSL ES 1.00 sources compile unchanged (the addon injects
  `#version 100` where a source has no version line), ES3-class entry
  points (VAOs, instancing) exist, but `#version 300 es` shaders do not
  compile — ES 3.00 *shading* is Linux-only today.
- **Verify pixels with `gl.readPixels`, not `GetImage`.** The GL surface is
  composited by the WindowServer *above* the X framebuffer, so X-side reads
  of a GL window — `GetImage`, screenshots of the X screen — show stale
  contents by design.
- Depth-32/ARGB windows are untested on this flavor (XQuartz typically
  publishes no 32-bit visual, so `chooseGLConfig({ ALPHA_SIZE: 8 })` fails
  there with `GL_CONTEXT_FAILED`).

## Choosing a window to draw into

`app.chooseGLConfig(spec)` answers for whichever backend the policy picked,
in GLX's attribute vocabulary either way, so the call site does not have to
be written twice:

```js
const config = await app.chooseGLConfig({ DEPTH_SIZE: 24 });
// { backend: 'direct', visual, depth, class, doubleBuffer, depthSize,
//   screen, fbconfig: null, device, config: {} }
```

On the direct backend it needs no round trip — there are no fbconfigs, only a
window whose depth the GPU's buffers can be read as. `DEPTH_SIZE` becomes the
EGL depth-buffer size; `ALPHA_SIZE` picks a 32-bit ARGB visual (whose alpha a
compositor blends) instead of the root's 24-bit one. Everything else in the
spec is ignored there, and honoured by
[`chooseGLXConfig`](context-opengl.md#choosing-a-visual) on the indirect one.

## Testing

`test/gl-policy.test.js` covers the decisions — policy resolution, the client
probe, capability gating, error codes, flavor dispatch — hermetically, with
the addon stubbed, so it runs with no display and no GPU, and
`test/appledri.test.js` checks the Apple-DRI wire encoding the same way. The
live halves skip wherever their path is unavailable, which includes CI (Xvfb
has neither DRI3 nor Apple-DRI): `test/gl-direct-live.test.js` renders a
shader-drawn triangle over DRI3 and reads the window back with `GetImage`;
`test/gl-appledri-live.test.js` does the same against XQuartz and verifies
with `gl.readPixels` (see [macOS](#macos) for why not `GetImage`).
