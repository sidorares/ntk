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
    emit would throw inside its packet parser and wedge the connection;
  - `sharedGlyphs` — the cross-process shared glyph cache
    ([shared-glyphs.md](shared-glyphs.md)): on by default, `false` turns it
    off (as does `NTK_NO_SHARED_GLYPHS=1` in the environment), an object
    (`{ budgetBytes }`) sets the directory-side budget.
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
- `app.sharedGlyphs` — the cross-process shared glyph cache client
  ([shared-glyphs.md](shared-glyphs.md)); `null` when disabled via
  `createClient({ sharedGlyphs: false })` or `NTK_NO_SHARED_GLYPHS`
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
- `app.composite()` / `app.damage()` / `app.xfixes()` / `app.shape()` /
  `app.xinput() → Promise<ext|null>` — the raw node-x11 extension objects,
  each `null` where the server has none. See [Extensions](#extensions)
- `app.createRegion(rects) → Promise<Region>` — a server-side XFIXES region
  of the given rectangles (`{x, y, width, height}` or ntk's own
  `{x, y, w, h}`), empty by default. Regions are how X describes a
  non-rectangular area — expose damage, a window's SHAPE, what a compositor
  has left to paint — and `ctx.clipRegion(region)` clips a 2d context to
  one. See [Region clips](context-2d.md#region-clips)
- `app.fixes() → Promise<ext>` — the throwing spelling of `app.xfixes()`:
  same query, same cache, but rejects with `code` `'ERR_NTK_NO_XFIXES'` on a
  server that has no XFIXES at all. `createRegion` awaits this for you; call
  it directly when you build regions through node-x11 yourself, or need the
  XFIXES requests ntk does not wrap
- `app.pictFormatFor(visual, { depth }) → Promise<formatId>` — the RENDER
  picture format a drawable on that visual is read and written through. See
  [Picture formats](#picture-formats)
- `app.pictFormats() → Promise<{formats, byVisual}>` — the whole table: the
  server's formats list as objects, and a `Map` from visual id to format id
- `app.close() → Promise` — flush pending requests, then close the connection

## Extensions

Everything past the core protocol is an extension, and which ones a server
has is a property of that server rather than of its version. These accessors
ask once per connection and hand back node-x11's extension object — or
`null`, which is a real answer and usually the one worth branching on:

```js
const composite = await app.composite();
if (!composite) throw new Error('no Composite: this server cannot be composited');

const damage = await app.damage();
const fixes = await app.xfixes();
const shape = await app.shape();
```

- `app.composite() → Promise<ext|null>` — **Composite**: redirect a window's
  own or its children's rendering into an offscreen pixmap and name that
  pixmap (`RedirectWindow`, `RedirectSubwindows`, `NameWindowPixmap`), plus
  the overlay window a compositing manager paints its output into
  (`GetOverlayWindow` / `ReleaseOverlayWindow`)
- `app.damage() → Promise<ext|null>` — **DAMAGE**: "this drawable changed"
  as an event (`Create`, `Subtract`), so a repaint costs the region a client
  drew into rather than the whole screen
- `app.xfixes() → Promise<ext|null>` — **XFIXES**: server-side regions and
  the algebra over them (`CreateRegion`, `CreateRegionFromWindow`,
  `UnionRegion`, `SubtractRegion`, `FetchRegion`), which is how a damaged
  area becomes a clip — `app.createRegion(rects)` builds one wrapped, and
  `ctx.clipRegion(region)` narrows a 2d context to it, entirely server-side
  ([Region clips](context-2d.md#region-clips)). node-x11 calls the module
  `fixes`; the accessor is named after the extension. `app.fixes()` is the
  same query through the same cache, rejecting instead of resolving `null`
- `app.shape() → Promise<ext|null>` — **SHAPE**: non-rectangular bounding,
  clip and input shapes (`Rectangles`, `Mask`, `Combine`, `GetRectangles`),
  which is what has to be read back to paint a shaped client without
  square corners
- `app.xinput() → Promise<ext|null>` — **XInput**. `ext.xi2` is `null` on a
  server that answers the extension query but speaks XI1 only, and every XI2
  request needs it, so callers check both. The escape hatch for the XI2
  requests ntk does not wrap (grabs, device properties, barriers)

The requests themselves are node-x11's, unwrapped: this is a discovery and
caching seam, not a second API over the extensions. See node-x11's
`lib/ext/` for each one's signatures.

The answer is cached per connection, the absent one included — node-x11 keeps
an extension object it built but not a query that came back absent, so
without this cache "does this server have Composite?" would cost a
`QueryExtension` round trip every time it was asked.

### Not every server has them

The four above are what a **compositing manager** is built out of; the
window-manager half of one is
[Being the window manager](window.md#being-the-window-manager). They do not
travel together, so ask rather than assume: XQuartz carries DAMAGE, XFIXES,
SHAPE, RENDER and Present, but **no Composite at all**. `null` is therefore
where a compositor stops — before it redirects anything — and where a plainer
app that only wanted a region or a shape degrades to doing without.

### Extension events

The events these extensions add are not core events and not generic events
either: their type codes are assigned by the server at QueryExtension time,
and each one names its target under the field its own protocol calls it —
`DamageNotify` a `drawable`, the others a `window` — so the core dispatch
tables cannot see them. Requiring an extension through the accessors above
is what teaches the connection its events; from then on each one is
delivered to the `Window` — or `Pixmap`, since a DAMAGE object can watch
one — that it names, under an ntk name, through the same delivery path as
core events:

| event | X event | payload |
|---|---|---|
| `damage` | DAMAGE DamageNotify | the drawable's content changed. Coalesced per paced frame exactly like `expose`: bounding box in `ev.x/y/width/height`, every reported rectangle in `ev.rects`; plus `ev.damage` (the DAMAGE object id, what `Subtract` takes), `ev.geometry`, `ev.level`, `ev.more` (the wire's "more follow" flag — coalescing already batches, so it is informational), `ev.time` |
| `shape` | SHAPE ShapeNotify | the window's shape changed: `ev.kind` (`'bounding'`, `'clip'` or `'input'`), the new extents in `ev.x/y/width/height`, `ev.shaped` (false when the shape was removed), `ev.time` |
| `selection_owner` | XFIXES SelectionNotify | a selection's ownership changed (`selection` here means what it does in [clipboard](clipboard.md), not the core conversion event `'selection'` reports): `ev.selection` (atom), `ev.owner` (window id, 0 when nobody), `ev.reason` (`'new-owner'`, `'destroyed'` or `'closed'`), `ev.timestamp`, `ev.selectionTimestamp`. [`app.clipboard.watch()`](clipboard.md) is the wrapped spelling |
| `cursor` | XFIXES CursorNotify | the displayed cursor image changed — what a compositor redraws its cursor from: `ev.cursorSerial`, `ev.cursorName` (atom, 0 when unnamed), `ev.time` |

Selecting for them still goes through the extension — `damage.Create(...)`,
`shape.SelectInput(...)`, `fixes.SelectSelectionInput(...)`,
`fixes.SelectCursorInput(...)` — because that is a request each protocol
shapes differently. Delivery is ntk's: a compositor's repaint loop is one
listener, with the same per-frame coalescing a window's own `expose` gets:

```js
const damage = await app.damage();
if (!damage) throw new Error('no DAMAGE on this server');

const wnd = app.createWindow({ id: clientWid }); // adopt the composited window
damage.Create(app.X.AllocID(), wnd.id, damage.ReportLevel.NonEmpty);
wnd.on('damage', (ev) => {
  // once per paced frame, however many rectangles the burst reported
  for (const r of ev.rects) repaint(wnd, r);
});
```

Events about drawables nothing wraps — an id never made into a `Window` or
`Pixmap` — still arrive parsed on the node-x11 client, as every event does:
`app.X.on('event', (ev) => ...)`, matching `ev.name`. A `Pixmap` joins the
routed path the moment it gets a listener for one of these names, and
leaves it in `destroy()`.

## Picture formats

A RENDER picture format tells the server how to read a drawable's pixels:
where the red, green, blue and alpha bits are, and how many of each. **The
drawable's visual is what names one — its depth is not enough.** A depth-16
visual may be 5:6:5 or 5:5:5, depth 24 may be RGB or BGR, and 10:10:10:2 is
32 bits wide just like 8:8:8:8. Compositing through a format that does not
describe the pixels is not an error RENDER reports; it simply reads the
channels wrong.

ntk does this for you on anything it draws on: a window knows its visual
(`wnd.visualId`), a backing pixmap is given the window's, and a 2d context
binds its picture from that. The table is fetched once per connection,
during the handshake, so nothing waits for it.

Ask directly when you hold a drawable ntk did not create — a compositor's
`NameWindowPixmap` result, a foreign pixmap handed over by another client:

```js
const attrs = await wnd.getAttributes();
const format = await app.pictFormatFor(attrs.visual);
Render.CreatePicture(pictureId, pixmapId, format, {});
```

`depth` is the fallback, used where the server names no format for the
visual (an indexed visual, or one this connection was never told about): the
standard format for that depth, which is what ntk assumed everywhere before
[#295](https://github.com/sidorares/ntk/issues/295).

## Resource management

`App` implements both `Symbol.asyncDispose` (flush + close, prefer this) and
`Symbol.dispose` (immediate terminate):

```js
await using app = await createClient();
// connection closed automatically at end of scope
```

See [resource-management.md](resource-management.md).
