// The layout engine, without a top-level await.
//
// `yoga-layout`'s default entry is `const Yoga = wrapAssembly(await
// loadYoga())`. That one `await` is contagious: every bundle containing ntk
// inherits it, esbuild then refuses to emit CommonJS ("Top-level await is
// currently not supported with the cjs output format"), and Node's single
// executable format runs its embedded main as CommonJS — so an ntk app could
// not be shipped as one binary at all.
//
// So ntk imports the half of the package that has no WASM in it —
// `yoga-layout/load` exports the enums as plain JavaScript and the assembly
// behind an async function — and loads the assembly during `createClient()`,
// which is already asynchronous.
//
// The object exported here keeps yoga's own shape, and that is the point:
// the flat SCREAMING_CASE constants are present from the first tick, so a
// consumer that builds a lookup table at module scope (ntk's own HtmlView,
// react-x11's styles.js) still reads them at import time. `Node`, `Config`
// and the rest of the assembly appear when `loadLayout()` resolves.

import {
  loadYoga,
  Align,
  BoxSizing,
  Dimension,
  Direction,
  Display,
  Edge,
  Errata,
  ExperimentalFeature,
  FlexDirection,
  Gutter,
  Justify,
  LogLevel,
  MeasureMode,
  NodeType,
  Overflow,
  PositionType,
  Unit,
  Wrap
} from 'yoga-layout/load';

const ENUMS = {
  Align,
  BoxSizing,
  Dimension,
  Direction,
  Display,
  Edge,
  Errata,
  ExperimentalFeature,
  FlexDirection,
  Gutter,
  Justify,
  LogLevel,
  MeasureMode,
  NodeType,
  Overflow,
  PositionType,
  Unit,
  Wrap
};

// yoga's generator names each constant <ENUM>_<MEMBER>, both snake-cased from
// PascalCase: FlexDirection.ColumnReverse -> FLEX_DIRECTION_COLUMN_REVERSE.
// yoga-export.test.js pins every name against the real assembly, so a rename
// upstream fails loudly instead of yielding an undefined constant.
const screamingSnake = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

/** The layout engine: enums now, assembly after `loadLayout()`. */
const Yoga = {};
for (const [enumName, members] of Object.entries(ENUMS)) {
  // a bundler may stub yoga out entirely — the browser playground does,
  // since no demo uses HtmlView — and importing ntk must still work
  if (!members || typeof members !== 'object') continue;
  const prefix = screamingSnake(enumName);
  for (const [member, value] of Object.entries(members)) {
    if (typeof value === 'number') Yoga[`${prefix}_${screamingSnake(member)}`] = value;
  }
}

const notLoaded = (what) => () => {
  throw new Error(
    `ntk: the layout engine is not loaded, so Yoga.${what} is not available yet. ` +
      'createClient() loads it; widgets used without an App need `await loadLayout()` first.'
  );
};

// A useful message instead of "Cannot read properties of undefined"
for (const name of ['Node', 'Config']) {
  Object.defineProperty(Yoga, name, { configurable: true, get: notLoaded(name) });
}

let loading = null;

/**
 * Load the layout engine's WebAssembly. Idempotent, and resolves with the
 * same `Yoga` object this module exports — `createClient()` awaits it, so
 * applications rarely call it themselves. Widgets used without an App
 * (`new HtmlView(null, …)`) need it.
 */
export function loadLayout() {
  if (!loading) {
    loading = loadYoga().then((assembly) => {
      for (const name of ['Node', 'Config']) delete Yoga[name]; // drop the throwing getters
      Object.assign(Yoga, assembly);
      return Yoga;
    });
  }
  return loading;
}

/** Whether the assembly is in place — layout will not throw. */
export function layoutLoaded() {
  return Object.getOwnPropertyDescriptor(Yoga, 'Node')?.value !== undefined;
}

export { Yoga };
export default Yoga;
