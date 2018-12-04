const Node = require('./node');

class Element extends Node {
  render(ctx, parentX, parentY) {
    const { left, top, width, height } = this._layoutNode.getComputedLayout();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.fillRect(left, top, width, height);
    this._children.map(ch => ch.render(ctx, parentX + left, parentY + top));
  }
}

module.exports = Element;
