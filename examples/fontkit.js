const ntk = require('..');
const fontkit = require('fontkit');
const throttle = require('lodash.throttle');

async function main() {
  const app = await ntk.createClient();
  const window = app.createWindow();
  window.map();
  window.setActions();

  //const path =
  //  '/usr/share/texlive/texmf-dist/fonts/truetype/huerta/alegreya/AlegreyaSans-LightItalic.ttf';
  //const path = '/usr/share/fonts/truetype/ubuntu/Ubuntu.ttf';

  //const path = 'PT-Serif.woff2';
  const path = 'LibreBaskerville.woff2';
  var font = fontkit.openSync(path);

  // layout a string, using default shaping features.
  // returns a GlyphRun, describing glyphs and positions.
  var run = font.layout(
    'Simp' //lifies a 2D polyline, first using a radial distance check, and then a recursive Douglas-Peucker algorithm.'
  );

  //console.log(run);
  let size = 900;

  const ctx = window.getContext('2d');
  const _update = () => {
    let left = 0;
    let scale = size / 2048;
    const svgs = run.glyphs.map((g, index) => {
      var path = g.path.scale(scale, -scale).translate(10 + left * scale, 800);
      left += run.positions[index].xAdvance;
      return path.toFunction();
    });

    ctx.fillStyle = 'rgb(140,100,100)';
    ctx.fillRect(0, 0, window.width, window.height);
    ctx.fillStyle = 'rgba(10,10,10, 0.5)';
    ctx.lineWidth = size / 200;
    svgs.forEach((svg, index) => {
      if (run.glyphs[index].traps) {
        ctx.fillTraps(run.glyphs[index].traps);
      } else {
        ctx.beginPath();
        svg(ctx);
        ctx.closePath();
        const traps = ctx._rasterizeTrapFill();
        ctx.fillTraps(traps);
        run.glyphs[index].traps = traps;
      }
    });
  };
  const update = throttle(_update, 130);
  window.on('expose', update);
  window.on('mousedown', ev => {
    if (ev.keycode == 4) {
      size *= 0.99;
    }
    if (ev.keycode == 5) {
      size *= 1.01;
    }
    update();
  });
}

main().catch(err => console.log(err));
