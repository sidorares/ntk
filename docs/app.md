# App

An `App` represents one connection to an X server and is the factory for
windows and pixmaps.

## `createClient([options], [callback]) → Promise<App>`

```js
import { createClient } from 'ntk';
const app = await createClient();           // uses $DISPLAY
const app2 = await createClient({ display: ':1' });
```

- `options` is passed through to `x11.createClient` (e.g. `{ display: ':1' }`).
  ntk additionally understands:
  - `fontSource` — where fonts come from: a FontSource, or a font spec such
    as `'/app/fonts'` or `[bytes]` naming the faces the app ships, which is
    what an environment without fontconfig needs
    (see [fonts.md](fonts.md#environments-without-fontconfig));
  - `rasterizer` / `rasterPolicy` — where fills, strokes and clip masks are
    rasterized, and the thresholds for that choice (see
    [context-2d.md](context-2d.md#where-drawings-are-rasterized));
  - `glxVisual` — visual id `getContext('opengl')` should use instead of
    querying the server for one (see [context-opengl.md](context-opengl.md));
  - `onXError` — called with X protocol errors that no request callback
    claimed (races like a request landing after its window was destroyed).
    Defaults to a `console.warn`; without any listener node-x11's error
    emit would throw inside its packet parser and wedge the connection.
- **Requests are buffered by default**, so a frame is one socket write
  instead of one per drawing request (see
  [Frames, coalescing and slow connections](window.md#frames-coalescing-and-slow-connections)).
  ntk sets
  node-x11's `bufferRequests` to a 64 KB output buffer; pass your own policy
  (`{ maxSize, maxDelay, flushOnReply, shouldFlush }`) or `bufferRequests:
  false` to write per request. Nothing waits on the buffer: node-x11 flushes
  it when it is full, when its oldest request is 5 ms old, when a request
  that expects a reply is sent, before the event loop polls, and on
  `app.close()`/process exit. `app.X.flush()` forces it out at any time, and
  `app.X.pack_stream.stats` (`{ packets, bytes, writes, allocs }`) reports
  what reached the socket.
- The XRender extension is preloaded (required for the 2d context). GLX is
  preloaded when available; `app.display.GLX` is `null` when the server has no
  GLX support.
- Keyboard mapping is fetched up front and kept up to date on
  `MappingNotify`, so `keydown` events carry `codepoint`.
- A big-endian (MSBFirst) connection is rejected with an error. node-x11
  declares the host byte order in its connection hello but encodes every
  request LSBFirst regardless, so such a connection is already inconsistent
  before ntk sees it; failing here beats decoding byte-swapped properties
  into plausible-looking nonsense.
- The legacy node-style `callback` is also supported.

## Properties

- `app.display` — the node-x11 display object (`screen`, `Render`, `GLX`, …)
- `app.X` — the raw node-x11 client, for direct protocol requests
- `app.fonts` — lazy [FontManager](fonts.md): font matching/loading, shaping
- `app.clipboard` — lazy [Clipboard](clipboard.md): selection/clipboard
  transfer (`write()`/`read()`/`clear()`), text or arbitrary targets
- `app.rasterizer` — the Rasterizer small fills, strokes and clip masks go
  through; writable, `null` sends every drawing to the server
  ([context-2d.md](context-2d.md#swapping-the-rasterizer))
- `app.rasterPolicy` — the thresholds for that choice, merged over
  `DEFAULT_RASTER_POLICY`
- `app.maskPolicy` — when a drawing whose subpaths are scattered is worth
  more than one mask, merged over `DEFAULT_MASK_POLICY`
  ([context-2d.md](context-2d.md#many-pieces-in-one-path-what-the-mask-costs))
- `app.refreshRate` — the fastest refresh rate any active output is running
  at, in Hz; `null` until the display has been asked, and on a server with no
  RandR or no mode worth pacing to
- `app.frameInterval` — that rate as a period in ms, which is what windows on
  this connection take as their default `frameInterval` (see
  [window.md](window.md#frames-coalescing-and-slow-connections)); `null`
  alongside `refreshRate`

The rate is probed once per connection, in the background, when the first
window is created — three RandR round trips that no window waits for. Windows
built before the answer lands adopt it when it does, unless they were given a
`frameInterval` of their own. The *fastest* output rather than the one a given
window sits on, because what this feeds is a rate ceiling: a window paced
faster than its own monitor is bounded by the next gate along, whereas one
paced slower can never reach the rate its display offers.

## Methods

- `app.createWindow(args) → Window` — see [window.md](window.md)
- `app.rootWindow() → Window` — wrapper for the first screen's root window
- `app.createPixmap(args) → Pixmap` — see [pixmap.md](pixmap.md)
- `app.createColormap(visual, screen = 0) → id` — allocate a colormap for a
  visual (alloc None). Windows created with an explicit `visual` get one
  automatically, so this is only needed to share one between windows
- `app.chooseGLXConfig(spec) → Promise<config>` — pick a GLX-capable visual
  by querying the server; `config.visual`/`config.depth` feed `createWindow`
  and the whole object feeds `getContext('opengl', config)`. See
  [context-opengl.md](context-opengl.md)
- `app.inputDevices({ refresh }) → Promise<device[]>` — every input device
  the server knows about, from XInput 2's `XIQueryDevice`:
  `{deviceId, use, attachment, enabled, name, classes}`, where `classes`
  describes each device's keys, buttons, valuators and scroll axes. `[]`
  where the server has no XI2. Cached — this is what a window with
  [smooth scrolling](window.md#wheel-and-smooth-scrolling) consults to find
  the axis behind a wheel delta, and it must not cost a round trip per
  event; pass `{ refresh: true }` to re-read it
- `app.xinput() → Promise<ext|null>` — the raw node-x11 XInput extension
  object, or `null` where there is none. `ext.xi2` is `null` on a server
  that speaks XI1 only. The escape hatch for the XI2 requests ntk does not
  wrap (grabs, device properties, barriers)
- `app.close() → Promise` — flush pending requests, then close the connection

## Resource management

`App` implements both `Symbol.asyncDispose` (flush + close, prefer this) and
`Symbol.dispose` (immediate terminate):

```js
await using app = await createClient();
// connection closed automatically at end of scope
```

See [resource-management.md](resource-management.md).
