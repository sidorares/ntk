const LayoutNode = require('./layout_node');

function Element(component, style) {
  this.component = component;
  this.layout = new LayoutNode(style);
  this.layout.setOwner(this);
}

Element.prototype.appendChild = function(element) {};
