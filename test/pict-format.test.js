// Picking a RENDER picture format from the drawable's *visual* rather than
// its depth (sidorares/ntk#295). Depth does not name a format: 5:6:5 and
// 5:5:5 are both depth 16, RGB and BGR share depth 24, and 10:10:10:2 is 32
// bits wide like 8:8:8:8. Compositing a foreign drawable through a format
// that does not describe its pixels is not an error RENDER reports — it just
// reads the channels wrong.
//
// The matching itself is pure and is tested against a real server's formats
// list. The rest is hermetic: node-x11's in-process pure-JS X server for the
// end-to-end lookup, and a mock client for the layouts no server on this
// machine has.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';

import xserver from 'x11/lib/xserver/index.js';

import Window from '../lib/window.js';
import {
  formatForDepth,
  matchVisualFormat,
  parsePictFormats,
  visualFormats
} from '../lib/pictformat.js';
import { StaticFontSource, createClient } from '../lib/index.js';

const { createServer, createStreamPair } = xserver;

// ---------------------------------------------------------------------
// the matching
// ---------------------------------------------------------------------

// A real server's QueryPictFormats list, as node-x11 hands it over:
// [id, type, depth, redShift, redMask, greenShift, greenMask, blueShift,
//  blueMask, alphaShift, alphaMask, colormap]. Taken from XQuartz, which
// publishes the fixed set every RENDER server does plus one format per
// visual it has.
const FORMATS = parsePictFormats({
  formats: [
    [36, 1, 8, 0, 0, 0, 0, 0, 0, 0, 255, 0], // a8
    [37, 1, 32, 16, 255, 8, 255, 0, 255, 24, 255, 0], // a8r8g8b8
    [38, 1, 32, 16, 255, 8, 255, 0, 255, 0, 0, 0], // x8r8g8b8
    [39, 1, 32, 8, 255, 16, 255, 24, 255, 0, 255, 0], // b8g8r8a8
    [41, 1, 24, 16, 255, 8, 255, 0, 255, 0, 0, 0], // r8g8b8
    [42, 1, 24, 0, 255, 8, 255, 16, 255, 0, 0, 0], // b8g8r8
    [57, 1, 32, 0, 255, 8, 255, 16, 255, 0, 0, 0], // x8b8g8r8
    [49, 1, 16, 10, 31, 5, 31, 0, 31, 0, 0, 0], // x1r5g5b5
    [51, 1, 16, 10, 31, 5, 31, 0, 31, 15, 1, 0], // a1r5g5b5
    [53, 1, 16, 11, 31, 5, 63, 0, 31, 0, 0, 0], // r5g6b5
    [54, 1, 16, 0, 31, 5, 63, 11, 31, 0, 0, 0], // b5g6r5
    [58, 1, 32, 20, 1023, 10, 1023, 0, 1023, 30, 3, 0], // a2r10g10b10
    [59, 1, 32, 20, 1023, 10, 1023, 0, 1023, 0, 0, 0], // x2r10g10b10
    [70, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0x21] // an indexed format
  ]
});

/** a TrueColor visual as the connection handshake describes one */
const visual = (vid, red, green, blue) => ({
  vid,
  class: 4,
  bits_per_rgb: 8,
  red_mask: red,
  green_mask: green,
  blue_mask: blue
});

test('the ordinary depths still resolve to the standard formats', () => {
  // what the depth-based guess got right, and has to go on getting right
  assert.equal(matchVisualFormat(visual(1, 0xff0000, 0xff00, 0xff), 24, FORMATS), 41);
  assert.equal(matchVisualFormat(visual(2, 0xff0000, 0xff00, 0xff), 32, FORMATS), 37);
});

test('a depth-32 visual takes the format with the alpha channel', () => {
  // a8r8g8b8 and x8r8g8b8 have identical colour masks; the 8 bits the
  // channels do not account for are what tells them apart
  const argb = matchVisualFormat(visual(3, 0xff0000, 0xff00, 0xff), 32, FORMATS);
  assert.equal(argb, 37, 'a8r8g8b8, not x8r8g8b8');
});

test('a BGR visual does not get the RGB format of the same depth', () => {
  // both are depth 24, and the old depth-only guess handed back r8g8b8 for
  // either — red and blue swapped in everything composited
  assert.equal(matchVisualFormat(visual(4, 0xff, 0xff00, 0xff0000), 24, FORMATS), 42);
  // this server publishes no BGR format with an alpha channel, so a depth-32
  // one settles for the layout it does have rather than the wrong layout
  assert.equal(matchVisualFormat(visual(5, 0xff, 0xff00, 0xff0000), 32, FORMATS), 57);
});

test('a depth-16 visual is 5:6:5 or 5:5:5, and the masks say which', () => {
  // rgb24 was the answer for both — a 16-bit client on an embedded or
  // remote-X setup composited through a format twice its pixel width
  assert.equal(matchVisualFormat(visual(6, 0xf800, 0x7e0, 0x1f), 16, FORMATS), 53);
  assert.equal(matchVisualFormat(visual(7, 0x1f, 0x7e0, 0xf800), 16, FORMATS), 54);
  assert.equal(matchVisualFormat(visual(8, 0x7c00, 0x3e0, 0x1f), 16, FORMATS), 49, '5:5:5, no alpha');
});

test('a 10-bit visual matches on layout where the two lists disagree on depth', () => {
  // the visual is depth 30; the fixed formats every server publishes carry
  // the pixel width instead, so a2r10g10b10 is listed at depth 32. The masks
  // still identify the layout, which is what decides how pixels are read.
  const wide = visual(9, 0x3ff00000, 0xffc00, 0x3ff);
  assert.equal(matchVisualFormat(wide, 30, FORMATS), 59, 'x2r10g10b10, and the depth-only guess said rgb24');
  // two spare bits at depth 32 are padding, not an alpha channel: compositing
  // through a2r10g10b10 would read whatever is in them as transparency
  assert.equal(matchVisualFormat(wide, 32, FORMATS), 59);
});

test('a visual with no masks names no format', () => {
  // an indexed visual (PseudoColor and friends) has an Indexed format tied
  // to a colormap, which this list cannot be matched against. Saying so
  // leaves the caller its depth-based fallback, which is better than a
  // Direct format whose channels the visual does not have.
  const indexed = { vid: 10, class: 3, red_mask: 0, green_mask: 0, blue_mask: 0 };
  assert.equal(matchVisualFormat(indexed, 8, FORMATS), null);
  // and a layout this server does not publish at all
  assert.equal(matchVisualFormat(visual(11, 0xf00, 0xf0, 0xf), 12, FORMATS), null);
});

test('visualFormats walks every screen and depth the handshake described', () => {
  const display = {
    screen: [
      { depths: { 24: { 34: visual(34, 0xff0000, 0xff00, 0xff) } } },
      {
        depths: {
          16: { 40: visual(40, 0xf800, 0x7e0, 0x1f) },
          32: { 41: visual(41, 0xff0000, 0xff00, 0xff) }
        }
      }
    ]
  };
  assert.deepEqual(
    [...visualFormats(display, FORMATS)],
    [
      [34, 41],
      [40, 53],
      [41, 37]
    ]
  );
});

test('the depth fallback is the standard set node-x11 names', () => {
  const Render = { rgb24: 'rgb24', rgba32: 'rgba32', a8: 'a8' };
  assert.equal(formatForDepth(Render, 32), 'rgba32');
  assert.equal(formatForDepth(Render, 8), 'a8');
  assert.equal(formatForDepth(Render, 24), 'rgb24');
  assert.equal(formatForDepth(Render, 16), 'rgb24', 'wrong, which is why it is only the fallback');
});

// ---------------------------------------------------------------------
// app.pictFormatFor, against a real (if pure-JS) server
// ---------------------------------------------------------------------

let server = null;
let app = null;

beforeEach(async () => {
  server = createServer({ width: 400, height: 300 });
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);
  app = await createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
});

afterEach(() => {
  app?.X.terminate();
  server = app = null;
});

test('pictFormatFor answers with the format the server made for the visual', async () => {
  const screen = app.display.screen[0];
  const format = await app.pictFormatFor(screen.root_visual);
  assert.equal(format, app.display.Render.rgb24, 'depth-24 RGB root: the standard format');

  // and it is the same answer the depth-based guess gives here, which is the
  // point — this only diverges where the visual is not the ordinary one
  assert.equal(format, formatForDepth(app.display.Render, screen.root_depth));
});

test('pictFormatFor takes a handshake visual object as well as an id', async () => {
  const screen = app.display.screen[0];
  const vis = screen.depths[screen.root_depth][screen.root_visual];
  assert.equal(await app.pictFormatFor(vis), app.display.Render.rgb24);
});

test('a visual the server never mentioned falls back to the depth', async () => {
  assert.equal(await app.pictFormatFor(0xdead, { depth: 32 }), app.display.Render.rgba32);
  assert.equal(await app.pictFormatFor(0, { depth: 8 }), app.display.Render.a8);
});

test('the table is one query per connection, cached', async () => {
  const first = app.pictFormats();
  assert.equal(app.pictFormats(), first, 'the same promise, not a second round trip');
  const { formats, byVisual } = await first;
  assert.ok(formats.length > 0);
  assert.equal(app.pictFormats(), first, 'and still, once it has resolved');
  assert.equal(byVisual.get(app.display.screen[0].root_visual), app.display.Render.rgb24);
});

test('the connection prefetches the table, so a picture binds without waiting', async () => {
  // createClient sends the query during the handshake: nothing awaits it, but
  // by the time an app draws anything the answer is here, and binding a
  // picture is synchronous
  assert.ok(app._knownPictFormat(app.display.screen[0].root_visual, 24) !== undefined);
});

test('a window ntk created knows its visual without asking', async () => {
  const screen = app.display.screen[0];
  const wnd = app.createWindow({ width: 40, height: 30 });
  assert.equal(wnd.visual, 0, 'CopyFromParent, as the CreateWindow argument');
  assert.equal(wnd.visualId, screen.root_visual, 'but the pixels are the root visual');

  const child = wnd.createWindow({ width: 10, height: 10 });
  assert.equal(child.visualId, wnd.visualId, 'and a child copies from its parent');
  wnd.destroy();
});

test('an adopted window learns its visual, and ready is the wait for it', async () => {
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);
  const guest = await createClient({ stream: clientEnd, fontSource: new StaticFontSource() });
  const theirs = guest.createWindow({ width: 50, height: 50 });
  await new Promise((resolve) => guest.X.GetInputFocus(() => setImmediate(resolve)));

  const adopted = app.createWindow({ id: theirs.id });
  assert.equal(adopted.visualId, 0, 'another client chose it; nothing is known yet');

  await adopted.ready;
  assert.equal(adopted.depth, 24, 'the geometry reply');
  assert.equal(
    adopted.visualId,
    app.display.screen[0].root_visual,
    'and the attributes reply, which is the only place the visual is stated'
  );

  theirs.destroy();
  guest.X.terminate();
});

test('a context draws through the visual’s format, and the pixels land', async () => {
  const wnd = app.createWindow({ width: 8, height: 8 });
  wnd.map();
  const ctx = wnd.getContext('2d');
  assert.equal(
    ctx.picture.format,
    await app.pictFormatFor(wnd.visualId),
    'the picture is bound with the format the visual names'
  );

  ctx.fillStyle = '#ff8000';
  ctx.fillRect(0, 0, 8, 8);
  const image = await ctx.getImageData(0, 0, 1, 1);
  assert.deepEqual([...image.data.slice(0, 3)], [255, 128, 0], 'read back through the same format');
  wnd.destroy();
});

test('getAttributes writes the visual back too', async () => {
  const wnd = app.createWindow({ width: 20, height: 20 });
  const attrs = await wnd.getAttributes();
  assert.equal(wnd.visualId, attrs.visual);
  wnd.destroy();
});

// ---------------------------------------------------------------------
// what the format is for: what a 2d context binds
// ---------------------------------------------------------------------

let nextId = 0xc000;

/**
 * A mock client on a 5:6:5 server — the layout the depth-based guess got
 * wrong, and one no X server on a CI box has.
 */
function makeMockApp() {
  const calls = { pictures: [], freed: [] };
  const Render = {
    rgb24: 'rgb24',
    rgba32: 'rgba32',
    a8: 'a8',
    CreatePicture(id, drawable, format) {
      calls.pictures.push({ id, drawable, format });
    },
    FreePicture(id) {
      calls.freed.push(id);
    }
  };
  const X = {
    _closing: false,
    stream: { destroyed: false, writableEnded: false },
    event_consumers: {},
    keycode2keysyms: {},
    AllocID: () => nextId++,
    ReleaseID() {},
    CreateWindow() {},
    DestroyWindow() {},
    ChangeWindowAttributes() {},
    CreateGC() {},
    CreatePixmap() {},
    FreePixmap() {},
    PolyFillRectangle() {},
    CopyArea() {},
    GetGeometry(id, cb) {
      calls.getGeometry = cb;
    },
    GetWindowAttributes(id, cb) {
      calls.getAttributes = cb;
    },
    GetInputFocus() {}
  };
  const display = {
    client: X,
    Render,
    screen: [{ root: 1, root_depth: 16, root_visual: 0x21, white_pixel: 0xffff }]
  };
  // the visual -> format table, as App would have built it from the server's
  // answer: one 5:6:5 visual, whose format is nothing like rgb24
  const table = new Map([[0x21, 'r5g6b5']]);
  const app = {
    X,
    display,
    solidPicture: () => ({ id: nextId++ }),
    // as App does it: the depth has to describe the same pixels as the
    // visual, and 0 (CopyFromParent) is not a depth to disagree with
    _knownPictFormat: (v, depth) => (!depth || depth === 16 ? table.get(v) : undefined),
    pictFormats: () => Promise.resolve({ formats: [], byVisual: table })
  };
  return { app, calls };
}

const geometryReply = (depth) => ({
  windowid: 1,
  xPos: 0,
  yPos: 0,
  width: 64,
  height: 64,
  borderWidth: 0,
  depth
});

test('a context binds the visual’s format, not the depth’s', () => {
  const { app, calls } = makeMockApp();
  const wnd = new Window(app, { width: 64, height: 64, backingStore: false, frameSync: false });
  wnd.getContext('2d');
  assert.deepEqual(
    calls.pictures.map((p) => p.format),
    ['r5g6b5'],
    'a 5:6:5 window used to be read through rgb24'
  );
  wnd.destroy();
});

test('a context on an adopted window rebinds when the visual arrives', async () => {
  const { app, calls } = makeMockApp();
  const wnd = new Window(app, { id: 0xbead, frameInterval: 0 });
  const ctx = wnd.getContext('2d');

  // depth 0, no visual: nothing to go on but the fallback
  assert.deepEqual(
    calls.pictures.map((p) => p.format),
    ['rgb24']
  );

  calls.getGeometry(null, geometryReply(16));
  calls.getAttributes(null, { visual: 0x21 });
  await wnd.ready;
  await tick();

  assert.deepEqual(
    calls.pictures.map((p) => p.format),
    ['rgb24', 'r5g6b5'],
    'the pair of replies names the format, so the picture is rebuilt'
  );
  assert.equal(calls.freed.length, 1, 'and the wrong one is freed');
  assert.equal(ctx.picture.format, 'r5g6b5');
});

test('an adopted window that answers nothing keeps the depth fallback', async () => {
  const { app, calls } = makeMockApp();
  const wnd = new Window(app, { id: 0xbeaf, frameInterval: 0 });
  wnd.getContext('2d');

  // the window is gone: both requests earn a BadWindow, and `ready` still
  // has to settle (a window manager races exiting clients all the time)
  calls.getGeometry(new Error('BadWindow'));
  calls.getAttributes(new Error('BadWindow'));
  assert.equal(await wnd.ready, wnd);
  await tick();

  assert.equal(calls.pictures.length, 1, 'nothing learned, nothing to redo');
  assert.equal(calls.freed.length, 0);
});

test('a backing pixmap is read through the window’s visual', () => {
  const { app, calls } = makeMockApp();
  const wnd = new Window(app, { width: 64, height: 64, frameSync: false });
  wnd.getContext('2d'); // takes the backing store with it
  assert.ok(wnd._backing, 'double buffered');
  assert.equal(wnd._backing.visualId, 0x21, 'a pixmap has no visual of its own');
  assert.deepEqual(
    calls.pictures.map((p) => p.format),
    ['r5g6b5']
  );
  wnd.destroy();
});

test('the table arriving late rebinds a context that guessed', async () => {
  const { app, calls } = makeMockApp();
  let announce;
  const pending = new Promise((resolve) => (announce = resolve));
  app._knownPictFormat = () => undefined; // the query is still in flight
  app.pictFormats = () => pending;

  const wnd = new Window(app, { width: 64, height: 64, backingStore: false, frameSync: false });
  const ctx = wnd.getContext('2d');
  assert.deepEqual(
    calls.pictures.map((p) => p.format),
    ['rgb24'],
    'depth 16 has no standard format, so the fallback is the 8:8:8 one'
  );

  app._knownPictFormat = (v) => (v === 0x21 ? 'r5g6b5' : undefined);
  announce({ formats: [], byVisual: new Map() });
  await pending;
  await tick();

  assert.equal(ctx.picture.format, 'r5g6b5', 'the answer arrives and the picture is rebuilt');
  wnd.destroy();
});

test("the reply's own screens section names the format, indexed visuals included", () => {
  // node-x11 >= 4.0.0 decodes screens/depths/visuals, which is the server's
  // own visual -> format table: it covers what masks cannot (an indexed
  // visual) and it wins over mask matching where both have an answer.
  const display = {
    screen: [
      {
        depths: {
          8: { 10: { vid: 10, red_mask: 0, green_mask: 0, blue_mask: 0 } },
          24: { 34: visual(34, 0xff0000, 0xff00, 0xff) },
          16: { 40: visual(40, 0xf800, 0x7e0, 0x1f) }
        }
      }
    ]
  };
  const reply = {
    screens: [
      {
        fallback: 41,
        depths: [
          { depth: 8, visuals: [{ visual: 10, format: 21 }] },
          { depth: 24, visuals: [{ visual: 34, format: 41 }] }
        ]
      }
    ]
  };
  assert.deepEqual(
    [...visualFormats(display, FORMATS, reply)],
    [
      [10, 21], // indexed — only the server can name this one
      [34, 41],
      [40, 53] // left out of the reply, so matched on masks
    ]
  );
});
