# Test fixtures

## `MonelogicsSubset[wght].ttf`

A variable font, for the variable-font tests — nothing else in the tree has
an axis, and `fontkit` cannot instantiate one out of a `.woff2` (see
`docs/fonts.md#variable-fonts`), so a real uncompressed variable face has to
be here.

It is [monelogics](https://github.com/sklinkert/monelogics-font) 3.002
(itself a derivative of Libre Franklin), subset to the glyphs the tests set —
`Handgloves HANDGLOVES 0123456789 .,` — with the `wght` axis kept intact:
100–900, default 400, and the nine named instances. Subsetting takes it from
187 KB to 23 KB; the axis, the `fvar`/`gvar` tables and the named instances
are unchanged, which is all the tests look at.

Licensed under the SIL Open Font License 1.1 — see `OFL.txt`.
