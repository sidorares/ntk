import assert from 'node:assert/strict';
import { test } from 'node:test';

import { tokenize } from '../lib/widgets/highlight.js';

const rejoin = (tokens) => tokens.map((t) => t.text).join('');
const kindsOf = (tokens, kind) => tokens.filter((t) => t.kind === kind).map((t) => t.text);

test('tokens always concatenate back to the input', () => {
  const samples = [
    ['js', 'const x = "a\\"b" + `t${y}` // done\n/* block */ 0x1f'],
    ['python', 'def f(x):\n  # comment\n  return "s" if x else None'],
    ['html', '<div class="a"><!-- c --></div> text & <b>'],
    ['nosuchlang', 'anything at all'],
    ['sql', "SELECT * FROM t WHERE a = 'x' -- trailing"],
    ['json', '{"a": [1, 2.5, true, null], "b": "x"}']
  ];
  for (const [lang, code] of samples) {
    assert.equal(rejoin(tokenize(code, lang)), code, lang);
  }
});

test('javascript: keywords, strings, numbers, comments, literals', () => {
  const toks = tokenize('const n = 42; // count\nlet s = "hi";\nif (n === null) return true;', 'js');
  assert.deepEqual(kindsOf(toks, 'keyword'), ['const', 'let', 'if', 'return']);
  assert.deepEqual(kindsOf(toks, 'number'), ['42']);
  assert.deepEqual(kindsOf(toks, 'string'), ['"hi"']);
  assert.deepEqual(kindsOf(toks, 'comment'), ['// count']);
  assert.deepEqual(kindsOf(toks, 'literal'), ['null', 'true']);
});

test('ts is an alias of typescript', () => {
  const toks = tokenize('interface A { x: number }', 'ts');
  assert.ok(kindsOf(toks, 'keyword').includes('interface'));
});

test('function names get their own kind', () => {
  const toks = tokenize('function greet(name) { return name; }', 'js');
  assert.ok(kindsOf(toks, 'function').includes('greet'), JSON.stringify(toks));
});

test('block comments span lines', () => {
  const toks = tokenize('before /* one\ntwo */ after', 'c');
  assert.deepEqual(kindsOf(toks, 'comment'), ['/* one\ntwo */']);
});

test('python: strings, comments and literals', () => {
  const toks = tokenize('x = "text"  # note\ny = None', 'py');
  assert.ok(kindsOf(toks, 'string').includes('"text"'));
  assert.deepEqual(kindsOf(toks, 'comment'), ['# note']);
  assert.deepEqual(kindsOf(toks, 'literal'), ['None']);
});

test('shell: # comments but not inside strings', () => {
  const toks = tokenize('echo "a # b" # real comment', 'bash');
  assert.ok(kindsOf(toks, 'string').some((s) => s.includes('a # b')));
  assert.deepEqual(kindsOf(toks, 'comment'), ['# real comment']);
});

test('sql keywords are recognized', () => {
  const toks = tokenize('SELECT id FROM users', 'sql');
  const kw = kindsOf(toks, 'keyword');
  assert.ok(kw.includes('SELECT') && kw.includes('FROM'), JSON.stringify(kw));
});

test('html: tags, attributes, values, comments', () => {
  const toks = tokenize('<a href="x" disabled>text</a><!-- hi -->', 'html');
  const tagText = kindsOf(toks, 'tag').join('');
  assert.ok(tagText.includes('<a') && tagText.includes('</a>'), tagText);
  assert.deepEqual(kindsOf(toks, 'attr'), ['href', 'disabled']);
  assert.deepEqual(kindsOf(toks, 'string'), ['"x"']);
  assert.deepEqual(kindsOf(toks, 'comment'), ['<!-- hi -->']);
});

test('escaped entities in code round-trip', () => {
  const code = 'if (a < b && c > "d") { }';
  assert.equal(rejoin(tokenize(code, 'js')), code);
});

test('unknown or empty language falls back to a single plain token', () => {
  assert.deepEqual(tokenize('hello world', 'whatever'), [{ text: 'hello world', kind: 'plain' }]);
  assert.deepEqual(tokenize('hello', ''), [{ text: 'hello', kind: 'plain' }]);
  assert.deepEqual(tokenize('', 'js'), []);
});

test('identifiers containing keyword substrings stay plain', () => {
  const toks = tokenize('iffy_return = classical', 'js');
  assert.deepEqual(kindsOf(toks, 'keyword'), []);
});
