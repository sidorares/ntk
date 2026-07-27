# TeX math rendering

ntk renders TeX formulas with [KaTeX](https://katex.org) (a pure-JS
dependency, in line with the no-native-modules rule). KaTeX parses the TeX
and produces its DOM tree; `lib/widgets/tex.js` lays that tree out directly
in pixel space — reimplementing the small CSS subset KaTeX output actually
uses (inline flow with em margins, vertical lists, border rules,
font-size/font-family classes) — and draws through the normal ntk text
stack using the KaTeX `.ttf` fonts bundled with the package. No browser, no
DOM, no fontconfig involvement.

```js
import { createClient, TexView, layoutTex } from 'ntk';

// widget: one formula in a window, centered, re-rendered on expose
const app = await createClient();
const wnd = app.createWindow({ width: 480, height: 160, title: 'math' });
new TexView(wnd, { tex: '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}', size: 32 });
wnd.map();

// headless: measure and draw anywhere
const box = layoutTex('e^{i\\pi} + 1 = 0', { size: 24, color: '#222' });
console.log(box.width, box.height, box.baseline);
box.draw(ctx, 40, 40);
```

## `layoutTex(tex, options)` → `TexBox`

Parses and lays out a formula. Headless — needs no X connection; the
result can be measured and drawn any number of times.

Options:

- `size` — base font size in px (the formula's em), default 16
- `displayMode` — KaTeX display mode (`\displaystyle`, block layout),
  default false
- `color` — default ink color; `\color{...}` spans override it
- `katex` — extra options passed to KaTeX verbatim (`macros`, `strict`, …)

KaTeX parse errors throw (`katex.ParseError`) — callers choose the
fallback. `MarkdownView` falls back to rendering the source as a plain
code block.

### `configureTex({ katex, fonts })`

By default the katex package and its `.ttf` fonts are resolved from
`node_modules` at first use. Environments without node builtins (browser
bundles) inject them instead:

```js
import { configureTex } from 'ntk'; // also exported from lib/widgets/tex.js
configureTex({
  katex: katexModule,                              // the imported katex module
  fonts: { 'KaTeX_Main-Regular.ttf': bytes, ... }  // a subset is fine
});
```

## `TexBox`

- `width`, `height` — layout box in px (`height` includes the depth below
  the baseline)
- `baseline` — px from the top of the box to the alphabetic baseline;
  align formulas to surrounding text with `y = textBaseline - box.baseline`
- `draw(ctx, x, y)` — draw with the top-left corner at (x, y). The context
  `fillStyle` is used for items without an explicit color and left
  untouched. Everything it draws — glyph runs, rules and the vector shapes
  of radicals — honours the context's `clip()`, so a formula inside a
  clipped box stays inside it.

## `TexView`

A widget owning a window: clears the background, centers the formula and
redraws on expose.

```js
const view = new TexView(wnd, {
  tex: '\\frac{a}{b}', // initial formula (optional)
  size: 24,            // px em
  color: '#222222',
  background: 'white',
  displayMode: true,   // default for the widget
  padding: 16,
  katex: { macros: { '\\R': '\\mathbb{R}' } }
});
view.setTex('\\R^n');  // update + re-render
view.box;              // current TexBox (metrics)
```

## Markdown integration

Fenced blocks tagged `math`, `tex`, `latex` or `katex` inside a
`MarkdownView` render as centered display-mode formulas at 1.21× the base
text size (matching katex.css's `.katex` font-size):

    ```math
    \sum_{i=0}^{n} i = \frac{n(n+1)}{2}
    ```

## Wire efficiency

The renderer follows the same philosophy as the rest of the text stack
(see [text.md](text.md)):

- Adjacent symbols resolving to the same font/size/color are concatenated
  and shaped as **single runs** (KaTeX's own metrics come from the same
  font files, so positions agree). A formula does not become one Composite
  per character.
- Drawing batches **all runs of a color into one `CompositeGlyphs`
  request** — a typical formula is one composite for the glyphs plus a
  `FillRectangles`-style composite per fraction/overline rule.
- Radical surds and stretchy SVG fills are flattened client-side and
  rendered server-side as trapezoids through the same batched `AddTraps`
  scratch mask the vector text path uses.
- Glyphs go through the standard per-(face, size) glyph pages: formula
  redraws hit the server cache, and the LRU budget applies.

## Coverage and limits

Supported KaTeX output constructs: symbols across all KaTeX fonts
(Main/Math/AMS/Caligraphic/Fraktur/Script/SansSerif/Typewriter/Size1–4),
sub/superscripts, fractions and binomials, radicals (with indices), big
operators with limits, big/stacked delimiters, accents, matrices and
environments, `\color`, sizing commands, spacing/kerns, `\rule`,
over/underlines, `\llap`/`\rlap`/`\clap`. Unhandled constructs degrade
gracefully (extension-specific spans render their text content; unknown
boxes take zero space). `\hdashline` renders solid rather than dashed.
