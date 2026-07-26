// Glue for running ntk against node-x11's pure-JS X server: registers the
// RENDER extension (lib/xserver/render.js) and applies the small core-server
// patches ntk depends on. Deep-imports x11's CJS server modules (the x11
// package has no exports map) — bundlers resolve these fine, so the browser
// playground bundles this entry as-is; render.js itself has zero imports.

import drawing from 'x11/lib/xserver/drawing.js';
import errors from 'x11/lib/xserver/errors.js';
import xserver from 'x11/lib/xserver/index.js';

import { createRenderExtension } from './render.js';

const { XServer, createStreamPair } = xserver;
const { Pixmap } = drawing;
const { XError, codes } = errors;

/**
 * Register RENDER on an existing XServer instance and patch the core
 * handlers ntk needs:
 *
 *  - CreatePixmap accepts depth 8 (ntk allocates a8 mask pixmaps).
 *  - PutImage preserves the alpha byte when uploading depth-32 ZPixmap data
 *    into depth-32 drawables (ntk uploads premultiplied BGRA images; the
 *    stock handler masks pixels with 0xffffff).
 *
 * @returns the registered extension record
 */
export function installRender(server) {
  const ext = server.registerExtension('RENDER', createRenderExtension());

  // CreatePixmap (53): allow depth 8
  const origCreatePixmap = server.handlers[53];
  server.handlers[53] = (client, depth, body) => {
    if (depth !== 8) return origCreatePixmap(client, depth, body);
    const pid = body.readUInt32LE(0);
    server.getDrawable(body.readUInt32LE(4));
    const width = body.readUInt16LE(8);
    const height = body.readUInt16LE(10);
    if (width === 0 || height === 0) throw new XError(codes.Value, 0);
    server.checkIdFree(client, pid);
    server.resources.set(pid, new Pixmap(pid, 8, width, height, client));
  };

  // PutImage (72): keep alpha for ZPixmap depth-32 -> depth-32 uploads.
  // Wire bytes are BGRA little-endian per pixel, so readUInt32LE yields the
  // raster's native 0xAARRGGBB.
  const origPutImage = server.handlers[72];
  server.handlers[72] = (client, format, body) => {
    if (format === 2 && body.readUInt8(17) === 32) {
      const t = server.getDrawable(body.readUInt32LE(0));
      if (t.depth === 32) {
        const gc = server.getGC(body.readUInt32LE(4));
        const width = body.readUInt16LE(8);
        const height = body.readUInt16LE(10);
        const dstX = body.readInt16LE(12);
        const dstY = body.readInt16LE(14);
        if (body.readUInt8(16) !== 0) throw new XError(codes.Match, body.readUInt8(16));
        const data = body.subarray(20);
        if (data.length < width * height * 4) throw new XError(codes.Length, data.length);
        const pixels = new Uint32Array(width * height);
        for (let i = 0; i < pixels.length; i++) pixels[i] = data.readUInt32LE(i * 4);
        t.raster.putPixels(gc.rasterGC(), dstX, dstY, width, height, pixels);
        return;
      }
    }
    origPutImage(client, format, body);
  };

  return ext;
}

/**
 * Create an XServer with RENDER installed — everything an ntk client needs
 * to run headless:
 *
 *   const server = createServer({ width: 320, height: 240 });
 *   const [a, b] = createStreamPair();
 *   server.addClientStream(a);
 *   const app = await createClient({ stream: b });
 */
export function createServer(options = {}) {
  const server = new XServer(options);
  installRender(server);
  return server;
}

export { createRenderExtension, createStreamPair };
