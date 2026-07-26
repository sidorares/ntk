// Correctness gate for the playground demos: runs every demo string from
// website/src/demos against the repo's RENDER-enabled JS X server
// (lib/xserver) in node, exactly the way the browser runner does (require
// shim + DISPLAY protocol + StaticFontSource with the bundled DejaVu
// faces), injects input where relevant, and asserts nothing threw and
// pixels changed.
//
//   node scripts/check-demos.mjs
//
// NOTE: depends on lib/xserver (built separately). Until it exists this
// script fails fast with a clear message.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const websiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(websiteDir, '..');
const demosDir = path.join(websiteDir, 'src', 'demos');

const xserverPath = path.join(repoRoot, 'lib', 'xserver', 'index.js');
if (!fs.existsSync(xserverPath)) {
  console.error(
    'check-demos: lib/xserver/index.js does not exist yet (the RENDER-enabled\n' +
    'JS X server is built separately). The demos cannot be verified without\n' +
    'it — re-run once lib/xserver lands.'
  );
  process.exit(1);
}

const ntk = await import(pathToFileURL(path.join(repoRoot, 'lib', 'index.js')));
const x11 = require(path.join(repoRoot, 'node_modules', 'x11'));
const { createServer, createStreamPair } = await import(pathToFileURL(xserverPath));

// same fonts as the browser bundle: no fontconfig dependency, hermetic runs
const dejavu = (file) =>
  fs.readFileSync(require.resolve(`dejavu-fonts-ttf/ttf/${file}`));
const fontSource = new ntk.StaticFontSource();
fontSource.add(dejavu('DejaVuSans.ttf'), { family: 'DejaVu Sans' });
fontSource.add(dejavu('DejaVuSans-Bold.ttf'), { family: 'DejaVu Sans' });
fontSource.add(dejavu('DejaVuSans-Oblique.ttf'), { family: 'DejaVu Sans' });
fontSource.add(dejavu('DejaVuSerif.ttf'), { family: 'DejaVu Serif' });
fontSource.add(dejavu('DejaVuSansMono.ttf'), { family: 'DejaVu Sans Mono' });
fontSource.alias('sans-serif', 'DejaVu Sans');
fontSource.alias('serif', 'DejaVu Serif');
fontSource.alias('monospace', 'DejaVu Sans Mono');
ntk.setDefaultFontSource(fontSource);

// same wiring as static/demo/runner/index.html
process.env.DISPLAY = 'demo/local:0';

let current = null; // { server, streams }
x11.registerDisplayProtocol('demo', () => {
  if (!current) throw new Error('no demo server running');
  const [clientSide, serverSide] = createStreamPair();
  current.server.addClientStream(serverSide);
  current.streams.push(clientSide);
  return clientSide;
});

// Demo modules are browser ESM ({ export default {...} }, no imports);
// evaluate them in node with a one-line transform.
function loadDemo(file) {
  const src = fs.readFileSync(file, 'utf8');
  return new Function(`${src.replace(/^export default/m, 'return')}`)();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function checksum(server) {
  server.compose();
  const data = server.root.raster.data;
  let sum = 0;
  for (let i = 0; i < data.length; i++)
    sum = (sum * 31 + data[i]) >>> 0;
  return sum;
}

// per-demo input exercise, mirroring what a user would do in the browser
const exercises = {
  'pointer-paint'(server) {
    server.injectPointerMove(200, 200);
    server.injectButton(1, true);
    for (let i = 0; i <= 10; i++)
      server.injectPointerMove(200 + i * 8, 200 + i * 4);
    server.injectButton(1, false);
  },
  gradient(server) {
    server.injectPointerMove(150, 200);
    server.injectPointerMove(300, 260);
  },
  'event-log'(server) {
    server.injectPointerMove(120, 120);
    server.injectButton(1, true);
    server.injectButton(1, false);
    for (const keysym of [0x68, 0x65, 0x79]) { // 'h' 'e' 'y'
      const keycode = server.keymap.keycodeForKeysym(keysym);
      if (!keycode) continue;
      server.injectKey(keycode, true);
      server.injectKey(keycode, false);
    }
  },
};

async function runDemo(demo) {
  const server = createServer({ width: 640, height: 480 });
  current = { server, streams: [] };
  const problems = [];
  const timers = { intervals: [], timeouts: [] };
  let logCount = 0;

  const demoConsole = {
    log: () => { logCount++; },
    info: () => { logCount++; },
    warn: () => {},
    error: (...args) => problems.push(new Error(`console.error: ${args.join(' ')}`)),
  };
  const trackInterval = (fn, ms) => { const id = setInterval(fn, ms); timers.intervals.push(id); return id; };
  const trackTimeout = (fn, ms) => { const id = setTimeout(fn, ms); timers.timeouts.push(id); return id; };
  const demoRequire = name => {
    if (name === 'ntk') return ntk;
    if (name === 'x11') return x11;
    throw new Error(`module not available in the playground: ${name}`);
  };
  const onUncaught = err => problems.push(err);
  process.on('uncaughtException', onUncaught);
  const onRejection = err => problems.push(err);
  process.on('unhandledRejection', onRejection);

  const before = checksum(server);
  try {
    const fn = new Function(
      'require', 'process', 'console',
      'setInterval', 'setTimeout', 'clearInterval', 'clearTimeout',
      demo.code);
    fn(demoRequire, process, demoConsole,
      trackInterval, trackTimeout, clearInterval, clearTimeout);
    await sleep(500); // handshake, map, expose drawing
    const afterSetup = checksum(server);
    if (exercises[demo.id]) {
      exercises[demo.id](server);
      await sleep(300);
    }
    const after = checksum(server);

    if (after === before && afterSetup === before)
      problems.push(new Error('no pixels changed on the server raster'));
    if (demo.id === 'pointer-paint' && after === afterSetup)
      problems.push(new Error('painting via injected pointer input changed nothing'));
    if (demo.id === 'event-log' && logCount === 0)
      problems.push(new Error('no events were logged'));
    if (demo.id === 'bouncing-ball') {
      const mid = checksum(server);
      await sleep(200);
      if (checksum(server) === mid)
        problems.push(new Error('animation is not animating'));
    }
  } catch (err) {
    problems.push(err);
  } finally {
    timers.intervals.forEach(clearInterval);
    timers.timeouts.forEach(clearTimeout);
    current.streams.forEach(s => { try { s.destroy(); } catch { /* gone */ } });
    current = null;
    await sleep(80); // let in-flight callbacks drain while still monitored
    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('unhandledRejection', onRejection);
  }
  return problems;
}

const files = fs.readdirSync(demosDir)
  .filter(f => f.endsWith('.js') && f !== 'index.js')
  .sort();
if (files.length === 0) {
  console.error('no demos found in', demosDir);
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const demo = loadDemo(path.join(demosDir, file));
  const problems = await runDemo(demo);
  if (problems.length === 0) {
    console.log(`ok   ${demo.id}`);
  } else {
    failed++;
    console.error(`FAIL ${demo.id}`);
    for (const p of problems)
      console.error(`     ${p && p.stack ? p.stack.split('\n')[0] : p}`);
  }
}

console.log(failed === 0 ? `all ${files.length} demos green` : `${failed} demo(s) failed`);
process.exit(failed === 0 ? 0 : 1);
