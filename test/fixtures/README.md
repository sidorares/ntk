# Test fixtures

## `MonelogicsSubset[wght].ttf`, `.woff`, `.woff2`

A variable font, for the variable-font tests — nothing else in the tree has
an axis. The `.woff` and the `.woff2` are the same font in the containers a
web page serves one in, made from the `.ttf` with fontTools
(`TTFont(path)`, `font.flavor = 'woff2'`, `font.save(...)`): an instance has
to come out of each the same, and the sfnt ntk makes of each has to be the
`.ttf` again (see `docs/fonts.md#variable-fonts`).

It is [monelogics](https://github.com/sklinkert/monelogics-font) 3.002
(itself a derivative of Libre Franklin), subset to the glyphs the tests set —
`Handgloves HANDGLOVES 0123456789 .,` — with the `wght` axis kept intact:
100–900, default 400, and the nine named instances. Subsetting takes it from
187 KB to 23 KB; the axis, the `fvar`/`gvar` tables and the named instances
are unchanged, which is all the tests look at.

Licensed under the SIL Open Font License 1.1 — see `OFL.txt`.
