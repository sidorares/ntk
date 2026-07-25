import { execFileSync } from 'node:child_process';

// css weight -> fontconfig weight constants
const cssToFcWeight = {
  100: 0, // thin
  200: 40, // extralight
  300: 50, // light
  400: 80, // regular
  500: 100, // medium
  600: 180, // demibold
  700: 200, // bold
  800: 205, // extrabold
  900: 210 // black
};

// formats opentype.js can parse (no .ttc/.dfont collections)
const supported = /\.(ttf|otf|woff)$/i;

/**
 * Resolve a font pattern to a font file path using the fontconfig CLI
 * (fc-match), available on any system running X11. Returns { path } or
 * throws if nothing suitable is installed.
 */
export function listFontsSync(pattern) {
  let fc = pattern.family || 'sans-serif';
  const weight = normalizeWeight(pattern.weight);
  if (weight !== undefined) fc += `:weight=${weight}`;
  if (pattern.style && pattern.style.includes('italic')) fc += ':slant=italic';

  // -s returns the full sorted candidate list; pick the best match in a
  // format we can parse
  const out = execFileSync('fc-match', ['-s', '--format', '%{file}\n', fc], {
    encoding: 'utf8'
  });
  const path = out.split('\n').find((f) => supported.test(f));
  if (!path) {
    throw new Error(`No usable font found for pattern "${fc}" (need .ttf/.otf)`);
  }
  return { path };
}

function normalizeWeight(weight) {
  if (weight === undefined) return undefined;
  if (weight === 'normal') return cssToFcWeight[400];
  if (weight === 'bold') return cssToFcWeight[700];
  const n = parseInt(weight, 10);
  if (Number.isNaN(n)) return undefined;
  return cssToFcWeight[n] !== undefined ? cssToFcWeight[n] : n;
}
