// Makes lib/vendor/fontkit.js, the build of fontkit ntk runs.
//
// ntk runs the windowkit fork of fontkit (https://github.com/windowkit/fontkit),
// which carries fixes fontkit has not released, and the fork is not on npm.
// A published library cannot depend on it by its release's URL or by a git
// ref: npm 12 fetches neither for a dependency of a dependency (AGENTS.md).
// So ntk carries the fork's build itself, and depends on what that build
// imports, which is all on npm.
//
//   node scripts/vendor-fontkit.mjs v2.0.4-windowkit.2
//     from the fork's GitHub release of that tag
//   node scripts/vendor-fontkit.mjs path/to/fontkit-2.0.4-windowkit.2.tgz
//     from an `npm pack` of the fork, to try a change before it is released
//   node scripts/vendor-fontkit.mjs --check
//     makes the file again from the release its header names, and fails if
//     it differs from the one in lib/ or the dependencies are not package.json's
//
// The file is the tarball's dist/browser-module.mjs, without its source map
// comment, under a header naming where it came from: the build without
// `open`/`openSync`, whose `import fs` lib/ may not have (AGENTS.md).
// The script also sets package.json's dependencies to the tarball's; run
// `npm install` afterwards for the lockfile.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const REPO = 'windowkit/fontkit';
const BUILD = 'dist/browser-module.mjs';
const root = new URL('../', import.meta.url);
const target = new URL('lib/vendor/fontkit.js', root);
const pkgFile = new URL('package.json', root);

const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const releaseUrl = (tag) =>
  `https://github.com/${REPO}/releases/download/${tag}/fontkit-${tag.replace(/^v/, '')}.tgz`;

/** The files of a gzipped tarball, by path. */
function untar(tgz) {
  const tar = gunzipSync(tgz);
  const files = new Map();
  const field = (block, start, length) =>
    block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    const name = field(header, 0, 100);
    if (!name) break;
    const size = parseInt(field(header, 124, 12).trim() || '0', 8);
    const prefix = field(header, 345, 155);
    const type = String.fromCharCode(header[156]);
    if (type === '0' || type === '\0') {
      files.set(prefix ? `${prefix}/${name}` : name, tar.subarray(at + 512, at + 512 + size));
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** The package a bare specifier names: `brotli/decompress.js` -> `brotli`. */
function packageOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Every specifier a module statically imports. */
function importsOf(source) {
  return [...source.matchAll(/^import\s[^'"]*?from\s*["']([^"']+)["'];?$/gm)].map((m) => m[1]);
}

/** lib/vendor/fontkit.js and the dependencies it needs, from a tarball. */
function vendor(tgz, source) {
  const files = untar(tgz);
  const manifest = JSON.parse(files.get('package/package.json').toString('utf8'));
  const build = files.get(`package/${BUILD}`);
  if (!build) throw new Error(`${source} has no ${BUILD}`);
  const body = build.toString('utf8').replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n');
  const dependencies = manifest.dependencies ?? {};
  for (const specifier of importsOf(body)) {
    if (!(packageOf(specifier) in dependencies)) {
      throw new Error(`${BUILD} imports ${specifier}, which ${source}'s package.json does not depend on`);
    }
  }
  const sha256 = createHash('sha256').update(tgz).digest('hex');
  const comment = (text) => text.split('\n').map((line) => `//${line && ' '}${line}`).join('\n');
  const header = comment(`fontkit ${manifest.version}: the windowkit fork's ${BUILD}, from
${source}
sha256 ${sha256}

Made by scripts/vendor-fontkit.mjs; do not edit. Why ntk carries fontkit
rather than depending on it: AGENTS.md, "The fontkit fork".

fontkit is by Devon Govett and its contributors, under the MIT License:

${MIT}`);
  return { text: `${header}\n\n${body}`, dependencies, version: manifest.version };
}

/** package.json with fontkit's dependencies where fontkit was. */
function withDependencies(pkg, dependencies) {
  const deps = { ...pkg.dependencies };
  delete deps.fontkit;
  Object.assign(deps, dependencies);
  const sorted = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { ...pkg, dependencies: sorted };
}

async function fetchTarball(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

const arg = process.argv[2];
if (!arg) {
  console.error('usage: node scripts/vendor-fontkit.mjs <v…-windowkit.N | fontkit-….tgz | --check>');
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));

if (arg === '--check') {
  const current = readFileSync(target, 'utf8');
  const url = /^\/\/ (https:\/\/github\.com\/\S+\.tgz)$/m.exec(current)?.[1];
  if (!url) {
    console.error(
      `${target.pathname} was made from a local tarball, not a release of ${REPO}: ` +
        'release the fork and run this script with the tag'
    );
    process.exit(1);
  }
  const { text, dependencies } = vendor(await fetchTarball(url), url);
  const problems = [];
  if (text !== current) problems.push(`lib/vendor/fontkit.js is not what ${url} makes`);
  for (const [name, range] of Object.entries(dependencies)) {
    if (pkg.dependencies?.[name] !== range) {
      problems.push(`package.json depends on ${name} ${pkg.dependencies?.[name] ?? '(nothing)'}, the build on ${range}`);
    }
  }
  if (pkg.dependencies?.fontkit) problems.push('package.json still depends on fontkit from npm');
  if (problems.length) {
    console.error(problems.join('\n') + '\nrun: node scripts/vendor-fontkit.mjs <tag>, then npm install');
    process.exit(1);
  }
  console.log(`lib/vendor/fontkit.js is ${url}`);
} else {
  const local = arg.endsWith('.tgz');
  const source = local ? `a local pack, ${arg.split('/').pop()}` : releaseUrl(arg);
  const tgz = local ? readFileSync(arg) : await fetchTarball(source);
  const { text, dependencies, version } = vendor(tgz, source);
  writeFileSync(target, text);
  const before = pkg.dependencies ?? {};
  const next = withDependencies(pkg, dependencies);
  writeFileSync(pkgFile, JSON.stringify(next, null, 2) + '\n');
  console.log(`lib/vendor/fontkit.js: fontkit ${version} from ${source}`);
  for (const [name, range] of Object.entries(dependencies)) {
    if (before[name] !== range) console.log(`  package.json: ${name} ${before[name] ?? '(new)'} -> ${range}`);
  }
  if (before.fontkit) console.log('  package.json: fontkit dropped');
  console.log('now: npm install');
}
