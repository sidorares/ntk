import { createClient } from '../lib/index.js';

const app = await createClient();

const wnd = app.createWindow({ title: 'Click me!', x: 100, y: 100, width: 300, height: 300 });
wnd
  .on('mouseover', () => console.log('In'))
  .on('mouseout', () => console.log('Out'))
  .on('mousedown', (ev) => {
    wnd.setTitle(`click: ${ev.x},${ev.y}`);
    wnd.unmap();
    setTimeout(() => wnd.map(), 1000);
  })
  .map();
