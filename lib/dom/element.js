const Node = require('./node');

class Element extends Node {
  constructor(props) {
    super(props);
  }
  render(ctx) {
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, ctx.width, ctx.height);
    this._children.map(ch => ch.render(ctx));
  }
}

module.exports = Element;
