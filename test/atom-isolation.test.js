// Each connection gets its own atom table (lib/app.js `_isolateAtoms`).
//
// node-x11 gives every client the same table object and answers InternAtom
// out of it without a round trip, so an id interned on one connection is
// handed to every other connection in the process. An X server frees every
// atom it holds the moment its last client disconnects, and reissues the
// same ids to whatever is interned next — so a process that opens
// connections in sequence ends up writing properties with ids the server has
// forgotten, or worse, ids it has since given to a different name.
//
// Against a live server the shape is:
//
//   xvfb-run -a node -e "... four Apps in sequence, each createWindow+map ..."
//   ntk: unhandled X error: Bad atom (opcode 18, seq 12)   # one per app
//
// which needs a server nothing else is connected to — a window manager holds
// the server open and hides the whole thing. These tests pin the invariant
// instead, which holds everywhere.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import App from '../lib/app.js';

/** node-x11's own predefined table: ids 1..68, fixed by the core protocol. */
const PREDEFINED = { PRIMARY: 1, ATOM: 4, CARDINAL: 6, STRING: 31, WM_NAME: 39, WM_TRANSIENT_FOR: 68 };

/**
 * Two clients over one shared atoms object, the way node-x11 builds them.
 * `stdatoms` is assigned rather than copied, so both start out pointing at
 * the very same object.
 */
function makeConnections(count) {
  const shared = { ...PREDEFINED };
  const apps = [];
  for (let i = 0; i < count; i++) {
    const X = {
      atoms: shared,
      atom_names: Object.fromEntries(Object.entries(shared).map(([n, v]) => [v, n])),
      on() {}
    };
    apps.push(new App({ client: X, screen: [{ root: 1 }] }, {}));
  }
  return { apps, shared };
}

test('an atom interned on one connection is not visible to the next', () => {
  const { apps, shared } = makeConnections(2);
  // the first connection interns something at runtime, as setPid does; the
  // reply handler writes it into what node-x11 thinks is that client's table
  apps[0].X.atoms._NET_WM_PID = 233;

  assert.equal(
    apps[1].X.atoms._NET_WM_PID,
    undefined,
    'the second connection must ask the server itself'
  );
  assert.equal(shared._NET_WM_PID, undefined, 'and the shared table is left alone');
});

test('predefined atoms are kept, because no server ever frees them', () => {
  const { apps } = makeConnections(1);
  const X = apps[0].X;
  for (const [name, id] of Object.entries(PREDEFINED)) {
    assert.equal(X.atoms[name], id, `${name} is fixed by the protocol`);
  }
});

test('a runtime atom already in the shared table is dropped, not inherited', () => {
  // the realistic case: something interned before this App was built — an
  // earlier App in the same process, or a raw node-x11 client
  const shared = { ...PREDEFINED, _NET_WM_PID: 233, WM_PROTOCOLS: 297 };
  const X = { atoms: shared, atom_names: {}, on() {} };
  const app = new App({ client: X, screen: [{ root: 1 }] }, {});

  assert.equal(app.X.atoms._NET_WM_PID, undefined);
  assert.equal(app.X.atoms.WM_PROTOCOLS, undefined);
  assert.equal(app.X.atoms.CARDINAL, 6, 'while the predefined ones survive');
});

test('atom_names is rebuilt to match, so a stale id resolves to no name', () => {
  const shared = { ...PREDEFINED, _NET_WM_PID: 233 };
  const X = {
    atoms: shared,
    atom_names: Object.fromEntries(Object.entries(shared).map(([n, v]) => [v, n])),
    on() {}
  };
  const app = new App({ client: X, screen: [{ root: 1 }] }, {});

  assert.equal(app.X.atom_names[233], undefined, 'no name for an id we never interned');
  assert.equal(app.X.atom_names[6], 'CARDINAL');
});

test('the table is the connection\'s own object, not the shared one', () => {
  const { apps, shared } = makeConnections(2);
  assert.notEqual(apps[0].X.atoms, shared);
  assert.notEqual(apps[1].X.atoms, shared);
  assert.notEqual(apps[0].X.atoms, apps[1].X.atoms);
});
