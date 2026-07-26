# SVG widget

`SvgView` renders static SVG documents through the [2d context](context-2d.md):
geometry becomes `Path2D` objects, `<g transform="…">` becomes context
transforms, paint servers become canvas gradients — so everything is
composited server-side by XRender like any other 2d drawing.

```js
import { createClient, SvgView } from 'ntk';

const app = await createClient();
const wnd = app.createWindow({ width: 480, height: 360, title: 'svg' });
const view = new SvgView(wnd);
view.setSvg(await readFile('drawing.svg', 'utf8'));
wnd.map();
```

Standalone (windowless) use mirrors `HtmlView`/`MarkdownView` — draw into
any 2d context (a window, a [pixmap](pixmap.md)):

```js
const view = new SvgView(null);
view.setSvg(svgText);
view.draw(ctx, x, y, width, height);
```

See `examples/svg-viewer.js` for a small viewer
(`node svg-viewer.js file.svg`).

## API

- `new SvgView(window[, opts])` — `window` may be `null` for standalone use.
  Options:
  - `theme.background` — window-mode background fill (default `'white'`)
  - `fit` — window-mode fitting: `'contain'` (default; fitted + centered,
    preserving aspect ratio) or `'fill'` (stretch)
- `view.setSvg(svgText)` — parse and adopt a document (a string containing
  an `<svg>` element). Re-renders in window mode
- `view.draw(ctx, x, y[, w, h])` — draw into any 2d context; `w`/`h` default
  to the natural size. The `viewBox` (when present) is scaled to the target
  box
- `view.render()` — window mode: clear the background and draw fitted;
  called automatically on `expose`
- `view.naturalWidth` / `view.naturalHeight` — from the `width`/`height`
  attributes, falling back to the `viewBox` size
- `view.viewBox` — `[minX, minY, width, height]` or `null`

Like `HtmlView`, the widget is static and safe by construction: no
scripting, no network or filesystem access — documents are strings and
nothing external is ever fetched.

## Supported SVG subset

Elements:

- shapes: `path` (full path-data grammar, arcs included), `rect`
  (+`rx`/`ry`), `circle`, `ellipse`, `line`, `polyline`, `polygon`
- structure: `svg` (`viewBox`, `width`/`height`), `g`, `defs`, `use`
  (`href`/`xlink:href` to a local `#id`, `x`/`y` offset, `symbol` targets),
  `a` (rendered, not clickable)
- paint servers: `linearGradient`, `radialGradient` with `stop`
  (`offset`, `stop-color`, `stop-opacity`), `gradientUnits` of
  `objectBoundingBox` (default) or `userSpaceOnUse`
- `text` — basic: `x`, `y`, `font-size`, `font-family`, `text-anchor`,
  solid `fill`; rendered through the shaped-text pipeline

Presentation attributes (also inside inline `style="…"`, which wins):

- `fill`, `stroke` — colors, `none`, `currentColor`, `url(#gradient)`
- `fill-rule` (`nonzero`/`evenodd`), `fill-opacity`, `stroke-opacity`,
  `opacity` (multiplies down the tree)
- `stroke-width`, `stroke-linecap`, `stroke-linejoin`, `stroke-miterlimit`
- `transform` — `matrix`, `translate`, `scale`, `rotate` (incl. the
  3-argument center form), `skewX`, `skewY`, in any list combination
- `color` (for `currentColor`)

Not supported (skipped silently): CSS stylesheets/`<style>`, `clipPath`,
`mask`, `filter`, `pattern`, `marker`, animation/SMIL, `foreignObject`,
external references, `preserveAspectRatio` values other than the default
behavior, stroke dashing, and full `text` layout (`tspan`, `textPath`).

## SVG path data elsewhere

The path-data parser is shared with `Path2D` and exported directly:

```js
import { Path2D, parseSvgPath } from 'ntk';

ctx.fill(new Path2D('M10 10 A 20 20 0 0 1 50 10 Z'));
const commands = parseSvgPath('M0 0 Q 5 5 10 0'); // [{type:'M',…}, {type:'Q',…}]
```

`parseSvgPath` returns normalized `M/L/C/Q/Z` commands (arcs are converted
to cubics) — the same shape consumed by `lib/rasterize.js` and the TeX
widget.
