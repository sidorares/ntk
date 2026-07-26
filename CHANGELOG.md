# Changelog

## [3.0.0](https://github.com/sidorares/ntk/compare/v2.2.0...v3.0.0) (2026-07-26)


### ⚠ BREAKING CHANGES

* depend on x11 git master (pure-JS X server + browser transports)
* FontFace, ctx.loadFont() and ctx.setFont() are removed; use app.fonts (FontManager), ctx.font and app.fonts.load(). measureText() now returns canvas-style TextMetrics.

### Features

* canvas 2d parity — transforms, save/restore, arcs, Path2D, fill rules, clip, globalAlpha; SvgView widget ([c62a60d](https://github.com/sidorares/ntk/commit/c62a60d6b87588114dcd52645683084ea58f1fe7))
* coalesce noisy events and pace frames to connection latency ([7f446e1](https://github.com/sidorares/ntk/commit/7f446e1d2845d53b4158a1e3b930f6b395d29ccf))
* coalesce noisy events and pace frames to connection latency ([c174336](https://github.com/sidorares/ntk/commit/c1743367159f777c020d9dcbad7a4218ae1e5ef5))
* depend on x11 git master (pure-JS X server + browser transports) ([19d7703](https://github.com/sidorares/ntk/commit/19d770384187fe6b62a83dbda51abc6fce1223a0))
* documentation site with live in-browser playground (pluggable font sources + in-package XRender server) ([f1de6ce](https://github.com/sidorares/ntk/commit/f1de6ce7ece01d3218559c8aa320367b4a1df602))
* documentation website with live in-browser playground ([013b57f](https://github.com/sidorares/ntk/commit/013b57fccfd7af4618ee66350e6d05200bc189d7))
* **examples:** pelican riding a bicycle in the svg-viewer sample scene ([af40908](https://github.com/sidorares/ntk/commit/af409089ad25c98537e6a50652b697a636467584))
* HtmlView static HTML/CSS widget, PNG/JPEG images, yoga-layout ([5b2cd3d](https://github.com/sidorares/ntk/commit/5b2cd3d5f9ad2b862d402ad4b8e101109f5ab379))
* HtmlView static HTML/CSS widget, PNG/JPEG images, yoga-layout ([d325529](https://github.com/sidorares/ntk/commit/d325529281f0eecd197f39bfa301c5c4311f3383))
* in-package headless X server with XRender (ntk/xserver) ([56a3394](https://github.com/sidorares/ntk/commit/56a33946e5f38e88152e5aea4e066fa40616988d))
* mermaid diagram rendering in MarkdownView (```mermaid fences) ([4e06b5a](https://github.com/sidorares/ntk/commit/4e06b5a2470cf1f6b6862bbf76a7b24cbfa3a293))
* pluggable FontSource + environment hooks (browser-bundleable lib) ([3ff6199](https://github.com/sidorares/ntk/commit/3ff61998d4e295a05af8236ae0c3ed72f3968a03))
* render GFM tables in MarkdownView ([385f9d9](https://github.com/sidorares/ntk/commit/385f9d958dabc58fc2306e7967a91b974ca5852a))
* render GFM tables in MarkdownView ([266f3d3](https://github.com/sidorares/ntk/commit/266f3d383860bd65abaaf4b3d2c1fcecbad62e58))
* shaped text rendering, TextLayout, markdown widget, double-buffered windows ([617c1bd](https://github.com/sidorares/ntk/commit/617c1bdc583e2ce200661be3356487ea92704e32))
* SVG support in HtmlView — inline &lt;svg&gt; and &lt;img&gt; with SVG sources ([cb18d0c](https://github.com/sidorares/ntk/commit/cb18d0ca6da6f9b35445c6642ce10575e538213e))
* vector text path ([#45](https://github.com/sidorares/ntk/issues/45)), KaTeX math widget, highlighted markdown fences ([d9147c7](https://github.com/sidorares/ntk/commit/d9147c791d01ec0e92b9803b11861602de554e0b))
* vector text path ([#45](https://github.com/sidorares/ntk/issues/45)), KaTeX math widget, highlighted markdown fences ([12261cd](https://github.com/sidorares/ntk/commit/12261cd8399344275578e4f847b6ed89ad1fc5a0))


### Bug Fixes

* **website:** serve playground runner as directory index ([d56ea0f](https://github.com/sidorares/ntk/commit/d56ea0f55adf7576bc6ae493bd84181a8ce125b3))
