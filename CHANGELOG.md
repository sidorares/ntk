# Changelog

## [8.8.0](https://github.com/sidorares/ntk/compare/v8.7.0...v8.8.0) (2026-08-27)


### Features

* **window:** deselectInput, the inverse of selectInput ([#342](https://github.com/sidorares/ntk/issues/342)) ([c8979fd](https://github.com/sidorares/ntk/commit/c8979fd3092a1f243a243a54622ac20f4d7e15b2))


### Bug Fixes

* **gl:** answer the multisample request instead of dropping it ([#343](https://github.com/sidorares/ntk/issues/343)) ([41af955](https://github.com/sidorares/ntk/commit/41af95519dad75e0c14317adcdd7e283db083ef3))

## [8.7.0](https://github.com/sidorares/ntk/compare/v8.6.0...v8.7.0) (2026-08-26)


### Features

* **shadow:** run a wide blur on shrunk coverage ([#339](https://github.com/sidorares/ntk/issues/339)) ([5ec399e](https://github.com/sidorares/ntk/commit/5ec399ef2af678f481ce8f44c1e5fec6b68be1cd)), closes [#338](https://github.com/sidorares/ntk/issues/338)

## [8.6.0](https://github.com/sidorares/ntk/compare/v8.5.0...v8.6.0) (2026-08-26)


### Features

* **shadow:** export blurCoverage, the blur that bakes instead of re-filtering ([#336](https://github.com/sidorares/ntk/issues/336)) ([41da9f6](https://github.com/sidorares/ntk/commit/41da9f6044cd67ee92aa4d85d2fabd4e1d334c1a))

## [8.5.0](https://github.com/sidorares/ntk/compare/v8.4.1...v8.5.0) (2026-08-25)


### Features

* **text:** drive the opsz axis from the size text is set at ([#333](https://github.com/sidorares/ntk/issues/333)) ([d7d5282](https://github.com/sidorares/ntk/commit/d7d528256958f2316dc8d1f3bdaf14ab77e88725))

## [8.4.1](https://github.com/sidorares/ntk/compare/v8.4.0...v8.4.1) (2026-08-25)


### Bug Fixes

* **app:** fall back to the native display rate when RandR's answer is implausible ([#329](https://github.com/sidorares/ntk/issues/329)) ([5c6f9e9](https://github.com/sidorares/ntk/commit/5c6f9e93c646bc2b468d8d6cbf786526fcf54d86))
* **window:** answer the motion hint with QueryPointer, so it thins motion instead of stopping it ([#331](https://github.com/sidorares/ntk/issues/331)) ([9e1645c](https://github.com/sidorares/ntk/commit/9e1645c9d3a63a3f4214e50806b2fa40b0c78afa))

## [8.4.0](https://github.com/sidorares/ntk/compare/v8.3.1...v8.4.0) (2026-08-24)


### Features

* **gl:** direct rendering on macOS/XQuartz via the Apple-DRI extension ([#326](https://github.com/sidorares/ntk/issues/326)) ([da64a90](https://github.com/sidorares/ntk/commit/da64a90cb361693e1f6a1e8f6c47e420c3933cba))

## [8.3.1](https://github.com/sidorares/ntk/compare/v8.3.0...v8.3.1) (2026-08-24)


### Bug Fixes

* **window:** adopt a window without selecting events on it ([#323](https://github.com/sidorares/ntk/issues/323)) ([d2534d0](https://github.com/sidorares/ntk/commit/d2534d01f0927683bbe7d32ce364e1bb6f39c956)), closes [#322](https://github.com/sidorares/ntk/issues/322)
* **window:** adopt nothing on a closing connection, so a routed event cannot throw ([#324](https://github.com/sidorares/ntk/issues/324)) ([6535504](https://github.com/sidorares/ntk/commit/6535504e2f3ffcd2bc771283ae44ef98533b93d5)), closes [#321](https://github.com/sidorares/ntk/issues/321)

## [8.3.0](https://github.com/sidorares/ntk/compare/v8.2.0...v8.3.0) (2026-08-23)


### Features

* **2d:** clip to an XFIXES region, and put the picture clip back ([#296](https://github.com/sidorares/ntk/issues/296)) ([a8bad58](https://github.com/sidorares/ntk/commit/a8bad5873cb3cbd2ce9ade3be0488bc27660bb48))
* **app:** the four extensions a compositor needs, asked once per connection ([#301](https://github.com/sidorares/ntk/issues/301)) ([7e7689e](https://github.com/sidorares/ntk/commit/7e7689eb06013e92e1a01fe1832f0747d5e426a3)), closes [#289](https://github.com/sidorares/ntk/issues/289)
* **deps:** x11 4.0.1, and the visual to format table it decodes ([#320](https://github.com/sidorares/ntk/issues/320)) ([4e8999a](https://github.com/sidorares/ntk/commit/4e8999af2811e1bec7b5b0c94cb546ed122775fa))
* **events:** deliver extension events to the window or pixmap they name ([#305](https://github.com/sidorares/ntk/issues/305)) ([64878b7](https://github.com/sidorares/ntk/commit/64878b7f406c4679ecfedd56f8eb9a2be5ebf45a)), closes [#290](https://github.com/sidorares/ntk/issues/290)
* **pixmap:** adopt an existing id with real geometry, depth and ownership ([#304](https://github.com/sidorares/ntk/issues/304)) ([2344f3d](https://github.com/sidorares/ntk/commit/2344f3d1a68fe6c1565e2fa1507d733d2caa74ca))
* **render:** pick a picture format from the drawable's visual, not its depth ([#300](https://github.com/sidorares/ntk/issues/300)) ([caa7ab0](https://github.com/sidorares/ntk/commit/caa7ab06919e4de6e6d85945cb6291d360863a45))
* **text:** share glyphs across processes via a _NTK_GLYPHD directory ([#302](https://github.com/sidorares/ntk/issues/302)) ([49a85ee](https://github.com/sidorares/ntk/commit/49a85ee830b956f88651c098c70f78d6bd80c9c7))
* **window:** a public wait for an adopted window's geometry ([#299](https://github.com/sidorares/ntk/issues/299)) ([c691a76](https://github.com/sidorares/ntk/commit/c691a765737a1cde715327ad6ac06b84e7cdeca6))
* **window:** let an adopted window opt into a backing store and Present ([#316](https://github.com/sidorares/ntk/issues/316)) ([9710685](https://github.com/sidorares/ntk/commit/9710685390602a31dcdf69046fcf18649624fa32))


### Bug Fixes

* **svg:** apply presentation attributes on the root &lt;svg&gt; ([#310](https://github.com/sidorares/ntk/issues/310)) ([201c08a](https://github.com/sidorares/ntk/commit/201c08a1f807040be722f119fc3c666528c2a019))
* **test:** dispose of the connection a timed-out wait still receives ([#317](https://github.com/sidorares/ntk/issues/317)) ([97df026](https://github.com/sidorares/ntk/commit/97df026604070212504e1f7169b4fb084c165a4e))


### Performance Improvements

* **2d:** apply a rectangular clip by shrinking the composite box ([#312](https://github.com/sidorares/ntk/issues/312)) ([367b778](https://github.com/sidorares/ntk/commit/367b7783ce127b1c61897ecbf3c72657fbefe811))
* **2d:** bound the composite-mask fallback to the drawing's own box ([#315](https://github.com/sidorares/ntk/issues/315)) ([2b94c43](https://github.com/sidorares/ntk/commit/2b94c43803681e46e049a2f2466942cc71ee4f46))
* **2d:** the picture clip is context state, not a stamp per drawing ([#314](https://github.com/sidorares/ntk/issues/314)) ([f3b7a4b](https://github.com/sidorares/ntk/commit/f3b7a4bdc9befbf1690ed9d24572f4e5d163b2ef))
* **window:** drop no-op callbacks on void requests, memo the cursor ([#311](https://github.com/sidorares/ntk/issues/311)) ([c9a58e0](https://github.com/sidorares/ntk/commit/c9a58e0fff246029e3fb168e39a807bbbddc434b))

## [8.2.0](https://github.com/sidorares/ntk/compare/v8.1.1...v8.2.0) (2026-08-18)


### Features

* **text:** shadows for laid-out text, one coverage surface per paragraph ([#285](https://github.com/sidorares/ntk/issues/285)) ([3c33112](https://github.com/sidorares/ntk/commit/3c33112f52a7cdb74a022fa2263b1bd187fe7a93)), closes [#283](https://github.com/sidorares/ntk/issues/283)

## [8.1.1](https://github.com/sidorares/ntk/compare/v8.1.0...v8.1.1) (2026-08-18)


### Bug Fixes

* **text:** draw glyph runs through the transform, not past it ([#282](https://github.com/sidorares/ntk/issues/282)) ([cdc9f75](https://github.com/sidorares/ntk/commit/cdc9f7586839442015d41c2e96c56e89fceac4a9)), closes [#280](https://github.com/sidorares/ntk/issues/280)

## [8.1.0](https://github.com/sidorares/ntk/compare/v8.0.0...v8.1.0) (2026-08-18)


### Features

* **context2d:** shadows, with the blur run as two passes and text coverage cached ([#278](https://github.com/sidorares/ntk/issues/278)) ([3e88dfc](https://github.com/sidorares/ntk/commit/3e88dfcee2bf589bb365c30bc0bb3ccaa03b8182))
* **fonts:** an async matchSorted, so a font picker stops blocking on fc-match ([#275](https://github.com/sidorares/ntk/issues/275)) ([d5d2625](https://github.com/sidorares/ntk/commit/d5d2625bc6d278b1339acc3b0f19e9b9e0094364))
* **fonts:** fc-match answers with the family name too ([#276](https://github.com/sidorares/ntk/issues/276)) ([44c7163](https://github.com/sidorares/ntk/commit/44c716373d68383ea44bcf7171b72e2f422ac27f))


### Bug Fixes

* **context2d:** a gradient paints where the fill is, not where the window starts ([#277](https://github.com/sidorares/ntk/issues/277)) ([b55c245](https://github.com/sidorares/ntk/commit/b55c2459e8aaa76ab254c5253e6b17da93935bce))

## [8.0.0](https://github.com/sidorares/ntk/compare/v7.7.0...v8.0.0) (2026-08-16)


### ⚠ BREAKING CHANGES

* the document widgets leave, and the layout engine with them ([#269](https://github.com/sidorares/ntk/issues/269))

### Features

* the document widgets leave, and the layout engine with them ([#269](https://github.com/sidorares/ntk/issues/269)) ([4fcdc20](https://github.com/sidorares/ntk/commit/4fcdc203fc509e957beef81dffd91b385996618a))

## [7.7.0](https://github.com/sidorares/ntk/compare/v7.6.1...v7.7.0) (2026-08-14)


### Features

* **context2d:** createPattern tiles a surface as one repeating fill ([#265](https://github.com/sidorares/ntk/issues/265)) ([fd61e55](https://github.com/sidorares/ntk/commit/fd61e557787d2cfb9e179be0c1c2b51294d1510f))


### Performance Improvements

* **context2d:** a path of scattered subpaths pays for its pieces, not the box around them ([#267](https://github.com/sidorares/ntk/issues/267)) ([ce3e46b](https://github.com/sidorares/ntk/commit/ce3e46b63851f2037f3de9c2dda2ab0f2c76dee8))

## [7.6.1](https://github.com/sidorares/ntk/compare/v7.6.0...v7.6.1) (2026-08-13)


### Bug Fixes

* **context2d:** stroke same-x hairpin bursts without NaN join geometry ([#260](https://github.com/sidorares/ntk/issues/260)) ([45ce1c0](https://github.com/sidorares/ntk/commit/45ce1c0607f842881866116ae01232185ea0b682))

## [7.6.0](https://github.com/sidorares/ntk/compare/v7.5.0...v7.6.0) (2026-08-12)


### Features

* **context2d:** fillRects batches many rectangle fills into one FillRectangles request ([#256](https://github.com/sidorares/ntk/issues/256)) ([af68a8d](https://github.com/sidorares/ntk/commit/af68a8d38082f7255808a2e4d13a1675b45a9b62))
* **surface:** copyWithin — overlapping self-copy for offscreen surfaces ([#255](https://github.com/sidorares/ntk/issues/255)) ([a080e38](https://github.com/sidorares/ntk/commit/a080e38f17b5585bb9952a420108da4888a0e2c9))
* **text:** public glyph-run seam — Font.glyphIdFor and a documented drawGlyphs run contract ([#258](https://github.com/sidorares/ntk/issues/258)) ([3faabd9](https://github.com/sidorares/ntk/commit/3faabd97fef85f336f5b1f465e028e07b72d2c0b))

## [7.5.0](https://github.com/sidorares/ntk/compare/v7.4.0...v7.5.0) (2026-08-11)


### Features

* **input:** select and route XI2 device events, so a wheel reports a real delta ([#250](https://github.com/sidorares/ntk/issues/250)) ([0eee153](https://github.com/sidorares/ntk/commit/0eee153b69cc2ef75093c656537a7be6fa5a2ade))

## [7.4.0](https://github.com/sidorares/ntk/compare/v7.3.3...v7.4.0) (2026-08-11)


### Features

* **xembed:** socket and plug halves of the embedding protocol ([#248](https://github.com/sidorares/ntk/issues/248)) ([ddc39e1](https://github.com/sidorares/ntk/commit/ddc39e1d0ff9ed609a3898ccc0ad0296b39fc045))

## [7.3.3](https://github.com/sidorares/ntk/compare/v7.3.2...v7.3.3) (2026-08-10)


### Bug Fixes

* **2d:** sample the coverage scratch mask at the destination offset ([#244](https://github.com/sidorares/ntk/issues/244)) ([49d004a](https://github.com/sidorares/ntk/commit/49d004a90b72f48ffd561f3de7b9f935330ac101))

## [7.3.2](https://github.com/sidorares/ntk/compare/v7.3.1...v7.3.2) (2026-08-09)


### Bug Fixes

* **gl:** tell a runtime that cannot pass descriptors from a remote display ([#241](https://github.com/sidorares/ntk/issues/241)) ([2287d95](https://github.com/sidorares/ntk/commit/2287d956c6f81e44da1e1e55fcb6d64f60b5d201))

## [7.3.1](https://github.com/sidorares/ntk/compare/v7.3.0...v7.3.1) (2026-08-09)


### Bug Fixes

* **gl:** do not cap the optional GPU addon at one minor ([#239](https://github.com/sidorares/ntk/issues/239)) ([dec8759](https://github.com/sidorares/ntk/commit/dec87592ded70dad4b7235285dea60685f30940c))

## [7.3.0](https://github.com/sidorares/ntk/compare/v7.2.0...v7.3.0) (2026-08-09)


### Features

* **gl:** a direct rendering backend, off by default ([#237](https://github.com/sidorares/ntk/issues/237)) ([5f26475](https://github.com/sidorares/ntk/commit/5f2647556f45e78c82329b1ebc112ce65ca18d61))


### Bug Fixes

* **2d:** keep a stroke inside the path it strokes ([#234](https://github.com/sidorares/ntk/issues/234)) ([71274b7](https://github.com/sidorares/ntk/commit/71274b7c6b36b46eed079a06df167abf08fa8376)), closes [#233](https://github.com/sidorares/ntk/issues/233)

## [7.2.0](https://github.com/sidorares/ntk/compare/v7.1.0...v7.2.0) (2026-08-07)


### Features

* **text:** textRendering, so a run can name its own glyph path ([#231](https://github.com/sidorares/ntk/issues/231)) ([9d75a20](https://github.com/sidorares/ntk/commit/9d75a2098fe47c4878830de9d84b54062dfe8952))


### Bug Fixes

* **text:** an animated axis is churn, and the router could not see it ([#230](https://github.com/sidorares/ntk/issues/230)) ([a3d1a54](https://github.com/sidorares/ntk/commit/a3d1a54f1c8bb2f00467535c406b7db089ec2110))

## [7.1.0](https://github.com/sidorares/ntk/compare/v7.0.0...v7.1.0) (2026-08-07)


### Features

* **text:** variable fonts, instantiated on demand ([#227](https://github.com/sidorares/ntk/issues/227)) ([03539e9](https://github.com/sidorares/ntk/commit/03539e947f938b0bfe97beaaaeed22c91dd45971))


### Bug Fixes

* **app:** give each connection its own atom table ([#226](https://github.com/sidorares/ntk/issues/226)) ([5585aad](https://github.com/sidorares/ntk/commit/5585aad671087f4736f141ae910e94925fd2c2c5))

## [7.0.0](https://github.com/sidorares/ntk/compare/v6.7.0...v7.0.0) (2026-08-06)


### ⚠ BREAKING CHANGES

* **window:** `present: true` was opt-in and is now the default for double-buffered windows, which changes both how a frame is sent and what paces it. Pass `present: false` for the old behaviour, or `frameClock: 'fence'` to keep the old clock while still presenting.

### Features

* **app:** default the frame interval to the display's refresh rate ([#221](https://github.com/sidorares/ntk/issues/221)) ([28c73d8](https://github.com/sidorares/ntk/commit/28c73d89380f8543da62c14d7ec876765bb41586))
* **window:** present by default, and clock frames on the display ([#222](https://github.com/sidorares/ntk/issues/222)) ([a021a9f](https://github.com/sidorares/ntk/commit/a021a9f8f7d5d1fc75b352218e301a3fa1e26eb1))


### Performance Improvements

* an odd border width belongs on the rounded-stroke fast path ([#218](https://github.com/sidorares/ntk/issues/218)) ([a952e09](https://github.com/sidorares/ntk/commit/a952e096b7c39b76723c6ee4cc1404b692d46d41))
* **window:** clock frames on Present's CompleteNotify ([#220](https://github.com/sidorares/ntk/issues/220)) ([a929e62](https://github.com/sidorares/ntk/commit/a929e625029bb0ab25054cedda7d65ce110b1434))

## [6.7.0](https://github.com/sidorares/ntk/compare/v6.6.1...v6.7.0) (2026-08-06)


### Features

* recognize rounded-rect fill/stroke and emit corner glyphs + FillRectangles ([#212](https://github.com/sidorares/ntk/issues/212)) ([c33908a](https://github.com/sidorares/ntk/commit/c33908a652f911f7f40bababf08b36ef8e9d0cfe)), closes [#211](https://github.com/sidorares/ntk/issues/211)


### Bug Fixes

* a closed subpath's seam is a join, not two loose ends ([#216](https://github.com/sidorares/ntk/issues/216)) ([3bb8e32](https://github.com/sidorares/ntk/commit/3bb8e32375e572d7e0b8d19bf3b397c8170499e4))


### Performance Improvements

* flatten arcs from their own geometry instead of bisecting their cubics ([#215](https://github.com/sidorares/ntk/issues/215)) ([ca24183](https://github.com/sidorares/ntk/commit/ca24183250af0e0fe7cdf763fadd15e7067821b4)), closes [#213](https://github.com/sidorares/ntk/issues/213)

## [6.6.1](https://github.com/sidorares/ntk/compare/v6.6.0...v6.6.1) (2026-08-05)


### Bug Fixes

* **window:** the backing store cleared to white, whatever the window's background ([#209](https://github.com/sidorares/ntk/issues/209)) ([5d5e758](https://github.com/sidorares/ntk/commit/5d5e758f3059a87cff4c5579ae02304a203df801))

## [6.6.0](https://github.com/sidorares/ntk/compare/v6.5.0...v6.6.0) (2026-08-04)


### Features

* **window:** ARGB visual discovery and transparent windows ([#206](https://github.com/sidorares/ntk/issues/206)) ([67c21b5](https://github.com/sidorares/ntk/commit/67c21b5ef07276ce2b3a2212bbf314917a01b07a))

## [6.5.0](https://github.com/sidorares/ntk/compare/v6.4.0...v6.5.0) (2026-08-04)


### Features

* support Node 18.19 by reaching builtins through a version-tolerant helper ([#205](https://github.com/sidorares/ntk/issues/205)) ([9fc2e72](https://github.com/sidorares/ntk/commit/9fc2e72cf7d269c11da5b8762bf51070e7edda4d))


### Bug Fixes

* **window:** frameInFlight reports a present deferred by the inter-blit interval ([#204](https://github.com/sidorares/ntk/issues/204)) ([d604b9e](https://github.com/sidorares/ntk/commit/d604b9e1becb5636285f3d452d819a5504b9ba44))


### Performance Improvements

* **clip:** route non-rectangular clip masks through the local rasterizer ([#202](https://github.com/sidorares/ntk/issues/202)) ([59b9d89](https://github.com/sidorares/ntk/commit/59b9d895bbac6a87c3839e7eac69e8fd256aa4ee))

## [6.4.0](https://github.com/sidorares/ntk/compare/v6.3.0...v6.4.0) (2026-08-03)


### Features

* **glx:** explain why getContext('opengl') failed ([#200](https://github.com/sidorares/ntk/issues/200)) ([0139d9c](https://github.com/sidorares/ntk/commit/0139d9c45ecbf5dcdfdb3dd1f5a872104b44c141))

## [6.3.0](https://github.com/sidorares/ntk/compare/v6.2.0...v6.3.0) (2026-08-03)


### Features

* _NET_WM_SYNC_REQUEST, so window managers can pace interactive resizes ([#197](https://github.com/sidorares/ntk/issues/197)) ([84d849a](https://github.com/sidorares/ntk/commit/84d849a37641f08448e78f4fb572793563886d21))
* blit with the Present extension, opt-in per window ([#198](https://github.com/sidorares/ntk/issues/198)) ([c50fc14](https://github.com/sidorares/ntk/commit/c50fc141667a67fe7693955a0868903bb5cc6704))


### Performance Improvements

* pace discrete-event blits with a minimum inter-blit interval ([#195](https://github.com/sidorares/ntk/issues/195)) ([551817e](https://github.com/sidorares/ntk/commit/551817eb13bd39d1772cfef2d0900bf145d35ce9))

## [6.2.0](https://github.com/sidorares/ntk/compare/v6.1.0...v6.2.0) (2026-08-03)


### Features

* **window:** tag 'resize' with what actually changed ([#184](https://github.com/sidorares/ntk/issues/184)) ([#193](https://github.com/sidorares/ntk/issues/193)) ([bd309b1](https://github.com/sidorares/ntk/commit/bd309b16405e85acd47fbd27549117c19b07e41b))

## [6.1.0](https://github.com/sidorares/ntk/compare/v6.0.1...v6.1.0) (2026-08-03)


### Features

* **shm:** route bulk pixel transfers through MIT-SHM on local connections ([#191](https://github.com/sidorares/ntk/issues/191)) ([b427535](https://github.com/sidorares/ntk/commit/b42753539c578c0bf16931ff49b9549e2302f77d))

## [6.0.1](https://github.com/sidorares/ntk/compare/v6.0.0...v6.0.1) (2026-08-02)


### Performance Improvements

* **fonts:** prewarm fc-match for the default pattern off the event loop ([#189](https://github.com/sidorares/ntk/issues/189)) ([b92b806](https://github.com/sidorares/ntk/commit/b92b80670121e43a4003fb5cf5ab77e217dd6392))
* rect-only clip stacks never materialize the a8 mask ([#185](https://github.com/sidorares/ntk/issues/185)) ([25627b3](https://github.com/sidorares/ntk/commit/25627b35da61e2344b9d2cf06798ac812ced5c85))
* solid paints are one CreateSolidFill, cached per connection ([#190](https://github.com/sidorares/ntk/issues/190)) ([8a55431](https://github.com/sidorares/ntk/commit/8a554319922fc45b0351fb7808ff22f3a8ba5fee))
* **text:** LRU-evict the shaping memo and route fillText through it ([#188](https://github.com/sidorares/ntk/issues/188)) ([58faf84](https://github.com/sidorares/ntk/commit/58faf84be8458f2ece1b452f1d2937252cfc6709))
* **window:** headroom in the backing pixmap, so a drag-resize reallocates O(log) times ([#187](https://github.com/sidorares/ntk/issues/187)) ([115205d](https://github.com/sidorares/ntk/commit/115205d4465cf892a2321332b49f548c5e0d19ed))

## [6.0.0](https://github.com/sidorares/ntk/compare/v5.4.0...v6.0.0) (2026-08-02)


### ⚠ BREAKING CHANGES

* distribute leading above and below the text, not only below ([#175](https://github.com/sidorares/ntk/issues/175))

### Features

* **text:** TextLayout maxLines and ellipsis truncation ([#173](https://github.com/sidorares/ntk/issues/173)) ([d5eb6b5](https://github.com/sidorares/ntk/commit/d5eb6b56fcf59caeda1f44d810f6be5b599e462b))


### Bug Fixes

* distribute leading above and below the text, not only below ([#175](https://github.com/sidorares/ntk/issues/175)) ([50202ce](https://github.com/sidorares/ntk/commit/50202cea04f1f38aca44503eb663bd2d21ac8f3c))

## [5.4.0](https://github.com/sidorares/ntk/compare/v5.3.0...v5.4.0) (2026-08-02)


### Features

* **clipboard:** conversion timestamps, and clear() to give a selection back ([#172](https://github.com/sidorares/ntk/issues/172)) ([0f79862](https://github.com/sidorares/ntk/commit/0f79862d60b99e0da045f48969404f42e6b0c598))
* **fonts:** a font spec, for environments without fontconfig ([#167](https://github.com/sidorares/ntk/issues/167)) ([4084c93](https://github.com/sidorares/ntk/commit/4084c939a5aeb9ecc523976f84674f0eea20fc64))


### Bug Fixes

* stop leaking GCs, pixmaps and pictures from the 2d context ([#165](https://github.com/sidorares/ntk/issues/165)) ([545e450](https://github.com/sidorares/ntk/commit/545e450f4ecf27522598b739f5e1bbba97be302d))

## [5.3.0](https://github.com/sidorares/ntk/compare/v5.2.0...v5.3.0) (2026-08-02)


### Features

* a cancellable 'close' event for WM_DELETE_WINDOW ([#155](https://github.com/sidorares/ntk/issues/155)) ([d6b12f0](https://github.com/sidorares/ntk/commit/d6b12f080128792adfe4b982f34f4b56a59405f0))
* **clipboard:** INCR on the write side, required targets, any format ([#164](https://github.com/sidorares/ntk/issues/164)) ([2ced75e](https://github.com/sidorares/ntk/commit/2ced75e0fee3bc793b97c58698ff7a80133d804d))
* **clipboard:** watch a selection instead of polling it ([#163](https://github.com/sidorares/ntk/issues/163)) ([420035d](https://github.com/sidorares/ntk/commit/420035d9a9890766f7069004c6c202238cec0d16))
* setIcon/getIcon — the _NET_WM_ICON writer ([#154](https://github.com/sidorares/ntk/issues/154)) ([f08fe91](https://github.com/sidorares/ntk/commit/f08fe914f7f144daa0a2bcb78dd18ab10784c091))
* Surface, and SVG documents that take their colour from the caller ([#157](https://github.com/sidorares/ntk/issues/157)) ([c74f684](https://github.com/sidorares/ntk/commit/c74f684ec47a1b70ed0adb17ebc2a9a9908a63b4))


### Bug Fixes

* **test:** a test timeout that unrefs itself cannot fire when it matters ([#162](https://github.com/sidorares/ntk/issues/162)) ([8811235](https://github.com/sidorares/ntk/commit/88112352646077977f170ea1b0bca824026ed692))

## [5.2.0](https://github.com/sidorares/ntk/compare/v5.1.0...v5.2.0) (2026-08-01)


### Features

* publish frameInFlight, the gate for painting a discrete input now ([#148](https://github.com/sidorares/ntk/issues/148)) ([64e4108](https://github.com/sidorares/ntk/commit/64e41082094dade3c89db35fb1f33cad63758f58))

## [5.1.0](https://github.com/sidorares/ntk/compare/v5.0.0...v5.1.0) (2026-08-01)


### Features

* **context-2d:** rasterize small drawings locally, behind a pluggable seam ([#147](https://github.com/sidorares/ntk/issues/147)) ([05c46fa](https://github.com/sidorares/ntk/commit/05c46fae2a961ea1161f29d742828f466cc12b62))


### Bug Fixes

* **context-2d:** bound stroke mask work to the stroke's bounding box ([#145](https://github.com/sidorares/ntk/issues/145)) ([3e6a332](https://github.com/sidorares/ntk/commit/3e6a3326be3abd79dd1880dfc96129af161c71b4))

## [5.0.0](https://github.com/sidorares/ntk/compare/v4.3.0...v5.0.0) (2026-08-01)


### ⚠ BREAKING CHANGES

* load the layout engine without top-level await ([#143](https://github.com/sidorares/ntk/issues/143))

### Features

* load the layout engine without top-level await ([#143](https://github.com/sidorares/ntk/issues/143)) ([3ea8127](https://github.com/sidorares/ntk/commit/3ea8127190eec5b82cd3fcb6b59b4c287114cd71))
* one socket write per frame — buffer requests by default ([#141](https://github.com/sidorares/ntk/issues/141)) ([8c6e76d](https://github.com/sidorares/ntk/commit/8c6e76df34eb5efc9627238e3f0b9807b96d43d3))

## [4.3.0](https://github.com/sidorares/ntk/compare/v4.2.0...v4.3.0) (2026-08-01)


### Features

* Window.scrollRegion — server-side scroll of the backing store ([#139](https://github.com/sidorares/ntk/issues/139)) ([055028a](https://github.com/sidorares/ntk/commit/055028a2b2e231e30dbecd9b88f33f5e5523d57a))

## [4.2.0](https://github.com/sidorares/ntk/compare/v4.1.0...v4.2.0) (2026-07-31)


### Features

* setCursor('none'), a genuinely blank cursor ([#136](https://github.com/sidorares/ntk/issues/136)) ([6e69a1b](https://github.com/sidorares/ntk/commit/6e69a1bc10e925941b7cf98ea093e5a700346fbd))

## [4.1.0](https://github.com/sidorares/ntk/compare/v4.0.0...v4.1.0) (2026-07-31)


### Features

* _NET_WM_STATE beyond always-on-top, and both ways of changing it ([#132](https://github.com/sidorares/ntk/issues/132)) ([7016021](https://github.com/sidorares/ntk/commit/70160215f0a0ff284d979cdb8ddbca4ef391f92f))
* round out the ICCCM writers, and stop WM_PROTOCOLS clobbering itself ([#131](https://github.com/sidorares/ntk/issues/131)) ([cca73c3](https://github.com/sidorares/ntk/commit/cca73c3da2d3bb980db81b9f4f88c6db9b93e57c))


### Bug Fixes

* build outgoing events from objects, and reject a big-endian connection ([#130](https://github.com/sidorares/ntk/issues/130)) ([cd34931](https://github.com/sidorares/ntk/commit/cd349318c262323059e614817f2227e31cc680ef))
* follow the active keyboard layout, and stop CapsLock shifting digits ([#133](https://github.com/sidorares/ntk/issues/133)) ([7621477](https://github.com/sidorares/ntk/commit/7621477f5f0e2db43dc08d3096f18b423a76b3ce))
* implement deleteProperty, which the docs already promised ([#134](https://github.com/sidorares/ntk/issues/134)) ([8bf4ea4](https://github.com/sidorares/ntk/commit/8bf4ea4407db79b8a4a04aab8f863110e21b8d03))
* inline the keysym-to-unicode table, drop the keysym dependency ([#127](https://github.com/sidorares/ntk/issues/127)) ([97d9409](https://github.com/sidorares/ntk/commit/97d940994a5cd590bd437a55ad74652fa1840243))

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
