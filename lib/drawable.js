import { EventEmitter } from 'node:events';

export default class Drawable extends EventEmitter {
  getContext(name, ...args) {
    const factory = Drawable.renderingContextFactory[name];
    if (!factory) throw new Error(`Unknown rendering context: ${name}`);
    return factory(this, ...args);
  }
}

// populated by the renderingcontext_* modules on import
Drawable.renderingContextFactory = {};
