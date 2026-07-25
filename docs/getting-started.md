# Getting started

## Requirements

- Node.js >= 20.19 (the package is ESM; CJS consumers on >= 20.19 can still `require('ntk')`)
- An X server (any Linux desktop, Xvfb, XQuartz on macOS, …)
- `fontconfig` (`fc-match`) for CSS-style font name resolution — present on
  virtually every system that runs X11. Only needed if you use `ctx.font = '...'`;
  loading fonts by file path works without it.

All dependencies are pure JavaScript — there is nothing to compile at install
time.

```
npm install ntk
```

## First window

```js
import { createClient } from 'ntk';

const app = await createClient();
const wnd = app.createWindow({ width: 500, height: 300, title: 'Hello' });
wnd.on('mousedown', (ev) => wnd.setTitle(`click: ${ev.x},${ev.y}`));
wnd.map();
```

`createClient()` returns a `Promise<App>`; a node-style callback
`createClient((err, app) => {})` is also still supported.

## Drawing

```js
const ctx = wnd.getContext('2d');
ctx.fillStyle = 'red';
ctx.fillRect(10, 10, 100, 100);
```

See [context-2d.md](context-2d.md) for the full drawing API and
[window.md](window.md) for events.

## Headless / CI

Everything works against Xvfb:

```
xvfb-run -a node my-app.js
```

The ntk test suite itself runs this way in CI.
