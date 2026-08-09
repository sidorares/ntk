// Which OpenGL backend a window draws through, and whether it can.
//
// ntk has two, and they are different pipelines rather than two spellings of
// one:
//
//  - **indirect GLX** (lib/renderingcontext_opengl.js) — GL commands encoded
//    into the X connection. Reaches any server that allows indirect contexts,
//    including over a network, and is a fixed-function OpenGL 1.x pipeline
//    with no shaders, because that is what the GLX protocol encodes.
//  - **direct** (lib/renderingcontext_gles.js) — a GPU render node draws the
//    frame, and the finished buffer reaches the server as a dma-buf
//    descriptor over DRI3 + Present. OpenGL ES 2 with real shaders, and no
//    pixels on the socket; local connections only, and it needs the optional
//    `x11-dri` addon.
//
// Which one runs is `glPolicy`, and the default is `indirect` — the backend
// that has always run. See docs/context-gles.md.
//
// This module is the decision and nothing else: what is available, what the
// caller asked for, and what that resolves to. Neither context imports the
// other, and the direct one is only ever loaded when the answer is `direct`.

import { nodeRequire } from './builtin.js';

/**
 * `err.code` on failures of the direct path, alongside `GLXError` for the
 * indirect one. Every code names a distinct remedy:
 *
 * - `GL_DISABLED` — `glPolicy: 'off'`; nothing tried.
 * - `GL_NO_ADDON` — the optional `x11-dri` addon is not installed or would
 *   not load. `npm install x11-dri`.
 * - `GL_NO_DRIVER` — the addon loaded but the GPU libraries it needs are
 *   missing (`libgbm`, `libEGL`, `libGLESv2`), or this is not Linux.
 * - `GL_NO_DEVICE` — no readable DRM render node (`/dev/dri/renderD*`).
 * - `GL_REMOTE_DISPLAY` — a TCP or forwarded display, so there is no local
 *   socket to hand the server a buffer down.
 * - `GL_NO_FD_PASSING` — the display is local, but this JavaScript runtime
 *   cannot send a descriptor over the socket. Bun is the case in the field;
 *   x11 does it through a Node internal Bun does not implement.
 * - `GL_NO_DRI3` — the server has no DRI3/Present (Xvfb, Xephyr, XQuartz).
 * - `GL_IMPORT_FAILED` — the server refused the buffer; usually client and
 *   server on different DRM devices.
 * - `GL_CONTEXT_FAILED` — GBM/EGL setup failed for some other reason.
 */
export const GLError = {
  DISABLED: 'GL_DISABLED',
  NO_ADDON: 'GL_NO_ADDON',
  NO_DRIVER: 'GL_NO_DRIVER',
  NO_DEVICE: 'GL_NO_DEVICE',
  REMOTE_DISPLAY: 'GL_REMOTE_DISPLAY',
  NO_FD_PASSING: 'GL_NO_FD_PASSING',
  NO_DRI3: 'GL_NO_DRI3',
  IMPORT_FAILED: 'GL_IMPORT_FAILED',
  CONTEXT_FAILED: 'GL_CONTEXT_FAILED'
};

export function glError(code, message, hint, cause) {
  const err = new Error(message);
  err.code = code;
  if (hint) err.hint = hint;
  if (cause) err.cause = cause;
  return err;
}

/**
 * The backend choice, and the knobs the direct one has.
 *
 * `mode` is the whole decision:
 * - `'indirect'` (default) — indirect GLX, the only backend before 7.x.
 * - `'auto'` — direct where everything for it is present, indirect otherwise.
 * - `'direct'` — direct or nothing; `getContext` fails with a coded error
 *   rather than quietly running a fixed-function pipeline instead.
 * - `'off'` — no GL at all.
 *
 * The default is deliberately not `'auto'`: the two backends expose different
 * GL APIs (see docs/context-gles.md), so switching under an app that never
 * asked would break its draw code. Opt in per app, or per run with
 * `NTK_GL_POLICY`.
 */
export const DEFAULT_GL_POLICY = {
  mode: 'indirect',
  // which render node to draw on; null picks the first usable one
  devicePath: null,
  // presents allowed in flight before a frame waits for a buffer to come back
  maxInFlight: 2,
  // retry a refused buffer import once with a linear layout, which is what
  // makes cross-device (render on one GPU, display on another) work
  linearFallback: true
};

export const GL_MODES = ['auto', 'direct', 'indirect', 'off'];

function badMode(mode, source) {
  return new Error(
    `ntk: ${source} is ${JSON.stringify(mode)}, which is not a GL policy mode — use one of ${GL_MODES.join(', ')} (see docs/context-gles.md)`
  );
}

/**
 * The effective policy for an app: defaults, then `options.glPolicy` (a mode
 * string is sugar for `{ mode }`), then `NTK_GL_POLICY`.
 *
 * The environment wins on purpose. Its job is running one build both ways —
 * `NTK_GL_POLICY=direct npm start` against the same app that ships
 * `'indirect'` — which it cannot do if the code overrides it.
 */
export function resolveGLPolicy(options = {}) {
  const given = options.glPolicy;
  const asObject = typeof given === 'string' ? { mode: given } : given;
  if (asObject && typeof asObject !== 'object') throw badMode(given, 'glPolicy');
  const policy = { ...DEFAULT_GL_POLICY, ...asObject };

  const fromEnv = globalThis.process?.env?.NTK_GL_POLICY;
  if (fromEnv) policy.mode = fromEnv;

  if (!GL_MODES.includes(policy.mode)) {
    throw badMode(policy.mode, fromEnv ? 'NTK_GL_POLICY' : 'glPolicy.mode');
  }
  return policy;
}

/** Does this policy ever want the direct backend? */
export const wantsDirect = (policy) => policy.mode === 'auto' || policy.mode === 'direct';

// ---------------------------------------------------------------------------
// the addon

let addon; // undefined = not tried, null = unavailable

/**
 * The optional `x11-dri` addon, or null.
 *
 * Loaded through `nodeRequire` rather than imported: it is a native module and
 * an optional dependency, so it is absent on plenty of machines that run ntk
 * perfectly well, and a static import would make it a hard requirement of the
 * package (and of any bundle built from it). Nothing here throws.
 */
export function loadDriAddon() {
  if (addon !== undefined) return addon;
  addon = null;
  try {
    const require = nodeRequire();
    if (require) addon = require('x11-dri');
  } catch {
    // not installed, wrong platform, or no loadable binary — all "no direct"
  }
  return addon;
}

/** Test seam: swap the addon (or clear the cache with `undefined`). */
export function setDriAddon(module) {
  addon = module;
}

const INSTALL_HINT = `Direct rendering needs the optional native addon:

  npm install x11-dri

It ships prebuilt binaries for linux x64/arm64 and macOS arm64, so no build
tools are needed; anything else compiles with node-gyp and a C toolchain. ntk
does not depend on it — without it, GL runs through indirect GLX.`;

/**
 * What the *client side* can do, before any server is asked: the addon, the
 * GPU libraries under it, and a render node to draw on. Never throws.
 *
 * @returns {{ok: boolean, code?: string, message?: string, hint?: string,
 *   device?: string, devices?: string[], probe?: object}}
 */
export function probeDirect(policy = DEFAULT_GL_POLICY) {
  const dri = loadDriAddon();
  if (!dri) {
    return {
      ok: false,
      code: GLError.NO_ADDON,
      message: 'the x11-dri addon is not installed, so there is no way to produce GPU buffers',
      hint: INSTALL_HINT
    };
  }

  let probe;
  try {
    probe = dri.probe();
  } catch (err) {
    return { ok: false, code: GLError.NO_DRIVER, message: `x11-dri probe() failed: ${err.message}` };
  }

  // probe() reports each capability as `true` or as the string saying why not
  const missing = ['gbm', 'egl', 'gles'].filter((key) => probe[key] !== true);
  if (missing.length) {
    const detail = missing.map((key) => `${key}: ${probe[key]}`).join('; ');
    return {
      ok: false,
      code: GLError.NO_DRIVER,
      message: `the GPU libraries direct rendering needs are unavailable (${detail})`,
      hint:
        probe.platform && probe.platform !== 'linux'
          ? `Direct rendering is Linux-only — dma-buf, GBM and DRI3 have no equivalent on ${probe.platform}.`
          : 'Install Mesa (libgbm1, libegl1, libgles2 on Debian/Ubuntu). They are dlopen()ed at\nrun time, so no rebuild of x11-dri is needed once they are there.',
      probe
    };
  }

  let devices = [];
  try {
    devices = dri.listRenderNodes();
  } catch {
    devices = [];
  }
  const device = policy.devicePath ?? devices[0] ?? null;
  if (!device) {
    return {
      ok: false,
      code: GLError.NO_DEVICE,
      message: 'no readable DRM render node (/dev/dri/renderD*) — there is no GPU to render on',
      hint:
        'A container usually needs the device mapped in (--device /dev/dri), and a bare\nmachine needs the user in the "render" (or "video") group.',
      probe,
      devices
    };
  }
  return { ok: true, device, devices, probe };
}

// ---------------------------------------------------------------------------
// the connection and the server

/**
 * Can this connection carry a descriptor to the server at all?
 *
 * DRI3 hands the server a dma-buf over the socket with SCM_RIGHTS, which only
 * a local unix socket can do. Everything remote — TCP, `ssh -X` — is out
 * before any extension is queried, and this costs nothing to find out.
 */
export function canPassDescriptors(display) {
  const stream = display?.client?.stream;
  return !!(display?.isLocalSocket && stream?._fdCapable && typeof stream.sendFds === 'function');
}

const displayName = () => globalThis.process?.env?.DISPLAY || 'the X server';

/** What is running this, for an error that is about the runtime. */
const runtimeName = () => {
  const versions = globalThis.process?.versions;
  if (versions?.bun) return `Bun (${versions.bun})`;
  if (versions?.deno) return `Deno (${versions.deno})`;
  return versions?.node ? `Node (${versions.node})` : 'JavaScript runtime';
};

const requireExt = (X, name) =>
  new Promise((resolve) => X.require(name, (err, ext) => resolve(err ? null : ext)));

/**
 * Everything about `app` that decides the backend, answered once and cached.
 *
 * The two extension queries are the only round trips, and they only happen
 * under a policy that could use direct — `createClient` warms this during the
 * connect handshake for exactly that reason, so `getContext` can decide
 * synchronously afterwards.
 *
 * @returns {Promise<{direct: boolean, indirect: boolean, device: string|null,
 *   reason: Error|null, DRI3: object|null, Present: object|null}>}
 */
export function glCapabilities(app) {
  if (app._glCaps) return app._glCaps;
  app._glCaps = (async () => {
    const policy = app.glPolicy;
    const indirect = !!app.display.GLX;
    const fail = (code, message, hint) => ({
      direct: false,
      indirect,
      device: null,
      reason: glError(code, message, hint),
      DRI3: null,
      Present: null
    });

    if (policy.mode === 'off') {
      return fail(GLError.DISABLED, "glPolicy is 'off', so no GL context will be created");
    }
    if (!app.display.isLocalSocket) {
      return fail(
        GLError.REMOTE_DISPLAY,
        'this X connection is not a local socket, and DRI3 works by passing a descriptor down one',
        'Direct rendering is local-only by construction. Over a network, indirect GLX is\n' +
          'the backend that can work at all — leave glPolicy at its default.'
      );
    }
    if (!canPassDescriptors(app.display)) {
      // The socket is local; what is missing is the ability to send a
      // descriptor along it. x11 does that through Node's internal
      // `process.binding('pipe_wrap')`, so a runtime that does not implement
      // it lands here — Bun, today. Saying "not a local socket" would send
      // the reader off to check their DISPLAY, which is fine.
      return fail(
        GLError.NO_FD_PASSING,
        `this ${runtimeName()} cannot pass file descriptors over the X socket, and DRI3 works by passing one`,
        'The connection is local; the runtime is what cannot carry the descriptor.\n' +
          "x11 sends one through Node's process.binding('pipe_wrap'), which Bun does\n" +
          'not implement. Run under Node for direct rendering, or leave glPolicy at its\n' +
          'default and use indirect GLX, which needs no descriptor passing at all.'
      );
    }

    const client = probeDirect(policy);
    if (!client.ok) return fail(client.code, client.message, client.hint);

    const X = app.X;
    const [DRI3, Present] = await Promise.all([requireExt(X, 'dri3'), requireExt(X, 'present')]);
    if (!DRI3 || !Present) {
      const absent = [!DRI3 && 'DRI3', !Present && 'Present'].filter(Boolean).join(' and ');
      return fail(
        GLError.NO_DRI3,
        `${displayName()} does not have ${absent}, so a GPU buffer cannot be turned into a pixmap or shown`,
        'Xorg with glamor and Xwayland both have them; Xvfb, Xephyr and XQuartz do not.\n' +
          'Indirect GLX is the backend that can work on such a server.'
      );
    }
    if (!DRI3.fdCapable) {
      return fail(
        GLError.NO_FD_PASSING,
        'the x11 client cannot send descriptors on this connection (DRI3.fdCapable is false)',
        'x11 builds an fd-capable socket for local displays unless `shm: false` was passed\n' +
          'to createClient, and needs a runtime that can pass descriptors — see above.'
      );
    }

    return { direct: true, indirect, device: client.device, reason: null, DRI3, Present };
  })();
  return app._glCaps;
}

/**
 * The backend `getContext('opengl')` should use right now, synchronously.
 *
 * Synchronous because `getContext` is, and the async part (two extension
 * queries) is warmed at connect time under any policy that could say
 * `direct`. `null` means "not known yet" — a policy raised to `auto` after
 * connect, before `await app.glCapabilities()` has answered.
 */
export function backendFor(app) {
  const mode = app.glPolicy.mode;
  if (mode === 'off') return 'off';
  if (mode === 'indirect') return 'indirect';
  const settled = app._glCapsResolved;
  if (!settled) return null;
  if (settled.direct) return 'direct';
  return mode === 'direct' ? 'off' : 'indirect';
}
