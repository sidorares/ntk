const ntk = require('..');
const fontkit = require('fontkit');
const throttle = require('lodash.throttle');

async function main() {
  const app = await ntk.createClient();
  const window = app.createWindow();
  window.map();
  window.setActions();

  const path =
    '/usr/share/texlive/texmf-dist/fonts/truetype/huerta/alegreya/AlegreyaSans-LightItalic.ttf';
  // const path = '/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf';
  var font = fontkit.openSync(path);

  // layout a string, using default shaping features.
  // returns a GlyphRun, describing glyphs and positions.
  var run = font.layout('returns a GlyphRun, describing glyphs and positions');
  let left = 0;
  const svgs = run.glyphs.map((g, index) => {
    var path = g.path.scale(0.1, -0.1).translate(10 + left / 10, 300);
    left += run.positions[index].xAdvance;
    return path.toFunction();
  });

  //console.log(run);

  const ctx = window.getContext('2d');
  const _update = () => {
    ctx.fillStyle = 'rgb(140,100,100)';
    ctx.fillRect(0, 0, window.width, window.height);
    ctx.fillStyle = 'black';
    svgs.forEach(svg => {
      ctx.beginPath();
      svg(ctx);
      ctx.fill();
    });
  };
  const update = throttle(_update, 130);
  window.on('expose', update);
}

main().catch(err => console.log(err));
