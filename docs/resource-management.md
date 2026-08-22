# Resource management

Every ntk object that owns a server-side X resource supports **explicit
resource management** ([`using` declarations](https://github.com/tc39/proposal-explicit-resource-management),
available since Node 24; the `Symbol.dispose` methods themselves work on
Node 20+ when called directly):

| object | explicit | `using` support |
|---|---|---|
| `App` (connection) | `await app.close()` | `Symbol.asyncDispose` (flush + close), `Symbol.dispose` (terminate) |
| `Window` | `wnd.destroy()` | `Symbol.dispose` |
| `Pixmap` | `pixmap.destroy()` | `Symbol.dispose` |
| `Picture` | `picture.destroy()` | `Symbol.dispose` |
| `GlyphSet` | `glyphset.destroy()` | `Symbol.dispose` |
| `Region` | `region.destroy()` | `Symbol.dispose` |

```js
import { createClient } from 'ntk';

{
  await using app = await createClient();
  using pixmap = app.createPixmap({ width: 256, height: 256, depth: 24 });
  const ctx = pixmap.getContext('2d');
  // ... draw, read pixels ...
} // pixmap freed, connection flushed and closed — process can exit
```

## GC fallback

If you never destroy an object explicitly, the server resource is freed when
the JS wrapper is garbage collected, via `FinalizationRegistry` (this
replaced the old native `weak-napi` dependency). This is a safety net, not a
strategy: GC timing is unpredictable and the X server keeps resources alive
in the meantime. For long-running apps, destroy what you create — or let
`using` do it.

Objects wrapping ids ntk did not create (`new Window(app, { id })`,
`new Pixmap(app, { id })`) are not owned and are never freed by ntk.

Cleanup — explicit or GC-driven — becomes a silent no-op once the connection
is closing or closed: the X server frees all of a client's resources on
disconnect, so late finalizers after `app.close()` have nothing left to do.

## The connection keeps the process alive

An open X connection holds the node event loop open. Call
`await app.close()` (or use `await using`) when your program is done, or the
process will not exit.
