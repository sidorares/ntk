// lib/vendor/fontkit.js, the windowkit fork's build of fontkit that ntk
// carries (scripts/vendor-fontkit.mjs): what it imports is not ntk's code,
// and nothing installs it for an application unless package.json says so.
// A vendored file whose imports drift from the dependencies breaks only
// where the missing package is not hoisted in from somewhere else, which is
// to say not here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const vendored = readFileSync(new URL('lib/vendor/fontkit.js', root), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

const packageOf = (specifier) =>
  specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');

test('every package the vendored fontkit imports is a dependency', () => {
  const imports = [...vendored.matchAll(/^import\s[^'"]*?from\s*["']([^"']+)["'];?$/gm)].map((m) => m[1]);
  assert.ok(imports.includes('restructure'), 'the imports were found at all');
  const missing = imports.map(packageOf).filter((name) => !pkg.dependencies[name]);
  assert.deepEqual(missing, [], 'run scripts/vendor-fontkit.mjs, which sets them, then npm install');
});

test('fontkit is not also a dependency from npm', () => {
  // a second fontkit, which nothing imports, in every application's install
  assert.equal(pkg.dependencies.fontkit, undefined);
});

test('the vendored fontkit names where it came from', () => {
  // --check makes the file again from the release this names
  assert.match(vendored, /^\/\/ fontkit \S+-windowkit\.\d+: /);
  assert.match(vendored, /^\/\/ sha256 [0-9a-f]{64}$/m);
});
