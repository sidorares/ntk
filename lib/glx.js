// GLX visual/fbconfig discovery, and the diagnosis of a failed setup.
//
// A GLX drawable has to use a visual the GL context was created for, so the
// visual must be known *before* CreateWindow. This module asks the server
// (GetFBConfigs, falling back to the GLX 1.2 GetVisualConfigs) instead of
// shelling out to `glxinfo`, so it works headlessly and in CI.

/**
 * `err.code` on every error this module and the OpenGL context throw, so
 * callers can branch on the cause instead of matching on message text.
 *
 * - `GLX_NO_EXTENSION` — the server does not have the GLX extension.
 * - `GLX_INDIRECT_DISABLED` — it has GLX, but refuses indirect contexts,
 *   which is the only kind that works over the wire. The default on Xorg
 *   >= 1.17 and Xwayland, and by far the most common failure.
 * - `GLX_NO_CONFIG` — no visual/fbconfig matches the requested attributes.
 * - `GLX_CONTEXT_FAILED` — anything else that went wrong in setup.
 */
export const GLXError = {
  NO_EXTENSION: 'GLX_NO_EXTENSION',
  INDIRECT_DISABLED: 'GLX_INDIRECT_DISABLED',
  NO_CONFIG: 'GLX_NO_CONFIG',
  CONTEXT_FAILED: 'GLX_CONTEXT_FAILED'
};

// `message` says what is wrong in one line; `hint` is the multi-line
// remedy, printed by the default warning and available to anyone rendering
// their own fallback UI.
function glxError(code, message, hint, cause) {
  const err = new Error(message);
  err.code = code;
  if (hint) err.hint = hint;
  if (cause) err.cause = cause;
  return err;
}

const displayName = () => process.env.DISPLAY || 'the X server';

const IGLX_HINT = `Indirect GLX is what ntk draws with: GL commands travel over the X
connection, since there is no client-side GL library involved. Xorg >= 1.17
and Xwayland ship with it disabled, and answer GLX CreateContext with
BadValue. The extension is still present and still advertises GLX 1.4 with a
full set of fbconfigs, which is why this looks like it should have worked.

To get a server that allows it:
  under Wayland:  Xwayland :5 +iglx &  then DISPLAY=:5
  under X:        Xephyr :5 +iglx &    then DISPLAY=:5
  Xorg:           +iglx on the command line, or
                  Option "AllowIndirectGLX" "on" in xorg.conf
  XQuartz:        defaults write org.xquartz.X11 enable_iglx -bool true

Note that on current Linux distros the indirect GL *engine* behind those
contexts is often gone even with +iglx on — contexts are created but nothing
rasterizes. See docs/context-opengl.md.`;

/** Turn a failed GLX CreateContext into an error that explains itself. */
export function diagnoseCreateContext(err, cfg) {
  // BadValue with value 0 from CreateContext (minor opcode 3) is how a
  // server without +iglx says "no indirect contexts here" — every other
  // rejection names the value it disliked
  if (err?.error === 2 && err.badParam === 0) {
    return glxError(
      GLXError.INDIRECT_DISABLED,
      `${displayName()} has GLX but refuses to create indirect GLX contexts, so there is no OpenGL context to draw with`,
      IGLX_HINT,
      err
    );
  }
  const visual = cfg?.visual ? ` for visual 0x${cfg.visual.toString(16)}` : '';
  return glxError(
    GLXError.CONTEXT_FAILED,
    `GLX CreateContext${visual} failed: ${err?.message ?? err}`,
    null,
    err
  );
}

/**
 * The console form of a failed GL setup: what went wrong, then how to fix
 * it. Indented so the remedy reads as one block and not as unrelated log
 * lines, and ending with the way to take over the handling.
 */
export function glxErrorReport(err) {
  const lines = [`ntk: getContext('opengl') failed — ${err?.message ?? err}`];
  if (err?.hint) lines.push('', ...err.hint.split('\n').map((l) => (l ? `  ${l}` : l)));
  lines.push('', `  (await gl.ready to handle this yourself; err.code is ${err?.code ?? 'unset'})`);
  return lines.join('\n');
}

/**
 * Create a GLX context and find out whether it worked.
 *
 * CreateContext has no reply, so its failure would otherwise surface as an
 * unattributed X error plus a misleading GLXBadContext from the MakeCurrent
 * that follows. node-x11 >= 3.8 takes a callback here; older versions
 * cannot report it at all, and this resolves optimistically rather than
 * hanging.
 */
export function createContext(GLX, ctx, cfg) {
  if (GLX.CreateContext.length < 6) {
    GLX.CreateContext(ctx, cfg.visual, cfg.screen ?? 0, 0, 0);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    GLX.CreateContext(ctx, cfg.visual, cfg.screen ?? 0, 0, 0, (err) => {
      if (err) reject(diagnoseCreateContext(err, cfg));
      else resolve();
      return true; // handled here; keep it away from the app's onXError
    });
  });
}

// defaults applied on top of the caller's spec; `null` means "don't care"
const DEFAULT_SPEC = {
  DOUBLEBUFFER: true,
  DEPTH_SIZE: 16,
  RED_SIZE: 8,
  GREEN_SIZE: 8,
  BLUE_SIZE: 8
};

// GLX 1.2 GetVisualConfigs property names for the attributes we filter on
const legacyProps = {
  DOUBLEBUFFER: 'doubleBufferMode',
  STEREO: 'stereoMode',
  BUFFER_SIZE: 'rgbBits',
  DEPTH_SIZE: 'depthBits',
  STENCIL_SIZE: 'stencilBits',
  RED_SIZE: 'redBits',
  GREEN_SIZE: 'greenBits',
  BLUE_SIZE: 'blueBits',
  ALPHA_SIZE: 'alphaBits',
  AUX_BUFFERS: 'numAuxBuffers',
  LEVEL: 'level',
  // Not among GetVisualConfigs' fixed properties, but a server that has
  // multisample visuals sends these as (tag, value) pairs after them, which
  // x11 decodes under their attribute names. Mapped to themselves so a
  // SAMPLES request is filtered on this path too rather than passing
  // through unexamined — a spec that asks for multisampling and gets a
  // visual without it is the failure this whole field exists to stop.
  SAMPLE_BUFFERS: 'SAMPLE_BUFFERS',
  SAMPLES: 'SAMPLES'
};

// attributes compared as "at least this much"; the rest must match exactly
const minimums = new Set([
  'BUFFER_SIZE',
  'DEPTH_SIZE',
  'STENCIL_SIZE',
  'RED_SIZE',
  'GREEN_SIZE',
  'BLUE_SIZE',
  'ALPHA_SIZE',
  'AUX_BUFFERS',
  'SAMPLE_BUFFERS',
  'SAMPLES'
]);

function toNumber(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

// the X depth and visual info for a visual id, or null if the screen has no
// such visual (fbconfigs with VISUAL_ID 0 are pbuffer/pixmap only)
function visualInfo(screen, visualId) {
  if (!visualId) return null;
  for (const depth in screen.depths) {
    const visual = screen.depths[depth][visualId];
    if (visual) return { depth: Number(depth), visual };
  }
  return null;
}

function describe(spec) {
  return (
    Object.entries(spec)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ') || '(no constraints)'
  );
}

function fbConfigs(GLX, screen, spec) {
  return new Promise((resolve, reject) => {
    // ChooseFBConfig filters and sorts per the GLX 1.4 selection rules
    GLX.ChooseFBConfig(screen, spec, (err, configs) => {
      // a bad attribute name is the caller's bug, not a missing feature —
      // everything else means "this server has no fbconfigs for us"
      if (err instanceof TypeError) return reject(err);
      resolve(err ? [] : configs);
    });
  });
}

function visualConfigs(GLX, screen) {
  return new Promise((resolve) => {
    GLX.GetVisualConfigs(screen, (err, configs) => resolve(err ? [] : configs));
  });
}

// GLX 1.2 fallback: filter GetVisualConfigs results by the same spec
function matchLegacy(configs, spec) {
  return configs.filter((cfg) => {
    if (!cfg.rgbMode) return false;
    for (const key in spec) {
      const want = toNumber(spec[key]);
      if (want === null || want === undefined) continue;
      const prop = legacyProps[key];
      // attributes GetVisualConfigs doesn't report (RENDER_TYPE,
      // DRAWABLE_TYPE, ...) can't be checked — RGBA windows are all this
      // path can offer anyway
      if (!prop) continue;
      const have = cfg[prop] || 0;
      if (minimums.has(key) ? have < want : have !== want) return false;
    }
    return true;
  });
}

/**
 * Choose a GLX-capable visual on `app`'s display.
 *
 * @param {import('./app.js').default} app
 * @param {object} [spec] GLX attribute constraints by name (see
 *   `GLX.glxAttrib`), e.g. `{ DEPTH_SIZE: 24, DOUBLEBUFFER: true }`;
 *   `null` means "don't care". `screen` picks the X screen (default 0),
 *   `visual` pins a specific visual id and skips the search.
 * @returns {Promise<{visual: number, depth: number, class: number,
 *   doubleBuffer: boolean, depthSize: number, samples: number|null,
 *   fbconfig: number|null, config: object}>} `samples` is the colour
 *   samples per pixel the chosen config has — 0 for no multisampling, and
 *   `null` only in the pinned-`visual` case, where no fbconfig was looked
 *   at to know.
 */
export async function chooseGLXConfig(app, spec = {}) {
  const GLX = app.display.GLX;
  if (!GLX) {
    throw glxError(
      GLXError.NO_EXTENSION,
      `${displayName()} does not have the GLX extension, so it cannot do OpenGL at all`,
      'A server built without GLX, or started with -extension GLX. This is a\n' +
        'different problem from indirect GLX being disabled, which is the usual\n' +
        'one — there the extension is present and CreateContext is what fails.'
    );
  }

  const { screen: screenNum = 0, preferVisual, ...wanted } = spec;
  const want = { ...DEFAULT_SPEC, ...wanted };
  const screen = app.display.screen[screenNum];
  // a candidate list is searched for `preferVisual` first: a context must
  // be created for the visual its drawable already has
  const pick = (candidates) =>
    (preferVisual && candidates.find((c) => c.visual === preferVisual)) || candidates[0];

  if (want.visual) {
    const info = visualInfo(screen, want.visual);
    if (!info)
      throw glxError(
        GLXError.NO_CONFIG,
        `GLX: visual 0x${want.visual.toString(16)} is not on screen ${screenNum}`
      );
    return {
      visual: want.visual,
      depth: info.depth,
      class: info.visual.class,
      doubleBuffer: !!toNumber(want.DOUBLEBUFFER),
      depthSize: toNumber(want.DEPTH_SIZE) || 0,
      // the caller pinned the visual, so nothing was chosen and no fbconfig
      // was read: unknown, which is not the same claim as "none"
      samples: null,
      screen: screenNum,
      fbconfig: null,
      config: {}
    };
  }

  // GLX >= 1.3 fbconfigs first; they carry the attributes we care about
  const fromFbConfigs = [];
  for (const cfg of await fbConfigs(GLX, screenNum, want)) {
    const info = visualInfo(screen, cfg.VISUAL_ID);
    if (!info) continue; // no X visual: pbuffer/pixmap-only config
    fromFbConfigs.push({
      visual: cfg.VISUAL_ID,
      depth: info.depth,
      class: info.visual.class,
      doubleBuffer: !!cfg.DOUBLEBUFFER,
      depthSize: cfg.DEPTH_SIZE || 0,
      samples: cfg.SAMPLES || 0,
      screen: screenNum,
      fbconfig: cfg.FBCONFIG_ID,
      config: cfg
    });
  }
  const best = pick(fromFbConfigs);
  if (best) return best;

  // GLX 1.2 servers (and servers that report no usable fbconfig)
  const legacy = await visualConfigs(GLX, screenNum);
  const fromVisuals = [];
  for (const cfg of matchLegacy(legacy, want)) {
    const info = visualInfo(screen, cfg.visualID);
    if (!info) continue;
    fromVisuals.push({
      visual: cfg.visualID,
      depth: info.depth,
      class: info.visual.class,
      doubleBuffer: !!cfg.doubleBufferMode,
      depthSize: cfg.depthBits || 0,
      samples: cfg.SAMPLES || 0,
      screen: screenNum,
      fbconfig: null,
      config: cfg
    });
  }
  const legacyBest = pick(fromVisuals);
  if (legacyBest) return legacyBest;

  throw glxError(
    GLXError.NO_CONFIG,
    `GLX: no visual on screen ${screenNum} matches ${describe(want)} (server offered ${legacy.length} GLX visuals)`,
    'Relax the spec — DEPTH_SIZE and DOUBLEBUFFER are the usual culprits.'
  );
}

export default chooseGLXConfig;
