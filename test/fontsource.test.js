// The pluggable FontSource seam — fully hermetic: uses the KaTeX .ttf files
// shipped with the katex dependency, no fontconfig / fc-match required.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import FontManager from '../lib/text/fontmanager.js';
import Font from '../lib/text/font.js';
import { TextLayout } from '../lib/text/layout.js';
import {
  FontconfigFontSource,
  StaticFontSource,
  createFontSource,
  defaultFontSource,
  setDefaultFontSource
} from '../lib/text/fontsource.js';

const require = createRequire(import.meta.url);
const fontDir = join(dirname(require.resolve('katex/package.json')), 'dist', 'fonts');
const bytes = (file) => readFileSync(join(fontDir, file));

/** a directory of faces, the way an app ships its own fonts */
function fontsDir(files = ['KaTeX_SansSerif-Regular.ttf', 'KaTeX_Typewriter-Regular.ttf']) {
  const dir = mkdtempSync(join(tmpdir(), 'ntk-fonts-'));
  for (const file of files) copyFileSync(join(fontDir, file), join(dir, file));
  return dir;
}

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

// CSS Fonts 4 §5.2 looks for a weight in a direction first: for 400 to 500,
// up to 500, then lighter, then heavier; below 400 lighter first; above 500
// heavier first. The fontconfig source picks that face (test/fontconfig.test.js),
// so a family handed over as files has to as well — `fontSource: '/app/fonts'`
// took the face nearest in weight, and set 520 in the regular where the same
// family found through fontconfig was set in the bold.

test('a weight between two faces is the one CSS looks at first, not the nearest', () => {
  const fm = new FontManager({
    source: fontsDir(['KaTeX_Main-Regular.ttf', 'KaTeX_Main-Bold.ttf'])
  });
  const face = (weight) => fm.match('KaTeX_Main', { weight }).postscriptName;
  // 400 to 500 look up to 500 first, and then lighter
  assert.equal(face(450), 'KaTeX_Main-Regular');
  assert.equal(face(500), 'KaTeX_Main-Regular');
  // above 500, heavier first: 520 is 120 from the regular and 180 from the bold
  assert.equal(face(520), 'KaTeX_Main-Bold');
  assert.equal(face(550), 'KaTeX_Main-Bold');
  // below 400, lighter first, and with none lighter the nearest heavier
  assert.equal(face(300), 'KaTeX_Main-Regular');
  assert.equal(face(100), 'KaTeX_Main-Regular');
});

/**
 * The faces CSS Fonts 4 §5.2 picks of `faces` — font-style, then
 * font-weight — on the weights they were added with, nothing of ntk's in it.
 * More than one where they tie.
 */
function cssPicks(faces, weight, italic) {
  const styled = faces.filter((f) => f.italic === italic);
  const set = styled.length > 0 ? styled : faces;
  // a face's place in the order CSS looks in, lowest first
  const place = ({ weight: x }) => {
    if (x === weight) return 0;
    if (weight >= 400 && weight <= 500) {
      if (x > weight && x <= 500) return x - weight;
      return x < weight ? 1000 + weight - x : 2000 + x - weight;
    }
    if (weight < 400) return x < weight ? weight - x : 1000 + x - weight;
    return x > weight ? x - weight : 1000 + weight - x;
  };
  const first = Math.min(...set.map(place));
  return set.filter((f) => place(f) === first);
}

test('every weight in families shaped like real ones is the face CSS picks', () => {
  // the shapes test/fontconfig.test.js gives the fontconfig source: Arial,
  // Helvetica, Helvetica Neue's uprights, Avenir Next with one italic, and
  // Hiragino Sans with none — all in one source, so every other family's
  // faces are there to be picked wrongly
  const families = {
    Arial: [[400], [700]],
    Helvetica: [[300], [400], [700], [300, 'italic'], [400, 'italic'], [700, 'italic']],
    'Helvetica Neue': [[100], [200], [300], [400], [500], [700]],
    'Avenir Next': [[275], [275, 'italic'], [400], [500], [600], [700], [900]],
    'Hiragino Sans': [[100], [200], [300], [400], [600]]
  };
  const source = new StaticFontSource();
  const added = new Map(); // Font -> { family, weight, italic }
  for (const [family, faces] of Object.entries(families)) {
    for (const [weight, style = 'normal'] of faces) {
      const font = source.add(bytes('KaTeX_Main-Regular.ttf'), { family, weight, style });
      added.set(font, { family, weight, italic: style === 'italic' });
    }
  }
  const label = (f) => `${f.family} ${f.weight}${f.italic ? ' italic' : ''}`;
  for (const family of Object.keys(families)) {
    const faces = [...added.values()].filter((f) => f.family === family);
    for (const italic of [false, true]) {
      for (let weight = 100; weight <= 900; weight += 10) {
        const [head] = source.matchSorted({ family, weight, style: italic ? 'italic' : 'normal' });
        const picks = cssPicks(faces, weight, italic);
        assert.ok(
          picks.includes(added.get(head.font)),
          `${family} at ${weight}${italic ? ' italic' : ''}: ${label(added.get(head.font))}, ` +
            `where CSS picks ${picks.map(label).join(' or ')}`
        );
      }
    }
  }
});

test('the rest of a family follows in the order CSS looks in, other families after it', () => {
  const source = new StaticFontSource();
  const labels = new Map();
  const add = (file, opts, label) => labels.set(source.add(bytes(file), opts), label);
  // added out of order, so the order that comes back is the ranking's
  for (const weight of [700, 300, 500, 400]) {
    add('KaTeX_Main-Regular.ttf', { family: 'Ladder', weight, style: 'normal' }, String(weight));
  }
  add('KaTeX_Main-Italic.ttf', { family: 'Ladder', weight: 450, style: 'italic' }, '450 italic');
  add('KaTeX_AMS-Regular.ttf', { family: 'Other' }, 'other');
  const chain = (weight, style = 'normal') =>
    source.matchSorted({ family: 'Ladder', weight, style }).map((c) => labels.get(c.font));

  // each of these is nearer the other way: 420 is 20 from 400, 380 is 20
  // from 400, 560 is 60 from 500
  assert.deepEqual(chain(420), ['500', '400', '300', '700', '450 italic', 'other']);
  assert.deepEqual(chain(380), ['300', '400', '500', '700', '450 italic', 'other']);
  assert.deepEqual(chain(560), ['700', '500', '400', '300', '450 italic', 'other']);
  // the style before the weight: the italic is 250 off and still first
  assert.deepEqual(chain(700, 'italic'), ['450 italic', '700', '500', '400', '300', 'other']);
  // and a family asked for after another trails it, whatever its weights
  assert.deepEqual(
    source.matchSorted({ family: 'Other, Ladder', weight: 700 }).map((c) => labels.get(c.font)),
    ['other', '700', '500', '400', '300', '450 italic']
  );
});

test('a variable face holds every weight on its axis, beside static faces', () => {
  const vfBytes = readFileSync(new URL('./fixtures/MonelogicsSubset[wght].ttf', import.meta.url));
  const source = new StaticFontSource();
  source.add(bytes('KaTeX_Main-Bold.ttf'), { family: 'Mixed' }); // 700
  source.add(vfBytes, { family: 'Mixed' }); // wght 100–900, OS/2 400
  const head = (src, weight) => src.matchSorted({ family: 'Mixed', weight })[0].font.postscriptName;
  // 600 and 900 were the bold's while the face was ranked by its OS/2 weight
  for (const weight of [100, 300, 520, 600, 900]) {
    assert.equal(head(source, weight), 'monelogics-Thin', `at ${weight}`);
  }
  // a weight both hold is a tie, and a tie goes to the face added first
  assert.equal(head(source, 700), 'KaTeX_Main-Bold');
  // and the weight asked for is set on the axis
  const fm = new FontManager({ source });
  assert.deepEqual(fm.match('Mixed', { weight: 600 }).variationCoords, { wght: 600 });

  // a weight given to add is the face's, as @font-face's descriptor is, so a
  // variable face added at 400 is one face at 400
  const pinned = new StaticFontSource();
  pinned.add(bytes('KaTeX_Main-Bold.ttf'), { family: 'Mixed' });
  pinned.add(vfBytes, { family: 'Mixed', weight: 400 });
  assert.equal(head(pinned, 450), 'monelogics-Thin');
  assert.equal(head(pinned, 600), 'KaTeX_Main-Bold');
});

test('the last match answers again as it was, and a font loaded after it is seen', () => {
  const fm = new FontManager({ source: staticSource() });
  const regular = fm.match('Test Main');
  // asked again, and again after another match: the same face each time
  assert.equal(fm.match('Test Main'), regular);
  assert.equal(fm.match('Test Main', { weight: 'bold' }).postscriptName, 'KaTeX_Main-Bold');
  assert.equal(fm.match('Test Main'), regular);
  // a weight spelled another way is the same question
  assert.equal(fm.match('Test Main', { weight: 400 }), regular);
  // a face registered for the family takes it over at once: the remembered
  // match does not outlive the cache it came from
  const loaded = fm.load(bytes('KaTeX_SansSerif-Regular.ttf'), { family: 'Test Main' });
  assert.equal(fm.match('Test Main'), loaded);
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

/**
 * A face whose cmap covers characters fontkit can make no glyph of: a
 * KaTeX face with its `glyf` table renamed out of reach. That is what a
 * bitmap-only colour emoji font (CBDT) is to fontkit — Noto Color Emoji and
 * EmojiOne as most Linux desktops ship them, and the first face fontconfig
 * answers for an emoji — and its shaper threw on the null glyph.
 */
function withoutOutlines(file) {
  const b = Buffer.from(bytes(file));
  const tables = b.readUInt16BE(4);
  for (let i = 0; i < tables; i++) {
    const at = 12 + i * 16;
    if (b.toString('latin1', at, at + 4) === 'glyf') b.write('xglf', at, 'latin1');
  }
  return b;
}

test('a face no glyph can be made from covers nothing, and is passed by', () => {
  const source = new StaticFontSource();
  source.add(bytes('KaTeX_Main-Regular.ttf'), { family: 'Test Main' });
  // ahead of the real one, so it is the first fallback a character reaches
  source.add(withoutOutlines('KaTeX_AMS-Regular.ttf'), { family: 'Test Bitmaps' });
  source.add(bytes('KaTeX_AMS-Regular.ttf'), { family: 'Test AMS' });
  source.alias('sans-serif', 'Test Main');
  const fm = new FontManager({ source });

  const bitmaps = Font.fromData(withoutOutlines('KaTeX_AMS-Regular.ttf'));
  assert.equal(bitmaps.drawable, false);
  assert.equal(bitmaps.fk.hasGlyphForCodePoint(0x2136), true, 'its cmap says it has it');
  assert.equal(bitmaps.hasGlyph(0x2136), false, 'and nothing can be drawn from it');
  assert.equal(bitmaps.glyphIdFor(0x2136), null);

  // a fallback passes it by for the face that has the glyph…
  assert.equal(fm.fallbackFor(0x2136, 'sans-serif').postscriptName, 'KaTeX_AMS-Regular');
  assert.equal(fm.fallbackFor(0x2136, 'sans-serif').drawable, true);
  // …and so the text shapes, where it threw
  const shaped = fm.shape('a \u2136 b', { family: 'sans-serif', size: 16 });
  assert.deepEqual(
    shaped.runs.map((r) => r.font.postscriptName),
    ['KaTeX_Main-Regular', 'KaTeX_AMS-Regular', 'KaTeX_Main-Regular']
  );

  // named outright, it is not handed out as a base face either
  const named = fm.match('Test Bitmaps');
  assert.equal(named.drawable, true);
  const layout = fm.layout('\u2136 x', { family: 'Test Bitmaps', size: 16 });
  assert.ok(layout.width > 0);
});

test("a face the source answers first is read past when no glyph can be made from it", () => {
  // fontconfig's source answers a face's match from the head of its answer
  // (`matchFirst`) and reads the chain only when it has to: a head nothing
  // can be drawn from is when it has to
  const source = new StaticFontSource();
  source.add(bytes('KaTeX_Main-Regular.ttf'), { family: 'Test Main' });
  source.add(withoutOutlines('KaTeX_AMS-Regular.ttf'), { family: 'Test Bitmaps' });
  source.add(bytes('KaTeX_AMS-Regular.ttf'), { family: 'Test AMS' });
  const sorted = source.matchSorted.bind(source);
  let chains = 0;
  source.matchSorted = (pattern) => (chains++, sorted(pattern));
  source.matchFirst = (pattern) => sorted(pattern)[0];
  const fm = new FontManager({ source });

  assert.equal(fm.match('Test Main').postscriptName, 'KaTeX_Main-Regular');
  assert.equal(chains, 0, 'a head that can be drawn is the answer, and no chain is read');
  const named = fm.match('Test Bitmaps');
  assert.equal(named.drawable, true, 'the best face that can be drawn, not the head');
  assert.equal(chains, 1);
  assert.ok(fm.layout('\u2136 x', { family: 'Test Bitmaps', size: 16 }).width > 0);
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

test('a letter the first family lacks is set in the next one the style names', () => {
  // `Primary, Second` sets a letter Primary has no glyph for in Second, as
  // CSS has it; the first registered face with one took it, which was a
  // family the style never named
  const fm = new FontManager({ source: { matchSorted: () => [] } });
  fm.load(bytes('KaTeX_Main-Regular.ttf'), { family: 'First' });
  fm.load(bytes('KaTeX_SansSerif-Regular.ttf'), { family: 'Second' });
  fm.load(bytes('KaTeX_Size1-Regular.ttf'), { family: 'Primary' });
  const A = 0x41;
  assert.equal(fm.match('Primary, Second').hasGlyph(A), false, 'precondition');
  assert.equal(fm.fallbackFor(A, 'Primary, Second').postscriptName, 'KaTeX_SansSerif-Regular');
  assert.equal(fm.fallbackFor(A, '"Primary", "Second"').postscriptName, 'KaTeX_SansSerif-Regular');
  // a list that names no face with the letter still finds one registered
  assert.equal(fm.fallbackFor(A, 'Primary').postscriptName, 'KaTeX_Main-Regular');
});

test('a word is shaped again for another family list after its first face', () => {
  // the shaping memo keyed a word by the face it resolved to, so the
  // fallback one list set it in answered the same word under another
  const fm = new FontManager({ source: { matchSorted: () => [] } });
  fm.load(bytes('KaTeX_Size1-Regular.ttf'), { family: 'Primary' });
  fm.load(bytes('KaTeX_SansSerif-Regular.ttf'), { family: 'Second' });
  fm.load(bytes('KaTeX_Typewriter-Regular.ttf'), { family: 'Third' });
  const faceOf = (family) =>
    new TextLayout(fm, [{ text: 'A' }], { family, size: 16 }).lines[0].runs[0].run.font.postscriptName;
  assert.equal(faceOf('Primary, Second'), 'KaTeX_SansSerif-Regular');
  assert.equal(faceOf('Primary, Third'), 'KaTeX_Typewriter-Regular');
});

test('a fallback asks the source for the pattern its match asked for', () => {
  // A source caches its lists by pattern, and a prewarm fetches the ones a
  // match will ask for. The fallback asked with the span's raw weight —
  // undefined for regular text, 'bold' for a bold span — which was another
  // pattern, and cost the first character needing a fallback an fc-match
  // of its own.
  const data = bytes('KaTeX_Main-Regular.ttf');
  const seen = [];
  const fm = new FontManager({
    source: {
      matchSorted(pattern) {
        seen.push(pattern);
        return [{ key: 'only', data }];
      }
    }
  });
  const ask = (match, fallback) => {
    seen.length = 0;
    fm.match(...match);
    fm.fallbackFor(0x2135, ...fallback);
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1], seen[0], JSON.stringify(fallback));
  };
  ask(['plain'], ['plain', {}]);
  ask(['plain two', { weight: 400 }], ['plain two', { weight: undefined, style: undefined }]);
  ask(['"Quoted", other', { weight: 700, style: 'italic' }], ['"Quoted", other', { weight: 'bold', style: 'italic' }]);
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

// ---------------------------------------------------------------------------
// Font specs — pointing ntk at the faces an app ships, which is the whole
// answer for an environment with no fontconfig (issue #121)
// ---------------------------------------------------------------------------

test('a FontSource passes through createFontSource untouched', () => {
  const source = staticSource();
  assert.equal(createFontSource(source), source);
  // duck-typed, so a plain object implementing the contract survives too
  const plain = { matchSorted: () => [] };
  assert.equal(createFontSource(plain), plain);
});

test('null and undefined pass through, so the default can still be reset', () => {
  assert.equal(createFontSource(null), null);
  assert.equal(createFontSource(undefined), undefined);
  const original = defaultFontSource();
  try {
    setDefaultFontSource(staticSource());
    setDefaultFontSource(null);
    assert.ok(defaultFontSource() instanceof FontconfigFontSource);
  } finally {
    setDefaultFontSource(original);
  }
});

test("'system' names the default out loud, without spawning anything", () => {
  assert.ok(createFontSource('system') instanceof FontconfigFontSource);
});

test('a directory of faces becomes a working source', () => {
  const dir = fontsDir();
  const fm = new FontManager({ source: dir });
  assert.equal(fm.match('sans-serif').postscriptName, 'KaTeX_SansSerif-Regular');
  assert.equal(fm.match('monospace').postscriptName, 'KaTeX_Typewriter-Regular');
});

test('directory order is sorted, not readdir order', () => {
  // the filesystem must never be what decides which face `sans-serif` gets
  const dir = fontsDir(['KaTeX_Main-Regular.ttf', 'KaTeX_AMS-Regular.ttf', 'KaTeX_Fraktur-Regular.ttf']);
  const order = () =>
    createFontSource(dir)
      .matchSorted({ family: 'nothing-matches' })
      .map((c) => c.font.postscriptName);
  assert.deepEqual(order(), order());
  assert.equal(order()[0], 'KaTeX_AMS-Regular'); // alphabetical, not copy order
});

// Issue #273: a match list is shown, not just opened — so a candidate names
// its face whichever source produced it, and a StaticFontSource answers with
// the font's own family name rather than the (lowercased, aliased) key it is
// matched by.
test('candidates carry a family name for showing a match list', () => {
  const source = new StaticFontSource();
  source.add(bytes('KaTeX_SansSerif-Regular.ttf'), { family: 'ui-sans' });
  const [best] = source.matchSorted({ family: 'ui-sans' });
  assert.equal(best.family, 'KaTeX_SansSerif');
  assert.deepEqual(best.families, ['KaTeX_SansSerif']);
});

test('subdirectories need recursive: true', () => {
  const dir = fontsDir();
  mkdirSync(join(dir, 'extra'));
  copyFileSync(join(fontDir, 'KaTeX_Fraktur-Regular.ttf'), join(dir, 'extra', 'KaTeX_Fraktur-Regular.ttf'));
  const names = (spec) => createFontSource(spec).matchSorted({}).map((c) => c.font.postscriptName);
  assert.equal(names(dir).includes('KaTeX_Fraktur-Regular'), false);
  assert.equal(names({ fonts: dir, recursive: true }).includes('KaTeX_Fraktur-Regular'), true);
});

test('font files, bytes and descriptors are all faces', () => {
  const paths = createFontSource([
    join(fontDir, 'KaTeX_Main-Regular.ttf'),
    join(fontDir, 'KaTeX_Main-Bold.ttf')
  ]);
  assert.equal(new FontManager({ source: paths }).match('KaTeX_Main', { weight: 700 }).postscriptName, 'KaTeX_Main-Bold');

  const buf = bytes('KaTeX_Main-Regular.ttf');
  for (const data of [buf, new Uint8Array(buf), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)]) {
    assert.equal(new FontManager({ source: [data] }).match('x').postscriptName, 'KaTeX_Main-Regular');
  }

  const described = new FontManager({
    source: [{ path: join(fontDir, 'KaTeX_Main-Regular.ttf'), family: 'UI', weight: 700 }]
  });
  assert.equal(described.match('UI', { weight: 'bold' }).postscriptName, 'KaTeX_Main-Regular');
});

test('generic families are inferred from the font tables, not the filename', () => {
  const source = createFontSource(fontsDir([
    'KaTeX_SansSerif-Regular.ttf',
    'KaTeX_Typewriter-Regular.ttf',
    'KaTeX_Main-Regular.ttf'
  ]));
  // KaTeX_Typewriter reports isFixedPitch = 0 and is caught by the advance
  // probe; KaTeX_SansSerif is named, and must not also win `serif` just
  // because "SansSerif" contains it
  assert.equal(source.aliases.monospace, 'katex_typewriter');
  assert.equal(source.aliases['sans-serif'], 'katex_sansserif');
  assert.equal('serif' in source.aliases, false, 'no evidence for serif, so no guess');
});

test('an explicit alias survives inference', () => {
  const source = createFontSource({ fonts: fontsDir(), alias: { serif: 'KaTeX_SansSerif' } });
  assert.equal(source.aliases.serif, 'katex_sansserif');
  assert.equal(source.aliases.monospace, 'katex_typewriter'); // still inferred
});

test('a hand-built source is unchanged unless it asks for inference', () => {
  const source = new StaticFontSource();
  source.add(bytes('KaTeX_Typewriter-Regular.ttf'));
  assert.deepEqual(source.aliases, {});
  source.inferGenerics();
  assert.equal(source.aliases.monospace, 'katex_typewriter');
});

test('one unparseable file does not take the directory down', () => {
  const dir = fontsDir();
  writeFileSync(join(dir, 'broken.ttf'), 'not a font');
  const source = createFontSource(dir);
  assert.equal(source.skipped.length, 1);
  assert.match(source.skipped[0].file, /broken\.ttf$/);
  assert.equal(new FontManager({ source }).match('monospace').postscriptName, 'KaTeX_Typewriter-Regular');
});

test('a spec mistake is reported as a spec mistake', () => {
  const dir = fontsDir();
  // the issue proposes `fonts: 'bundled'`; ntk ships none, so rather than
  // name a value that could only ever throw, say what is accepted
  assert.throws(() => createFontSource('bundled'), /not a font source|no such font file/);
  assert.throws(() => createFontSource('bundled'), /ntk ships no fonts of its own/);
  for (const bad of [42, {}, [], true]) {
    assert.throws(() => createFontSource(bad), /is not a font source/);
  }
  assert.throws(() => createFontSource('/no/such/dir'), /no such font file or directory/);
  assert.throws(() => createFontSource(mkdtempSync(join(tmpdir(), 'ntk-empty-'))), /no font files in/);
  assert.throws(() => createFontSource({ fonts: dir, maxFiles: 1 }), /maxFiles/);
  // none of these are ERR_NTK_NO_FONTS: the environment is fine, the call is wrong
  assert.throws(() => createFontSource(42), (err) => err.code !== 'ERR_NTK_NO_FONTS');
});

// A caller that can await (a font picker matching as the user types) asks
// the source instead of blocking. It must not have to know which source it
// is holding, so the one with nothing to await implements it too — and its
// failures arrive as rejections, not synchronous throws.
test('StaticFontSource.matchSortedAsync mirrors the sync match', async () => {
  const source = staticSource();
  const sync = source.matchSorted({ family: 'Test AMS' });
  const async_ = await source.matchSortedAsync({ family: 'Test AMS' });
  assert.deepEqual(async_, sync);
  assert.equal(async_[0].font.postscriptName, 'KaTeX_AMS-Regular');

  await assert.rejects(
    new StaticFontSource().matchSortedAsync({}),
    (err) => err.code === 'ERR_NTK_NO_FONTS'
  );
});

test('an empty source reports having no fonts, with the shared code', () => {
  assert.throws(
    () => new StaticFontSource().matchSorted({}),
    (err) => err.code === 'ERR_NTK_NO_FONTS'
  );
});

test('no system fonts degrades to .notdef instead of crashing mid-shape', () => {
  // the environment this issue is about: an app that loaded its own faces
  // still reaches the source for the first codepoint they lack
  const empty = {
    matchSorted() {
      const err = new Error('nothing here');
      err.code = 'ERR_NTK_NO_FONTS';
      throw err;
    }
  };
  const fm = new FontManager({ source: empty });
  fm.load(bytes('KaTeX_Main-Regular.ttf'), { family: 'ui' });
  assert.equal(fm.fallbackFor(0x2136, 'ui'), null);
  const shaped = fm.shape('aℶ', { family: 'ui', size: 16 });
  assert.deepEqual(shaped.runs.map((r) => r.font.postscriptName), ['KaTeX_Main-Regular']);

  // a source that failed for any other reason is a bug, and still surfaces
  const broken = new FontManager({
    source: {
      matchSorted() {
        throw new Error('my source is broken');
      }
    }
  });
  broken.load(bytes('KaTeX_Main-Regular.ttf'), { family: 'ui' });
  assert.throws(() => broken.fallbackFor(0x2136, 'ui'), /my source is broken/);
});

test("match takes a source's best face alone where it can answer one", () => {
  // the fallback chain behind a face is read when a character first falls
  // back, so a match that only needs the face asks for it alone
  const file = join(fontDir, 'KaTeX_Main-Regular.ttf');
  const asked = [];
  const source = {
    matchFirst: (pattern) => {
      asked.push(['first', pattern.family]);
      return { path: file, postscriptName: 'KaTeX_Main-Regular' };
    },
    matchSorted: (pattern) => {
      asked.push(['sorted', pattern.family]);
      return [{ path: file, postscriptName: 'KaTeX_Main-Regular' }];
    }
  };
  const fonts = new FontManager({ source });
  const face = fonts.match('Test Main');
  assert.ok(face, 'a face');
  assert.deepEqual(asked, [['first', 'Test Main']]);
  // a source without it is asked for the chain, as it always was
  const plain = { matchSorted: source.matchSorted };
  asked.length = 0;
  new FontManager({ source: plain }).match('Test Main');
  assert.deepEqual(asked, [['sorted', 'Test Main']]);
});

test('prewarm is handed to the source, and a source with nothing to look up ignores it', () => {
  const asked = [];
  const source = { matchSorted: () => [], prewarm: (family) => asked.push(family) };
  new FontManager({ source }).prewarm('monospace');
  assert.deepEqual(asked, ['monospace']);
  // fonts in memory: nothing to warm, and nothing thrown
  new FontManager({ source: staticSource() }).prewarm('monospace');
});

test('prewarm asks for the patterns a layout will: the family and faces spelled as match spells them', () => {
  const warmed = [];
  const matched = [];
  const source = {
    matchSorted: (pattern) => {
      matched.push(pattern);
      throw new Error('stop at the ask');
    },
    prewarm: (family, faces) => warmed.push({ family, faces })
  };
  const fonts = new FontManager({ source });
  fonts.prewarm(' "JetBrains Mono", monospace');
  fonts.prewarm('sans-serif', [{ weight: 500 }, { weight: 'bold', style: 'italic' }]);
  assert.throws(() => fonts.match(' "JetBrains Mono", monospace'), /stop at the ask/);
  assert.throws(() => fonts.match('sans-serif', { weight: 500 }), /stop at the ask/);
  assert.throws(() => fonts.match('sans-serif', { weight: 'bold', style: 'italic' }), /stop at the ask/);
  assert.equal(warmed[0].family, matched[0].family);
  assert.equal(warmed[0].faces, undefined, 'no faces named: the source warms its four');
  const [, medium, boldItalic] = matched;
  assert.deepEqual(warmed[1], {
    family: medium.family,
    faces: [
      { weight: medium.weight, style: medium.style },
      { weight: boldItalic.weight, style: boldItalic.style }
    ]
  });
  // a family that names nothing warms nothing
  fonts.prewarm(' , ');
  assert.equal(warmed.length, 2);
});
