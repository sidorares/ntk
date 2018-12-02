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
}

module.exports = Document;
