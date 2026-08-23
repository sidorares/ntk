// Extension event routing (issue #290): DamageNotify, ShapeNotify and the
// XFIXES notifies carry a server-assigned type code and name their target
// under `drawable`/`window` rather than `wid`, so node-x11's per-window
// dispatch never routes them. App learns their codes when an extension is
// required through its accessors and hands each one to the drawable it
// names, under an ntk name.
//
// Hermetic — the extension objects and the event stream are stubs, because
// what is under test is the registration, the lookup and the translation.
// The full path against a real server (frame-coalesced delivery included) is
// extension-events-live.test.js.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import App from '../lib/app.js';
import Pixmap from '../lib/pixmap.js';
import * as xevents from '../lib/events_map.js';

// firstEvent values as a real server might assign them — arbitrary, distinct
const EXTS = {
  damage: { majorOpcode: 143, firstEvent: 91, events: { DamageNotify: 0 } },
  fixes: { majorOpcode: 138, firstEvent: 87, events: { SelectionNotify: 0, CursorNotify: 1 } },
  shape: { majorOpcode: 129, firstEvent: 64, events: { ShapeNotify: 0 } }
};

/** An App on a stub client that "has" every extension in EXTS. */
function makeApp() {
  const X = new EventEmitter();
  X.atoms = {};
  X.event_consumers = {};
  X.require = (name, cb) => {
    const ext = EXTS[name];
    setImmediate(() => (ext ? cb(null, ext) : cb(new Error('extension not available'))));
  };
  const app = new App({ client: X, screen: [{ root: 1 }] }, {});
  return { app, X };
}

/** An ntk-drawable-shaped consumer that records what reaches it. */
function consumer() {
  const delivered = [];
  return { delivered, _deliverEvent: (name, ev) => delivered.push({ name, ev }) };
}

test('DamageNotify reaches the drawable it names, expose-shaped', async () => {
  const { app, X } = makeApp();
  const wnd = consumer();
  X.event_consumers[5001] = wnd;

  await app.damage();
  X.emit('event', {
    type: EXTS.damage.firstEvent,
    name: 'DamageNotify',
    level: 1 | 0x80,
    drawable: 5001,
    damage: 777,
    time: 12345,
    area: { x: 10, y: 20, w: 30, h: 40 },
    geometry: { x: 0, y: 0, w: 200, h: 200 }
  });

  assert.equal(wnd.delivered.length, 1);
  const { name, ev } = wnd.delivered[0];
  assert.equal(name, 'damage');
  assert.deepEqual(
    { x: ev.x, y: ev.y, width: ev.width, height: ev.height },
    { x: 10, y: 20, width: 30, height: 40 },
    'the damaged box lands where expose puts it, so union coalescing applies'
  );
  assert.equal(ev.damage, 777, 'the DAMAGE object id, for Subtract');
  assert.equal(ev.level, 1, 'report level without the wire flag bit');
  assert.equal(ev.more, true, 'the flag bit, split out');
  assert.deepEqual(ev.geometry, { x: 0, y: 0, w: 200, h: 200 });
  assert.equal(ev.target, wnd, 'events carry their target object');
});

test('ShapeNotify and the XFIXES notifies route by their window field', async () => {
  const { app, X } = makeApp();
  const wnd = consumer();
  X.event_consumers[42] = wnd;

  await Promise.all([app.shape(), app.xfixes()]);

  X.emit('event', {
    type: EXTS.shape.firstEvent,
    name: 'ShapeNotify',
    kind: 0,
    window: 42,
    x: 1,
    y: 2,
    width: 3,
    height: 4,
    time: 9,
    shaped: 1
  });
  X.emit('event', {
    type: EXTS.fixes.firstEvent + EXTS.fixes.events.SelectionNotify,
    name: 'SelectionNotify',
    subtype: 0,
    window: 42,
    owner: 600,
    selection: 31,
    timestamp: 100,
    selectionTimestamp: 99
  });
  X.emit('event', {
    type: EXTS.fixes.firstEvent + EXTS.fixes.events.CursorNotify,
    name: 'CursorNotify',
    subtype: 0,
    window: 42,
    cursorSerial: 8,
    timestamp: 101,
    cursorName: 0
  });

  assert.deepEqual(
    wnd.delivered.map((d) => d.name),
    ['shape', 'selection_owner', 'cursor']
  );
  const [shape, owner, cursor] = wnd.delivered.map((d) => d.ev);
  assert.equal(shape.kind, 'bounding', 'ShapeKind by name');
  assert.equal(shape.shaped, true);
  assert.deepEqual(
    { x: shape.x, y: shape.y, width: shape.width, height: shape.height },
    { x: 1, y: 2, width: 3, height: 4 }
  );
  assert.equal(owner.reason, 'new-owner', 'the vocabulary clipboard.watch answers in');
  assert.equal(owner.owner, 600);
  assert.equal(owner.selection, 31);
  assert.equal(cursor.cursorSerial, 8);
  assert.equal(cursor.time, 101, "the timestamp under the name ntk's other events use");
});

test('the type code is what routes, not the name the parser wrote', async () => {
  // every extension parser sets `type` since x11 4.0.0 (node-x11#284), so the
  // server-assigned code is the whole key: a name alone reaches nothing, and
  // a type alone is enough
  const { app, X } = makeApp();
  const wnd = consumer();
  X.event_consumers[5001] = wnd;

  await app.damage();
  const damage = {
    name: 'DamageNotify',
    level: 0,
    drawable: 5001,
    damage: 1,
    time: 0,
    area: { x: 1, y: 1, w: 2, h: 2 },
    geometry: { x: 0, y: 0, w: 9, h: 9 }
  };
  X.emit('event', damage);
  assert.equal(wnd.delivered.length, 0, 'a name is not a route');

  X.emit('event', { ...damage, name: undefined, type: EXTS.damage.firstEvent });
  assert.equal(wnd.delivered.length, 1);
  assert.equal(wnd.delivered[0].name, 'damage');
});

test('nothing routes before the extension has been required', async () => {
  const { app, X } = makeApp();
  const wnd = consumer();
  X.event_consumers[5001] = wnd;

  X.emit('event', { type: EXTS.damage.firstEvent, drawable: 5001, area: {}, geometry: {} });
  assert.equal(wnd.delivered.length, 0, 'the type code means nothing yet');
  assert.equal(X.listenerCount('event'), 0, 'and no listener sits on an unused connection');

  await app.damage();
  X.emit('event', {
    type: EXTS.damage.firstEvent,
    drawable: 5001,
    level: 0,
    area: { x: 0, y: 0, w: 1, h: 1 },
    geometry: { x: 0, y: 0, w: 1, h: 1 }
  });
  assert.equal(wnd.delivered.length, 1, 'requiring the extension is what arms the route');
});

test('an event naming nothing we wrap, or a consumer that is not ours, is left alone', async () => {
  const { app, X } = makeApp();
  const plain = new EventEmitter(); // a caller's own event_consumers entry
  let raw = 0;
  plain.on('event', () => raw++);
  X.event_consumers[7] = plain;

  await app.damage();
  // no entry for this drawable at all — must not throw
  X.emit('event', { type: EXTS.damage.firstEvent, drawable: 999, area: {}, geometry: {} });
  // an entry that is not an ntk drawable — must be left to its raw stream
  X.emit('event', { type: EXTS.damage.firstEvent, drawable: 7, area: {}, geometry: {} });
  assert.equal(raw, 0, 'ntk does not double-deliver into foreign consumers');
});

test('extension event names collide with nothing the core tables hand out', () => {
  for (const name of xevents.extensionEventNames) {
    assert.ok(!Object.values(xevents.eventName).includes(name), `'${name}' vs core event names`);
    assert.ok(!(name in xevents.mask), `'${name}' vs the mask table`);
  }
  assert.equal(xevents.coalesce.damage, 'union', 'damage coalesces the way expose does');
});

test('a pixmap enrols for routing when listened to, and leaves on destroy', () => {
  let ids = 9000;
  const X = {
    atoms: {},
    on() {},
    event_consumers: {},
    AllocID: () => ++ids,
    CreatePixmap() {}
  };
  const app = { X, display: { screen: [{ root: 1 }] } };

  const pixmap = new Pixmap(app, { width: 4, height: 4 });
  pixmap.on('newListener', () => {}); // any non-extension name changes nothing
  assert.equal(X.event_consumers[pixmap.id], undefined, 'no listener, no entry, no pinning');

  pixmap.on('damage', () => {});
  assert.equal(X.event_consumers[pixmap.id], pixmap, 'a damage listener enrols it');

  pixmap.destroy();
  assert.equal(X.event_consumers[pixmap.id], undefined, 'destroy removes the entry');
});
