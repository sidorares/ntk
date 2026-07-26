// wnd.setCursor(name) creates a cursor from the standard X11 'cursor' font
// (OpenFont + CreateGlyphCursor) and applies it via ChangeWindowAttributes.
// Hermetic: runs against node-x11's in-process pure-JS X server and verifies
// the results server-side through the server's resource table (the core
// GetWindowAttributes reply has no cursor field, so the wire protocol offers
// no readback; the server object is available here anyway).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { createClient, cursorShapes, StaticFontSource } from '../lib/index.js';

const { createServer, createStreamPair } = xserver;

let server = null;
let app = null;

const connect = async () => {
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);
  return createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
};

// X processes requests in order: once this cheap request has its reply,
// everything issued before it has been executed by the server
const roundtrip = (a) => new Promise((resolve, reject) => a.X.GetInputFocus((err) => (err ? reject(err) : resolve())));

before(async () => {
  server = createServer({ width: 320, height: 240 });
  app = await connect();
});

after(async () => {
  if (app) await app.close();
});

test('setCursor(name) creates a cursor-font cursor and sets it on the window', async () => {
  const wnd = app.createWindow({ width: 40, height: 30 });
  wnd.setCursor('text');
  const cid = app.cursors.get('text'); // cached: the same id setCursor used
  await roundtrip(app);

  const serverWin = server.resources.get(wnd.id);
  assert.equal(serverWin.cursor, cid, 'window attribute points at the created cursor');

  const cursor = server.resources.get(cid);
  assert.equal(cursor.type, 'cursor');
  assert.equal(cursor.sourceChar, cursorShapes.text, 'source glyph is the shape index');
  assert.equal(cursor.maskChar, cursorShapes.text + 1, 'mask glyph is shape + 1');
  assert.deepEqual(cursor.fore, [0, 0, 0], 'black foreground');
  assert.deepEqual(cursor.back, [0xffff, 0xffff, 0xffff], 'white background');

  const font = server.resources.get(cursor.sourceFont);
  assert.equal(font.name, 'cursor', "glyphs come from the standard 'cursor' font");
  assert.equal(cursor.maskFont, cursor.sourceFont, 'mask uses the same font');
  wnd.destroy();
});

test('cursors are cached per connection, aliases share the shape', async () => {
  assert.equal(app.cursors.get('text'), app.cursors.get('text'), 'same id for the same name');
  assert.equal(app.cursors.get('pointer'), app.cursors.get('hand'), 'aliases resolve to one cursor');
  assert.notEqual(app.cursors.get('default'), app.cursors.get('text'), 'distinct shapes get distinct cursors');
  await roundtrip(app);
});

test('raw cursor-font glyph indices are accepted', async () => {
  const wnd = app.createWindow({ width: 40, height: 30 });
  wnd.setCursor(34); // XC_crosshair
  await roundtrip(app);
  const cursor = server.resources.get(server.resources.get(wnd.id).cursor);
  assert.equal(cursor.sourceChar, 34);
  assert.equal(cursor.maskChar, 35);
  assert.equal(app.cursors.get('crosshair'), app.cursors.get(34), 'numeric and named lookups share the cache');
  wnd.destroy();
});

test('setCursor(null) restores the parent cursor (None)', async () => {
  const wnd = app.createWindow({ width: 40, height: 30 });
  wnd.setCursor('wait');
  await roundtrip(app);
  assert.notEqual(server.resources.get(wnd.id).cursor, 0);
  wnd.setCursor(null);
  await roundtrip(app);
  assert.equal(server.resources.get(wnd.id).cursor, 0, 'cursor attribute back to None');
  wnd.destroy();
});

test('unknown cursor names throw synchronously and list the valid names', () => {
  const wnd = app.createWindow({ width: 40, height: 30 });
  assert.throws(() => wnd.setCursor('sideways'), (err) => {
    assert.match(err.message, /unknown cursor name 'sideways'/);
    for (const name of Object.keys(cursorShapes)) {
      assert.ok(err.message.includes(name), `error lists '${name}'`);
    }
    return true;
  });
  wnd.destroy();
});

test('app.close() frees the cached cursors and the cursor font', async () => {
  const app2 = await connect();
  const cid = app2.cursors.get('move');
  await roundtrip(app2);
  const fontId = server.resources.get(cid).sourceFont;
  assert.ok(server.resources.get(fontId), 'font resource exists while cached');

  // dispose is what close() runs; exercise it with the connection still up
  // so the FreeCursor/CloseFont requests are observable server-side
  app2.cursors.dispose();
  await roundtrip(app2);
  assert.equal(server.resources.get(cid), undefined, 'cursor freed');
  assert.equal(server.resources.get(fontId), undefined, 'font closed');
  await app2.close();
});
