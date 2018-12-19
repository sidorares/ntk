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

const yogaValues = {
  flexDirection: {
    row: Yoga.FLEX_DIRECTION_ROW,
    column: Yoga.FLEX_DIRECTION_COLUMN,
    'row-referse': Yoga.FLEX_DIRECTION_ROW_REVERSE,
    'column-referse': Yoga.FLEX_DIRECTION_COLUMN_REVERSE
  },
  flexWrap: {
    'no-wrap': Yoga.WRAP_NO_WRAP,
    wrap: Yoga.WRAP,
    'wrap-reverse': Yoga.WRAP_REVERSE
  },
  justifyContent: {
    'flex-start': Yoga.JUSTIFY_FLEX_START,
    'flex-end': Yoga.JUSTIFY_FLEX_END,
    center: Yoga.JUSTIFY_CENTER,
    'space-between': Yoga.JUSTIFY_SPACE_BETWEEN,
    'space-around': Yoga.JUSTIFY_SPACE_AROUND,
    'space-evenly': Yoga.JUSTIFY_SPACE_EVENLY
  },
  alignItems: {
    align: Yoga.ALIGN_AUTO,
    'flex-start': Yoga.ALIGN_FLEX_START,
    center: Yoga.ALIGN_CENTER,
    'flex-end': Yoga.ALIGN_FLEX_END,
    stretch: Yoga.ALIGN_STRETCH,
    baseline: Yoga.ALIGN_BASELINE,
    'space-between': Yoga.ALIGN_SPACE_BETWEEN,
    'space-around': Yoga.ALIGN_SPACE_AROUND
  }
};
const toValue = (key, value) => {
  console.log(key, value);
  return yogaValues[key][value];
};

const toYogaSetter = (key, value) => {
  return [simpleSettersMap[key], [toValue(key, value)]];
};
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

  // TODO: also support string setter similar to HTML DOM inline style?
  set style(_inputStyleObject) {
    Object.keys(_inputStyleObject).forEach(key => {
      const [setter, values] = toYogaSetter(key, _inputStyleObject[key]);
      if (!setter) {
        console.log('Style setter not found!', setter, key, _inputStyleObject[key]);
        return;
      }
      this._layoutNode[setter](...values);
    });
  }
}

module.exports = Node;
