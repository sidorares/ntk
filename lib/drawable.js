import { EventEmitter } from 'node:events';

// lib/ may not statically import node builtins (see docs/packaging.md); this
// file is the one sanctioned exception for node:events, so it is also where
// the rest of lib/ takes EventEmitter from.
export { EventEmitter };

export default class Drawable extends EventEmitter {
  getContext(name, ...args) {
    const factory = Drawable.renderingContextFactory[name];
    if (!factory) throw new Error(`Unknown rendering context: ${name}`);
    return factory(this, ...args);
  }
}

// populated by the renderingcontext_* modules on import
Drawable.renderingContextFactory = {};
