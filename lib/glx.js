// GLX visual/fbconfig discovery.
//
// A GLX drawable has to use a visual the GL context was created for, so the
// visual must be known *before* CreateWindow. This module asks the server
// (GetFBConfigs, falling back to the GLX 1.2 GetVisualConfigs) instead of
// shelling out to `glxinfo`, so it works headlessly and in CI.

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
  LEVEL: 'level'
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
 *   doubleBuffer: boolean, depthSize: number, fbconfig: number|null,
 *   config: object}>}
 */
export async function chooseGLXConfig(app, spec = {}) {
  const GLX = app.display.GLX;
  if (!GLX) {
    throw new Error(
      'GLX: extension not available on this display — indirect GLX is often disabled (X server flag +iglx / AllowIndirectGLX)'
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
    if (!info) throw new Error(`GLX: visual 0x${want.visual.toString(16)} is not on screen ${screenNum}`);
    return {
      visual: want.visual,
      depth: info.depth,
      class: info.visual.class,
      doubleBuffer: !!toNumber(want.DOUBLEBUFFER),
      depthSize: toNumber(want.DEPTH_SIZE) || 0,
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
      screen: screenNum,
      fbconfig: null,
      config: cfg
    });
  }
  const legacyBest = pick(fromVisuals);
  if (legacyBest) return legacyBest;

  throw new Error(
    `GLX: no visual on screen ${screenNum} matches ${describe(want)} (server offered ${legacy.length} GLX visuals)`
  );
}

export default chooseGLXConfig;
