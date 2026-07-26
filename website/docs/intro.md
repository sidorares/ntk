---
title: Introduction
sidebar_position: 1
slug: /intro
---

# ntk

**ntk** is a node.js desktop UI toolkit for X11: a set of wrappers around the
low level [node-x11](https://github.com/sidorares/node-x11) module that
simplify X Window UI programming — window creation, DOM-style event handling,
2d/3d graphics — using API concepts you already know from the web:

- browser-style events (`mousedown`, `keydown`, `expose`, …) on windows
- an HTML canvas-like **2d context** backed by the XRender extension —
  composition, gradients, blur and glyph drawing happen **server-side**
- a webgl-ish **opengl context** over indirect GLX (OpenGL 1.4 command
  serialization, no client GL library)

Everything, including font rasterization, is pure JavaScript:
`npm install` never compiles anything.

## Install

```bash
npm install ntk
```

Requires Node.js >= 20.19 and an X server (any Linux desktop, Xvfb,
XQuartz on macOS, …).

## Hello, window

```js
import { createClient } from 'ntk';

const app = await createClient();
const wnd = app.createWindow({ width: 500, height: 300, title: 'Hello' });
wnd.on('mousedown', (ev) => wnd.setTitle(`click: ${ev.x},${ev.y}`));
wnd.map();
```

Drawing works like an HTML canvas:

```js
const ctx = wnd.getContext('2d');
ctx.fillStyle = 'red';
ctx.fillRect(10, 10, 100, 100);
ctx.font = '24px sans-serif';
ctx.fillStyle = '#1c4e80';
ctx.fillText('Hello from ntk', 10, 160);
```

## Try it in your browser

No X server at hand? The [Playground](/playground) runs ntk demos entirely
in your browser: the code talks to a pure-JavaScript X server (with the
XRender extension) composited to a canvas — the same code you would run in
node against a real display.

## Where to go next

- [Getting started](reference/getting-started.md) — requirements, first
  window, headless/CI setup
- [API reference](reference/index.md) — the full public API surface: App,
  Window, the 2d context, fonts and text, images, widgets, OpenGL, resource
  management
- [Playground](/playground) — live, editable demos in your browser
