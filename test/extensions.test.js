// The compositor extension seam: app.composite() / damage() / xfixes() /
// shape(), alongside the app.xinput() they are shaped after. Each answers
// with node-x11's extension object, or `null` where the server has none, and
// asks the server once per connection.
//
// Hermetic — the answers come from a stub `X.require`, because what is under
// test is the mapping and the cache rather than any one server's extension
// list. That the list really is the server's is extensions-live.test.js.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import App from '../lib/app.js';

/**
 * accessor -> the name node-x11 loads the extension module by. Only `xfixes`
 * differs from its accessor, and it is the reason this table exists: node-x11
 * calls the module `fixes`, everyone else calls the extension XFIXES.
 */
const ACCESSORS = [
  ['composite', 'composite'],
  ['damage', 'damage'],
  ['xfixes', 'fixes'],
  ['shape', 'shape'],
  ['xinput', 'xinput']
];

/**
 * An App on a client whose extensions are exactly `present`, recording what
 * it was asked for. Replies land a tick later, as a real server's do.
 */
function makeApp(present = []) {
  const asked = [];
  const X = {
    atoms: {},
    on() {},
    require(name, cb) {
      asked.push(name);
      setImmediate(() =>
        present.includes(name)
          ? cb(null, { module: name, majorOpcode: 130 })
          : cb(new Error('extension not available'))
      );
    }
  };
  return { app: new App({ client: X, screen: [{ root: 1 }] }, {}), asked };
}

test('each accessor asks for the extension module it stands for', async () => {
  for (const [accessor, module] of ACCESSORS) {
    const { app, asked } = makeApp([module]);
    const ext = await app[accessor]();
    assert.deepEqual(asked, [module], `${accessor}() asks node-x11 for '${module}'`);
    assert.equal(ext.module, module, 'and hands back what node-x11 built');
  }
});

test('an extension the server lacks resolves null rather than rejecting', async () => {
  const { app } = makeApp([]);
  for (const [accessor] of ACCESSORS) {
    assert.equal(await app[accessor](), null, `${accessor}() on a server without it`);
  }
});

test('a compositor asks four questions and gets one no', async () => {
  // XQuartz, as measured: DAMAGE, XFIXES and SHAPE but no Composite at all.
  // The interesting answer is the absent one — it is what tells a caller to
  // stop before redirecting anything.
  const { app } = makeApp(['damage', 'fixes', 'shape']);
  const [composite, damage, fixes, shape] = await Promise.all([
    app.composite(),
    app.damage(),
    app.xfixes(),
    app.shape()
  ]);
  assert.equal(composite, null, 'no Composite');
  assert.ok(damage && fixes && shape, 'the other three are there');
});

test('the answer is asked for once per connection, absent included', async () => {
  // node-x11 caches the extension object it built but not a failed query, so
  // without this cache a server missing the extension would be re-asked on
  // every call — and "is it missing?" is exactly what gets asked repeatedly.
  const { app, asked } = makeApp([]);
  assert.equal(await app.composite(), null);
  assert.equal(await app.composite(), null);
  assert.deepEqual(asked, ['composite'], 'one QueryExtension, not two');

  const present = makeApp(['shape']);
  const first = await present.app.shape();
  assert.equal(await present.app.shape(), first, 'the same object comes back');
  assert.deepEqual(present.asked, ['shape']);
});

test('concurrent callers share the query in flight', async () => {
  const { app, asked } = makeApp(['damage']);
  const [a, b] = await Promise.all([app.damage(), app.damage()]);
  assert.equal(a, b);
  assert.deepEqual(asked, ['damage'], 'the second caller waited on the first');
});

test('app.fixes() is the throwing spelling of xfixes(), on the same cache', async () => {
  // Two public names, one question: regions go through `fixes()`, which
  // rejects where XFIXES is absent, while `xfixes()` answers `null`. They
  // must ride one QueryExtension, not one each.
  const withIt = makeApp(['fixes']);
  const [viaFixes, viaXfixes] = await Promise.all([withIt.app.fixes(), withIt.app.xfixes()]);
  assert.equal(viaFixes, viaXfixes, 'the same extension object comes back');
  assert.deepEqual(withIt.asked, ['fixes'], 'one query serves both names');

  const without = makeApp([]);
  await assert.rejects(without.app.fixes(), { code: 'ERR_NTK_NO_XFIXES' });
  assert.equal(await without.app.xfixes(), null);
  assert.deepEqual(without.asked, ['fixes'], 'the absent answer is shared too');
});

test('the cache belongs to the connection, not the process', async () => {
  const one = makeApp(['composite']);
  const two = makeApp([]);
  assert.ok(await one.app.composite(), 'a server with Composite');
  assert.equal(await two.app.composite(), null, 'a second connection, asked for itself');
  assert.deepEqual(two.asked, ['composite']);
});
