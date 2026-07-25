// Type into the window; text is shaped (kerning, bidi, font fallback) and
// drawn with a gradient fill. Try pasting mixed-script text: hello عالم 世界
import { createClient } from '../lib/index.js';

const app = await createClient();
const wnd = app.createWindow({ width: 800, height: 600 });
const ctx = wnd.getContext('2d');

let text = 'Type AVAST — kerning works';

wnd.on('expose', () => {
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, wnd.width, wnd.height);

  ctx.font = "50px 'Times New Roman'";
  const m = ctx.measureText(text);
  ctx.fillStyle = ctx
    .createLinearGradient(100, 0, 100 + m.width, 0)
    .addColorStop(0, 'red')
    .addColorStop(1, 'blue');
  ctx.fillText(text, 100, 100);

  // multi-line layout wrapped to the window width
  ctx.font = '20px sans-serif';
  ctx.fillStyle = '#333';
  const layout = ctx.layoutText(
    'This paragraph is laid out with ctx.layoutText(): it wraps to the ' +
      'window width, strips trailing spaces at line ends, and reuses shaped ' +
      'words on every relayout — resize the window to see it reflow. ' +
      'Mixed directions work too: النص العربي يتدفق من اليمين إلى اليسار.',
    { maxWidth: wnd.width - 200, lineHeight: 1.35 }
  );
  layout.draw(ctx, 100, 160);
});

wnd.on('keydown', (ev) => {
  if (ev.codepoint === 8) text = text.slice(0, -1);
  else if (ev.codepoint) text += String.fromCodePoint(ev.codepoint);
  wnd.emit('expose', {});
});

// no resize handler needed: the window is double-buffered and re-emits
// 'expose' itself when its size changes

wnd.map();
