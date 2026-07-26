// Minimal SVG viewer: renders a file through the SvgView widget (fitted
// and centered, re-fit on resize).
//
//   node svg-viewer.js [path/to/file.svg]
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient, SvgView } from '../lib/index.js';

const file = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), 'assets', 'sample.svg');
const svg = await readFile(file, 'utf8');

const app = await createClient();
const wnd = app.createWindow({ title: `svg: ${file}`, width: 520, height: 420 });
const view = new SvgView(wnd, { theme: { background: '#dddddd' } });
view.setSvg(svg);
console.log(`rendering ${file} (${view.naturalWidth}x${view.naturalHeight})`);
wnd.map();
