const Node = require('./node');

class Element extends Node {
  render() {
    const ctx = this.ownerDocument.window.getContext('2d');
    const { left, top, width, height } = this._layoutNode.getComputedLayout();

    ctx.fillStyle = 'rgb(255, 255, 255)';
    ctx.fillRect(left, top, width, height);
    this._children.map(ch => ch.render(ctx));
  }
}

module.exports = Element;
