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

// 'none' is the pointer being invisible; setCursor(null) is X cursor None,
// which *inherits* the parent's cursor and leaves the pointer on screen.
// The two get conflated because CSS spells the first one `cursor: none`.

test("setCursor('none') hides the pointer with an empty-mask cursor", async () => {
  const wnd = app.createWindow({ width: 40, height: 30 });
  wnd.setCursor('none');
  const cid = app.cursors.get('none');
  await roundtrip(app);

  assert.equal(server.resources.get(wnd.id).cursor, cid, 'set on the window');
  const cursor = server.resources.get(cid);
  assert.equal(cursor.type, 'cursor');
  assert.equal(cursor.sourceFont, undefined, 'not a cursor-font glyph cursor');
  assert.equal(cursor.source, cursor.mask, 'one empty bitmap serves as both');
  assert.deepEqual(cursor.fore, [0, 0, 0]);
  assert.deepEqual(cursor.back, [0, 0, 0]);
  wnd.destroy();
});

test("the bitmap behind 'none' is freed, not held for the connection", async () => {
  const cid = app.cursors.get('none');
  await roundtrip(app);
  const { source } = server.resources.get(cid);
  assert.equal(
    server.resources.get(source),
    undefined,
    'the cursor keeps its own copy, so the pixmap goes straight back'
  );
});

test("'none' is cached like any other cursor", async () => {
  assert.equal(app.cursors.get('none'), app.cursors.get('none'), 'built once');
  assert.notEqual(app.cursors.get('none'), app.cursors.get('default'));
  await roundtrip(app);
});

test("setCursor(null) after 'none' brings the pointer back", async () => {
  const wnd = app.createWindow({ width: 40, height: 30 });
  wnd.setCursor('none');
  await roundtrip(app);
  assert.notEqual(server.resources.get(wnd.id).cursor, 0, 'hidden');
  wnd.setCursor(null);
  await roundtrip(app);
  assert.equal(server.resources.get(wnd.id).cursor, 0, 'inheriting again');
  wnd.destroy();
});

test('unknown cursor names throw synchronously and list the valid names', () => {
  const wnd = app.createWindow({ width: 40, height: 30 });
  assert.throws(() => wnd.setCursor('sideways'), (err) => {
    assert.match(err.message, /unknown cursor name 'sideways'/);
    for (const name of [...Object.keys(cursorShapes), 'none']) {
      assert.ok(err.message.includes(name), `error lists '${name}'`);
    }
    return true;
  });
  wnd.destroy();
});

test('app.close() frees the cached cursors and the cursor font', async () => {
  const app2 = await connect();
  const cid = app2.cursors.get('move');
  const blank = app2.cursors.get('none');
  await roundtrip(app2);
  const fontId = server.resources.get(cid).sourceFont;
  assert.ok(server.resources.get(fontId), 'font resource exists while cached');

  // dispose is what close() runs; exercise it with the connection still up
  // so the FreeCursor/CloseFont requests are observable server-side
  app2.cursors.dispose();
  await roundtrip(app2);
  assert.equal(server.resources.get(cid), undefined, 'cursor freed');
  assert.equal(server.resources.get(blank), undefined, 'blank cursor freed too');
  assert.equal(server.resources.get(fontId), undefined, 'font closed');
  await app2.close();
});

// The cost of a callback on a *void* request: node-x11 guarantees it fires
// (node-x11 issue #85), and where nothing else in the tick expects a reply it
// keeps that promise by injecting a GetInputFocus round trip. A callback that
// ignores its argument therefore buys a round trip per cursor change and
// nothing else — an X error reaches client.emit('error') either way (#309).
const countInjectedSyncs = async (fn) => {
  const original = app.X.GetInputFocus;
  let injected = 0;
  app.X.GetInputFocus = function (...args) {
    injected++;
    return original.apply(this, args);
  };
  try {
    fn();
    // node-x11 schedules the void sync on setImmediate; give it two turns
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    app.X.GetInputFocus = original;
  }
  return injected;
};

test('setCursor does not inject a void-sync round trip', async () => {
  const wnd = app.createWindow({ width: 40, height: 30 });
  const cid = app.cursors.get('wait'); // create it now, outside the measurement
  await roundtrip(app);

  const injected = await countInjectedSyncs(() => wnd.setCursor('wait'));
  assert.equal(injected, 0, 'no GetInputFocus rides along with the attribute change');

  await roundtrip(app);
  assert.equal(server.resources.get(wnd.id).cursor, cid, 'and the cursor still got set');
  wnd.destroy();
});

test('setting the cursor a window already has sends nothing', async () => {
  const wnd = app.createWindow({ width: 40, height: 30 });
  wnd.setCursor('pointer');
  await roundtrip(app);

  const before = app.X.seq_num;
  wnd.setCursor('pointer');
  wnd.setCursor('hand'); // an alias: the same cursor id
  assert.equal(app.X.seq_num, before, 'no requests for a cursor that is already current');

  wnd.setCursor(null);
  assert.equal(app.X.seq_num, before + 1, 'a different cursor still goes out');
  await roundtrip(app);
  assert.equal(server.resources.get(wnd.id).cursor, 0);
  wnd.destroy();
});

test('a window created with a cursor knows it, and re-setting it is free', async () => {
  const cid = app.cursors.get('crosshair');
  await roundtrip(app);
  const wnd = app.createWindow({ width: 40, height: 30, cursor: cid });
  await roundtrip(app);
  assert.equal(server.resources.get(wnd.id).cursor, cid, 'set at creation time');

  const before = app.X.seq_num;
  wnd.setCursor('crosshair');
  assert.equal(app.X.seq_num, before, 'the creation attribute seeded the memo');
  wnd.destroy();
});

test('an X error from the callback-less request still reaches onXError', async () => {
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);
  const errors = [];
  const app2 = await createClient({
    stream: clientEnd,
    fontSource: new StaticFontSource(),
    onXError: (err) => errors.push(err)
  });
  const wnd = app2.createWindow({ width: 40, height: 30 });
  await roundtrip(app2);

  // the window is gone, so the ChangeWindowAttributes that follows is a
  // BadWindow — with no callback to route it, node-x11 emits it on the client
  // and App's listener hands it to onXError
  wnd.destroy();
  wnd.setCursor('text');
  await roundtrip(app2);

  assert.equal(errors.length, 1, 'exactly one error surfaced');
  assert.equal(errors[0].error, 3, 'BadWindow');
  await app2.close();
});
