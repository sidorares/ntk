# Shared glyphs across processes

**Status: implemented.** The directory is `lib/glyphdirectory.js`, the client
side `lib/sharedglyphs.js`, the wire codecs `lib/glyphdwire.js`; the pages in
`lib/text/glyphs.js` and `lib/shapeglyphs.js` bind to it. The server behavior
it stands on is fenced by `test/shared-glyphs-assumptions.test.js`, and the
machinery itself by `test/shared-glyphs.test.js` — both hermetic against the
pure-JS server and smoke-style against a real one. This document is the
design record and the protocol reference. Numbers were measured during the
investigation (aarch64 Linux, Xvfb 21.1.22, node 22).

Without sharing, every ntk process rasterizes its own glyphs and uploads them
to the server ([text.md](text.md), `lib/text/glyphs.js`): a `GlyphPage` per
(face, pixel size), lazily filled, one `AddGlyphs` per batch of new glyphs.
Two ntk apps showing the same UI font repeat identical work — parse the same
font, rasterize the same bitmaps, upload the same bytes. The question this
document answers: can processes share server-side glyphs — say, a special
unmapped window claiming a "font renderer" selection and keeping a
display-wide glyph set — and what would an efficient protocol for that look
like?

## Using it

The feature is on by default and entirely invisible: the first ntk app on a
display becomes the *glyph directory* (a few hundred lines riding its
existing connection), every app — including that one — asks it for shared
glyph ids, and any failure anywhere falls back to the private per-process
path with the same pixels.

- `createClient({ sharedGlyphs: false })` turns it off for one app;
  `NTK_NO_SHARED_GLYPHS=1` turns it off for a process. Off means not one
  byte of the machinery runs — page behavior is exactly the pre-feature
  code path.
- `createClient({ sharedGlyphs: { budgetBytes } })` sets the directory-side
  generation budget (default 32MB; `DEFAULT_SHARED_GLYPHS_POLICY`).
- `app.sharedGlyphs` is the client (`null` when off). Purely lazy — nothing
  touches the server until the first glyph page binds.
- `warmSharedGlyphs(app, font, size, text)` resolves a page's entries from
  the directory *before* first paint. A synchronous `fillText` cannot wait
  for the directory's answer, so a cold first draw mints a private copy for
  that one frame and adopts the shared entries behind it; warming first is
  what makes the first paint of already-shared text rasterize **nothing**
  and upload **nothing**.

## Verdict: possible, and RENDER was designed for it

Cross-connection glyph use needs no extension and no server changes.
XIDs are display-global names, and RENDER's `ReferenceGlyphSet` request
exists precisely to alias a glyphset under a second (refcounted) name
owned by a different client. Everything below is verified against both
servers ntk targets — Xorg 21.1 (Xvfb) and node-x11's pure-JS server
([xserver.md](xserver.md)) — by the fence test:

| server fact | Xorg | js server |
| --- | --- | --- |
| composite with a glyphset created on another connection (raw XID) | ✓ | ✓ |
| `ReferenceGlyphSet` alias keeps glyphs alive after the creator disconnects | ✓ | ✓ |
| aliases chain: C references B's alias, B dies, C still draws | ✓ | ✓ |
| a non-creator can `AddGlyphs` through its own alias | ✓ | ✓ |
| stale/dead glyphset XID → `GLYPHSET` error, draws nothing | ✓ | ✓ |
| glyph id not in the set | **silently skipped, pen does not advance** | `GLYPH` error |

The one divergence (last row) is recorded, not resolved: Xorg builds its
glyph list with `if ((glyph = FindGlyph(...)))` and simply drops misses
— including the miss's stored advance, so every following glyph in the
element lands shifted. The js server raises an error instead. Either
way the conclusion is the same and it shapes the whole protocol:
**a client must never composite a glyph id it hasn't confirmed present.**
There is no safe blind-fire-and-handle-the-error path.

Two more facts worth knowing before designing anything:

- **Xorg already dedupes glyph pixel storage globally** — since 2007
  (Carl Worth's glyph-storage rework, xorg-server 1.5: "Use strong hash
  (SHA1) for glyphs", `19b3b1fd8feb`). Every glyph is content-hashed on
  `AddGlyphs` (`render/glyph.c`: `HashGlyph`, `FindGlyphByHash`, the
  per-format `globalGlyphs` tables); identical
  bits uploaded by different clients into different sets share one
  refcounted `GlyphRec`. So on Xorg, sharing does **not** save server
  pixel memory — that is already free. What is not shared without this
  protocol: the rasterization CPU, the font parsing, the wire bytes, and
  the per-set id→glyph tables — all per process.
- **The js server has no content dedup** (each set is its own `Map`;
  an alias shares the map). There, sharing one set across clients *is*
  the memory dedup.

## What sharing buys — and what it doesn't

Per process, per (face, size), measured here with ntk's JS rasterizer
(KaTeX Main regular, 93 ASCII glyphs at 16px): **~8 ms of rasterization**
and **~11.5 KB of `AddGlyphs` wire**, plus ~1 ms font parse per face.
An app touching two faces at three sizes each pays this six times; every
further ntk process pays it all again. CJK multiplies the glyph count by
an order of magnitude. With a shared cache, the *n*-th process starts
with every glyph any earlier process ever drew: warmed, its first text
paint uploads nothing and rasterizes nothing — a cold-start latency win,
not just saved throughput.

What it does not change: the steady-state draw path. `CompositeGlyphs`
requests are identical, shaping and layout stay local (they need the
font regardless — sharing rasterization is not outsourcing text), and a
warm process redrawing cached text costs exactly what it costs today.
One honest regression: a shared page accumulates the union of all
processes' glyphs, so it crosses 256 local ids — the point where
`CompositeGlyphs8` becomes `CompositeGlyphs16` ([text.md](text.md)) —
sooner than a private page would. That is +1 wire byte per glyph after
the first 256, against ~124 bytes saved per glyph *upload*; noise.

## The protocol: a glyph directory (`_NTK_GLYPHD`)

The user-visible sketch — "renderer confirms *I can render that for
you* / *it's there already*" — splits into two jobs: **naming** (which
shared page, which local id, is it present) and **rasterizing**. The
key insight from the fence test is that only naming needs a central
authority. Any client may upload bits into the shared set through its
own alias, and uploads keyed by content are idempotent (identical bytes;
Xorg dedupes them by hash anyway). So the service is not a font
*renderer* — it is a glyph *directory*, and rasterization is done once,
by whichever client needs the glyph first. That keeps the directory
trivially small, stateless about fonts, and version-proof.

### Discovery — a manager selection

Standard ICCCM manager-selection pattern, exactly the plumbing
[clipboard.md](clipboard.md) already exercises: the directory owns an
unmapped window and claims the `_NTK_GLYPHD` selection with a real
timestamp, announces itself with a `MANAGER` ClientMessage on the root,
and hands over via `SelectionClear`. The first ntk app on a display
self-elects (the directory is a few hundred lines riding an existing
connection); a standalone `ntk-glyphd` could claim it instead and then
outlive every app. `GetSelectionOwner` returning `None` — or the
`NTK_NO_SHARED_GLYPHS` kill switch — means every page below silently
degrades to today's private per-process `GlyphPage`; the feature is a
pure overlay, correct with zero directories running.

### Keys — two ways to name a bitmap

A shared page is named by a token, and a glyph within it by
(token, member key). The rule that makes the whole design sound is
only this: **token + member key must deterministically name the bitmap
bytes**, with the token's namespace prefix pinning the generator
version. Two addressing families cover everything ntk uploads:

**Font pages are content-addressed** — the generator's input is a font
file, far too big to name literally, so a hash stands in for it:

```
ntkg1:<sha1 of font file bytes>:<variation coords>:<px size>:<format>
```

with the member key being the font glyph index. Two refinements the
"sha1 of font + glyph id" idea needs in practice:

- **The namespace version (`ntkg1`) is load-bearing, not hygiene.** A
  glyph's advance is baked into the set at `AddGlyphs` time (`offX`,
  rounded by the uploader), and idempotent duplicate uploads assume
  byte-identical rasterization. Both hold only among processes running
  the same rasterizer and rounding — so the version is part of the
  name, and two ntk versions on one display simply share nothing
  (correct, if less efficient).
- The sha1 is computed from the loaded font buffer, lazily on first
  shared use, cached per `Font` — a `path#psName` key
  (`lib/text/font.js`) names a file on *this* machine, which another
  process, or the same app after an upgrade, cannot trust.

**Shape pages are parameter-addressed** — hashing would be overkill and
worse. The rounded-box fast path (`lib/shapeglyphs.js`) mints corner
glyphs from *intended use*, not from any file: there is no font, no
name, and the generator's entire input is a handful of small integers.
Those parameters are already the bitmap's canonical name, and the
codebase already spells it: `cornerKey()` — `kind|rx|ry|bw|corner` — is
the local cache key. The shared member key is that same string; the
page token is just the namespace:

```
token   ntks1:a8            one page for all corners, as locally
member  stroke|40|40|3|2    3px-wide quarter-arc band, 40px radius,
                            bottom-left corner of its box
```

Hashing `stroke|40|40|3|2` would only hide from a debugger what the
string says outright. Determinism is even easier than for fonts: a
corner bitmap is a pure function of four small integers (and the three
mirrored corners are byte-level flips of the rasterized top-left
master, so all four are exact by construction). What the version
prefix pins is the coverage/antialiasing profile of the band
rasterizer — change what an arc's edge pixels look like, bump `ntks1`.

Straight sides stay `FillRectangles` (no upload, nothing to share —
the existing analysis in `lib/shapeglyphs.js` is unchanged by any of
this), but the grammar has room for edge/segment members if that ever
flips. And the payoff compounds: corner glyphs are keyed by radius and
band width only — not box size — so within one app its progress bars,
pills and cards all share four glyphs per (r, bw). Shared pages make
that *every ntk app on the display* sharing them: cross-box batching
becomes cross-process batching.

### The ensure RPC — XDND-style, misses only

Each client owns an unmapped mailbox window. To use glyphs it doesn't
yet know (mirror of `GlyphPage.ensure`, batched per draw):

1. Client writes the request — token + list of member keys
   (length-prefixed strings; a header flag lets font pages pack plain
   glyph-index arrays instead) — into a property on its mailbox, and
   sends the directory's window a
   `_NTK_GLYPHD_ENSURE` ClientMessage naming the mailbox, a serial, and
   the property.
2. Directory allocates any ids it hasn't seen (it is the **single
   writer** of the lid space, which is what keeps ids compact for the
   8-bit encoding), writes the reply property on the mailbox — page
   `generation`, `gsid`, and per requested glyph its `lid` plus a
   *present* bit — and answers with a `_NTK_GLYPHD_DONE` message.
3. First use of a page: client issues `ReferenceGlyphSet(myAlias, gsid)`
   (lifetime fence below) and keeps `entries` exactly as before.
4. For every glyph whose present bit was clear, the client rasterizes
   and `AddGlyphs` **through its own alias** — then tells the directory
   (`_NTK_GLYPHD_ADDED`) so it flips the bit for future askers. The
   uploader itself may composite immediately: its upload and its draw
   are ordered on its own connection. Two clients racing on the same
   missing glyph both get told "yours to upload": both upload identical
   bytes, `AddGlyphs` replaces by id, Xorg dedupes by hash — idempotent,
   nobody waits.
5. No metrics ride in the reply: a font client derives advances from
   its own copy of the same font bytes, a shape client from the member
   key's own parameters — in both families the token already pins
   everything the reply would otherwise have to say.

The hot path never appears in this list. Drawing cached text is
`CompositeGlyphs` against the referenced alias, no directory involved;
the RPC happens once per (glyph, process) lifetime, the same moments
the private path rasterizes and uploads.

The exact property layouts live in `lib/glyphdwire.js` (format-8
payloads, little-endian): a request is
`version, flags, token length, member count, uploaded bytes, token,
members`; a reply is `version, status, serial, generation, gsid, count`
followed by one word per member — bit 31 the present bit, bits 0–30 the
lid — in request order. The ClientMessages carry
`[window, serial, property]` (`ENSURE`/`ADDED`, with `window` the
mailbox) and `[serial, status]` (`DONE`).

### Lifetime, eviction, crashes

- **The directory never frees an advertised set.** Eviction (the
  private path's `cacheBytes` LRU becomes a directory-side budget)
  means opening a new *generation*: fresh sets advertised, old ones no
  longer handed out — they die when the last client alias drops.
  Clients keep their own LRU (`trimGlyphPages`): dropping a page frees
  the alias, a refcount decrement, never the shared set.
- **XID-reuse fence.** A client that read `gsid` from a reply must not
  reference it into a void: the directory could die and the XID be
  recycled by an unrelated client. Send `ReferenceGlyphSet` and
  `GetSelectionOwner(_NTK_GLYPHD)` in one batch: replies are processed
  in order, and the directory's contract says it frees nothing while it
  owns the selection — so if the owner is still the advertising window
  *after* the reference, the reference bound the intended object. If
  not, drop the alias and re-ask whoever owns the selection now. A
  reference that raced the death itself fails with the `GLYPHSET` error
  the fence test pins — an error, never wrong pixels.
- **Directory death is graceful by construction.** Aliased pages stay
  fully drawable in every client (fence test, rows 2–3); they merely
  freeze — no new lids without an allocator. Clients route new glyphs to
  private pages until a new owner appears (`MANAGER` announcement), then
  adopt its fresh generation lazily. A client crash needs no handling at
  all: its aliases die with its connection.
- **Hardened servers.** XACE/SELinux policies can forbid touching
  another client's resources; the first cross-client operation fails
  cleanly and the client falls back to private pages for good. And a
  hostile same-display client could upload wrong bits for a shared lid —
  but a same-display client can already fake your input and read your
  windows; core X clients are mutually trusting, and this adds no new
  boundary (the kill switch exists for belt-and-braces).

### The renderer-executes variant (rejected for v1, compatible later)

The directory could also *rasterize* — answer "I have the font, here
are finished glyphs" — which saves the first-needer's ~8 ms and is the
literal "font renderer" of the original sketch. It costs a font-transfer
subprotocol (the directory may not have the bytes behind a sha1; INCR
chunking like the clipboard's), makes the directory's rasterizer version
load-bearing, and helps only the *first* toucher of each glyph — every
later process gains nothing over the registry design. It also could
never cover the shape namespace at all: there is no file to transfer —
the generator is client code. That the registry design serves both
families identically, knowing nothing about either, is the strongest
argument that it carved the protocol at the right joint. The registry
protocol above is forward-compatible with it: a directory that happens
to hold the font can pre-fill bits and simply always answer "present".

## Prior art

Nothing on a current free desktop does cross-process glyph sharing — but
the idea has shipped repeatedly in single-vendor window systems, and
both X and Wayland carry designed-but-never-built versions of it.

- **The X server itself fixed the memory half, below the protocol.**
  Every cairo/GTK2-3 process on a desktop uploads the same DejaVu
  glyphs; Carl Worth's 2007 rework ([log of
  `render/glyph.c`](https://cgit.freedesktop.org/xorg/xserver/log/render/glyph.c?showmsg=1))
  made the server hash and share the storage instead of asking clients
  to coordinate. That is the *transparent* point in the stack — and it
  structurally cannot save what this proposal saves: per-process
  rasterization, font parsing, and wire uploads.
- **Xft/cairo (GTK2/3) and Qt3/4 on X11** all drive per-process RENDER
  glyphsets and never coordinated, even though `ReferenceGlyphSet` sat
  in the protocol the whole time, put there to let glyphsets be shared.
  The intended client-side half was simply never built.
- **Qt for Embedded Linux (QWS)** — Qt's own window system — did build
  it: FreeType-rendered glyphs were [shared between
  applications](https://doc.qt.io/archives/qt-4.8/qt-embedded-fonts.html)
  through memory-mapped glyph maps (the QPF2 format doubling as the
  shared-cache layout). Dropped with QWS itself in Qt 5; on
  eglfs/Wayland every Qt process is back to a private cache.
- **Symbian's Font and Bitmap Server** is the closest cousin of the
  "font renderer" sketch: a dedicated server owning rasterization, one
  instance of each glyph in a [shared, refcounted
  heap](https://docs.huihoo.com/symbian/nokia-symbian3-developers-library-v0.8/GUID-71DADA82-3ABC-52D2-8360-33FAEB2E5DE9.html)
  mapped read-only into every client.
- **Windows**: GDI text runs in kernel `win32k`, so its glyph caches are
  per-session — cross-process by construction. DirectWrite moved
  rendering into processes but kept a system **Font Cache Service**
  (shared font data over ALPC); Chrome even [built its own shared
  DirectWrite font
  cache](https://www.chromium.org/developers/design-documents/directwrite-font-cache/)
  for sandboxed renderers before the OS service sufficed. **RDP**
  carries a wire-level [glyph
  cache](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpcr2/42794cc9-8807-4063-b2dd-d16a612e3852)
  — bitmaps uploaded once, then drawn by index: `AddGlyphs` /
  `CompositeGlyphs` reinvented for another wire.
- **Wayland designed it and dropped it.** Kristian Høgsberg's original
  [2010 design document](https://people.freedesktop.org/~krh/wayland.pdf)
  sketches a glyph cache as a global object advertised at connect time:
  clients rasterize into a shared atlas buffer they take references on,
  the compositor composites from it, entries refcounted and purged. No
  such protocol was ever adopted; GTK4 (GSK), Qt 6 and Skia each keep
  private per-process atlases, and GNOME/KDE expose no font service
  over D-Bus either — portals carry font *settings*, `fontconfig`'s
  mmap'd caches share font *metadata*, and rendered glyphs are shared
  by nobody. The duplication measured above is simply accepted there.
- **Chromium** ships the same split this document proposes, one browser
  wide: renderer processes shape and record text, rasterization happens
  once in the GPU/viz process
  ([RenderingNG](https://developer.chrome.com/docs/chromium/renderingng-architecture)),
  whose glyph caches serve every tab's renderer.
- **The ancestors** — core X fonts and `xfs`, NeWS/Display PostScript,
  BeOS's app_server — shared glyphs across clients trivially because the
  server rendered all text, and were abandoned precisely to give
  clients shaping and rasterization control.

The pattern across all of it: sharing happens either *below* the
protocol (Xorg's hash, win32k) or through a *single owner of
rasterization* (Symbian, QWS, core fonts). The registry design lands on
the third point both Chromium (shipped) and Høgsberg's sketch
(unshipped) chose: rasterize at the edge, name and store centrally.
ntk can occupy it on X only because it still renders text through
RENDER glyphs — toolkits that moved to client-side pixels lost the
shared server-side store this design leans on.

## How it lands in the code

`lib/text/glyphs.js` keeps its shape: `GlyphPage` has a *shared* mode
where entries re-bind to ensure-reply lids instead of staying on the
locally minted ones, `GlyphSet` has `referenceTo(app, gsid)` beside its
constructor, and `encodeGlyphItems`/draw paths don't change at all
(entries carry their glyphset, and the encoder always knew how to
switch sets mid-run). `ShapeGlyphPage` (`lib/shapeglyphs.js`) mirrors
`GlyphPage` by design and takes the same change; its `cornerKey`
strings go on the wire as-is.

One behavior worth spelling out: a synchronous draw never waits for the
directory. Glyphs the page hasn't confirmed yet are minted privately
for that frame — the same rasterize + `AddGlyphs` as always, pixels
identical — while the ensure RPC runs behind it; the reply re-binds the
entries to the shared set (uploading the retained bitmap only when this
process was first to need the glyph), and once nothing composites from
the private set any more it is freed. `warmSharedGlyphs` is the way to
skip that one-frame fallback entirely. A page binds to exactly one
(owner, gsid, generation); any disagreement afterwards — a new
generation, a dead directory, a refused request — freezes its shared
side: bound entries keep drawing from the alias, new glyphs go private,
and a fresh page binds fresh. The client-side LRUs are unchanged and
count private bytes only; dropping a page frees its alias, which is a
refcount, never the shared set. The shape page's over-budget reset
frees its alias the same way — the recreated page simply re-binds and
finds every corner already present; only the directory opens new
generations.

The directory side (`lib/glyphdirectory.js`) is small: the selection +
property RPC riding the clipboard's selection patterns, and a `Map` of
token → {glyphset, lids, presence bits}. It rides the first app's
existing connection; every app embeds it behind the same code path.

## Open questions

- Election policy: is first-app-wins good enough, or should a desktop
  session prefer a standalone `ntk-glyphd` so pages outlive app churn?
  (First-app-wins already survives churn via generation handoff — the
  cost is churn of the *cache*, not correctness.)
- Should the js server's missing-glyph error be relaxed upstream to
  match Xorg's silent skip, or is fail-loud the better default for a
  server whose main job is tests?
- Real-app id pressure: how quickly do shared pages cross the 256-lid
  boundary on an actual desktop (forcing 16-bit encoding), and is it
  worth partitioning pages by script to delay it?
- Token spec freeze if anything non-ntk ever wants to join (out of
  scope until someone asks).

## Running the fence test

```bash
node --test test/shared-glyphs-assumptions.test.js
```

The pure-JS server scenarios run hermetically; the real-server scenarios
run when `DISPLAY` is set (CI's Xvfb, or any desktop session) and skip
otherwise, smoke-test style. `test/shared-glyphs.test.js` exercises the
directory and client the same two ways — whole ntk apps side by side on
one server, glyphs crossing between them.
