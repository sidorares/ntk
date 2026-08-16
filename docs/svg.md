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

Standalone (windowless) use draws into
any 2d context (a window, a [pixmap](pixmap.md)):

```js
const view = new SvgView(null);
view.setSvg(svgText);
view.draw(ctx, x, y, width, height);
```

See `examples/svg-viewer.js` for a small viewer
(`node svg-viewer.js file.svg`).

A document renderer built on ntk uses this widget for the SVG inside its
documents — react-x11's `<svg>` element is the worked example, feeding it
either a parsed DOM or a markup string.

## API

- `new SvgView(window[, opts])` — `window` may be `null` for standalone use.
  Options:
  - `theme.background` — window-mode background fill (default `'white'`)
  - `fit` — window-mode fitting: `'contain'` (default; fitted + centered,
    preserving aspect ratio) or `'fill'` (stretch)
  - `color` — what `currentColor` resolves to (default `'#000'`); see
    [Taking colour from the caller](#taking-colour-from-the-caller)
- `view.setSvg(svgText)` — parse and adopt a document (a string containing
  an `<svg>` element). Re-renders in window mode
- `view.setSvgDom(element)` — adopt an already-parsed htmlparser2 `<svg>`
  element. For inline SVG inside a host document; tolerates HTML-mode
  parses (lowercased tag/attribute names like `viewbox`, `lineargradient`)
- `view.draw(ctx, x, y[, w, h][, opts])` — draw into any 2d context; `w`/`h`
  default to the natural size. The `viewBox` (when present) is scaled to the
  target box. `opts.color` sets what `currentColor` resolves to for this draw
  only, overriding the view's own `color`
- `view.paintKind` / `view.soloPaint` — how many colours the document commits
  to, from the parse; see [Taking colour from the caller](#taking-colour-from-the-caller)
- `view.render()` — window mode: clear the background and draw fitted;
  called automatically on `expose`
- `view.naturalWidth` / `view.naturalHeight` — from the `width`/`height`
  attributes, falling back to the `viewBox` size
- `view.viewBox` — `[minX, minY, width, height]` or `null`

The widget is static and safe by construction: no
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

## Taking colour from the caller

An icon set is written without colours: every shape says
`fill="currentColor"` or `stroke="currentColor"`, and the surrounding UI
decides what that means. One parsed document then serves a normal row, a
hovered row and a disabled row.

```js
const icon = new SvgView(null).setSvg(iconMarkup);

icon.draw(ctx, x, y, 20, 20, { color: theme.fg });
icon.draw(ctx, x, y + 24, 20, 20, { color: theme.accent }); // same document
```

`opts.color` applies to that draw only. A default for every draw goes on the
view, and window mode uses it too, since `render()` takes no options:

```js
const view = new SvgView(wnd, { color: '#0984e3' });
```

Both fall back to the CSS initial value, black. Note that only `currentColor`
follows this: the initial `fill` is black, not `currentColor`, so a document
that names no paint at all still fills black — as it does in a browser.

### paintKind: which documents can be recoloured

Parsing also records how many distinct paints the drawing actually commits
to, which is what a caller caching rendered output needs in order to decide
whether the colour belongs in its cache key:

- `view.paintKind === 'mono'` — every fill and stroke that reaches a shape is
  `none` or the *same* paint. The drawing is a coverage mask plus a colour,
  so one rendered copy can be recoloured for every use. `view.soloPaint` is
  that paint: a colour, or the literal `'currentColor'` when the document
  defers to its caller.
- `view.paintKind === 'multi'` — a second distinct paint, or a
  gradient/pattern reference. Those colours belong to the drawing rather than
  to the UI, so a rendered copy is only good for the colours baked into it,
  and `soloPaint` is `null`.

Opacity does not enter into it: `opacity`, `fill-opacity` and
`stroke-opacity` scale coverage, which a mask carries perfectly well.

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
