// Temporary fallback used by build-demo-bundles.mjs while the repo's
// lib/xserver (RENDER-enabled JS X server) does not exist yet: re-export
// node-x11's plain XServer so the bundle builds and the site ships.
//
// NOTE: without the RENDER extension ntk's createClient() rejects, so the
// playground demos cannot run against this fallback — it exists purely so
// the website build does not block on the parallel lib/xserver work. As
// soon as ../lib/xserver/index.js appears the build switches to it
// automatically (and adds installRender).
'use strict';

const { XServer, createServer, createStreamPair } = require('x11/lib/xserver');

module.exports = { XServer, createServer, createStreamPair };
