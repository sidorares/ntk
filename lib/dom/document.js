const Element = require('./element');

class Document {
  constructor({ window }) {
    this._window = window;
    this._application = window.app;
    this._root = null;
  }

  get window() {
    return this._window;
  }

  get body() {
    if (!this._root) {
      this._root = new Element(this);
    }
    return this._root;
  }

  createElement(name) {
    const Ctor = this._application.cutomElementsRegistry[name];
    if (!Ctor) {
      throw new Error(`Element ${name} is not defined`);
    }
    return new Ctor(this);
  }

  render(backBuffer) {
    let queue = [this.body];
    // TODO: body scroll position? Or make body absolutely positioned element and handle via layout?
    let x = 0;
    let y = 0;
    // TODO make it iasync/interruptable?
    while (queue.length) {
      const currentElement = queue.shift();
      const { width, height, left, top } = currentElement._layoutNode.getComputedLayout();
      const parent = currentElement.parent || {
        _viewportLeft: 0,
        _viewportTop: 0
      };
      currentElement._viewportLeft = parent._viewportLeft + left;
      currentElement._viewportTop = parent._viewportTop + top;

      // TODO: reuse single pixmap for compositing
      const ctx = this.window.createPixmap({ width, height }).getContext('2d');
      ctx.fillStyle = 'rgba(0, 0, 0, 0)';
      ctx.fillRect(0, 0, width, height);
      currentElement.render(ctx);
      backBuffer.drawImage(
        ctx,
        0,
        0,
        width,
        height,
        currentElement._viewportLeft,
        currentElement._viewportTop,
        width,
        height
      );
      queue = queue.concat(currentElement.children);
    }
  }
}

module.exports = Document;
