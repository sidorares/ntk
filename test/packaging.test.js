// ntk must stay bundleable, for the browser and as CommonJS.
//
// The CommonJS half used to need a lint of its own. Node's single-executable
// format runs its embedded main as CommonJS, esbuild refuses to emit CommonJS
// for a graph containing top-level await, and `yoga-layout`'s default entry is
// `const Yoga = wrapAssembly(await loadYoga())` — ntk laid `HtmlView` out with
// it, so one import cost every app the ability to ship as one binary.
//
// The layout engine left with the document widgets, and `yoga-layout` is not a
// dependency any more: there is nothing here to import it wrongly, and the
// lint moved to where the engine went (react-x11's `test/yoga.test.js`, which
// still pins both halves). What remains is the browser half, below, which is
// ntk's alone. See docs/packaging.md.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const libDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'lib');

function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.js')) out.push(path);
  }
  return out;
}

test('nothing in lib/ statically imports a node builtin', () => {
  // docs/packaging.md and AGENTS.md both promise this: lib/ bundles for the
  // browser, so a node builtin has to be fetched lazily through
  // `process.getBuiltinModule` behind a capability check. A static import
  // breaks the bundle at build time, a long way from whoever added it.
  //
  // Two files are sanctioned exceptions, each for one specifier in that one
  // file — anywhere else the same specifier is still an offender:
  //   node:events — drawable.js extends EventEmitter.
  //   node:module — builtin.js's createRequire is the Node < 20.16 fallback
  //     for getBuiltinModule itself, guarded on process.versions.node and
  //     never evaluated in a browser (a browser build stubs this one
  //     specifier). See lib/builtin.js.
  const ALLOW = { 'node:events': 'drawable.js', 'node:module': 'builtin.js' };
  const offenders = [];
  for (const path of sources(libDir)) {
    const rel = path.slice(libDir.length + 1);
    for (const [, mod] of readFileSync(path, 'utf8').matchAll(/from\s+['"](node:[\w/]+)['"]/g)) {
      if (ALLOW[mod] !== rel) offenders.push(`${rel}: ${mod}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "use globalThis.process?.getBuiltinModule?.('node:…') inside the function that needs it"
  );
});
