import { createClient } from '../lib/index.js';

const app = await createClient();
const wnd = app.createWindow({
  title: 'opengl drawable as texture example',
  x: 100,
  y: 100,
  width: 300,
  height: 300
});
wnd.map();
const xpixmap = wnd.createPixmap({ width: 512, height: 512, depth: 24 });
const gl = wnd.getContext('opengl');
const glxPixmapId = gl.CreateGLXPixmap(xpixmap.id);
console.log('created GLX pixmap', glxPixmapId, 'for pixmap', xpixmap.id);
// gl.BindTexImage(glxPixmapId, 0x20de /* GLX_FRONT_LEFT_EXT */);
