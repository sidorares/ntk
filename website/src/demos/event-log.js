export default {
  id: 'event-log',
  title: 'Event log',
  description:
    'Browser-style events (mousedown, keydown, mousemove, …) drawn as text lines and echoed to the console.',
  code: `const { createClient } = require('ntk');

async function main() {
  const app = await createClient();
  const wnd = app.createWindow({
    x: 20, y: 20, width: 600, height: 440,
    title: 'event log'
  });
  const ctx = wnd.getContext('2d');

  const MAX_LINES = 18;
  const lines = ['move / click / type inside the window'];

  function draw() {
    ctx.fillStyle = '#101820';
    ctx.fillRect(0, 0, wnd.width, wnd.height);
    ctx.font = '14px monospace';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillStyle = i === lines.length - 1 ? '#ffb703' : '#8fa3b8';
      ctx.fillText(lines[i], 16, 28 + i * 22);
    }
  }

  function log(text) {
    lines.push(text);
    if (lines.length > MAX_LINES) lines.shift();
    draw();
  }

  wnd.on('expose', draw);

  wnd.on('mousedown', (ev) => log('mousedown  button=' + ev.keycode + ' at ' + ev.x + ',' + ev.y));
  wnd.on('mouseup', (ev) => log('mouseup    at ' + ev.x + ',' + ev.y));
  wnd.on('mouseover', () => log('mouseover'));
  wnd.on('mouseout', () => log('mouseout'));

  // keydown carries ev.codepoint (unicode) resolved from the keymap
  wnd.on('keydown', (ev) => {
    const ch = ev.codepoint ? JSON.stringify(String.fromCodePoint(ev.codepoint)) : '';
    log('keydown    keycode=' + ev.keycode + ' ' + ch);
    console.log('keydown', ev.keycode, ch);
  });

  // mousemove is coalesced per frame — the newest position wins
  wnd.on('mousemove', (ev) => {
    const text = 'mousemove  ' + ev.x + ',' + ev.y;
    if (lines[lines.length - 1] && lines[lines.length - 1].startsWith('mousemove')) {
      lines[lines.length - 1] = text;
      draw();
    } else {
      log(text);
    }
  });

  wnd.map();
  console.log('listening for events');
}

main().catch(console.error);
`,
};
