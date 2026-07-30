# Changelog

## [4.0.0](https://github.com/sidorares/ntk/compare/v3.10.2...v4.0.0) (2026-07-30)


### ⚠ BREAKING CHANGES

* MarkdownView no longer renders fences tagged mermaid as diagrams, and its onInvalidate option is gone. parseMermaid and layoutMermaid are removed.

### Features

* drop mermaid diagram rendering ([#113](https://github.com/sidorares/ntk/issues/113)) ([e478c67](https://github.com/sidorares/ntk/commit/e478c67674e42f93af1bbff210b6f021ab1a0fcb))

## [3.10.2](https://github.com/sidorares/ntk/compare/v3.10.1...v3.10.2) (2026-07-30)


### Performance Improvements

* copy a region, not the box around it ([#112](https://github.com/sidorares/ntk/issues/112)) ([1dd38b2](https://github.com/sidorares/ntk/commit/1dd38b2f18d9581e2f3b225a5ae4b0b93e8e6263))
* copy only the region a frame changed, not the whole window ([#110](https://github.com/sidorares/ntk/issues/110)) ([79cd32d](https://github.com/sidorares/ntk/commit/79cd32dbe5c4fedc2d20dff8a63c7e1476057013))

## [3.10.1](https://github.com/sidorares/ntk/compare/v3.10.0...v3.10.1) (2026-07-30)


### Bug Fixes

* a squeezed markdown table column keeps its longest word whole ([#108](https://github.com/sidorares/ntk/issues/108)) ([21f824a](https://github.com/sidorares/ntk/commit/21f824a2142ca0ed1595ea38c1779eb258075abb))


### Performance Improvements

* intersect a rectangular clip without a full-surface mask ([#107](https://github.com/sidorares/ntk/issues/107)) ([d2bfb6d](https://github.com/sidorares/ntk/commit/d2bfb6d912eaa733fb1ef89c357444ad3fe94802))

## [3.10.0](https://github.com/sidorares/ntk/compare/v3.9.1...v3.10.0) (2026-07-30)


### Features

* re-record the straight-colour exports ([9fdbe38](https://github.com/sidorares/ntk/commit/9fdbe38b95f555a5c6fdd38e1f889d4ef747428e))

## [3.9.1](https://github.com/sidorares/ntk/compare/v3.9.0...v3.9.1) (2026-07-30)


### Bug Fixes

* hex alpha, and premultiply the colours XRender is given ([#100](https://github.com/sidorares/ntk/issues/100)) ([f800a2f](https://github.com/sidorares/ntk/commit/f800a2f15e0022e5abac40dccbc3dc34dd466771))

## [3.9.0](https://github.com/sidorares/ntk/compare/v3.8.0...v3.9.0) (2026-07-29)


### Features

* setProperty, the write side of the property API ([#97](https://github.com/sidorares/ntk/issues/97)) ([075ab56](https://github.com/sidorares/ntk/commit/075ab56d549da7ba8123441091bd6072b1107826))

## [3.8.0](https://github.com/sidorares/ntk/compare/v3.7.2...v3.8.0) (2026-07-29)


### Features

* window manager support — substructure payloads, property reads, frames ([#95](https://github.com/sidorares/ntk/issues/95)) ([277d3a1](https://github.com/sidorares/ntk/commit/277d3a1112a7a8b604d2e865589931ad360adc56))

## [3.7.2](https://github.com/sidorares/ntk/compare/v3.7.1...v3.7.2) (2026-07-27)


### Bug Fixes

* **text:** an empty span list is a layout, not a crash ([#93](https://github.com/sidorares/ntk/issues/93)) ([7cb9ca8](https://github.com/sidorares/ntk/commit/7cb9ca8145f0784686719f83af2e12f15027df69))

## [3.7.1](https://github.com/sidorares/ntk/compare/v3.7.0...v3.7.1) (2026-07-27)


### Bug Fixes

* **tex:** TeX boxes honour the 2d clip ([#91](https://github.com/sidorares/ntk/issues/91)) ([ac95ac8](https://github.com/sidorares/ntk/commit/ac95ac88a20dcf75205177612924afeaac40b138))

## [3.7.0](https://github.com/sidorares/ntk/compare/v3.6.0...v3.7.0) (2026-07-27)


### Features

* keyboard focus events, wnd.focus(), and pointer/keyboard grabs ([#89](https://github.com/sidorares/ntk/issues/89)) ([6fdb6a9](https://github.com/sidorares/ntk/commit/6fdb6a99649b59f93a447b312eb6327ca26c54c2))

## [3.6.0](https://github.com/sidorares/ntk/compare/v3.5.3...v3.6.0) (2026-07-27)


### Features

* **css:** export cssColor and cssLength ([#87](https://github.com/sidorares/ntk/issues/87)) ([2b49fc7](https://github.com/sidorares/ntk/commit/2b49fc77edd131bebd4ecfa373467a8d4cded8cc))
* **glx:** context tag, GLX visuals for windows, server-side visual discovery ([e523667](https://github.com/sidorares/ntk/commit/e52366708fb5d08c7b298544fec24d93ad811ed5))

## [3.5.3](https://github.com/sidorares/ntk/compare/v3.5.2...v3.5.3) (2026-07-27)


### Performance Improvements

* **2d:** bound fill and stroke mask work to the shape's bounding box ([#83](https://github.com/sidorares/ntk/issues/83)) ([5b9dafe](https://github.com/sidorares/ntk/commit/5b9dafed90cca9b8e3b5840467e588a6bbbb48b8))

## [3.5.2](https://github.com/sidorares/ntk/compare/v3.5.1...v3.5.2) (2026-07-27)


### Performance Improvements

* **2d:** server-side clip for glyphs, and one glyph batch per layout ([#81](https://github.com/sidorares/ntk/issues/81)) ([ba2cbff](https://github.com/sidorares/ntk/commit/ba2cbffbedd689a18db84b75b23d1ffbd078993b))

## [3.5.1](https://github.com/sidorares/ntk/compare/v3.5.0...v3.5.1) (2026-07-27)


### Bug Fixes

* **2d:** glyph drawing now honours the clip mask ([#79](https://github.com/sidorares/ntk/issues/79)) ([632e896](https://github.com/sidorares/ntk/commit/632e89653ac879896ab23bc24cf33d9e1d1d7f40))

## [3.5.0](https://github.com/sidorares/ntk/compare/v3.4.0...v3.5.0) (2026-07-27)


### Features

* **window:** WM_NORMAL_HINTS, WM_CLASS, _NET_WM_WINDOW_TYPE, always-on-top ([#77](https://github.com/sidorares/ntk/issues/77)) ([388542f](https://github.com/sidorares/ntk/commit/388542f68293a503fe12ecb1801b34a4330fd645))

## [3.4.0](https://github.com/sidorares/ntk/compare/v3.3.0...v3.4.0) (2026-07-26)


### Features

* onInvalidate hook for async content in standalone MarkdownView/HtmlView ([#75](https://github.com/sidorares/ntk/issues/75)) ([1658669](https://github.com/sidorares/ntk/commit/16586699fa5e249c49ad80dd0ffdf25e90000258))

## [3.3.0](https://github.com/sidorares/ntk/compare/v3.2.0...v3.3.0) (2026-07-26)


### Features

* **text:** caret positioning and hit-testing API on TextLayout ([#73](https://github.com/sidorares/ntk/issues/73)) ([7c6579d](https://github.com/sidorares/ntk/commit/7c6579d2833bf70ab5febc392987220b45ae37a3))

## [3.2.0](https://github.com/sidorares/ntk/compare/v3.1.0...v3.2.0) (2026-07-26)


### Features

* clipboard/selection API (app.clipboard.read/write) ([#69](https://github.com/sidorares/ntk/issues/69)) ([b6fe113](https://github.com/sidorares/ntk/commit/b6fe1132609a65f96e4c5028eba0beb8c8db112d))
* line dashes and round caps/joins in the 2d stroke pipeline ([#70](https://github.com/sidorares/ntk/issues/70)) ([084977b](https://github.com/sidorares/ntk/commit/084977b77850e1482a54265eaaaa0b13b0ba7399))
* mouse cursor support via the X11 cursor font ([#68](https://github.com/sidorares/ntk/issues/68)) ([df9407e](https://github.com/sidorares/ntk/commit/df9407ee0194d22dfba141c3b8a803f1f9b83f45))


### Bug Fixes

* bump x11 to ^3.1.1 ([#71](https://github.com/sidorares/ntk/issues/71)) ([24eadfa](https://github.com/sidorares/ntk/commit/24eadfa627a7a426653b56259eb5f7437e0f3b0e))
* guard setTitle/setActions request chains against a closing client ([#63](https://github.com/sidorares/ntk/issues/63)) ([1cfe9f9](https://github.com/sidorares/ntk/commit/1cfe9f9332112a8cbc098341913de916ad391673))

## [3.1.0](https://github.com/sidorares/ntk/compare/v3.0.0...v3.1.0) (2026-07-26)


### Features

* re-export the yoga-layout instance as Yoga ([#58](https://github.com/sidorares/ntk/issues/58)) ([cf1f3b9](https://github.com/sidorares/ntk/commit/cf1f3b9124666650bd6567d9c1a43e57e8efb195))
* set UTF-8 window titles via EWMH _NET_WM_NAME ([#60](https://github.com/sidorares/ntk/issues/60)) ([a260dbe](https://github.com/sidorares/ntk/commit/a260dbebcc2b9e2a8ac68f4fed8d291f106993bf))


### Bug Fixes

* forward X window attributes from createWindow args to CreateWindow ([#56](https://github.com/sidorares/ntk/issues/56)) ([f353723](https://github.com/sidorares/ntk/commit/f353723c34c3e84f569a032653395d03435618ff))

## [3.0.0](https://github.com/sidorares/ntk/compare/v2.2.0...v3.0.0) (2026-07-26)


### ⚠ BREAKING CHANGES

* the x11 dependency is now ^3.1.0 (major bump of the underlying client)
* FontFace, ctx.loadFont() and ctx.setFont() are removed; use app.fonts (FontManager), ctx.font and app.fonts.load(). measureText() now returns canvas-style TextMetrics.

### Features

* canvas 2d parity — transforms, save/restore, arcs, Path2D, fill rules, clip, globalAlpha; SvgView widget ([c62a60d](https://github.com/sidorares/ntk/commit/c62a60d6b87588114dcd52645683084ea58f1fe7))
* coalesce noisy events and pace frames to connection latency ([c174336](https://github.com/sidorares/ntk/commit/c1743367159f777c020d9dcbad7a4218ae1e5ef5))
* depend on x11 ^3.1.0 — pure-JS X server (RENDER included) + browser transports; ntk apps run headless or in the browser with no real X server ([19d7703](https://github.com/sidorares/ntk/commit/19d770384187fe6b62a83dbda51abc6fce1223a0))
* documentation website with live in-browser playground ([013b57f](https://github.com/sidorares/ntk/commit/013b57fccfd7af4618ee66350e6d05200bc189d7))
* **examples:** pelican riding a bicycle in the svg-viewer sample scene ([af40908](https://github.com/sidorares/ntk/commit/af409089ad25c98537e6a50652b697a636467584))
* HtmlView static HTML/CSS widget, PNG/JPEG images, yoga-layout ([d325529](https://github.com/sidorares/ntk/commit/d325529281f0eecd197f39bfa301c5c4311f3383))
* mermaid diagram rendering in MarkdownView (```mermaid fences) ([4e06b5a](https://github.com/sidorares/ntk/commit/4e06b5a2470cf1f6b6862bbf76a7b24cbfa3a293))
* pluggable FontSource + environment hooks (browser-bundleable lib) ([3ff6199](https://github.com/sidorares/ntk/commit/3ff61998d4e295a05af8236ae0c3ed72f3968a03))
* render GFM tables in MarkdownView ([266f3d3](https://github.com/sidorares/ntk/commit/266f3d383860bd65abaaf4b3d2c1fcecbad62e58))
* shaped text rendering, TextLayout, markdown widget, double-buffered windows ([617c1bd](https://github.com/sidorares/ntk/commit/617c1bdc583e2ce200661be3356487ea92704e32))
* SVG support in HtmlView — inline &lt;svg&gt; and &lt;img&gt; with SVG sources ([cb18d0c](https://github.com/sidorares/ntk/commit/cb18d0ca6da6f9b35445c6642ce10575e538213e))
* vector text path ([#45](https://github.com/sidorares/ntk/issues/45)), KaTeX math widget, highlighted markdown fences ([12261cd](https://github.com/sidorares/ntk/commit/12261cd8399344275578e4f847b6ed89ad1fc5a0))


### Bug Fixes

* **website:** serve playground runner as directory index ([d56ea0f](https://github.com/sidorares/ntk/commit/d56ea0f55adf7576bc6ae493bd84181a8ce125b3))
