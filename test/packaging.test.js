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

test('importing ntk does not load the layout WebAssembly', async () => {
  // startup cost aside, this is what keeps the graph free of top-level await:
  // the assembly is fetched by createClient(), not by module evaluation
  const { layoutLoaded } = await import('../lib/index.js');
  assert.equal(layoutLoaded(), false);
});
