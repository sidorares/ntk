// Browser stub for node's `module`. lib/builtin.js imports `createRequire`
// from here for its Node < 20.16 fallback, but that path is guarded on
// process.versions.node and never runs in the browser — so this only has to
// resolve at bundle time, never be called.
module.exports = {
    createRequire: () => () => {
        throw new Error('ntk: createRequire is not available in the browser bundle');
    }
};
