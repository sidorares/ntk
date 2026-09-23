// The subpath exports: pieces of ntk a renderer that is not drawing through
// X11 can use without loading the X11 client, the font engine or the SVG
// parser the package root brings. react-x11's Cocoa, Windows and Wayland
// backends need a colour parser and the shadow arithmetic at startup and
// nothing else of ntk's, and the root was two hundred milliseconds of
// module loading on Windows before their first window.
//
// Each subpath is imported in a process of its own, under a loader hook
// that records every module loaded — ES and CommonJS alike, since fontkit
// arrives as the one and x11 as the other — so what it loaded is what it
// alone asked for.
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The packages under node_modules a fresh process loaded importing
 *  `specifier`. */
function packagesLoadedBy(specifier) {
  const dir = mkdtempSync(join(tmpdir(), 'ntk-subpaths-'));
  try {
    const out = join(dir, 'loaded.txt');
    writeFileSync(
      join(dir, 'hooks.mjs'),
      `import { appendFileSync } from 'node:fs';
export async function load(url, context, next) {
  appendFileSync(${JSON.stringify(out)}, url + '\\n');
  return next(url, context);
}
`
    );
    writeFileSync(
      join(dir, 'register.mjs'),
      `import { register } from 'node:module';
register(${JSON.stringify(pathToFileURL(join(dir, 'hooks.mjs')).href)});
`
    );
    writeFileSync(out, '');
    execFileSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(join(dir, 'register.mjs')).href,
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(specifier)});`
      ],
      { cwd: new URL('..', import.meta.url) }
    );
    const seen = new Set();
    for (const url of readFileSync(out, 'utf8').split('\n')) {
      const m = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(url);
      if (m) seen.add(m[1]);
    }
    return seen;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HEAVY = ['x11', 'fontkit', 'htmlparser2'];

for (const [specifier, allowed] of [
  ['ntk/color', []],
  ['ntk/imagedata', []],
  ['ntk/path', []],
  ['ntk/gl', []],
  ['ntk/shadow-math', []],
  ['ntk/image', []],
  // the SVG parser is what this one is for
  ['ntk/svg', ['htmlparser2']]
]) {
  test(`${specifier} loads none of the X11 client, the font engine and the SVG parser it does not need`, () => {
    const loaded = packagesLoadedBy(specifier);
    for (const name of HEAVY) {
      if (allowed.includes(name)) continue;
      assert.ok(!loaded.has(name), `${specifier} loaded ${name}`);
    }
  });
}

test('the root still loads all of them', () => {
  const loaded = packagesLoadedBy('ntk');
  for (const name of HEAVY) assert.ok(loaded.has(name), `ntk loaded ${name}`);
});

test('a subpath hands back the same functions as the root', async () => {
  // one module instance either way: an application that imports from both
  // must not get two copies of anything with state behind it
  const root = await import('ntk');
  const pairs = [
    ['ntk/color', ['cssColor', 'cssColorStraight', 'premultiply']],
    ['ntk/imagedata', ['ImageData', 'pixelLayout', 'toStraightRgba', 'fromStraightRgba']],
    ['ntk/path', ['Path2D', 'parseSvgPath']],
    ['ntk/gl', ['GLError', 'GL_MODES', 'DEFAULT_GL_POLICY']],
    [
      'ntk/shadow-math',
      ['DEFAULT_SHADOW_POLICY', 'shadowSigma', 'shadowReach', 'gaussianKernel1d', 'blurScale']
    ],
    ['ntk/image', ['Image', 'decodeImage', 'loadImage']]
  ];
  for (const [specifier, names] of pairs) {
    const sub = await import(specifier);
    for (const name of names) {
      assert.ok(root[name] !== undefined, `the root exports ${name}`);
      assert.strictEqual(sub[name], root[name], `${specifier} ${name}`);
    }
  }
  assert.strictEqual((await import('ntk/svg')).default, root.SvgView);
  assert.strictEqual((await import('ntk/font')).default, root.Font);
});

test('shadow.js still exports the arithmetic it moved out', async () => {
  const shadow = await import('../lib/shadow.js');
  const math = await import('ntk/shadow-math');
  for (const name of [
    'DEFAULT_SHADOW_POLICY',
    'shadowPolicyOf',
    'shadowSigma',
    'shadowReach',
    'gaussianKernel1d',
    'blurScale'
  ]) {
    assert.strictEqual(shadow[name], math[name], name);
  }
});
