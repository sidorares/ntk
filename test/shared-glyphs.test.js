// The shared glyph cache end to end (docs/shared-glyphs.md): the _NTK_GLYPHD
// wire codecs, and the directory + client machinery exercised the way it
// ships — multiple whole ntk apps on one server, glyphs crossing between
// them. Hermetic against node-x11's pure-JS server (which sees both clients,
// so cross-process claims are real, not simulated), plus a smoke-style run
// against a real X server when DISPLAY is set.
//
// The headline numbers are asserted with spies on the requests a client
// issues (Render.AddGlyphs is the only path an upload takes) and on
// Font.rasterize — "a warm process uploads nothing and rasterizes nothing"
// is a claim about what a client sends, counted where it is sent.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';

import { Font, StaticFontSource, createClient, warmSharedGlyphs } from '../lib/index.js';
import {
  SHAPE_PAGE_TOKEN,
  encodeGlyphdRequest,
  encodeGlyphdReply,
  fontPageToken,
  parseGlyphdRequest,
  parseGlyphdReply
} from '../lib/sharedglyphs.js';
import { getGlyphPage } from '../lib/text/glyphs.js';
import { getShapeGlyphPage } from '../lib/shapeglyphs.js';
import { withTimeout } from './helpers/async.js';

// this file tests the feature itself: a kill switch inherited from the
// environment would turn every scenario into a no-op (test files run in
// their own process, so clearing it here leaks nowhere)
delete process.env.NTK_NO_SHARED_GLYPHS;

const require = createRequire(import.meta.url);
const fontDir = join(dirname(require.resolve('katex/package.json')), 'dist', 'fonts');
const fontBytes = readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf'));

function makeFontSource() {
  const source = new StaticFontSource();
  source.add(fontBytes, { family: 'Test Main' });
  source.alias('sans-serif', 'Test Main');
  return source;
}

/** count calls of one Render request as this app issues them */
function spyRender(app, name) {
  const Render = app.display.Render;
  const original = Render[name];
  const counter = { n: 0 };
  Render[name] = (...args) => {
    counter.n++;
    return original.apply(Render, args);
  };
  return counter;
}

/** count rasterizations of one Font instance */
function spyRasterize(font) {
  const original = font.rasterize.bind(font);
  const counter = { n: 0 };
  font.rasterize = (...args) => {
    counter.n++;
    return original(...args);
  };
  return counter;
}

const TEXT_W = 200;
const TEXT_H = 60;

async function drawText(app, text, { size = 24 } = {}) {
  const pixmap = app.createPixmap({ width: TEXT_W, height: TEXT_H, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, TEXT_W, TEXT_H);
  ctx.font = `${size}px sans-serif`;
  ctx.fillStyle = 'black';
  ctx.fillText(text, 10, 40);
  const img = await ctx.getImageData(0, 0, TEXT_W, TEXT_H);
  pixmap.destroy();
  return Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
}

const inkOf = (pixels) => {
  let ink = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 128) ink++;
  return ink;
};

/** two whole ntk apps (or more) on one in-process JS server */
function makeWorld() {
  const server = xserver.createServer({ width: 320, height: 240 });
  return {
    server,
    apps: [],
    async app(options = {}) {
      const [serverEnd, clientEnd] = xserver.createStreamPair();
      server.addClientStream(serverEnd);
      const errors = [];
      const app = await withTimeout(
        createClient({
          stream: clientEnd,
          fontSource: makeFontSource(),
          onXError: (err) => errors.push(err),
          ...options
        }),
        5000,
        'connecting an app to the js server'
      );
      app._testErrors = errors;
      this.apps.push(app);
      return app;
    },
    async close() {
      for (const app of this.apps) {
        try {
          // close() round-trips; an app the scenario already terminated
          // would never answer, so cap the wait and fall back to terminate
          await withTimeout(app.close(), 2000, 'closing a test app');
        } catch {
          try {
            app.X.terminate();
          } catch {
            // already gone
          }
        }
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Wire codecs (pure)
// ---------------------------------------------------------------------------

test('glyphd wire: requests round-trip in both key modes', () => {
  const fontReq = { token: 'ntkg1:abc:wght=460:24:a8', indices: true, keys: [0, 7, 65535], bytes: 0 };
  assert.deepEqual(parseGlyphdRequest(encodeGlyphdRequest(fontReq)), fontReq);

  const shapeReq = {
    token: SHAPE_PAGE_TOKEN,
    indices: false,
    keys: ['fill|10|10|0|0', 'stroke|40|40|3|2'],
    bytes: 1234
  };
  assert.deepEqual(parseGlyphdRequest(encodeGlyphdRequest(shapeReq)), shapeReq);
});

test('glyphd wire: replies round-trip, presence bit intact', () => {
  const reply = {
    serial: 42,
    generation: 3,
    gsid: 0x00a00007,
    entries: [
      { lid: 0, present: true },
      { lid: 257, present: false },
      { lid: 65535, present: true }
    ]
  };
  assert.deepEqual(parseGlyphdReply(encodeGlyphdReply(reply)), reply);
});

test('glyphd wire: malformed payloads parse to null, never throw', () => {
  const good = encodeGlyphdRequest({ token: 'ntks1:a8', indices: false, keys: ['a|b'] });
  assert.equal(parseGlyphdRequest(Buffer.alloc(0)), null);
  assert.equal(parseGlyphdRequest(good.subarray(0, good.length - 1)), null, 'truncated member');
  const wrongVersion = Buffer.from(good);
  wrongVersion.writeUInt8(99, 0);
  assert.equal(parseGlyphdRequest(wrongVersion), null);
  assert.equal(parseGlyphdReply(Buffer.alloc(4)), null);
  const reply = encodeGlyphdReply({ serial: 1, generation: 1, gsid: 5, entries: [{ lid: 1, present: false }] });
  assert.equal(parseGlyphdReply(reply.subarray(0, reply.length - 2)), null, 'truncated entries');
});

test('font page tokens are content-addressed and pin size and version', () => {
  const a = Font.fromData(fontBytes);
  const b = Font.fromData(fontBytes);
  const t24 = fontPageToken(a, 24);
  assert.match(t24, /^ntkg1:[0-9a-f]{40}::24:a8$/, 'versioned, hashed, static face has no coords');
  assert.equal(fontPageToken(b, 24), t24, 'two loads of the same bytes name the same page');
  assert.notEqual(fontPageToken(a, 32), t24, 'the pixel size is part of the name');
});

// ---------------------------------------------------------------------------
// Two ntk apps on one JS server
// ---------------------------------------------------------------------------

test('a second app drawing already-shared text uploads nothing and rasterizes nothing', async () => {
  const world = makeWorld();
  try {
    const app1 = await world.app();
    const font1 = app1.fonts.match('sans-serif');
    assert.equal(await warmSharedGlyphs(app1, font1, 24, 'Hello'), true, 'first app warms (and self-elects)');
    assert.ok(app1.sharedGlyphs._directory, 'first app on the display is the directory');
    const img1 = await drawText(app1, 'Hello');
    assert.ok(inkOf(img1) > 40, 'first app inked the text');
    const page1 = getGlyphPage(app1, font1, 24);
    assert.equal(page1.glyphset, null, 'a fully shared page holds no private set');

    const app2 = await world.app();
    const font2 = app2.fonts.match('sans-serif');
    const uploads = spyRender(app2, 'AddGlyphs');
    const rasterized = spyRasterize(font2);
    assert.equal(await warmSharedGlyphs(app2, font2, 24, 'Hello'), true, 'second app binds to the shared page');
    const img2 = await drawText(app2, 'Hello');
    assert.equal(uploads.n, 0, 'warm glyphs: zero AddGlyphs from the second app');
    assert.equal(rasterized.n, 0, 'warm glyphs: zero rasterizations in the second app');
    assert.equal(getGlyphPage(app2, font2, 24).glyphset, null, 'nothing private was ever minted');
    assert.equal(Buffer.compare(img1, img2), 0, 'both apps composite identical pixels');
    assert.deepEqual(app1._testErrors, [], 'no stray X errors on the directory app');
    assert.deepEqual(app2._testErrors, [], 'no stray X errors on the client app');
  } finally {
    await world.close();
  }
});

test('an unwarmed first draw falls back privately, then adopts the shared page', async () => {
  const world = makeWorld();
  try {
    const app1 = await world.app();
    const font1 = app1.fonts.match('sans-serif');
    await warmSharedGlyphs(app1, font1, 24, 'Hello');

    const app2 = await world.app();
    const font2 = app2.fonts.match('sans-serif');
    const uploads = spyRender(app2, 'AddGlyphs');
    const first = await drawText(app2, 'Hello'); // cold: this frame must not wait
    assert.ok(uploads.n > 0, 'the synchronous first draw minted a private page');
    const page = getGlyphPage(app2, font2, 24);
    await page._shared._chain; // the ensure reply lands: everything was already shared
    assert.equal(page.glyphset, null, 'the private set is freed once nothing composites from it');
    assert.equal(page._shared.bound, true);
    for (const entry of page.entries.values()) {
      assert.equal(entry.gs, page._shared.alias.id, 'entries re-bound to the shared alias');
    }
    const before = uploads.n;
    const second = await drawText(app2, 'Hello');
    assert.equal(uploads.n, before, 'the adopted page re-draws with zero uploads');
    assert.equal(Buffer.compare(first, second), 0, 'fallback and shared draws are pixel-identical');
  } finally {
    await world.close();
  }
});

test('killing the directory app freezes pages; a new owner revives sharing', async () => {
  const world = makeWorld();
  try {
    const app1 = await world.app();
    const font1 = app1.fonts.match('sans-serif');
    await warmSharedGlyphs(app1, font1, 24, 'Hello');
    assert.ok(app1.sharedGlyphs._directory, 'app1 owns the directory');

    const app2 = await world.app();
    const font2 = app2.fonts.match('sans-serif');
    await warmSharedGlyphs(app2, font2, 24, 'Hello');
    const beforeKill = await drawText(app2, 'Hello');

    // the directory dies mid-run; wait until the server has reverted the
    // selection so what follows is deterministic
    app1.X.terminate();
    await withTimeout(
      (async () => {
        for (;;) {
          const owner = await app2.sharedGlyphs._selectionOwner();
          if (owner === 0) return;
        }
      })(),
      5000,
      'selection never reverted after the owner died'
    );

    // frozen pages keep rendering: aliases survive the creator (fence test)
    const afterKill = await drawText(app2, 'Hello');
    assert.equal(Buffer.compare(beforeKill, afterKill), 0, 'frozen page renders unchanged pixels');

    // new glyphs route to the private path, pixels stay correct
    const world1 = await drawText(app2, 'World');
    assert.ok(inkOf(world1) > 40, 'new text after the death still inks');
    const page24 = getGlyphPage(app2, font2, 24);
    await page24._shared._chain;
    assert.equal(page24._shared.open, false, 'the page that met the death froze its shared side');
    assert.equal(app2.sharedGlyphs.state, 'dead', 'the client waits for a successor');
    assert.ok(page24.glyphset, 'the new glyphs live in a fresh private set');
    assert.deepEqual(app2._testErrors, [], 'no unhandled X errors from the whole affair');

    // a new app self-elects and announces; the survivor adopts it lazily
    const app3 = await world.app();
    const font3 = app3.fonts.match('sans-serif');
    await warmSharedGlyphs(app3, font3, 24, 'Hello');
    assert.ok(app3.sharedGlyphs._directory, 'the newcomer self-elected');
    await withTimeout(
      (async () => {
        while (app2.sharedGlyphs.state !== 'active') await new Promise((r) => setTimeout(r, 5));
      })(),
      5000,
      'survivor never adopted the MANAGER announcement'
    );
    assert.equal(app2.sharedGlyphs.ownerWid, app3.sharedGlyphs.ownerWid, 'survivor adopted the new owner');

    // fresh pages bind to the new generation
    assert.equal(await warmSharedGlyphs(app2, font2, 32, 'Hello'), true);
    const page32 = getGlyphPage(app2, font2, 32);
    assert.equal(page32._shared.bound, true, 'a fresh page shares through the new directory');
    const revived = await drawText(app2, 'Hello', { size: 32 });
    assert.ok(inkOf(revived) > 40, 'revived shared drawing inks');
    assert.deepEqual(app2._testErrors, [], 'still no unhandled X errors');
  } finally {
    await world.close();
  }
});

test('exceeding the directory budget opens a new generation; bound pages freeze', async () => {
  const world = makeWorld();
  try {
    // a budget one glyph batch blows through on the first upload
    const app = await world.app({ sharedGlyphs: { budgetBytes: 64 } });
    const font = app.fonts.match('sans-serif');
    await warmSharedGlyphs(app, font, 24, 'AB');
    const directory = app.sharedGlyphs._directory;
    assert.equal(directory.generation, 2, 'the reported upload crossed the budget');
    assert.equal(directory._retired.length, 1, 'the retired set is pinned, not freed');

    const page = getGlyphPage(app, font, 24);
    assert.equal(page._shared.generation, 1, 'the page bound generation 1');
    const before = await drawText(app, 'AB');
    await drawText(app, 'ABCD'); // C and D ask, and the answer is generation 2
    await page._shared._chain;
    assert.equal(page._shared.open, false, 'a generation mismatch freezes the page');
    assert.equal(page.entry(font.glyphIdFor(67)).gs, page.glyphset.id, 'new glyphs are private');
    assert.equal(page.entry(font.glyphIdFor(65)).gs, page._shared.alias.id, 'old glyphs stay on the frozen alias');
    const after = await drawText(app, 'AB');
    assert.equal(Buffer.compare(before, after), 0, 'frozen entries render unchanged');

    assert.equal(await warmSharedGlyphs(app, font, 32, 'A'), true);
    assert.equal(getGlyphPage(app, font, 32)._shared.generation, 2, 'fresh pages bind the new generation');
  } finally {
    await world.close();
  }
});

test('corner glyphs share across apps through the ntks1 page', async () => {
  const world = makeWorld();
  const drawBox = async (app) => {
    const pixmap = app.createPixmap({ width: 200, height: 120, depth: 24 });
    const ctx = pixmap.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 200, 120);
    ctx.fillStyle = 'black';
    ctx.beginPath();
    ctx.roundRect(10, 10, 130, 70, 10);
    ctx.fill();
    const img = await ctx.getImageData(0, 0, 200, 120);
    pixmap.destroy();
    return Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  };
  try {
    const app1 = await world.app();
    const img1 = await drawBox(app1);
    const page1 = getShapeGlyphPage(app1);
    await page1._shared._chain;
    assert.equal(page1._shared.adapter.token, SHAPE_PAGE_TOKEN);
    assert.equal(page1.glyphset, null, 'all four corners adopted into the shared page');

    const app2 = await world.app();
    const first = await drawBox(app2); // cold fallback, adoption behind it
    const page2 = getShapeGlyphPage(app2);
    await page2._shared._chain;
    assert.equal(page2.glyphset, null, 'second app adopted the same corners');
    const uploads = spyRender(app2, 'AddGlyphs');
    const second = await drawBox(app2);
    assert.equal(uploads.n, 0, 'warm corners re-draw with zero uploads');
    assert.equal(Buffer.compare(img1, first), 0, 'both apps ink identical boxes');
    assert.equal(Buffer.compare(first, second), 0, 'fallback and shared draws identical');
  } finally {
    await world.close();
  }
});

test('the kill switch and the option leave the private path untouched', async () => {
  const world = makeWorld();
  try {
    process.env.NTK_NO_SHARED_GLYPHS = '1';
    let app;
    try {
      app = await world.app();
    } finally {
      delete process.env.NTK_NO_SHARED_GLYPHS;
    }
    assert.equal(app.sharedGlyphs, null, 'the env kill switch turns the client off');
    // no selection traffic, no client messages: the machinery must not run
    const calls = [];
    for (const name of ['SetSelectionOwner', 'GetSelectionOwner', 'SendClientMessage']) {
      const original = app.X[name].bind(app.X);
      app.X[name] = (...args) => {
        calls.push(name);
        return original(...args);
      };
    }
    const font = app.fonts.match('sans-serif');
    const page = getGlyphPage(app, font, 24);
    assert.ok(page.glyphset, 'the private glyphset exists from page creation, as always');
    const img = await drawText(app, 'Hello');
    assert.ok(inkOf(img) > 40);
    assert.equal(page._shared, null, 'no shared binding was created');
    for (const entry of page.entries.values()) assert.equal(entry.gs, page.glyphset.id);
    assert.deepEqual(calls, [], 'not one selection request or client message was issued');

    const viaOption = await world.app({ sharedGlyphs: false });
    assert.equal(viaOption.sharedGlyphs, null, 'createClient({ sharedGlyphs: false }) turns it off too');
  } finally {
    await world.close();
  }
});

// ---------------------------------------------------------------------------
// Real X server, smoke-style
// ---------------------------------------------------------------------------

test('two real-server apps share glyphs (smoke)', async (t) => {
  if (!process.env.DISPLAY) {
    t.skip('no DISPLAY set');
    return;
  }
  let app1;
  try {
    app1 = await withTimeout(createClient({ fontSource: makeFontSource() }), 5000, 'connecting to X server');
  } catch (err) {
    t.skip(`cannot connect to X server: ${err.message}`);
    return;
  }
  const apps = [app1];
  try {
    const font1 = app1.fonts.match('sans-serif');
    const warmed1 = await warmSharedGlyphs(app1, font1, 24, 'Hello shared');
    const img1 = await drawText(app1, 'Hello shared');
    assert.ok(inkOf(img1) > 40, 'first app inked');

    const app2 = await withTimeout(createClient({ fontSource: makeFontSource() }), 5000, 'connecting to X server');
    apps.push(app2);
    const font2 = app2.fonts.match('sans-serif');
    const uploads = spyRender(app2, 'AddGlyphs');
    const rasterized = spyRasterize(font2);
    const warmed2 = await warmSharedGlyphs(app2, font2, 24, 'Hello shared');
    const img2 = await drawText(app2, 'Hello shared');
    assert.equal(Buffer.compare(img1, img2), 0, 'both apps composite identical pixels');
    if (warmed1 && warmed2) {
      // the deterministic claim: entries adopted before the draw mean the
      // draw itself uploads and rasterizes nothing, whatever the display's
      // directory does afterwards
      assert.equal(uploads.n, 0, 'warm glyphs: zero AddGlyphs on the real server');
      assert.equal(rasterized.n, 0, 'warm glyphs: zero rasterizations on the real server');
    } else {
      // another process on this display may own (or have just dropped) the
      // directory mid-test; correctness holds either way, the saving is
      // only asserted when the cache was actually bound
      t.diagnostic('shared cache not bound on this display; correctness-only run');
    }
  } finally {
    for (const app of apps) await app.close();
  }
});
