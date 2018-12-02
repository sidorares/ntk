const ntk = require('..');
const Element = require('../lib/dom/element');
const Yoga = require('yoga-layout-prebuilt');

class CustomButton extends Element {
  constructor(props) {
    super(props);
    this._layoutNode.setWidth(20);
    this._layoutNode.setHeight(20);
    this._layoutNode.setMargin(Yoga.EDGE_ALL, 5);
  }

  render() {
    const ctx = this.ownerDocument.window.getContext('2d');
    const { left, top, width, height } = this._layoutNode.getComputedLayout();
    ctx.fillStyle = 'rgb(255, 155, 155)';
    ctx.fillRect(left, top, width, height);
    this._children.map(ch => ch.render(ctx));
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

  for (var i = 0; i < 550; ++i) {
    const btn = document.createElement('custom-button');
    //if (i === 2) {
    //  btn._layoutNode.setFlexGrow(1);
    //}
    document.body.appendChild(btn);
  }

  window.map();
}

main().catch(err => console.log(err));
