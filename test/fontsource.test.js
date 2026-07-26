// The pluggable FontSource seam — fully hermetic: uses the KaTeX .ttf files
// shipped with the katex dependency, no fontconfig / fc-match required.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import FontManager from '../lib/text/fontmanager.js';
import Font from '../lib/text/font.js';
import {
  StaticFontSource,
  defaultFontSource,
  setDefaultFontSource
} from '../lib/text/fontsource.js';

const require = createRequire(import.meta.url);
const fontDir = join(dirname(require.resolve('katex/package.json')), 'dist', 'fonts');
const bytes = (file) => readFileSync(join(fontDir, file));

function staticSource() {
  const source = new StaticFontSource();
  source.add(bytes('KaTeX_Main-Regular.ttf'), { family: 'Test Main' });
  source.add(bytes('KaTeX_Main-Bold.ttf'), { family: 'Test Main' });
  source.add(bytes('KaTeX_Main-Italic.ttf'), { family: 'Test Main' });
  source.add(bytes('KaTeX_AMS-Regular.ttf'), { family: 'Test AMS' });
  source.alias('sans-serif', 'Test Main');
  return source;
}

test('StaticFontSource matches family, weight and style', () => {
  const fm = new FontManager({ source: staticSource() });
  assert.equal(fm.match('Test Main').postscriptName, 'KaTeX_Main-Regular');
  assert.equal(fm.match('Test Main', { weight: 'bold' }).postscriptName, 'KaTeX_Main-Bold');
  assert.equal(fm.match('Test Main', { weight: 600 }).postscriptName, 'KaTeX_Main-Bold');
  assert.equal(fm.match('Test Main', { style: 'italic' }).postscriptName, 'KaTeX_Main-Italic');
  // aliases resolve generic families; family lists pick the first match
  assert.equal(fm.match('sans-serif').postscriptName, 'KaTeX_Main-Regular');
  assert.equal(fm.match('"Test AMS", sans-serif').postscriptName, 'KaTeX_AMS-Regular');
  // unknown families still resolve to something (fontconfig semantics)
  assert.ok(fm.match('No Such Family'));
});

test('per-codepoint fallback works through a StaticFontSource', () => {
  const fm = new FontManager({ source: staticSource() });
  // U+2136 (bet symbol) exists only in the AMS face
  assert.equal(fm.match('sans-serif').hasGlyph(0x2136), false);
  const fallback = fm.fallbackFor(0x2136, 'sans-serif');
  assert.equal(fallback.postscriptName, 'KaTeX_AMS-Regular');
  // and the shaping pipeline splits runs accordingly
  const shaped = fm.shape('aℶ', { family: 'sans-serif', size: 16 });
  assert.deepEqual(
    shaped.runs.map((r) => r.font.postscriptName),
    ['KaTeX_Main-Regular', 'KaTeX_AMS-Regular']
  );
  // nothing covers U+10FFFF
  assert.equal(fm.fallbackFor(0x10ffff, 'sans-serif'), null);
});

test('layout runs end-to-end without fontconfig', () => {
  const fm = new FontManager({ source: staticSource() });
  const layout = fm.layout('Hello world wrap here', { family: 'sans-serif', size: 16 }, { maxWidth: 60 });
  assert.ok(layout.lines.length > 1);
  assert.ok(layout.lines.every((l) => l.width <= 60 + 1e-6));
});

test('FontManager.load accepts font bytes', () => {
  const fm = new FontManager({ source: staticSource() });
  const font = fm.load(bytes('KaTeX_Fraktur-Regular.ttf'), { family: 'Frak' });
  assert.ok(font instanceof Font);
  // registered fonts win over source matching
  assert.equal(fm.match('Frak'), font);
});

test('a plain-object source with data candidates satisfies the contract', () => {
  const data = bytes('KaTeX_Main-Regular.ttf');
  let calls = 0;
  const fm = new FontManager({
    source: {
      matchSorted() {
        calls++;
        return [{ key: 'only', data }];
      }
    }
  });
  const font = fm.match('anything');
  assert.equal(font.postscriptName, 'KaTeX_Main-Regular');
  // no covers() implemented: fallback opens candidates and checks glyphs
  assert.equal(fm.fallbackFor(0x2135, 'anything'), font);
  fm.match('anything else', { weight: 'bold' });
  assert.ok(calls >= 2);
});

test('setDefaultFontSource affects managers without an explicit source', () => {
  const original = defaultFontSource();
  try {
    const source = staticSource();
    setDefaultFontSource(source);
    const fm = new FontManager();
    assert.equal(fm.source, source);
    assert.equal(fm.match('sans-serif').postscriptName, 'KaTeX_Main-Regular');
  } finally {
    setDefaultFontSource(original);
  }
});
