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
  - `fontSource` — pluggable system-font lookup for `app.fonts`
    (see [fonts.md](fonts.md#pluggable-font-sources));
  - `rasterizer` / `rasterPolicy` — where fills and strokes are rasterized,
    and the thresholds for that choice (see
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
  text transfer (`write()`/`read()`)
- `app.rasterizer` — the Rasterizer small fills and strokes go through;
  writable, `null` sends every drawing to the server
  ([context-2d.md](context-2d.md#swapping-the-rasterizer))
- `app.rasterPolicy` — the thresholds for that choice, merged over
  `DEFAULT_RASTER_POLICY`

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
- `app.close() → Promise` — flush pending requests, then close the connection

## Resource management

`App` implements both `Symbol.asyncDispose` (flush + close, prefer this) and
`Symbol.dispose` (immediate terminate):

```js
await using app = await createClient();
// connection closed automatically at end of scope
```

See [resource-management.md](resource-management.md).
