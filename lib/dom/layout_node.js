const Yoga = require('yoga-layout-prebuilt');

function capitalizeFirstLetter(string) {
  return `${string.charAt(0).toUpperCase()}${string.slice(1)}`;
}

const layoutProps = [
  'flexDirection',
  'justifyContent',
  'alignContent',
  'alignItems',
  'alignSelf',
  'flexWrap',
  'flex',
  'flexGrow',
  'flexShrink',
  'flexBasis',
  'margin',
  'padding',
  'border',
  'width',
  'height'
];

const simpleSettersMap = layoutProps.reduce((acc, iter) => {
  return { ...acc, [iter]: `set${capitalizeFirstLetter(iter)}` };
}, {});

const toYogaSetter = (key, value) => {
  return [simpleSettersMap[key], [value]];
};

function LayoutNode() {
  this.node = Yoga.Node.create();
  //this.node.ntkLayout = this;
}

LayoutNode.prototype.mergeStyle = function(style) {
  Object.keys(style).forEach(key => {
    const [setter, values] = toYogaSetter(key, style.value);
    if (!setter) {
      return;
    }
    this.node[setter](...values);
  });
};

LayoutNode.prototype.appendChild = function(ln) {
  const count = this.node.getChildCount();
  this.node.insertChild(ln.node, count);
  ln.setParent(this);
};

LayoutNode.prototype.setOwner = function(ele) {
  this.ownerEle = ele;
};

module.exports = LayoutNode;
