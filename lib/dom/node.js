const Yoga = require('yoga-layout-prebuilt');

class Node {
  constructor(document) {
    this._layoutNode = Yoga.Node.create();
    this._children = [];
    this.ownerDocument = document;
  }

  get children() {
    return this._children;
  }

  appendChild(node) {
    const index = this._children.length;
    this._children.push(node);
    node.parent = this;
    this._layoutNode.insertChild(node.getLayoutNode(), index);
  }

  getLayoutNode() {
    return this._layoutNode;
  }
}

module.exports = Node;
