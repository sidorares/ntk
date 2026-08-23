// `ctx.font` and `ctx.fontVariationSettings` on the 2d context — the axis
// reaching the surface an app actually draws on.
//
// Needs a server (a context needs a window); skips without one, like the
// other server-backed tests. The lookup and instancing rules themselves are
// covered hermetically in variable-fonts.test.js.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { StaticFontSource, createClient } from '../lib/index.js';
import { withTimeout } from './helpers/async.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const VF = join(fixtures, 'MonelogicsSubset[wght].ttf');
const SAMPLE = 'Handgloves';

let app = null;
let win = null;
let ctx = null;
let skip = false;

before(async () => {
  if (!process.env.DISPLAY) {
    skip = 'no DISPLAY set';
    return;
  }
  try {
    const fontSource = new StaticFontSource();
    fontSource.add(readFileSync(VF), { family: 'Test VF' });
    fontSource.alias('sans-serif', 'test vf');
    app = await withTimeout(
      createClient({ fontSource }),
      5000,
      'connecting to X server',
      (late) => late.close()
    );
    win = app.createWindow({ width: 400, height: 120 });
    ctx = win.getContext('2d');
  } catch (err) {
    skip = `cannot connect: ${err.message}`;
    if (app) await app.close();
    app = null;
  }
});

after(async () => {
  if (app) await app.close();
});

const widthAt = (font) => {
  ctx.font = font;
  return ctx.measureText(SAMPLE).width;
};

test('a numeric weight in the font shorthand drives the wght axis', (t) => {
  if (skip) return t.skip(skip);
  const light = widthAt('200 40px Test VF');
  const black = widthAt('900 40px Test VF');
  assert.ok(black > light, `900 (${black}) should set wider than 200 (${light})`);
});

test('weights between the named instances measure between them', (t) => {
  if (skip) return t.skip(skip);
  const widths = [400, 500, 600].map((w) => widthAt(`${w} 40px Test VF`));
  assert.ok(widths[0] < widths[1] && widths[1] < widths[2], `monotonic, got ${widths}`);
});

test('fontVariationSettings takes the CSS string and an object alike', (t) => {
  if (skip) return t.skip(skip);
  ctx.font = '40px Test VF';
  ctx.fontVariationSettings = '"wght" 900';
  const fromString = ctx.measureText(SAMPLE).width;

  ctx.fontVariationSettings = { wght: 900 };
  assert.equal(ctx.measureText(SAMPLE).width, fromString);

  ctx.fontVariationSettings = null;
  assert.ok(ctx.measureText(SAMPLE).width < fromString, 'cleared back to the default');
});

test('order does not matter: settings before or after font', (t) => {
  if (skip) return t.skip(skip);
  ctx.fontVariationSettings = null;

  ctx.font = '40px Test VF';
  ctx.fontVariationSettings = { wght: 800 };
  const afterFont = ctx.measureText(SAMPLE).width;

  ctx.fontVariationSettings = null;
  ctx.font = '16px Test VF'; // something else entirely in between
  ctx.fontVariationSettings = { wght: 800 };
  ctx.font = '40px Test VF';
  const beforeFont = ctx.measureText(SAMPLE).width;

  assert.equal(beforeFont, afterFont);
  ctx.fontVariationSettings = null;
});

test('save/restore carries the axis with the rest of the text state', (t) => {
  if (skip) return t.skip(skip);
  ctx.fontVariationSettings = null;
  ctx.font = '40px Test VF';
  const flat = ctx.measureText(SAMPLE).width;

  ctx.save();
  ctx.fontVariationSettings = { wght: 900 };
  assert.ok(ctx.measureText(SAMPLE).width > flat);
  ctx.restore();

  assert.equal(ctx.measureText(SAMPLE).width, flat, 'restore put the axis back');
  assert.equal(ctx.fontVariationSettings, null);
});

test('an axis the font does not have is ignored, not an error', (t) => {
  if (skip) return t.skip(skip);
  ctx.fontVariationSettings = null;
  ctx.font = '40px Test VF';
  const flat = ctx.measureText(SAMPLE).width;
  ctx.fontVariationSettings = '"wdth" 75';
  assert.equal(ctx.measureText(SAMPLE).width, flat);
  ctx.fontVariationSettings = null;
});
