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
  - `glxVisual` — visual id used by `getContext('opengl')` in environments
    where `glxinfo` cannot be shelled out to
    (see [context-opengl.md](context-opengl.md)).
- The XRender extension is preloaded (required for the 2d context). GLX is
  preloaded when available; `app.display.GLX` is `null` when the server has no
  GLX support.
- Keyboard mapping is fetched up front and kept up to date on
  `MappingNotify`, so `keydown` events carry `codepoint`.
- The legacy node-style `callback` is also supported.

## Properties

- `app.display` — the node-x11 display object (`screen`, `Render`, `GLX`, …)
- `app.X` — the raw node-x11 client, for direct protocol requests

## Methods

- `app.createWindow(args) → Window` — see [window.md](window.md)
- `app.rootWindow() → Window` — wrapper for the first screen's root window
- `app.createPixmap(args) → Pixmap` — see [pixmap.md](pixmap.md)
- `app.close() → Promise` — flush pending requests, then close the connection

## Resource management

`App` implements both `Symbol.asyncDispose` (flush + close, prefer this) and
`Symbol.dispose` (immediate terminate):

```js
await using app = await createClient();
// connection closed automatically at end of scope
```

See [resource-management.md](resource-management.md).
