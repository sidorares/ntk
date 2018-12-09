const ntk = require('../lib');
const Element = require('../lib/dom/element');
const Yoga = require('yoga-layout-prebuilt');

class CustomButton extends Element {
  constructor(props) {
    super(props);
    this._layoutNode.setMinWidth(60);
    this._layoutNode.setMinHeight(80);
    this._layoutNode.setMaxHeight(380);
    this._layoutNode.setMargin(Yoga.EDGE_ALL, 5);
    this._layoutNode.setFlexWrap(Yoga.WRAP_WRAP);
    this._layoutNode.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
    this.name = 'BTN';
  }

  render(ctx) {
    const { left, top, width, height } = this._layoutNode.getComputedLayout();

    console.log(
      `=render ${this.name} ${this.style} (${this._viewportLeft} ${
        this._viewportTop
      }, ${[left, top, width, height].join(',')} ctx=${ctx.width} x ${
        ctx.height
      })`
    );
    ctx.fillStyle = this.style || 'rgb(255, 195, 195)';
    ctx.fillRect(0, 0, width, height);

    ctx.font = 'bold italic 40pt Helvetica';
    ctx.fillStyle = 'rgba(9, 25, 25, 0.8)';
    ctx.fillText(this.style, 5, 50);
  }
}

async function main() {
  const app = await ntk.createClient();
  const window = app.createWindow();

  app.customElements.define('custom-button', CustomButton);

  const { document } = window;

  document.body._layoutNode.setFlexWrap(Yoga.WRAP_WRAP);
  document.body._layoutNode.setJustifyContent(Yoga.JUSTIFY_CENTER);
  document.body._layoutNode.setAlignItems(Yoga.ALIGN_CENTER);
  document.body._layoutNode.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);

  let btn = document.createElement('custom-button');
  btn.style = 'green';

  btn._layoutNode.setJustifyContent(Yoga.JUSTIFY_CENTER);
  btn._layoutNode.setAlignContent(Yoga.ALIGN_CENTER);

  let btn2 = document.createElement('custom-button');
  btn2.style = 'red';
  btn.appendChild(btn2);
  let btn3 = document.createElement('custom-button');
  btn3.style = 'blue';

  let btn4 = document.createElement('custom-button');
  btn4.style = 'yellow';
  btn3.appendChild(btn4);

  let btn5 = document.createElement('custom-button');
  btn5.style = 'cyan';
  btn3.appendChild(btn5);

  let btn6 = document.createElement('custom-button');
  btn6.style = 'magenta';
  btn3.appendChild(btn6);

  btn.appendChild(btn3);
  document.body.appendChild(btn);

  window.map();
}

main().catch(err => console.log(err));
