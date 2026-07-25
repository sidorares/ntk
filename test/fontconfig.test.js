import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

import { listFontsSync } from '../lib/fontconfig.js';

let hasFontconfig = true;
try {
  execFileSync('fc-match', ['--version'], { stdio: 'ignore' });
} catch {
  hasFontconfig = false;
}

test('resolves sans-serif to a parseable font file', { skip: !hasFontconfig && 'fc-match not installed' }, () => {
  const match = listFontsSync({ family: 'sans-serif', style: 'normal', weight: 'normal' });
  assert.match(match.path, /\.(ttf|otf|woff)$/i);
});

test('resolves bold and italic patterns', { skip: !hasFontconfig && 'fc-match not installed' }, () => {
  const bold = listFontsSync({ family: 'sans-serif', style: 'normal', weight: 'bold' });
  const italic = listFontsSync({ family: 'sans-serif', style: 'italic', weight: 400 });
  assert.ok(bold.path);
  assert.ok(italic.path);
});
