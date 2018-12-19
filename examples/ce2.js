const ntk = require('../lib');
const Element = require('../lib/dom/element');
const Yoga = require('yoga-layout-prebuilt');

class CustomButton extends Element {
  constructor(props) {
    super(props);
    this._layoutNode.setMinWidth(60);
    this._layoutNode.setMinHeight(80);
    this._layoutNode.setMaxHeight(680);
    this._layoutNode.setMargin(Yoga.EDGE_ALL, 5);
    this._layoutNode.setFlexWrap(Yoga.WRAP_WRAP);
    this._layoutNode.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
    this.name = 'BTN';
  }

  render(ctx) {
    const { left, top, width, height } = this._layoutNode.getComputedLayout();
    ctx.fillStyle = this.color || 'rgb(255, 195, 195)';
    ctx.fillRect(0, 0, width, height);

    const w = this.ownerDocument.window;
    ctx.font = 'italic 20pt "Times New Roman"';
    ctx.fillStyle = 'black';
    ctx.fillText(`${w.width}x${w.height}`, 5, 40);
  }
}

async function main() {
  const app = await ntk.createClient();
  const window = app.createWindow();

  app.customElements.define('custom-button', CustomButton);

  const { document } = window;

  document.body.style = {
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row'
  };

  let btn = document.createElement('custom-button');
  btn.color = 'green';
  btn.text = 'test';
  btn.style = {
    justifyContent: 'center',
    alignItems: 'center'
  };

  let btn2 = document.createElement('custom-button');
  btn2.color = 'red';
  btn.appendChild(btn2);
  let btn3 = document.createElement('custom-button');
  btn3.color = 'blue';

  let btn4 = document.createElement('custom-button');
  btn4.color = 'yellow';
  btn3.appendChild(btn4);

  let btn5 = document.createElement('custom-button');
  btn5.color = 'cyan';
  btn3.appendChild(btn5);

  let btn6 = document.createElement('custom-button');
  btn6.color = 'magenta';
  btn3.appendChild(btn6);

  btn.appendChild(btn3);
  document.body.appendChild(btn);

  window.map();
}

main().catch(err => console.log(err));
