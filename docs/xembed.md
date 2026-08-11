# XEmbed

[XEmbed 0.5](http://specifications.freedesktop.org/xembed/0.5/) is the
freedesktop convention for putting one client's top-level window inside
another client's window hierarchy, across toolkits. It needs no X extension —
core requests only — and it is what a terminal pane, an embedded media
surface, a system-tray host and a `<foreign>` element all reduce to.

```js
import { XEmbedSocket, XEmbedPlug, XEMBED } from 'ntk/xembed';
// or: import { XEmbedSocket } from 'ntk';
```

There are two roles. The **embedder** (GTK calls it a socket, Qt a container)
owns a window that someone else's window is reparented into. The **client**
(GTK's plug) is that someone else. `XEmbedSocket` and `XEmbedPlug` are those
two roles; they can be used against each other, against GTK2/Qt4 plugs and
tray icons, or — the common case — against programs that speak no XEmbed at
all.

## The socket

```js
const socket = new XEmbedSocket(parentWindow, { x: 0, y: 0, width: 640, height: 480 });
await socket.embed(clientWindowId);
```

`XEmbedSocket(parent, options)` creates a container window under `parent` and
exposes it as `socket.window`. `embed()` then adds the client to our save-set,
reparents it in, sizes it to the container and — if the client speaks the
protocol — tells it so.

The client window id comes from wherever the client publishes it: `xterm
-into WID`, `mpv --wid=WID`, a tray icon's dock request, or a plug handing you
`plug.window.id`.

### Constructor options

| option | meaning |
| --- | --- |
| `x`, `y`, `width`, `height` | geometry of the container window this creates |
| `window` | embed into a window you already own instead. It is then yours to map, position and destroy |
| `version` | cap the protocol version offered to the client (default `XEMBED.VERSION`, 0) |
| `focusOnRequest` | answer `XEMBED_REQUEST_FOCUS` with `focusIn()` automatically (default `true`; turn it off if you run your own focus manager) |

### Methods

- `embed(clientId)` → `Promise<{ id, window, version, xembed }>` — take the
  window over. Rejects if it does not exist. `xembed: false` means the client
  set no `_XEMBED_INFO` and got plain reparenting
- `adopt({ timeout })` → the same, for a program that put its window inside
  ours by itself — see [below](#clients-that-do-not-speak-xembed)
- `resize({ x, y, width, height })` → `Promise` — move and resize the
  container and the client with it, and send the client a synthetic
  ConfigureNotify in **root** coordinates (ICCCM 4.1.5 — a reparented
  window's own ConfigureNotify says where it sits inside us, which is not the
  question it asked)
- `activate(on = true)` / `deactivate()` — the toplevel the socket lives in
  became, or stopped being, the active window
- `focusIn(detail = XEMBED.FOCUS_CURRENT)` / `focusOut()` — give and take the
  logical focus. `FOCUS_CURRENT` is a click (focus the client without
  disturbing which of its own widgets is focused); `FOCUS_FIRST` / `FOCUS_LAST`
  are a Tab or back-Tab arriving from outside
- `modality(on = true)` — the embedder has put up a modal dialog elsewhere;
  the client should stop responding to input
- `send(opcode, detail, data1, data2, { time })` — a raw `_XEMBED` message,
  for the opcodes ntk does not model (the accelerator ones)
- `release()` → `Promise` — hand the client back: reparented to the root at
  the position it occupied on screen, out of the save-set, no longer watched.
  It is an ordinary top-level window again
- `destroy()` → `Promise` — `release()`, then drop the container window (if
  this created it) and the focus proxy

### Events

| event | argument | when |
| --- | --- | --- |
| `embedded` | `{ id, window, version, xembed }` | the client is in |
| `mappedChange` | `mapped` | the client asked to be shown or hidden |
| `requestFocus` | — | the client wants the logical focus |
| `focusNext` / `focusPrev` | — | the client ran off the end of its own tab chain; move to your next widget |
| `message` | `{ opcode, name, detail, data1, data2, time }` | an `_XEMBED` message ntk does not act on itself |
| `gone` | — | the client was destroyed, or reparented away by someone else |

`socket.client` is the client as a `Window` (`null` when there is none),
`socket.xembed` whether it answered with `_XEMBED_INFO`.

## Clients that do not speak XEmbed

Most of the interesting ones do not. `xterm -into`, `mpv --wid`, VLC and Wine
want plain reparenting and set no `_XEMBED_INFO`. A missing property means
"map it now, skip the message protocol", which is what GtkSocket does and what
makes a terminal pane or a video surface work.

These programs also come at it from the other end: rather than publishing a
window id for an embedder to reparent, they are *given* one and put their own
window inside it. There is then nothing left to reparent, so `adopt()` is the
call rather than `embed()` — everything after that (sizing, the synthetic
ConfigureNotify, the mapped state, `gone`) is the same:

```js
const socket = new XEmbedSocket(pane, { width: 640, height: 480 });
spawn('xterm', ['-into', String(socket.window.id)]);
const { xembed } = await socket.adopt({ timeout: 10000 });
// xembed === false: sized and mapped, and that is all
```

A child that is already there is taken immediately, and `adopt()` listens
before it looks, so a program that is quicker than the call cannot fall
between the two. Without a `timeout` it waits for as long as it takes, which
is right for a program that is still starting up and wrong for one that has
already failed to.

`embed(id)` is for the other shape: a window id you were handed — a GtkPlug,
a tray icon's dock request, an `XEmbedPlug`.

GTK4 removed `GtkSocket`/`GtkPlug` and Qt never carried `QX11EmbedWidget` past
Qt4, so the living plugs are legacy apps and tray icons — and the living
sockets are the useful half.

## Focus, and the focus proxy

The embedder holds the real X input focus; the client gets *logical* focus by
message. That leaves keyboard input to be routed by hand, because X delivers a
key press to the focus window **or to the deepest descendant of it under the
pointer** — so with focus on the embedder's toplevel, whether the embedded
client sees a keystroke would depend on where the mouse happens to be.

`focusIn()` therefore brings up a `FocusProxy`: a 1×1 InputOnly window, mapped
but clipped entirely outside its parent, which holds the real focus and
forwards what it receives into the client with `SendEvent`. It has no
descendants and covers no pixels, so everything it gets belongs to whoever is
logically focused. `focusOut()` stops the forwarding.

Forwarded events carry X's `send_event` flag, as any `SendEvent` does. Toolkit
clients accept them — this is how XEmbed keyboard input has always worked —
but a client that filters synthetic events will not see them.

The socket's window has to be viewable for `focusIn()` to be able to take the
focus, which means the container and everything above it must be mapped.

A complete focus cycle looks like:

```js
top.on('focus', () => socket.activate(true));
top.on('blur', () => socket.activate(false));

socket.on('requestFocus', () => myFocusManager.give(socket)); // the user clicked it
socket.on('focusNext', () => myFocusManager.next());          // Tab off the end
```

## The plug

```js
const plug = new XEmbedPlug(app, { width: 300, height: 200 });
await plug.ready;
console.log(plug.window.id); // hand this to the embedder
```

The window is deliberately left unmapped: an embedder maps it, once it has
reparented it and read `XEMBED_MAPPED` out of `_XEMBED_INFO`. Draw into
`plug.window` like any other window. `await plug.ready` is what guarantees
`_XEMBED_INFO` is on the window before its id goes anywhere.

Options are `{ version, mapped }` — the two words of `_XEMBED_INFO` — plus
`{ window }` to adopt a window instead of creating one; anything else is
passed to `app.createWindow()`.

- `setMapped(mapped)` → `Promise` — ask the embedder to map or unmap us. An
  embedder may leave us unmapped while the bit is set (a tab that is not the
  current one), but must unmap promptly when it clears
- `requestFocus()` — what a client sends when the user clicks it. The embedder
  answers with `XEMBED_FOCUS_IN`, or does not
- `focusNext()` / `focusPrev()` — we ran off the end of our own tab chain; the
  embedder moves on to its next widget
- `send(opcode, detail, data1, data2, { time })` — a raw message
- `destroy()`

Events: `embedded(embedderId)`, `activate`, `deactivate`, `focusIn(detail)`,
`focusOut`, `modality(on)`, `message({ opcode, … })`, `released`.

State is mirrored on the object as `plug.embedder`, `plug.xembed`,
`plug.active`, `plug.focused`, `plug.modal`, `plug.mapped`. Before any message
arrives a client is inactive, unfocused and not modal — that is the protocol's
starting state, and the embedder synchronises by sending messages after
`XEMBED_EMBEDDED_NOTIFY`.

`embedded` fires on the ReparentNotify, which is how a client learns it has
been embedded (spec step 5). An XEmbed-aware embedder sends
`XEMBED_EMBEDDED_NOTIFY` immediately afterwards, so `plug.xembed` and
`plug.version` are worth reading on the next turn rather than inside that
handler; an embedder that only reparents (`xterm -into`, `mpv --wid`) never
sends it. `released` fires when the window is reparented back to the root,
which ends the protocol.

## Constants and the property

`XEMBED` holds the version, the `_XEMBED_INFO` flag, the opcodes and the
`XEMBED_FOCUS_IN` details:

```js
XEMBED.VERSION          // 0
XEMBED.MAPPED           // 1 — bit 0 of the _XEMBED_INFO flags word
XEMBED.EMBEDDED_NOTIFY  // 0
XEMBED.WINDOW_ACTIVATE  // 1     XEMBED.WINDOW_DEACTIVATE  // 2
XEMBED.REQUEST_FOCUS    // 3
XEMBED.FOCUS_IN         // 4     XEMBED.FOCUS_OUT          // 5
XEMBED.FOCUS_NEXT       // 6     XEMBED.FOCUS_PREV         // 7
XEMBED.MODALITY_ON      // 10    XEMBED.MODALITY_OFF       // 11
XEMBED.REGISTER_ACCELERATOR // 12 … UNREGISTER 13, ACTIVATE 14
XEMBED.FOCUS_CURRENT    // 0     FOCUS_FIRST 1, FOCUS_LAST 2
```

`XEMBED_OPCODE_NAMES` maps an opcode back to its name, which is what the
`message` events carry as `name`.

A message is a format-32 ClientMessage of type `_XEMBED` whose words are
`[time, opcode, detail, data1, data2]`.

`_XEMBED_INFO` is a format-32 property of type `_XEMBED_INFO` (its own name,
not `CARDINAL`) holding two CARD32s — the version the client speaks and its
flags:

```js
encodeXEmbedInfo({ version: 0, mapped: true }); // [0, 1]
decodeXEmbedInfo([0, 1]);       // { version: 0, flags: 1, mapped: true }
decodeXEmbedInfo(null);         // null — no property: not an XEmbed client
await readXEmbedInfo(someWindow);
```

## What ntk does not do

- **Accelerators.** `XEMBED_REGISTER_ACCELERATOR` and friends are the
  least-used corner of the spec; the opcodes are in `XEMBED`, the machinery
  is not. `socket.send()` / `plug.send()` reach them.
- **The system tray.** The
  [tray spec](http://specifications.freedesktop.org/systemtray/latest/) is
  XEmbed's largest surviving consumer — a host owns the
  `_NET_SYSTEM_TRAY_S<screen>` manager selection and embeds each docked icon
  with XEmbed. The embedding half is here; the selection half is not, yet.
