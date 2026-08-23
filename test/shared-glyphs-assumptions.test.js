// Fences the X server behavior a cross-process shared glyph cache would
// stand on (docs/shared-glyphs.md): RENDER glyphsets are server-side
// objects that any connection may use by XID, ReferenceGlyphSet keeps them
// alive across the creator's disconnect (and chains across generations),
// a non-creator can AddGlyphs into a set it only references, and a stale
// XID fails with a GLYPHSET error rather than drawing garbage.
//
// One behavior deliberately diverges between servers and is recorded here
// rather than papered over: compositing a glyph id that is not in the set
// is *silently skipped without advancing the pen* on Xorg, and raises a
// GLYPH error on node-x11's JS server. Either way an unconfirmed id is
// unusable — a shared-cache client must confirm presence before drawing,
// never blind-fire (a skipped glyph shifts the rest of the run on Xorg).
//
// Runs twice: hermetically against the pure-JS server, and (smoke-style,
// when DISPLAY is set) against a real X server.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import x11 from 'x11';
import xserver from 'x11/lib/xserver/index.js';

import { withTimeout } from './helpers/async.js';

const W = 64;
const H = 32;
const OVER = 3;
const SRC = 1;

function connect(opts) {
  return new Promise((resolve, reject) => {
    x11.createClient(opts, (err, display) => {
      if (err) return reject(err);
      const X = display.client;
      const errors = [];
      X.on('error', (e) => errors.push(e));
      // the connection is already up by the time these can fail; rejecting
      // hands the caller an error but no handle, so drop the socket here or
      // it refs the event loop for the rest of the process
      const failed = (cause) => {
        try {
          X.terminate();
        } catch {
          // already gone
        }
        reject(cause);
      };
      X.require('render', (rerr, Render) => {
        if (rerr) return failed(rerr);
        // QueryVersion also flushes the ext's QueryPictFormat, so a8/rgb24
        // are populated once this roundtrip completes
        Render.QueryVersion(0, 11, (verr) => {
          if (verr) return failed(verr);
          resolve({ display, X, Render, errors });
        });
      });
    });
  });
}

// One real round trip, always. An InternAtom barrier looks equivalent but is
// not: node-x11 caches atom replies in a table shared across every
// connection of the process, so a name any earlier connection interned
// resolves without touching the wire — and a no-op "sync" lets this test's
// cross-socket scenarios race (B compositing before A's upload landed, A's
// death overtaking B's reference). CI caught exactly that. X.sync() rides
// GetInputFocus, which nothing caches.
const sync = (c) => c.X.sync();

// 8x8 a8 glyphs (rows already 4-byte aligned), ntk's GLYPHINFO convention:
// baseline 8px below the bitmap top, advance 8px. Fresh objects per call —
// node-x11's AddGlyphs mutates its input (stride padding, offX/64).
const solidGlyph = (id) => ({
  id, width: 8, height: 8, x: 0, y: 8, offX: 8 * 64, offY: 0,
  image: Buffer.alloc(64, 0xff)
});
function hollowGlyph(id) {
  const image = Buffer.alloc(64, 0);
  for (let i = 0; i < 8; i++) {
    image[i] = image[56 + i] = 0xff;
    image[i * 8] = image[i * 8 + 7] = 0xff;
  }
  return { id, width: 8, height: 8, x: 0, y: 8, offX: 8 * 64, offY: 0, image };
}
const SOLID_LIT = 64; // 8x8 filled
const HOLLOW_LIT = 28; // 8x8 border
const BOTH_LIT = SOLID_LIT + HOLLOW_LIT;

/** black rgb24 pixmap + picture + solid white source, owned by `c` */
function makeCanvas(c) {
  const pid = c.X.AllocID();
  c.X.CreatePixmap(pid, c.display.screen[0].root, c.display.screen[0].root_depth, W, H);
  const picId = c.X.AllocID();
  c.Render.CreatePicture(picId, pid, c.Render.rgb24);
  const srcId = c.X.AllocID();
  c.Render.CreateSolidFill(srcId, 1, 1, 1, 1);
  return { pid, picId, srcId };
}

const clear = (c, canvas) =>
  c.Render.FillRectangles(SRC, canvas.picId, [0, 0, 0, 1], [0, 0, W, H]);

/** lit pixel count and bounding box of the canvas */
function readLit(c, canvas) {
  return new Promise((resolve, reject) => {
    c.X.GetImage(2, canvas.pid, 0, 0, W, H, 0xffffffff, (err, img) => {
      if (err) return reject(new Error(`GetImage: ${err.message}`));
      let lit = 0;
      let minX = Infinity;
      let maxX = -Infinity;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const o = (y * W + x) * 4;
          if (img.data[o] > 127 || img.data[o + 1] > 127 || img.data[o + 2] > 127) {
            lit++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
          }
        }
      }
      resolve({ lit, minX, maxX });
    });
  });
}

async function drawAndRead(c, canvas, gsid, elts) {
  clear(c, canvas);
  c.Render.CompositeGlyphs8(OVER, canvas.srcId, canvas.picId, 0, gsid, 0, 0, elts);
  await sync(c);
  return readLit(c, canvas);
}

/**
 * A disconnect is only *eventually* visible to other connections — request
 * order across two sockets is undefined — so poll until the dead client's
 * glyphset XID actually errors. This both proves the stale-XID fence and is
 * the deterministic "closedown finished" barrier the later scenarios need.
 */
async function waitClosedown(c, canvas, deadGsid, what) {
  await withTimeout(
    (async () => {
      for (;;) {
        const from = c.errors.length;
        const r = await drawAndRead(c, canvas, deadGsid, [[20, 20, '\x07']]);
        const errs = c.errors.slice(from);
        if (errs.length > 0) {
          assert.match(errs[0].message, /GLYPHSET argument/, `${what}: wrong error`);
          assert.equal(r.lit, 0, `${what}: stale XID must draw nothing`);
          return;
        }
      }
    })(),
    5000,
    `${what}: closedown never became visible`
  );
}

/** the whole scenario, over any pair-of-connections factory */
async function runScenarios(t, makeConn) {
  // every connection joins `open` the moment it exists: a factory that fails
  // (or times out) on the second or third call would otherwise strand the
  // ones already made, and a live X socket refs the event loop for as long as
  // the process lives — `node --test` reports and then never exits
  const open = [];
  const conn = async () => {
    const c = await makeConn();
    open.push(c);
    return c;
  };
  try {
    const A = await conn();
    const B = await conn();
    const C = await conn();
    // A creates the set and uploads two glyphs
    const gsA = A.X.AllocID();
    A.Render.CreateGlyphSet(gsA, A.Render.a8);
    A.Render.AddGlyphs(gsA, [solidGlyph(7), hollowGlyph(9)]);
    await sync(A);

    // 1: another connection composites via the raw XID
    const canvas = makeCanvas(B);
    let r = await drawAndRead(B, canvas, gsA, [[20, 20, '\x07\x09']]);
    assert.equal(r.lit, BOTH_LIT, 'cross-client raw-XID composite');
    assert.equal(B.errors.length, 0, `unexpected errors: ${B.errors.map((e) => e.message)}`);

    // 2: B references the set, A disconnects, glyphs live on
    const gsB = B.X.AllocID();
    B.Render.ReferenceGlyphSet(gsB, gsA);
    await sync(B);
    A.X.terminate();
    await waitClosedown(B, canvas, gsA, 'creator disconnect');
    r = await drawAndRead(B, canvas, gsB, [[20, 20, '\x07\x09']]);
    assert.equal(r.lit, BOTH_LIT, 'reference must survive creator disconnect');

    // 3: unknown glyph id between two known ones — record, per server
    const from = B.errors.length;
    r = await drawAndRead(B, canvas, gsB, [[20, 20, '\x07\x63\x09']]);
    const missErrs = B.errors.slice(from);
    if (missErrs.length === 0) {
      // Xorg: skipped without a pen advance — both drawn glyphs adjacent
      assert.equal(r.lit, BOTH_LIT, 'skipped id must not drop known glyphs');
      assert.equal(r.maxX - r.minX + 1, 16, 'skipped id must not advance the pen');
      t.diagnostic('missing glyph id: silently skipped, no pen advance (Xorg semantics)');
    } else {
      assert.match(missErrs[0].message, /GLYPH argument/);
      t.diagnostic('missing glyph id: GLYPH error (js server semantics)');
    }

    // 4: C references B's alias; B dies; the chain still holds
    const gsC = C.X.AllocID();
    C.Render.ReferenceGlyphSet(gsC, gsB);
    await sync(C);
    B.X.terminate();
    const canvasC = makeCanvas(C);
    await waitClosedown(C, canvasC, gsB, 'second-generation disconnect');
    r = await drawAndRead(C, canvasC, gsC, [[20, 20, '\x07\x09']]);
    assert.equal(r.lit, BOTH_LIT, 'chained reference must survive');

    // 5: a non-creator adds glyphs through its own alias (the closedown
    // barrier above already logged its deliberate stale-XID error on C, so
    // compare against a baseline, not zero)
    const cFrom = C.errors.length;
    C.Render.AddGlyphs(gsC, [solidGlyph(11)]);
    r = await drawAndRead(C, canvasC, gsC, [[20, 20, '\x0b']]);
    assert.equal(r.lit, SOLID_LIT, 'non-creator AddGlyphs via alias');
    const cErrs = C.errors.slice(cFrom);
    assert.equal(cErrs.length, 0, `unexpected errors: ${cErrs.map((e) => e.message)}`);
  } finally {
    for (const c of open) {
      try {
        c.X.terminate();
      } catch {
        // already gone
      }
    }
  }
}

test('shared glyphsets across connections (pure-JS server)', async (t) => {
  const server = xserver.createServer({ width: 320, height: 240 });
  await runScenarios(t, () => {
    const [serverEnd, clientEnd] = xserver.createStreamPair();
    server.addClientStream(serverEnd);
    return withTimeout(
      connect({ stream: clientEnd }),
      5000,
      'connecting to js server',
      (late) => late.X.terminate()
    );
  });
});

test('shared glyphsets across connections (real X server)', async (t) => {
  if (!process.env.DISPLAY) {
    t.skip('no DISPLAY set');
    return;
  }
  let first;
  try {
    first = await withTimeout(connect({}), 5000, 'connecting to X server', (late) => late.X.terminate());
  } catch (err) {
    t.skip(`cannot connect to X server: ${err.message}`);
    return;
  }
  let used = false;
  await runScenarios(t, () => {
    if (!used) {
      used = true;
      return first;
    }
    return withTimeout(connect({}), 5000, 'connecting to X server', (late) => late.X.terminate());
  });
});
