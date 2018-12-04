const ntk = require('..');
const Element = require('../lib/dom/element');
const Yoga = require('yoga-layout-prebuilt');

class CustomButton extends Element {
  constructor(props) {
    super(props);
    this._layoutNode.setMinWidth(30);
    this._layoutNode.setMinHeight(40);
    this._layoutNode.setMargin(Yoga.EDGE_ALL, 5);
    this.name = 'BTN';
  }

  render(ctx, parentX, parentY) {
    const { left, top, width, height } = this._layoutNode.getComputedLayout();
    ctx.fillStyle = this.style || 'rgb(255, 195, 195)';
    //console.log('Child fillRect');
    ctx.fillRect(parentX + left, parentY + top, width, height);
    //ctx.strokeStyle = 'rgb(155, 195, 195)';
    //ctx.lineWidth = 5;
    //ctx.strokeRect(left, top, width, height);
    this._children.map(ch => ch.render(ctx, parentX + left, parentY + top));
  }
}

function addExtra(btn) {
  const document = btn.ownerDocument;
  btn._layoutNode.setFlexWrap(Yoga.WRAP_WRAP);
  //btn._layoutNode.setJustifyContent(Yoga.JUSTIFY_SPACE_AROUND);
  btn._layoutNode.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
  btn._layoutNode.setMaxWidth(200);
  for (var i = 0; i < 10; ++i) {
    const btn2 = document.createElement('custom-button');
    btn2.style = 'green';
    btn2._layoutNode.setFlexWrap(Yoga.WRAP_WRAP);
    btn2._layoutNode.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
    btn2._layoutNode.setMinWidth(5);
    btn2._layoutNode.setMinHeight(5);

    if (i % 3 === 1) {
      for (var j = 0; j < 5; ++j) {
        let btn3 = document.createElement('custom-button');
        btn3._layoutNode.setMinWidth(5);
        btn3._layoutNode.setMinHeight(5);
        btn3.style = 'red';
        btn2.appendChild(btn3);
      }
    }
    btn.appendChild(btn2);
  }
}

async function main() {
  const app = await ntk.createClient();
  const window = app.createWindow();

  app.customElements.define('custom-button', CustomButton);

  const { document } = window;

  document.body._layoutNode.setFlexWrap(Yoga.WRAP_WRAP);
  document.body._layoutNode.setJustifyContent(Yoga.JUSTIFY_SPACE_AROUND);
  document.body._layoutNode.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);

  for (var i = 0; i < 500; ++i) {
    const btn = document.createElement('custom-button');
    if (i % 3 === 2) {
      btn._layoutNode.setFlexGrow(1);
    }
    if (i % 4 === 3) {
      btn._layoutNode.setFlexGrow(10);
    }
    if (i % 20 === 3) {
      addExtra(btn);
    }
    document.body.appendChild(btn);
  }

  window.map();
}

main().catch(err => console.log(err));
