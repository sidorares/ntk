// Sanity gate for the built demo runtime: evaluates the IIFE bundle in a
// bare vm context (no DOM at all — the bundle must not touch `document` at
// load time) and asserts the NtkDemo global has the full public surface,
// that the JS X server boots, and that the embedded fonts resolve.
//
//   node scripts/build-demo-bundles.mjs && node scripts/check-bundle.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const websiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(websiteDir, 'static', 'demo', 'ntk-demo-runtime.js');

if (!fs.existsSync(bundle)) {
  console.error('bundle missing — run: node scripts/build-demo-bundles.mjs');
  process.exit(1);
}

// deliberately minimal: no document, no window — load must not need them.
// TextDecoder/timers are host primitives fontkit and the stream pairs use.
const context = vm.createContext({
  console,
  TextDecoder,
  TextEncoder,
  atob,
  btoa,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
});
vm.runInContext(fs.readFileSync(bundle, 'utf8'), context, { filename: 'ntk-demo-runtime.js' });

const g = context.NtkDemo;
assert.ok(g, 'NtkDemo global is defined');
assert.strictEqual(typeof g.ntk.createClient, 'function', 'ntk.createClient');
assert.strictEqual(typeof g.ntk.StaticFontSource, 'function', 'ntk.StaticFontSource');
assert.strictEqual(typeof g.x11.createClient, 'function', 'x11.createClient');
assert.strictEqual(typeof g.x11.registerDisplayProtocol, 'function', 'x11.registerDisplayProtocol');
assert.strictEqual(typeof g.xserver.createServer, 'function', 'xserver.createServer');
assert.strictEqual(typeof g.createStreamPair, 'function', 'createStreamPair');
assert.strictEqual(typeof g.CanvasPresenter, 'function', 'CanvasPresenter');
assert.strictEqual(typeof g.keyboardEventToKeysym, 'function', 'keyboardEventToKeysym');
assert.strictEqual(typeof g.setupFonts, 'function', 'setupFonts');
assert.ok(context.Buffer, 'Buffer global installed by the bundle');
assert.ok(context.process && context.process.env, 'process global installed by the bundle');

// the server itself must boot DOM-free (only the presenter needs a canvas)
// and carry the RENDER extension ntk requires (built into x11 >= 3.1.0)
const server = g.xserver.createServer({ width: 64, height: 48 });
assert.strictEqual(server.width, 64);
assert.ok(server.root && server.root.raster && server.root.raster.data.length === 64 * 48);
assert.ok(server.extensions && server.extensions.get('RENDER'), 'server has RENDER');

// fonts: the embedded DejaVu faces must open and cover basic latin
const source = context.NtkDemo.setupFonts();
const candidates = source.matchSorted({ family: 'sans-serif' });
assert.ok(candidates.length >= 1, 'sans-serif resolves to at least one face');
assert.ok(source.covers(candidates[0], 'A'.codePointAt(0)), "best face covers 'A'");
for (const family of ['serif', 'monospace']) {
  assert.ok(
    source.matchSorted({ family }).length >= 1,
    `${family} resolves to at least one face`
  );
}

console.log(
  `bundle ok (${(fs.statSync(bundle).size / 1024).toFixed(0)} KB, ` +
    'xserver: x11 (RENDER))'
);
