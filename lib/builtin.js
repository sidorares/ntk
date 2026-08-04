// Reach a Node builtin from ESM across Node versions.
//
// `process.getBuiltinModule(id)` is the browser-safe accessor — the string is
// a function argument, so no bundler treats it as a module specifier — but it
// only exists on Node >= 20.16. ntk's floor is lower (Node 18.19, for
// react-x11), and there is no browser-safe, synchronous way to reach a builtin
// from ESM on an older Node: `getBuiltinModule` is the API that was added to
// fill exactly that gap. So where it is absent we fall back to `createRequire`.
//
// The `node:module` import below is a real specifier and the one place in lib/
// allowed to statically import a builtin other than node:events — a sanctioned
// exception in test/packaging.test.js, scoped to this file. A *browser* bundle
// of the text stack must stub this one specifier, but the fallback that uses it
// never runs in a browser (guarded on process.versions.node) and ntk ships no
// browser build. It is not a top-level await, so the CJS/SEA bundle path (see
// docs/packaging.md) is unaffected.
import { createRequire } from 'node:module';

let _require;

// One createRequire bound to ntk, made lazily. Builtins ('node:*') resolve
// regardless of the base URL, so this also serves callers that resolve a
// package in ntk's own dependency graph (e.g. KaTeX's font directory).
function req() {
  return (_require ??= createRequire(import.meta.url));
}

/**
 * `process.getBuiltinModule(id)` with a Node-18 fallback.
 * @param {string} id e.g. 'node:child_process'
 * @returns the builtin module, or `undefined` outside Node (a browser
 *   embedding of the text stack — supply a custom FontSource / callback there).
 */
export function builtin(id) {
  const p = globalThis.process;
  if (!p?.versions?.node) return undefined;
  if (typeof p.getBuiltinModule === 'function') return p.getBuiltinModule(id);
  return req()(id);
}

/**
 * A `require` for resolving packages in ntk's dependency graph.
 * @returns {NodeRequire|null} `null` outside Node.
 */
export function nodeRequire() {
  return globalThis.process?.versions?.node ? req() : null;
}
