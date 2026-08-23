// Extension events against a real X server: DamageNotify, ShapeNotify and
// XFixes SelectionNotify delivered to the ntk object they name (issue #290).
//
// This is the half the hermetic test cannot check — that the type codes the
// server really assigned are the ones the routing learnt, and that delivery
// rides the window's own frame machinery (a damage burst arrives coalesced,
// with its rectangles). Skipped where there is no DISPLAY, and per-extension
// where the server lacks the extension.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';

import { createClient } from '../lib/index.js';
import { withTimeout } from './helpers/async.js';

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

const nextEvent = (emitter, name) =>
  withTimeout(new Promise((resolve) => emitter.once(name, resolve)), 5000, `a '${name}' event`);

test('drawing on a window delivers coalesced damage to its wrapper', async (t) => {
  if (skip) return t.skip(skip);
  const damage = await app.damage();
  if (!damage) return t.skip('server has no DAMAGE');

  const wnd = app.createWindow({ width: 120, height: 90 });
  const ctx = wnd.getContext('2d');
  wnd.map();
  await withTimeout(once(wnd, 'map'), 5000, 'the window to map');

  // RawRectangles: every damaged rectangle is its own event, which is the
  // report level that makes coalescing observable — and the one a compositor
  // that wants ev.rects would pick
  const damageId = app.X.AllocID();
  damage.Create(damageId, wnd.id, damage.ReportLevel.RawRectangles);

  const delivered = nextEvent(wnd, 'damage');
  ctx.fillStyle = 'red';
  ctx.fillRect(10, 10, 50, 40);
  const ev = await delivered;

  assert.equal(ev.window, wnd, 'the event carries its Window');
  assert.equal(ev.target, wnd);
  assert.equal(ev.damage, damageId, 'the DAMAGE object id, for Subtract');
  assert.ok(Array.isArray(ev.rects) && ev.rects.length >= 1, 'rect list, like expose');
  assert.ok(ev.width > 0 && ev.height > 0, 'a non-empty bounding box');
  // the blit that damaged the window covers what was drawn, so the reported
  // box must touch it
  assert.ok(ev.x < 60 && ev.x + ev.width > 10, `box [${ev.x}, ${ev.x + ev.width}) misses x 10..60`);
  assert.ok(ev.y < 50 && ev.y + ev.height > 10, `box [${ev.y}, ${ev.y + ev.height}) misses y 10..50`);

  damage.Destroy(damageId);
  wnd.destroy();
});

test('drawing on a pixmap delivers damage to the pixmap itself', async (t) => {
  if (skip) return t.skip(skip);
  const damage = await app.damage();
  if (!damage) return t.skip('server has no DAMAGE');

  const pixmap = app.createPixmap({
    width: 40,
    height: 30,
    depth: app.display.screen[0].root_depth
  });
  const damageId = app.X.AllocID();
  damage.Create(damageId, pixmap.id, damage.ReportLevel.NonEmpty);

  const delivered = nextEvent(pixmap, 'damage');
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'blue';
  ctx.fillRect(0, 0, 40, 30);
  const ev = await delivered;

  assert.equal(ev.target, pixmap, 'a damage created on a pixmap routes to the Pixmap');
  assert.equal(ev.window, undefined, 'no window field on a pixmap event');
  assert.equal(ev.damage, damageId);
  assert.ok(ev.width > 0 && ev.height > 0);

  damage.Destroy(damageId);
  pixmap.destroy();
});

test('reshaping a window delivers a shape event', async (t) => {
  if (skip) return t.skip(skip);
  const shape = await app.shape();
  if (!shape) return t.skip('server has no SHAPE');

  const wnd = app.createWindow({ width: 60, height: 60 });
  shape.SelectInput(wnd.id, true);

  const delivered = nextEvent(wnd, 'shape');
  shape.Rectangles(shape.Op.Set, shape.Kind.Bounding, wnd.id, 0, 0, [[0, 0, 30, 30]]);
  const ev = await delivered;

  assert.equal(ev.window, wnd);
  assert.equal(ev.kind, 'bounding');
  assert.equal(ev.shaped, true);
  assert.ok(ev.width > 0 && ev.height > 0);

  wnd.destroy();
});

test('a selection changing owners delivers selection_owner to the watcher', async (t) => {
  if (skip) return t.skip(skip);
  const fixes = await app.xfixes();
  if (!fixes) return t.skip('server has no XFIXES');

  const watcher = app.createWindow({ width: 10, height: 10 });
  const owner = app.createWindow({ width: 10, height: 10 });
  const atom = await new Promise((resolve, reject) =>
    app.X.InternAtom(false, `NTK_TEST_SELECTION_${process.pid}`, (err, a) =>
      err ? reject(err) : resolve(a)
    )
  );
  fixes.SelectSelectionInput(watcher.id, atom, fixes.SelectionEventMask.SetSelectionOwner);

  const delivered = nextEvent(watcher, 'selection_owner');
  app.X.SetSelectionOwner(owner.id, atom);
  const ev = await delivered;

  assert.equal(ev.window, watcher, 'delivered to the window that selected the input');
  assert.equal(ev.selection, atom);
  assert.equal(ev.owner, owner.id);
  assert.equal(ev.reason, 'new-owner');

  watcher.destroy();
  owner.destroy();
});
