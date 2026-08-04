// ntk must stay bundleable as CommonJS.
//
// Node's single-executable format runs its embedded main as CommonJS, and
// esbuild refuses to emit CommonJS for a module graph containing top-level
// await ("Top-level await is currently not supported with the cjs output
// format"). One import can take that away from every ntk app: `yoga-layout`'s
// default entry is `const Yoga = wrapAssembly(await loadYoga())`. lib/yoga.js
// exists to keep it out of the graph — see docs/packaging.md.
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

test('nothing in lib/ imports the top-level-await yoga entry', () => {
  const offenders = sources(libDir)
    .filter((path) => /from\s+['"]yoga-layout['"]|import\(['"]yoga-layout['"]\)/.test(readFileSync(path, 'utf8')))
    .map((path) => path.slice(libDir.length + 1));
  assert.deepEqual(
    offenders,
    [],
    `import from 'yoga-layout/load' instead — the default entry is a top-level await, ` +
      `which makes every bundle containing ntk ESM-only`
  );
});

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

test('importing ntk does not load the layout WebAssembly', async () => {
  // startup cost aside, this is what keeps the graph free of top-level await:
  // the assembly is fetched by createClient(), not by module evaluation
  const { layoutLoaded } = await import('../lib/index.js');
  assert.equal(layoutLoaded(), false);
});
