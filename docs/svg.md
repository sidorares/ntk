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
  - `languages` — the languages `systemLanguage` is matched against, most
    preferred first, like `navigator.languages`; see
    [Conditional processing](#conditional-processing)
- `view.setSvg(svgText)` — parse and adopt a document (a string containing
  an `<svg>` element). Re-renders in window mode
- `view.setSvgDom(element)` — adopt an already-parsed htmlparser2 `<svg>`
  element. For inline SVG inside a host document; tolerates HTML-mode
  parses (lowercased tag/attribute names like `viewbox`, `lineargradient`)
- `view.draw(ctx, x, y[, w, h][, opts])` — draw into any 2d context; `w`/`h`
  default to the natural size. The `viewBox` (when present) is scaled to the
  target box. Options, each for this draw only:
  - `color` — what `currentColor` resolves to, overriding the view's own
    `color`
  - `font` — `{ family, size, weight, style }`, any of them, the size in
    user units: what the document's text inherits where it names no font of
    its own. A host document hands an inline `<svg>` its font this way, as a
    browser does; without it text starts from 16px `sans-serif`
  - `surface(width, height)` — makes the offscreen surface a
    [masked](#masks) element is drawn on: something with
    `getContext('2d')` and `destroy()` that `ctx.drawImage` takes, or null.
    A context of ntk's own needs none — it uses `app.createSurface` on its
    app — but one that is not ntk's, react-x11's macOS context, has to be
    handed one
- `view.paintKind` / `view.soloPaint` — how many colours the document commits
  to, from the parse; see [Taking colour from the caller](#taking-colour-from-the-caller)
- `view.render()` — window mode: clear the background and draw fitted;
  called automatically on `expose`
- `view.naturalWidth` / `view.naturalHeight` — from the `width`/`height`
  attributes, falling back to the `viewBox` size
- `view.viewBox` — `[minX, minY, width, height]` or `null`
- `view.languages` — the `languages` option, lowercased, or the default
  worked out from the runtime. Read when a document is adopted, for
  `paintKind`, and on every draw

The widget is static and safe by construction: no
scripting, no network or filesystem access — documents are strings and
nothing external is ever fetched.

## Supported SVG subset

Elements:

- shapes: `path` (full path-data grammar, arcs included), `rect`
  (+`rx`/`ry`), `circle`, `ellipse`, `line`, `polyline`, `polygon`
- structure: `svg` (`viewBox`, `width`/`height`, presentation attributes),
  `g`, `defs`, `use` (`href`/`xlink:href` to a local `#id`, `x`/`y` offset,
  `symbol` targets), `a` (rendered, not clickable), `switch` (draws its
  first child whose [conditions](#conditional-processing) hold, through its
  own `transform` and `opacity` as a `g` would)
- a nested `svg` is a new viewport, not a group: `width` by `height` at
  `x`,`y`, each a length or a percentage of the viewport around it, and all
  of that viewport where unset. Its `viewBox` is fitted in as
  `preserveAspectRatio` says — any alignment, `meet` (the default), `slice`
  or `none` — and what it draws is clipped to the viewport unless its
  `overflow` is `visible` or `auto`. A zero or negative `width` or `height`,
  or a zero-sized `viewBox`, draws nothing
- paint servers: `linearGradient`, `radialGradient` with `stop`
  (`offset`, `stop-color`, `stop-opacity`), `gradientUnits` of
  `objectBoundingBox` (default) or `userSpaceOnUse`, `gradientTransform`,
  and `href`/`xlink:href` to another gradient, whose attributes it takes
  where it sets none and whose stops it takes where it has none, through
  any number of them. A radial gradient under a `gradientTransform` that
  stretches it stays a circle, of the same area
- `text`, with `tspan` (and `a` and `textPath`, read as a `tspan`) — see
  [Text](#text)
- `mask` — see [Masks](#masks)

Presentation attributes (also inside inline `style="…"`, which wins):

- `fill`, `stroke` — colors, `none`, `currentColor`, `url(#gradient)`
- `fill-rule` (`nonzero`/`evenodd`), `fill-opacity`, `stroke-opacity`,
  `opacity` (multiplies down the tree) — each a number or a percentage
- `display: none`: the element and everything in it are left out, whatever
  `display` a child names — which is how an editor exports a hidden layer.
  What is only ever drawn by reference (a gradient, a `symbol`) is still
  there to reference, and a `use` of an element that is `display: none`
  draws nothing
- `visibility: hidden` or `collapse`: the shapes and text it reaches are not
  drawn. It is inherited, and a shape inside a hidden group that says
  `visibility="visible"` is drawn again
- `stroke-width`, `stroke-linecap`, `stroke-linejoin`, `stroke-miterlimit`
- `transform` — `matrix`, `translate`, `scale`, `rotate` (incl. the
  3-argument center form), `skewX`, `skewY`, in any list combination
- `color` (for `currentColor`)

These apply on the root `<svg>` too, and inherit from there like they do
from a `<g>` — which is how every mainstream icon set is written:

```xml
<!-- lucide, feather, heroicons, tabler, Material Symbols all look like this -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
</svg>
```

Nothing on the shapes names a paint, so dropping the root's attributes would
leave them at SVG's initial values — `fill: #000`, `stroke: none` — and an
outline icon would fill black, or paint nothing at all if its strokes enclose
no area.

Not supported (skipped silently): CSS stylesheets/`<style>`, `clipPath`,
`filter`, `pattern`, `marker`, animation/SMIL, `foreignObject`,
external references, `preserveAspectRatio` on the root `svg` (whose
`viewBox` is stretched to the box `draw` is given), a `symbol`'s `viewBox`,
stroke dashing, and of text: a path to set it along, `rotate`,
`textLength`, `baseline-shift`, decorations, and stroked text.

## Text

A `<text>` is laid out as SVG 2's text layout has it, short of what a
browser does for vertical and right-to-left writing:

- **Spans.** `tspan`s nest, and each sets its own paint, `opacity`, font and
  spacing for what it holds. A `tspan` that is `display: none` takes its text
  out; one that is `visibility: hidden` keeps its place and draws nothing,
  and one that says `visible` inside a hidden `text` is drawn.
- **White space** collapses as CSS's `white-space: normal` collapses it: a
  line break and a tab are a space, a run of spaces is one, across span
  boundaries, and none is left at either end of the `text`. `xml:space=
  "preserve"`, or a `white-space` of `pre`, `pre-wrap` or `break-spaces`,
  keeps each.
- **Positions.** `x`, `y`, `dx` and `dy` are lists, one value a character,
  in user units, `em`, `ex`, the absolute units or a percentage of the
  viewport; a character takes each from the innermost element that gives it
  one. A `dy` of `1.15em` on a `tspan` is of that span's own font size.
- **Chunks and anchoring.** A character with an absolute `x` or `y` starts
  a text chunk, and each chunk is moved as its first character's
  `text-anchor` says — measured, so the two `tspan`s of a badge are each
  centred on their own `x`, whatever size each is set at. Nothing is left to
  the context's `textAlign`, which a context that draws through CoreText or
  DirectWrite does not have.
- **Fonts.** `font-family`, `font-size` (lengths, percentages and keywords),
  `font-weight` (`bolder` and `lighter` included) and `font-style`. A family
  that leans on a custom property, `var(--sans)`, is the one inherited: there
  are no custom properties here.
- **Spacing and case.** `letter-spacing` and `word-spacing`, a length in
  `em` coming to the element's own size and inherited as that length, and
  `text-transform`.
- **Baselines.** `dominant-baseline`, inherited, and `alignment-baseline` on
  a span: `central`, `middle`, `hanging`, `mathematical` and the text edges,
  from the font's ascent and descent where the context's `measureText` says
  them and from an em's proportions where it does not.
- **Size.** Glyphs are set at the size they are drawn. On ntk's own context,
  whose glyphs are rasterized at the size they are shaped at and do not
  scale with the transform, the transform's scale goes into the font size;
  on a context with `scalesText`, the font is the size the document says and
  the context scales it.

## Masks

An element with a `mask` (attribute or `style`) naming a `<mask>` is drawn
as CSS Masking 1 has it:

- the element on an offscreen surface, and the mask's content on a second,
  through the same transform — device pixels, the part of the mask's region
  the drawing can show
- the second cuts the first with `destination-in`, and the first is
  composited in the element's place at its `opacity`, which applies to what
  the mask leaves of it as one group
- `mask-type: alpha` takes the mask's alpha as it is; the default,
  `luminance`, its luminance times its alpha. The content of a luminance mask
  is drawn as the value it makes: each mark first erases its alpha from what
  is under it (`destination-out`) and then adds its luminance times its alpha
  (`lighter`), so a black shape over a white one hides what is under it, as
  the colours composited would. A context with neither op adds the value
  alone
- `maskUnits` (`objectBoundingBox`, the default, or `userSpaceOnUse`) and
  the region's `x`, `y`, `width` and `height` (-10%, -10%, 120% and 120%
  where unset); `maskContentUnits`. An element whose bounding box has no
  area is not drawn where either is `objectBoundingBox`, and a region of no
  area shows nothing
- what is in the mask inherits from the mask's ancestors, not from what it
  masks, and a mask that reaches itself draws what it holds once

The surfaces come from `opts.surface`, or from `app.createSurface` on a
context of ntk's own. Where there is none, or the context cannot
`destination-in`, the element is drawn as it is, cut to the mask's region.
A mask that is not there, or that names something else, is no mask.

## Conditional processing

An element whose `requiredExtensions`, `requiredFeatures` or
`systemLanguage` does not hold is not drawn, nor anything in it; one that
carries none of them holds. A `switch` draws the first of its child elements
that holds and none of the rest — that one as it says, so one that is
`display: none` is chosen and draws nothing.

- `requiredExtensions` never holds: `SvgView` supports no extension. That is
  how an Illustrator export draws here, its own data first in a
  `foreignObject` behind Adobe's extension and the drawing after it.
- `requiredFeatures` holds unless it names an SVG 1.1 feature `SvgView`
  draws nothing of — `#Extensibility` (`foreignObject`), `#Image`, `#Clip`,
  `#Filter`, `#Pattern`, `#Marker`, `#Font`, `#Script`,
  `#Animation` and the like. SVG 2 dropped the attribute and browsers hold
  every one; here a feature it lacks picks the author's fallback, which is
  how a draw.io export's labels draw: as the `text` it writes after each
  `foreignObject` for renderers without one.
- `systemLanguage` holds where one of its comma-separated tags is one of the
  view's `languages`, or one of them narrowed or widened by a subtag — `en`
  matches `en-AU` and `en-AU` matches `en`. An empty one never holds. By
  default those are `navigator.languages`, or else the runtime's locale,
  each followed by its language alone: `['en-au', 'en']`. A host that knows
  its UI's language passes it:

```js
const view = new SvgView(null, { languages: ['de-CH', 'de'] });
```

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
`stroke-opacity` scale coverage, which a mask carries perfectly well. What
is not drawn at all — under `display: none`, a shape whose `visibility` is
`hidden`, a `switch` child it does not choose — commits to no colour.

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
