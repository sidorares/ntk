// The extension seam against a real X server: what ntk answers has to be what
// the server itself says, both ways round.
//
// Both directions matter, and neither can be checked hermetically. A server
// without the extension must yield `null` — XQuartz has DAMAGE, XFIXES and
// SHAPE but no Composite, so a compositor's first question there is answered
// by absence. A server *with* it must yield the object: a module name that
// reached node-x11 misspelled would come back `null` too, and from inside
// ntk the two look identical.
//
// Skipped where there is no DISPLAY.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createClient } from '../lib/index.js';
import { withTimeout } from './helpers/async.js';

/**
 * accessor -> the name QueryExtension answers to, and requests the extension
 * object is worthless without (the ones a compositor reaches for first).
 */
const EXTENSIONS = [
  ['composite', 'Composite', ['RedirectSubwindows', 'NameWindowPixmap', 'GetOverlayWindow']],
  ['damage', 'DAMAGE', ['Create', 'Subtract']],
  ['xfixes', 'XFIXES', ['CreateRegion', 'SetPictureClipRegion', 'SetWindowShapeRegion']],
  ['shape', 'SHAPE', ['GetRectangles', 'SelectInput']],
  ['xinput', 'XInputExtension', ['ListInputDevices']]
];

let app = null;
let skip = false;

before(async () => {
  if (!process.env.DISPLAY) {
    skip = 'no DISPLAY set';
    return;
  }
  try {
    app = await withTimeout(createClient(), 5000, 'connecting to X server', (late) => late.close());
  } catch (err) {
    skip = `cannot connect to X server: ${err.message}`;
  }
});

after(async () => {
  await app?.close();
});

/** what the server itself says about `name`, straight from QueryExtension */
const queryExtension = (name) =>
  new Promise((resolve, reject) =>
    app.X.QueryExtension(name, (err, ext) => (err ? reject(err) : resolve(ext)))
  );

test('every accessor agrees with the server about what is there', async (t) => {
  if (skip) return t.skip(skip);

  for (const [accessor, wireName, requests] of EXTENSIONS) {
    const present = (await queryExtension(wireName)).present;
    const ext = await app[accessor]();

    if (!present) {
      assert.equal(ext, null, `${accessor}(): the server has no ${wireName}`);
      continue;
    }
    assert.ok(ext, `${accessor}(): the server has ${wireName}, so this must not be null`);
    assert.ok(ext.majorOpcode > 0, `${wireName} carries its major opcode`);
    for (const request of requests) {
      assert.equal(typeof ext[request], 'function', `${wireName}.${request}`);
    }
  }
});

test('the four a compositor needs are answered without asking the server twice', async (t) => {
  if (skip) return t.skip(skip);

  const four = () => Promise.all([app.composite(), app.damage(), app.xfixes(), app.shape()]);
  const first = await four();

  const asked = [];
  const require_ = app.X.require.bind(app.X);
  app.X.require = (name, cb) => {
    asked.push(name);
    require_(name, cb);
  };
  try {
    assert.deepEqual(await four(), first, 'the same four answers');
    assert.deepEqual(asked, [], 'and no second QueryExtension for any of them');
  } finally {
    app.X.require = require_;
  }
});
