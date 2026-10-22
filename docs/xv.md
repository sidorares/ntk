# XVideo

`ntk/xv` hands a YCbCr frame to the X server, which converts it to RGB —
and can scale it — on the GPU. A frame of NV12 or I420 is 1.5 bytes a pixel
on the way in rather than 4, and no CPU of yours touches a pixel of the
conversion.

```js
import { createClient } from 'ntk';
import { openVideoPort } from 'ntk/xv';

const app = await createClient();
const port = await openVideoPort(app); // null: no adaptor here — draw it yourself

await port.prepare('NV12', 1280, 720); // the port's layout at that size
const target = port.createTarget(win, { width: 1280, height: 720 });

decoder.on('frame', (y, uv) => {
  target.put({ format: 'NV12', width: 1280, height: 720, planes: [y, uv], colorSpace: 'bt709' });
  target.copyTo(surface); // one server-side copy, in line with the put
  win.requestAnimationFrame(() => ctx.drawImage(surface, 0, 0, 640, 360));
});
```

It is a thin layer over node-x11's requests ([its docs](https://github.com/sidorares/node-x11/blob/master/docs/ext/xv.md)),
and needs x11 4.2 or later for the image half of the extension. What it adds
is what every caller would otherwise write again: choosing and grabbing a
port, laying a frame out the way the port asks, sending it through shared
memory where that attaches, and a place to put it that is not on screen.

## `openVideoPort(app, { depth = 24 })`

Resolves with a `VideoPort`, or with `null` when this server has nothing to
give: no XVideo, no adaptor that takes images at `depth`, every port held by
another client, or an x11 too old to send an image. **`null` is the normal
answer** on Xvfb and XQuartz, which advertise the extension and then answer
"no adaptors present" — so a caller always keeps a path that does not need
this one.

The port is grabbed, so another client setting an attribute cannot change
your frames under you. `port.close()` ungrabs it; `app.close()` closes every
port still open.

| `VideoPort`                  |                                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `formats`                    | what the port takes that ntk lays out: `'NV12'`, `'I420'`, `'YV12'`, `'UYVY'`, `'YUY2'`, `'AR24'`                       |
| `colorSpaces`                | `['bt601', 'bt709']` where the port has a settable `XV_COLORSPACE` (glamor, Intel); `['bt601']` where it has none      |
| `depth`, `adaptor`, `id`     | the depth it draws at, the adaptor's name (`'glamor textured video'`), the port XID                                      |
| `prepare(format, w, h)`      | the port's layout for that size, awaited — `{ width, height, dataSize, pitches, offsets }`, the size possibly rounded up |
| `layout(format, w, h)`       | the same, synchronously: `null` the first time, while the query is in flight                                            |
| `putImage(drawable, frame)`  | one frame into a window at the port's depth; answers whether it was sent                                                 |
| `createTarget(parent, size)` | a `VideoTarget` under `parent`, or `null` with no Composite                                                              |
| `stop(drawable)`             | `StopVideo` for a drawable the port drew into                                                                            |
| `close()`                    | ungrab, and let go of the shared-memory segments                                                                         |

### The frame

`{ format, width, height, planes, strides?, src?, dst?, colorSpace? }`.
`planes` are in the format's own order — `[y, u, v]` for I420, `[y, v, u]`
for YV12, `[y, uv]` for NV12, one buffer for the packed formats — and are
copied before `putImage` returns, so a decoder may reuse them at once.
`strides` are their bytes per row where a decoder pads them. `src` is the
part of the frame to show and `dst` where in the drawable, in each one's own
pixels; the adaptor scales between the two.

**Every adaptor ntk knows reads video range** — black at 16, white at 235.
A full-range frame is not one to put through Xv; convert it yourself.

`putImage` answers `false`, and sends nothing, for a format the port does not
take, a colour space it cannot be told, a size whose layout it has not
answered yet (the first ask starts the query; `prepare` beforehand avoids
the miss), or a frame too large for one request on a connection with no
shared memory. Draw that frame your own way.

### The transport

Through MIT-SHM where a segment attaches — the case on any local display —
and down the socket as `PutImage` where it does not. The discipline is
[`ShmUploader`'s](context-2d.md): only a segment that is **already attached**
is used, so a put lands in the request stream exactly where you made it; the
first frame of a size goes down the socket while a segment warms behind it;
and a segment goes back into the pool only when the server's `ShmCompletion`
says it has read it. A port keeps at most three.

## `VideoTarget`

A pixmap is not something an adaptor draws into. Measured on Xwayland's
glamor adaptor, `PutImage` into a depth-24 pixmap is `BadWindow` and into a
depth-32 one `BadMatch`: textured adaptors take windows. A window draws on
screen and takes the pointer — which is the flaw every embedded video player
has, sitting above everything drawn in its parent — so a target is a child
window that is **manually redirected** and placed **outside its parent**.
Composite gives it a pixmap of its own that nothing shows; the adaptor draws
into that; and RENDER reads it out wherever you composite it, in paint order,
under your clips and your tooltips.

```js
const target = port.createTarget(win, { width: 1280, height: 720 });
target.put(frame); // putImage, scaled to fill the target
target.copyTo(surface); // keep it: one Composite into a Surface
ctx.drawImage(target, x, y, w, h); // or composite it straight from the target
target.destroy();
```

It is shaped like an [`Image`](images.md) — `width`, `height`,
`picture(app)` — so `drawImage` takes it. **Its pixels last only while its
parent is mapped**: a window that is not viewable has no redirected pixmap.
Put a frame and copy it out in the same breath, while the parent is on
screen, and keep the copy in a [`Surface`](surface.md) for every paint after.

A target whose parent is an ntk `Window` goes quietly with it: destroying the
parent takes the child, its picture and the port's hold on it, and the target
sends nothing afterwards. A target under a window given by id is the
caller's to destroy first.
