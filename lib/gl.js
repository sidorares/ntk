// Which OpenGL backend a window draws through, and whether it can.
//
// ntk has two, and they are different pipelines rather than two spellings of
// one:
//
//  - **indirect GLX** (lib/renderingcontext_opengl.js) — GL commands encoded
//    into the X connection. Reaches any server that allows indirect contexts,
//    including over a network, and is a fixed-function OpenGL 1.x pipeline
//    with no shaders, because that is what the GLX protocol encodes.
//  - **direct** — the GPU draws the frame and no pixels cross the socket;
//    real shaders; local connections only; needs the optional `x11-dri`
//    addon. It comes in two *flavors*, one per platform, behind the same
//    context contract:
//      - `dri3` (Linux, lib/renderingcontext_gles.js): OpenGL ES 2 on a DRM
//        render node, finished buffers handed to the server as dma-buf
//        descriptors over DRI3 + Present.
//      - `appledri` (macOS/XQuartz, lib/renderingcontext_cgl.js): the server
//        exports the window's WindowServer surface over the Apple-DRI
//        extension, and a CGL context draws straight into it — desktop GL
//        with ES2 compatibility, so the same shaders compile.
//
// Which one runs is `glPolicy`, and the default is `indirect` — the backend
// that has always run. See docs/context-gles.md.
//
// This module is the decision and nothing else: what is available, what the
// caller asked for, and what that resolves to. Neither context imports the
// other, and the direct one is only ever loaded when the answer is `direct`.

import { requireAppleDRI } from './appledri.js';
import { nodeRequire } from './builtin.js';

/**
 * `err.code` on failures of the direct path, alongside `GLXError` for the
 * indirect one. Every code names a distinct remedy:
 *
 * - `GL_DISABLED` — `glPolicy: 'off'`; nothing tried.
 * - `GL_NO_ADDON` — the optional `x11-dri` addon is not installed or would
 *   not load. `npm install x11-dri`.
 * - `GL_NO_DRIVER` — the addon loaded but the platform libraries it needs
 *   are missing: `libgbm`/`libEGL`/`libGLESv2` on Linux,
 *   libXplugin/OpenGL.framework on macOS — or the platform has no direct
 *   path at all.
 * - `GL_NO_DEVICE` — no readable DRM render node (`/dev/dri/renderD*`);
 *   Linux only, macOS needs no device node.
 * - `GL_REMOTE_DISPLAY` — a TCP or forwarded display; both flavors are
 *   local-only by construction.
 * - `GL_NO_FD_PASSING` — the display is local, but this connection cannot
 *   send a descriptor over the socket. x11 has a transport for each runtime
 *   it supports — `process.binding('pipe_wrap')` under Node, `bun:ffi`
 *   calling `sendmsg(2)` under Bun since x11 4.1.0 — so what is left here is
 *   an x11 below that under Bun, a runtime with neither path (Deno), or a
 *   transport that would not initialise. Linux only — Apple-DRI passes no
 *   descriptors.
 * - `GL_NO_DRI3` — the server has no DRI3/Present (Xvfb, Xephyr, XQuartz —
 *   though XQuartz has its own path, see `GL_NO_APPLEDRI`).
 * - `GL_NO_APPLEDRI` — macOS, and the server has no Apple-DRI extension:
 *   not XQuartz, or an XQuartz running without its Xplugin backend.
 * - `GL_NO_WINDOWSERVER` — macOS, but this process has no WindowServer
 *   session to import surfaces into — an SSH session. Run from the
 *   logged-in GUI session.
 * - `GL_IMPORT_FAILED` — the server refused the buffer; usually client and
 *   server on different DRM devices.
 * - `GL_CONTEXT_FAILED` — GPU context setup failed for some other reason.
 */
export const GLError = {
  DISABLED: 'GL_DISABLED',
  NO_ADDON: 'GL_NO_ADDON',
  NO_DRIVER: 'GL_NO_DRIVER',
  NO_DEVICE: 'GL_NO_DEVICE',
  REMOTE_DISPLAY: 'GL_REMOTE_DISPLAY',
  NO_FD_PASSING: 'GL_NO_FD_PASSING',
  NO_DRI3: 'GL_NO_DRI3',
  NO_APPLEDRI: 'GL_NO_APPLEDRI',
  NO_WINDOWSERVER: 'GL_NO_WINDOWSERVER',
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

/**
 * The display's refresh rate asked of the native layer, in Hz, for servers
 * whose RandR carries no usable timing — XQuartz reports the current
 * desktop-sized mode with dot_clock = width * height, exactly 1 Hz.
 * `null` everywhere there is no answer: not darwin, no addon (or one
 * predating 0.6.0), or a session with no display to ask.
 */
export function nativeRefreshRate() {
  if (globalThis.process?.platform !== 'darwin') return null;
  try {
    return loadDriAddon()?.apple?.refreshRate?.() ?? null;
  } catch {
    return null;
  }
}

const INSTALL_HINT = `Direct rendering needs the optional native addon:

  npm install x11-dri

It ships prebuilt binaries for linux x64/arm64 and macOS arm64, so no build
tools are needed; anything else compiles with node-gyp and a C toolchain. ntk
does not depend on it — without it, GL runs through indirect GLX.`;

/**
 * What the *client side* can do, before any server is asked: the addon and
 * the platform libraries under it — plus, on Linux, a render node to draw
 * on. Never throws.
 *
 * `flavor` on an ok answer says which direct pipeline this machine runs:
 * `'dri3'` (Linux — GBM/EGL, dma-buf to the server) or `'appledri'`
 * (macOS — Apple-DRI surface export, CGL). macOS needs no device scan; the
 * window's surface is the render target, so `device` is `null` there.
 *
 * @returns {{ok: boolean, code?: string, message?: string, hint?: string,
 *   flavor?: 'dri3'|'appledri', device?: string|null, devices?: string[],
 *   probe?: object}}
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

  if (probe.platform === 'darwin') {
    // The macOS path draws through Apple-DRI + CGL, not GBM/EGL — probe()
    // reports it as `appledri`: `true`, or the string saying why not. An
    // addon from before 0.5.0 has no such key at all.
    if (probe.appledri !== true) {
      return {
        ok: false,
        code: GLError.NO_DRIVER,
        message: `the libraries direct rendering needs on macOS are unavailable (appledri: ${
          probe.appledri ?? 'not reported — this x11-dri predates Apple-DRI support'
        })`,
        hint:
          probe.appledri === undefined
            ? 'Upgrade the addon: npm install x11-dri@latest (Apple-DRI support arrived in 0.5.0).'
            : 'The macOS path needs XQuartz installed (it dlopen()s libXplugin from /opt/X11)\nand the system OpenGL framework — https://www.xquartz.org.',
        probe
      };
    }
    // no render nodes on macOS: the window's own surface is the target
    return { ok: true, flavor: 'appledri', device: null, devices: [], probe };
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
          ? `Direct rendering needs Linux (DRI3/dma-buf) or macOS (Apple-DRI/XQuartz) — ${probe.platform} has neither path.`
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
  return { ok: true, flavor: 'dri3', device, devices, probe };
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
 * The extension queries are the only round trips, and they only happen
 * under a policy that could use direct — `createClient` warms this during the
 * connect handshake for exactly that reason, so `getContext` can decide
 * synchronously afterwards.
 *
 * `flavor` names the direct pipeline where `direct` is true: `'dri3'`
 * carries `DRI3` and `Present`, `'appledri'` carries `AppleDRI` (the
 * lib/appledri.js extension object) and `appleClientId` (this process's
 * WindowServer id, which CreateSurface exports surfaces to).
 *
 * @returns {Promise<{direct: boolean, indirect: boolean,
 *   flavor: 'dri3'|'appledri'|null, device: string|null, reason: Error|null,
 *   DRI3: object|null, Present: object|null, AppleDRI: object|null,
 *   appleClientId: number|null}>}
 */
export function glCapabilities(app) {
  if (app._glCaps) return app._glCaps;
  app._glCaps = (async () => {
    const policy = app.glPolicy;
    const indirect = !!app.display.GLX;
    const fail = (code, message, hint) => ({
      direct: false,
      indirect,
      flavor: null,
      device: null,
      reason: glError(code, message, hint),
      DRI3: null,
      Present: null,
      AppleDRI: null,
      appleClientId: null
    });

    if (policy.mode === 'off') {
      return fail(GLError.DISABLED, "glPolicy is 'off', so no GL context will be created");
    }
    if (!app.display.isLocalSocket) {
      return fail(
        GLError.REMOTE_DISPLAY,
        'this X connection is not a local socket, and direct rendering is same-machine by construction (DRI3 passes a descriptor down the socket; Apple-DRI exports a surface to a local process)',
        'Over a network, indirect GLX is the backend that can work at all — leave\n' +
          'glPolicy at its default.'
      );
    }

    const client = probeDirect(policy);
    if (!client.ok) return fail(client.code, client.message, client.hint);

    if (client.flavor === 'appledri') {
      // No descriptor ever crosses this socket — the fd-passing checks the
      // dri3 flavor needs below do not apply, which is also what lets this
      // path work under runtimes that cannot send one.
      const dri = loadDriAddon();
      let appleClientId;
      try {
        // the WindowServer handshake happens on first call; a session with
        // no WindowServer (SSH into the machine) is where it throws
        appleClientId = dri.apple.clientId();
      } catch (err) {
        return fail(
          GLError.NO_WINDOWSERVER,
          `this process has no WindowServer session to import surfaces into (${err.message})`,
          'Apple-DRI hands the window surface to the WindowServer connection of this\n' +
            'process, which an SSH session does not have. Run the app from the logged-in\n' +
            'GUI session; over SSH, indirect GLX is the backend that can work.'
        );
      }
      const AppleDRI = await requireAppleDRI(app.display);
      if (!AppleDRI) {
        return fail(
          GLError.NO_APPLEDRI,
          `${displayName()} does not have the Apple-DRI extension, so it cannot export a window surface to render into`,
          'Apple-DRI is XQuartz\'s direct-rendering extension — is this display an\n' +
            'XQuartz server? Indirect GLX is the backend that can work on any other.'
        );
      }
      const capable = await new Promise((resolve) =>
        AppleDRI.QueryDirectRenderingCapable(0, (err, answer) => resolve(err ? false : answer))
      );
      if (!capable) {
        return fail(
          GLError.NO_APPLEDRI,
          `${displayName()} has Apple-DRI but reports it not direct-rendering capable`,
          'XQuartz answers this false when its Xplugin backend is not driving a real\n' +
            'display. Indirect GLX is the backend that can work on such a server.'
        );
      }
      return {
        direct: true,
        indirect,
        flavor: 'appledri',
        device: null,
        reason: null,
        DRI3: null,
        Present: null,
        AppleDRI,
        appleClientId
      };
    }

    if (!canPassDescriptors(app.display)) {
      // The socket is local; what is missing is the ability to send a
      // descriptor along it. x11 carries one through Node's internal
      // `process.binding('pipe_wrap')`, and under Bun through `bun:ffi`
      // calling `sendmsg(2)` — the latter since x11 4.1.0, so an x11 below
      // that under Bun lands here, as does a runtime with neither path and a
      // transport that would not initialise. Saying "not a local socket"
      // would send the reader off to check their DISPLAY, which is fine.
      return fail(
        GLError.NO_FD_PASSING,
        `this connection cannot pass file descriptors over the X socket under ${runtimeName()}, and DRI3 works by passing one`,
        'The connection is local; the descriptor transport is what is missing.\n' +
          "x11 carries one through Node's process.binding('pipe_wrap') under Node, and\n" +
          'through bun:ffi sendmsg(2) under Bun from x11 4.1.0 on. Under Bun on an older\n' +
          'x11, `npm install x11@^4.1.0` is the whole fix. Otherwise leave glPolicy at\n' +
          'its default and use indirect GLX, which needs no descriptor passing at all.'
      );
    }

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

    return {
      direct: true,
      indirect,
      flavor: 'dri3',
      device: client.device,
      reason: null,
      DRI3,
      Present,
      AppleDRI: null,
      appleClientId: null
    };
  })();
  return app._glCaps;
}

/**
 * How many colour samples per pixel a direct-backend window has. Zero, on
 * both flavors, and this is the one place that says so.
 *
 * Not because multisampling is exotic on a GPU — it is nearly free there —
 * but because the sample count belongs to the pixel format the `x11-dri`
 * addon builds one layer below ntk: `EGL_SAMPLES` on the EGLConfig behind
 * the GBM surface (`dri3`), `kCGLPFASamples`/`kCGLPFASampleBuffers` on the
 * CGL pixel format (`appledri`). Its `Gpu` and `apple.Context` take a depth
 * size and no sample count, and its GL table has neither
 * `renderbufferStorageMultisample` nor `blitFramebuffer`, so there is not a
 * multisampled framebuffer for ntk to resolve by hand either. Nothing here
 * can conjure one — what it can do is not pretend, which is why
 * `chooseGLConfig` reports `samples` on every backend and says so out loud
 * when the spec asked for more than it got (issue #341).
 *
 * When the addon grows the option this becomes what it reports, and the
 * request travels the rest of the way without another change here.
 */
export const DIRECT_SAMPLES = 0;

/**
 * The sample count a GLX-vocabulary spec asks for: `SAMPLES` when it names
 * one, 1 for a bare `SAMPLE_BUFFERS` (multisample, width up to the driver),
 * and 0 when it asks for no multisampling at all — which is also what a
 * config object from `chooseGLConfig` reads as, since it carries neither.
 */
export function requestedSamples(spec = {}) {
  const samples = Number(spec.SAMPLES) || 0;
  if (samples > 0) return samples;
  return Number(spec.SAMPLE_BUFFERS) > 0 ? 1 : 0;
}

/**
 * Say — once per connection, on the console — that a multisample request
 * cannot be honoured here.
 *
 * A downgrade rather than a failure: the window renders, its edges alias.
 * That is exactly the kind of thing an app finds out about six months later
 * from a screenshot, so it is worth one warning and a `samples` field to
 * branch on. Once per connection because every window would otherwise say
 * it again.
 */
export function warnDirectSamples(app, flavor, wanted) {
  if (app._warnedDirectSamples) return;
  app._warnedDirectSamples = true;
  console.warn(
    `ntk: this GL request asks for SAMPLES=${wanted}, and the direct backend` +
      `${flavor ? ` (${flavor} flavor)` : ''} cannot give a window a multisampled buffer, so it has ` +
      'samples: 0 and its edges will alias.\n' +
      '\n' +
      '  The sample count belongs to the pixel format x11-dri builds one layer below\n' +
      '  ntk (EGL_SAMPLES on dri3, kCGLPFASamples on appledri), and it takes no such\n' +
      '  option yet — there is nothing here to ask with.\n' +
      '\n' +
      '  Branch on config.samples (or gl.samples) rather than on having asked. For\n' +
      "  multisampling today: indirect GLX honours SAMPLES (glPolicy: 'indirect'),\n" +
      '  where the server picks an fbconfig that has it — or supersample in your own\n' +
      '  draw code. See docs/context-gles.md#multisampling.'
  );
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
