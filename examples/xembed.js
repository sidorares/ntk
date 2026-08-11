// XEmbed: another program's window living inside ours.
//
//   node examples/xembed.js              embed a second ntk process (a plug)
//   node examples/xembed.js xterm        embed anything that takes -into WID
//   node examples/xembed.js xterm -fa Mono -fs 12
//
// The two halves of the protocol, and the two shapes an embedding comes in:
//
//   embed(id)  — you were handed a window id (a GtkPlug, a tray icon, the
//                XEmbedPlug below) and you reparent it into your own window
//   adopt()    — you handed *out* your window id and the program put its own
//                window inside it (xterm -into, mpv --wid), so there is
//                nothing to reparent and everything else is the same
//
// Click the embedded area to give it the focus: the host sends
// XEMBED_FOCUS_IN and the plug repaints to show it has it. Keystrokes go
// through the focus proxy, which is why they arrive at the plug and not here.

import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createClient, XEMBED, XEmbedPlug, XEmbedSocket } from '../lib/index.js';

const self = fileURLToPath(import.meta.url);

if (process.argv.includes('--plug')) {
  await plugMain();
} else {
  await socketMain(process.argv.slice(2));
}

// ---------------------------------------------------------------------
// the embedder
// ---------------------------------------------------------------------

async function socketMain(command) {
  const app = await createClient();
  const wnd = app.createWindow({ title: 'ntk — XEmbed', width: 640, height: 420 });
  const ctx = wnd.getContext('2d');

  const BOX = { x: 24, y: 64, width: 592, height: 320 };
  const socket = new XEmbedSocket(wnd, BOX);

  let status = command.length ? `starting ${command[0]}…` : 'starting the plug…';
  let focused = false;

  const paint = () => {
    ctx.fillStyle = '#1d2027';
    ctx.fillRect(0, 0, wnd.width, wnd.height);
    ctx.fillStyle = '#e6e8ee';
    ctx.font = '15px sans-serif';
    ctx.fillText('XEmbed socket', 24, 32);
    ctx.fillStyle = focused ? '#7dd3a0' : '#7f8694';
    ctx.font = '12px sans-serif';
    ctx.fillText(status, 24, 52);
    // a frame around the socket, so the seam between the two clients shows
    ctx.strokeStyle = focused ? '#7dd3a0' : '#3a3f4b';
    ctx.lineWidth = 2;
    ctx.strokeRect(BOX.x - 2, BOX.y - 2, BOX.width + 4, BOX.height + 4);
  };

  wnd.on('expose', paint);
  wnd.map();

  // click anywhere to hand the logical focus to the client, and take it back
  // when the click lands outside
  wnd.on('mousedown', (ev) => {
    const inside =
      ev.x >= BOX.x && ev.y >= BOX.y && ev.x < BOX.x + BOX.width && ev.y < BOX.y + BOX.height;
    if (inside === focused) return;
    focused = inside;
    if (inside) socket.focusIn(XEMBED.FOCUS_CURRENT, { time: ev.time });
    else socket.focusOut({ time: ev.time });
    paint();
  });

  // the toplevel gaining or losing the window manager's focus is what
  // activation means to the client
  wnd.on('focus', () => socket.activate(true));
  wnd.on('blur', () => socket.activate(false));

  socket.on('embedded', ({ id, xembed }) => {
    status = `embedded window ${id} — ${xembed ? 'speaks XEmbed' : 'plain reparenting'}`;
    paint();
  });
  socket.on('requestFocus', () => {
    focused = true;
    paint();
  });
  socket.on('gone', () => {
    status = 'the client is gone';
    focused = false;
    paint();
  });

  wnd.on('close', async () => {
    await socket.destroy();
    await app.close();
    process.exit(0);
  });

  try {
    if (command.length) {
      // `xterm -into ID` creates its window inside ours: nothing to reparent
      const [program, ...args] = command;
      const child = spawn(program, [...args, '-into', String(socket.window.id)], {
        stdio: 'inherit'
      });
      child.on('error', (err) => {
        status = `could not start ${program}: ${err.message}`;
        paint();
      });
      await socket.adopt({ timeout: 15000 });
    } else {
      // the plug publishes a window id and waits to be reparented
      const child = fork(self, ['--plug'], { stdio: 'inherit' });
      const id = await new Promise((resolve, reject) => {
        child.once('message', (m) => resolve(m.plug));
        child.once('exit', (code) => reject(new Error(`the plug exited with code ${code}`)));
      });
      await socket.embed(id);
    }
  } catch (err) {
    status = err.message;
    paint();
  }
}

// ---------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------

async function plugMain() {
  const app = await createClient();
  const plug = new XEmbedPlug(app, { width: 592, height: 320 });
  await plug.ready;

  const ctx = plug.window.getContext('2d');
  let typed = '';

  const paint = () => {
    ctx.fillStyle = plug.active ? '#242a38' : '#20242e';
    ctx.fillRect(0, 0, plug.window.width, plug.window.height);
    ctx.fillStyle = '#9aa3b4';
    ctx.font = '13px sans-serif';
    ctx.fillText('a second process, drawing inside the first one', 24, 40);
    ctx.fillStyle = plug.focused ? '#7dd3a0' : '#5b6272';
    ctx.font = '15px sans-serif';
    ctx.fillText(
      plug.focused ? 'focused — type something' : 'click me to take the focus',
      24,
      72
    );
    if (typed) {
      ctx.fillStyle = '#e6e8ee';
      ctx.font = '20px sans-serif';
      ctx.fillText(typed.slice(-40), 24, 112);
    }
  };

  plug.window.on('expose', paint);
  // the embedder is the one that maps us, once it has seen XEMBED_MAPPED
  for (const event of ['activate', 'deactivate', 'focusIn', 'focusOut']) {
    plug.on(event, paint);
  }
  plug.on('embedded', (embedder) => {
    process.stderr.write(`plug: embedded into window ${embedder}\n`);
    paint();
  });
  plug.on('released', () => process.stderr.write('plug: released\n'));

  // a click asks the embedder for the focus rather than taking it
  plug.window.on('mousedown', () => plug.requestFocus());
  plug.window.on('keydown', (ev) => {
    if (ev.codepoint) typed += String.fromCodePoint(ev.codepoint);
    else if (ev.keysym === 0xff08) typed = typed.slice(0, -1); // BackSpace
    paint();
  });

  process.send?.({ plug: plug.window.id });
}
