// Apple-DRI: XQuartz's direct-rendering extension — the macOS counterpart of
// DRI3. Where DRI3 passes dma-buf descriptors from client to server,
// Apple-DRI runs the other way: the *server* owns a WindowServer surface for
// the drawable and exports it to the client's WindowServer connection,
// identified by (client_id, key[2]). What the client does with the key —
// import it and attach an OpenGL context through the Xplugin/CGL system
// libraries — is native-code territory: the x11-dri addon's `apple`
// namespace (lib/renderingcontext_cgl.js is the consumer).
//
// The protocol half lives here rather than in node-x11 because node-x11 does
// not ship it yet; the binding is written in node-x11's lib/ext style so it
// can move there verbatim when it does (docs/context-gles.md#macos).
//
// Protocol source (there is no shipped header — the extension is defined in
// the XQuartz server tree):
//   https://github.com/XQuartz/xorg-server/blob/master/hw/xquartz/xpr/appledristr.h
//   https://github.com/XQuartz/xorg-server/blob/master/hw/xquartz/xpr/appledri.h

/*
#define X_AppleDRIQueryVersion                0
#define X_AppleDRIQueryDirectRenderingCapable 1
#define X_AppleDRICreateSurface               2
#define X_AppleDRIDestroySurface              3
(4..8: AuthConnection and the shm pixmap requests — the accelerated path
needs none of them, so they are not bound)
*/

/** Sub-codes of the AppleDRISurfaceNotify event's `kind`. */
export const NotifyKind = {
  /** the window moved or resized under the surface: `ctx.update()` */
  Changed: 0,
  /** the surface is gone (window unmapped, frame recreated): CreateSurface + attach anew */
  Destroyed: 1
};

/**
 * Bind the Apple-DRI extension on a node-x11 display.
 *
 * Resolves the extension object — with the requests, `events`, `NotifyKind`
 * and `errors` below on it — or `null` where the server has no Apple-DRI,
 * which is every server that is not XQuartz. Asked once per connection and
 * cached; the event and error parsers are registered on first resolution.
 *
 * The requests are callback-style, like every node-x11 extension:
 *
 * - `QueryVersion(cb)` -> `{ major, minor, patch }`
 * - `QueryDirectRenderingCapable(screen, cb)` -> `boolean`
 * - `CreateSurface(screen, drawable, clientId, cb)` -> `{ key: [k0, k1], uid }`
 * - `DestroySurface(screen, drawable)` (void)
 *
 * `CreateSurface` makes the server create (or reference) a WindowServer
 * surface for the drawable and export it to the process whose WindowServer
 * id is `clientId` (x11-dri: `dri.apple.clientId()`). `key` is what
 * `AppleContext.attach()` consumes; `uid` is the server-side surface id that
 * SurfaceNotify events carry as `arg` — route by uid, not by window id.
 *
 * The `AppleDRISurfaceNotify` event is *classic* (type `firstEvent + 3`),
 * not a GenericEvent, and is sent unsolicited to the client that created the
 * surface — there is no event mask to select. It reaches node-x11's
 * client-level `'event'` stream only (no `wid` field for per-window
 * routing), parsed as `{ name: 'AppleDRISurfaceNotify', kind, time, arg }`.
 *
 * @param {object} display node-x11 display
 * @returns {Promise<object|null>}
 */
export function requireAppleDRI(display) {
  const X = display.client;
  if (X._appleDRIPromise) return X._appleDRIPromise;
  X._appleDRIPromise = new Promise((resolve) => {
    X.QueryExtension('Apple-DRI', (err, ext) => {
      if (err || !ext.present) return resolve(null);

      // -> { major, minor, patch }
      ext.QueryVersion = (cb) => {
        X.seq_num++;
        const b = Buffer.alloc(4);
        b.writeUInt8(ext.majorOpcode, 0);
        b.writeUInt8(0, 1);
        b.writeUInt16LE(1, 2);
        X.pack_stream.put(b);
        X.replies[X.seq_num] = [
          (buf) => ({
            major: buf.readUInt16LE(0),
            minor: buf.readUInt16LE(2),
            patch: buf.readUInt32LE(4)
          }),
          cb
        ];
        X.pack_stream.submit(true);
      };

      // -> boolean
      ext.QueryDirectRenderingCapable = (screen, cb) => {
        X.seq_num++;
        const b = Buffer.alloc(8);
        b.writeUInt8(ext.majorOpcode, 0);
        b.writeUInt8(1, 1);
        b.writeUInt16LE(2, 2);
        b.writeUInt32LE(screen >>> 0, 4);
        X.pack_stream.put(b);
        X.replies[X.seq_num] = [(buf) => buf.readUInt8(0) !== 0, cb];
        X.pack_stream.submit(true);
      };

      // -> { key: [key0, key1], uid }
      ext.CreateSurface = (screen, drawable, clientId, cb) => {
        X.seq_num++;
        const b = Buffer.alloc(16);
        b.writeUInt8(ext.majorOpcode, 0);
        b.writeUInt8(2, 1);
        b.writeUInt16LE(4, 2);
        b.writeUInt32LE(screen >>> 0, 4);
        b.writeUInt32LE(drawable >>> 0, 8);
        b.writeUInt32LE(clientId >>> 0, 12);
        X.pack_stream.put(b);
        X.replies[X.seq_num] = [
          (buf) => ({
            key: [buf.readUInt32LE(0), buf.readUInt32LE(4)],
            uid: buf.readUInt32LE(8)
          }),
          cb
        ];
        X.pack_stream.submit(true);
      };

      ext.DestroySurface = (screen, drawable) => {
        X.seq_num++;
        const b = Buffer.alloc(12);
        b.writeUInt8(ext.majorOpcode, 0);
        b.writeUInt8(3, 1);
        b.writeUInt16LE(3, 2);
        b.writeUInt32LE(screen >>> 0, 4);
        b.writeUInt32LE(drawable >>> 0, 8);
        X.pack_stream.put(b);
        X.pack_stream.submit(false);
      };

      ext.events = {
        AppleDRISurfaceNotify: 3 // 0..2 are obsolete
      };
      ext.NotifyKind = NotifyKind;

      X.eventParsers[ext.firstEvent + ext.events.AppleDRISurfaceNotify] = (
        type,
        seq,
        extra,
        code,
        raw
      ) => ({
        type,
        seq,
        name: 'AppleDRISurfaceNotify',
        kind: code, // NotifyKind
        time: extra,
        arg: raw.readUInt32LE(4) // the surface uid, NOT a window id
      });

      ext.errors = {
        ClientNotLocal: 0,
        OperationNotSupported: 1
      };
      // node-x11 names an extension error it cannot decode after a core one;
      // give both of Apple-DRI's a message that says what to do instead
      X.errorParsers[ext.firstError + ext.errors.ClientNotLocal] = (error) => {
        error.message =
          'Apple-DRI: the client is not local — surfaces can only be exported to a process on the same machine as the X server';
      };
      X.errorParsers[ext.firstError + ext.errors.OperationNotSupported] = (error) => {
        error.message =
          'Apple-DRI: operation not supported — the server refused the request for this drawable (a root or already-destroyed window, or a server running without the Xplugin backend)';
      };

      resolve(ext);
    });
  });
  return X._appleDRIPromise;
}
