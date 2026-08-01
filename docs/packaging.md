# Packaging an ntk app

ntk is pure JavaScript and WebAssembly — no node-gyp, no prebuild matrix — so
`npm install` on a fresh box just works. This page is about the other two
ways to ship: one bundled file, and one executable file.

## A single `.mjs`

```sh
esbuild app.js --bundle --platform=node --format=esm --outfile=app.mjs \
  --banner:js="import{createRequire as __cjsRequire}from'node:module';const require=__cjsRequire(import.meta.url);"

node app.mjs
```

The banner is needed because node-x11 is CommonJS and calls `require()` from
inside functions; esbuild turns those into a shim that needs a real `require`
to exist. Alias the import — `createRequire` collides with the same import in
some consumers, react-x11 among them.

## A single executable

Node's [single executable applications](https://nodejs.org/api/single-executable-applications.html)
embed a script in a copy of the node binary. The embedded main is evaluated
as **CommonJS**, so the bundle must be CommonJS too:

```sh
esbuild app.js --bundle --platform=node --format=cjs --outfile=app.cjs
node --build-sea=sea-config.json          # { "main": "app.cjs", "output": "app" }
./app
```

Two rules follow from "the main is CommonJS":

- **No top-level `await` anywhere in the graph.** esbuild refuses to emit
  CommonJS for a graph that has one, and the diagnostic names the file. Put
  your own startup in an `async function main()` rather than awaiting at
  module scope — `await createClient()` at the top level of your entry is
  enough to block the build.
- **`import.meta.url` is `undefined`** in a CommonJS bundle, so anything
  resolving paths through it (a `createRequire(import.meta.url)` of your own,
  for instance) has to use `process.execPath` or a literal path instead.

Inside a SEA, `require()` and `import()` resolve **built-in modules only** —
a `data:` or `file:` URL import fails with `ERR_UNKNOWN_BUILTIN_MODULE`. That
is fine for a bundle, which has nothing left to resolve, but it rules out
loading anything at runtime.

ntk itself is built for this: nothing in `lib/` uses top-level await, and
`test/packaging.test.js` keeps it that way. The one thing that would take it
away is importing `yoga-layout`'s default entry — it is
`const Yoga = wrapAssembly(await loadYoga())` — which is why ntk loads the
layout engine through `yoga-layout/load` and exposes it as
[`Yoga`/`loadLayout()`](html.md). Verified end to end: a bundle with ntk,
node-x11's client *and* its pure-JS X server runs as one file, drawing
through XRender and laying out an `HtmlView`.

The binary is large (~140 MB): most of it is node itself.

## What to ship beside it

- A **`.desktop`** file whose `StartupWMClass` matches the window's
  `wmClass`, or the desktop groups your windows under the wrong icon
  ([window.md](window.md#application-identity--setclassinstance-class--wmclass)).
- **Icons** under `usr/share/icons/hicolor/<size>/apps/`.
- **Fonts**, if the target may not have fontconfig: `StaticFontSource` takes
  font bytes directly and needs no `fc-match`
  ([fonts.md](fonts.md#pluggable-font-sources)). Bundling the faces you draw
  with also makes rendering identical across machines.
