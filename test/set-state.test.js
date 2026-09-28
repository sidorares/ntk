// Window#setState sends a new size with both axes, even when only one of them
// changed. A window manager answers a request that names one axis with its
// own idea of the other: Muffin (Cinnamon) reads the height as its frame's,
// title bar included, so each width-only request grew the window by 32 px.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import Window from '../lib/window.js';

let nextId = 0xd000;

function makeWindow(args = {}) {
  const configures = [];
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
    ConfigureWindow(id, props) {
      configures.push(props);
    }
  };
  const display = { client: X, screen: [{ root: 1, root_depth: 24, white_pixel: 0xffffff }] };
  const wnd = new Window({ X, display }, { width: 400, height: 300, ...args });
  return { wnd, configures };
}

test('a width change sends the height with it', () => {
  const { wnd, configures } = makeWindow();
  wnd.setState({ width: 380, height: 300 });
  assert.deepEqual(configures, [{ width: 380, height: 300 }]);
  wnd.destroy();
});

test('an axis left out goes as the size the window has', () => {
  const { wnd, configures } = makeWindow();
  wnd.setState({ width: 360 });
  wnd.setState({ height: 280 });
  assert.deepEqual(configures, [
    { width: 360, height: 300 },
    { width: 400, height: 280 }
  ]);
  wnd.destroy();
});

test('a size that did not change sends nothing, and a move sends no size', () => {
  const { wnd, configures } = makeWindow({ x: 10, y: 20 });
  wnd.setState({ width: 400, height: 300 });
  wnd.setState({ x: 30, y: 20 });
  assert.deepEqual(configures, [{ x: 30 }]);
  wnd.destroy();
});
