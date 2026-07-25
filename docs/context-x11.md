# Raw X11 rendering context

`drawable.getContext('x11')` returns a thin wrapper over core X drawing
requests (no XRender — no antialiasing, no alpha). Mostly useful for
debugging or very simple drawing; prefer the [2d context](context-2d.md).

```js
const rc = wnd.getContext('x11');
rc.setForeground(0xff0000);
rc.fillRectangle({ left: 10, top: 10, width: 50, height: 50 });
```

## Methods

- `setForeground(pixel)`, `setBackground(pixel)` — raw pixel values
- `point({ x, y })`
- `polyLine([{ x, y }, ...])`
- `rectangle({ left, top, width, height })` — outline
- `fillRectangle({ left, top, width, height })`
- `drawText(text, x, y)` — server core fonts
- `putImage(imageData, x, y)`
- `copy(dstDrawable)` — CopyArea
