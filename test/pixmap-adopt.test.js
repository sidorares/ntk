// Pixmap adoption (sidorares/ntk#291): an id-only pixmap used to report
// depth 24 whatever it really was, know nothing of its size, and refuse
// ownership — so a compositor's XCompositeNameWindowPixmap result leaked by
// construction and tiled with its alpha channel dropped. Now nothing is
// defaulted, the constructor asks GetGeometry for whatever was not declared,
// `ready`/`getGeometry()` are the same waits an adopted window has, and
// `own`/`Pixmap.adopt` make destroy() mean it.
//
// Hermetic: node-x11's in-process pure-JS X server, two connections, so the
// adopted pixmap really belongs to another client the way a handed-over one
// does. The pure-JS server takes pixmaps at depth 32, so the case that loses
// the alpha channel runs against a real reply here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';

import xserver from 'x11/lib/xserver/index.js';

import Pixmap from '../lib/pixmap.js';
import { StaticFontSource, createClient } from '../lib/index.js';

const { createServer, createStreamPair } = xserver;

const docsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');

let server = null;
let host = null; // the adopter: a compositor, a client handed a pixmap
let guest = null; // the client whose pixmap it adopts

// Adopting a pixmap that has gone is half of what is under test, so the X
// errors it earns are expected output, not noise to print
const xErrors = [];

const connect = async () => {
  const [serverEnd, clientEnd] = createStreamPair();
  server.addClientStream(serverEnd);
  return createClient({
    stream: clientEnd,
    fontSource: new StaticFontSource(),
    onXError: (err) => xErrors.push(err)
  });
};

beforeEach(async () => {
  server = createServer({ width: 400, height: 300 });
  xErrors.length = 0;
  host = await connect();
  guest = await connect();
});

afterEach(() => {
  host?.X.terminate();
  guest?.X.terminate();
  server = host = guest = null;
});

/** drain the round trips a connection has in flight */
const settle = (app) => new Promise((resolve) => app.X.GetInputFocus(() => setImmediate(resolve)));

/** ask the server directly whether a drawable still answers */
const geometryOf = (app, id) =>
  new Promise((resolve, reject) => app.X.GetGeometry(id, (err, res) => (err ? reject(err) : resolve(res))));

test('a pixmap ntk created is ready without a round trip', async () => {
  const pixmap = host.createPixmap({ width: 16, height: 8, depth: 24 });

  let resolved = null;
  pixmap.ready.then((p) => (resolved = p));
  await Promise.resolve(); // one microtask: no room for any I/O
  assert.equal(resolved, pixmap, 'resolves with the pixmap, and immediately');
  pixmap.destroy();
});

test('an adopted pixmap defaults nothing and learns its real depth', async () => {
  const src = guest.createPixmap({ width: 100, height: 80, depth: 32 });
  await settle(guest);

  const adopted = new Pixmap(host, { id: src.id });
  assert.equal(adopted.depth, undefined, 'no invented depth 24 — nothing is known yet');
  assert.equal(adopted.width, undefined);
  assert.equal(adopted.height, undefined);

  let resolved = null;
  adopted.ready.then((p) => (resolved = p));
  await Promise.resolve();
  assert.equal(resolved, null, 'the wait is a real reply, not a formality');

  assert.equal(await adopted.ready, adopted);
  assert.equal(adopted.width, 100);
  assert.equal(adopted.height, 80);
  assert.equal(adopted.depth, 32, 'the depth a picture format is picked from');

  src.destroy();
});

test('declaring the full geometry costs no round trip', async () => {
  const src = guest.createPixmap({ width: 10, height: 10, depth: 32 });
  await settle(guest);

  const adopted = new Pixmap(host, { id: src.id, width: 10, height: 10, depth: 32 });
  let resolved = null;
  adopted.ready.then((p) => (resolved = p));
  await Promise.resolve();
  assert.equal(resolved, adopted, 'the caller already said everything GetGeometry would');
  assert.equal(adopted.depth, 32);

  src.destroy();
});

test('getGeometry() asks the server and writes the answer back', async () => {
  const src = guest.createPixmap({ width: 60, height: 40, depth: 24 });
  await settle(guest);

  const adopted = new Pixmap(host, { id: src.id });
  const geometry = await adopted.getGeometry();
  assert.deepEqual(geometry, {
    x: 0,
    y: 0,
    width: 60,
    height: 40,
    depth: 24,
    borderWidth: 0,
    root: host.display.screen[0].root
  });
  assert.equal(adopted.width, 60);
  assert.equal(await adopted.ready, adopted, 'the pending wait is settled by this reply too');

  src.destroy();
});

test('Pixmap.adopt owns: destroy() really frees the server-side pixmap', async () => {
  const src = guest.createPixmap({ width: 20, height: 20, depth: 24 });
  await settle(guest);

  const adopted = await Pixmap.adopt(host, src.id);
  assert.equal(adopted.width, 20);
  assert.equal(adopted.depth, 24);
  assert.equal(adopted._owned, true);

  adopted.destroy();
  await settle(host);
  await assert.rejects(() => geometryOf(guest, src.id), 'the pixmap is gone server-side');
});

test('destroy() without ownership stays a no-op', async () => {
  const src = guest.createPixmap({ width: 20, height: 20, depth: 24 });
  await settle(guest);

  const adopted = new Pixmap(host, { id: src.id });
  await adopted.ready;
  adopted.destroy();
  await settle(host);
  await assert.ok(await geometryOf(guest, src.id), 'someone else\'s pixmap was left alone');

  src.destroy();
});

test('adopting a pixmap that has already gone rejects with the remedy', async () => {
  const src = guest.createPixmap({ width: 20, height: 20, depth: 24 });
  const id = src.id;
  src.destroy();
  await settle(guest);

  await assert.rejects(
    () => Pixmap.adopt(host, id),
    (err) => {
      assert.match(err.message, /does not exist/);
      assert.match(err.message, /name it again/, 'the compositor remedy is named');
      assert.ok(err.cause, 'the X error rides along');
      return true;
    }
  );
});

test("a foreign id is freed but never recycled into this client's allocator", async () => {
  const src = guest.createPixmap({ width: 8, height: 8, depth: 24 });
  await settle(guest);

  const adopted = await Pixmap.adopt(host, src.id);
  adopted.destroy();
  assert.ok(
    !host.X._unusedIds.includes(src.id),
    "guest's id must not come back out of host's AllocID — the server would refuse it"
  );
});

test('an id this client allocated itself goes back into the pool', async () => {
  // the NameWindowPixmap shape: the adopter allocated the id, another party
  // (here: a raw request) made the pixmap live behind it
  const id = host.X.AllocID();
  host.X.CreatePixmap(id, host.display.screen[0].root, 24, 8, 8);

  const adopted = await Pixmap.adopt(host, id);
  assert.equal(adopted.width, 8);
  adopted.destroy();
  assert.ok(host.X._unusedIds.includes(id), 'the id is ours, so destroy() recycles it');
});

// ---------------------------------------------------------------------
// what the wait is for: the picture format a 2d context binds
// ---------------------------------------------------------------------

test('a context on an adopted pixmap rebinds when the depth turns out to be 32', async () => {
  const src = guest.createPixmap({ width: 32, height: 32, depth: 32 });
  await settle(guest);

  const adopted = new Pixmap(host, { id: src.id });
  const ctx = adopted.getContext('2d');
  const Render = host.display.Render;
  // an unknown depth is indistinguishable from 24 at this point, so the only
  // format available is the opaque one — this is where the alpha channel
  // used to be lost for good
  assert.equal(ctx.picture.format, Render.rgb24);

  await adopted.ready;
  await tick();
  assert.equal(ctx.picture.format, Render.rgba32, 'the reply changes the format, so the picture is rebuilt');
  assert.equal(ctx._hasAlpha, true, 'clearRect can clear to transparent again');

  src.destroy();
});

test('the docs sections the adoption story points at exist', () => {
  // a cross-file anchor is the one kind of doc link nothing else in CI checks
  const pixmap = readFileSync(join(docsDir, 'pixmap.md'), 'utf8');
  assert.ok(/^## Adoption$/m.test(pixmap), 'docs/pixmap.md#adoption');
  const resources = readFileSync(join(docsDir, 'resource-management.md'), 'utf8');
  assert.ok(resources.includes('pixmap.md#adoption'), 'and resource-management points at it');
});
