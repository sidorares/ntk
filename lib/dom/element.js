const Node = require('./node');

class Element extends Node {
  constructor(args) {
    super(args);
    this.name = 'Base Element';
  }

  render(ctx) {
    const { left, top, width, height } = this._layoutNode.getComputedLayout();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    console.log('Base fillRect');
    console.log(`Body paint: ${[left, top, width, height].join(',')}`);
    ctx.fillRect(left, top, width, height);
    this._children.map(ch => ch.render(ctx));
  }
}

module.exports = Element;
