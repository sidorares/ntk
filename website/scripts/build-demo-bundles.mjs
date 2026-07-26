// Builds the in-browser demo runtime bundle for the playground:
//   (virtual entry) → static/demo/ntk-demo-runtime.js  (IIFE, global NtkDemo)
//
// The bundle contains:
//   - ntk itself (../lib/index.js) — exported as NtkDemo.ntk
//   - node-x11 (the repo's node_modules/x11) — exported as NtkDemo.x11
//   - the RENDER-enabled JS X server (../lib/xserver) — NtkDemo.xserver;
//     until that lands, a plain node-x11 XServer fallback keeps the build
//     green (scripts/xserver-fallback.js)
//   - x11's browser presentation layer (CanvasPresenter, DOM key mapping)
//   - setupFonts(): a StaticFontSource preloaded with embedded DejaVu TTFs
//
// Heavy optional ntk dependencies that no playground demo needs are aliased
// to inert stubs (scripts/stubs/*) so the bundle stays reasonable:
// yoga-layout (HtmlView), mermaid + dompurify + @dagrejs/dagre (diagram
// fences), pngjs (browserify polyfill forest). katex is already lazy-loaded
// by ntk and never bundled.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const websiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(websiteDir, '..');
const scriptsDir = path.join(websiteDir, 'scripts');
const shimsDir = path.join(scriptsDir, 'browser-shims');
const stubsDir = path.join(scriptsDir, 'stubs');
const outFile = path.join(websiteDir, 'static', 'demo', 'ntk-demo-runtime.js');

const x11Dir = path.join(repoRoot, 'node_modules', 'x11');
const ntkXserver = path.join(repoRoot, 'lib', 'xserver', 'index.js');
const hasNtkXserver = fs.existsSync(ntkXserver);

// Virtual entry (resolveDir = website/scripts so ./demo-fonts.js and the
// dejavu-fonts-ttf devDependency resolve from the website's node_modules,
// while 'ntk' / 'x11' resolve through the aliases below).
const entrySource = [
  "const ntk = require('ntk');",
  "const x11 = require('x11');",
  hasNtkXserver
    ? `const xserver = require(${JSON.stringify(ntkXserver)});`
    : "const xserver = require('./xserver-fallback.js'); // lib/xserver not built yet",
  "const { CanvasPresenter } = require('x11/browser/compositor.js');",
  "const { keyboardEventToKeysym } = require('x11/browser/domkeys.js');",
  "const { setupFonts } = require('./demo-fonts.js');",
  'module.exports = {',
  '  ntk,',
  '  x11,',
  '  xserver,',
  '  CanvasPresenter,',
  '  keyboardEventToKeysym,',
  '  createStreamPair: xserver.createStreamPair,',
  '  setupFonts,',
  `  hasRenderServer: ${hasNtkXserver},`,
  '};',
].join('\n');

await esbuild.build({
  stdin: {
    contents: entrySource,
    resolveDir: scriptsDir,
    sourcefile: 'ntk-demo-entry.js',
    loader: 'js',
  },
  bundle: true,
  outfile: outFile,
  format: 'iife',
  globalName: 'NtkDemo',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  sourcemap: false,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.ttf': 'binary' },
  // Buffer/process globals for the bundled node-style code:
  inject: [path.join(shimsDir, 'globals.js')],
  alias: {
    // the toolkit itself and the x11 client it wraps (single instances)
    ntk: path.join(repoRoot, 'lib', 'index.js'),
    x11: x11Dir,
    // real polyfills (installed as website devDependencies)
    buffer: require.resolve('buffer/'),
    'node:buffer': require.resolve('buffer/'),
    events: require.resolve('events/'),
    'node:events': require.resolve('events/'),
    process: require.resolve('process/browser'),
    'node:process': require.resolve('process/browser'),
    // inert stubs for node builtins reached only on node-only code paths
    net: path.join(shimsDir, 'net.js'),
    'node:net': path.join(shimsDir, 'net.js'),
    fs: path.join(shimsDir, 'fs.js'),
    'node:fs': path.join(shimsDir, 'fs.js'),
    os: path.join(shimsDir, 'os.js'),
    'node:os': path.join(shimsDir, 'os.js'),
    path: path.join(shimsDir, 'path.js'),
    'node:path': path.join(shimsDir, 'path.js'),
    util: path.join(shimsDir, 'util.js'),
    'node:util': path.join(shimsDir, 'util.js'),
    // keysym reads its JSON tables with fs at load time; this build inlines them
    keysym: path.join(shimsDir, 'keysym.js'),
    // heavy optional deps no playground demo needs
    'yoga-layout': path.join(stubsDir, 'yoga-layout.js'),
    mermaid: path.join(stubsDir, 'mermaid.js'),
    dompurify: path.join(stubsDir, 'dompurify.js'),
    '@dagrejs/dagre': path.join(stubsDir, 'dagre.js'),
    pngjs: path.join(stubsDir, 'pngjs.js'),
  },
});

const kb = (fs.statSync(outFile).size / 1024).toFixed(0);
console.log(
  `built ${path.relative(websiteDir, outFile)} (${kb} KB, ` +
    `xserver: ${hasNtkXserver ? 'lib/xserver (RENDER)' : 'node-x11 fallback — no RENDER yet'})`
);
