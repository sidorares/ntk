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

// formats fontkit can parse
const supported = /\.(ttf|otf|woff|woff2|ttc|dfont)$/i;

const sortedCache = new Map();

function patternFor({ family, weight, style }) {
  let fc = family || 'sans-serif';
  const fcWeight = normalizeWeight(weight);
  if (fcWeight !== undefined) fc += `:weight=${fcWeight}`;
  if (style && style.includes('italic')) fc += ':slant=italic';
  return fc;
}

/**
 * Full fontconfig match list for a pattern, best match first — this is the
 * system's font fallback chain. Each candidate carries the unicode coverage
 * fontconfig knows about (`charset`, lazily parsed via `charsetHas`), so a
 * fallback font for a codepoint can be chosen without opening font files.
 *
 * Cached per pattern; one fc-match invocation (~50ms) per distinct pattern.
 *
 * @returns {Array<{path, postscriptName, charset: string}>}
 */
export function matchSortedSync(pattern) {
  const fc = patternFor(pattern);
  let list = sortedCache.get(fc);
  if (list) return list;

  const out = execFileSync(
    'fc-match',
    ['-s', '--format', '%{file}\t%{postscriptname}\t%{charset}\n', fc],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  list = [];
  for (const line of out.split('\n')) {
    const [path, postscriptName, charset] = line.split('\t');
    if (path && supported.test(path)) {
      list.push({ path, postscriptName, charset: charset || '', _ranges: null });
    }
  }
  if (list.length === 0) {
    throw new Error(`No usable font found for pattern "${fc}" (need .ttf/.otf/.ttc)`);
  }
  sortedCache.set(fc, list);
  return list;
}

/**
 * Resolve a font pattern ({family, weight, style}) to the best matching font
 * file. Returns { path, postscriptName } or throws if nothing suitable is
 * installed. Requires the fc-match CLI (fontconfig), present on any system
 * running X11.
 */
export function listFontsSync(pattern) {
  const [best] = matchSortedSync(pattern);
  return { path: best.path, postscriptName: best.postscriptName };
}

/**
 * Does a fc-match candidate's charset cover a codepoint?
 * The charset string is fontconfig's range format: "20-7e a0-ff 131 ...".
 */
export function charsetHas(candidate, codepoint) {
  if (candidate._ranges === null) {
    const ranges = [];
    for (const part of candidate.charset.split(' ')) {
      if (!part) continue;
      const dash = part.indexOf('-');
      if (dash === -1) {
        const v = parseInt(part, 16);
        ranges.push(v, v);
      } else {
        ranges.push(parseInt(part.slice(0, dash), 16), parseInt(part.slice(dash + 1), 16));
      }
    }
    candidate._ranges = ranges;
  }
  const r = candidate._ranges;
  let lo = 0;
  let hi = r.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (codepoint < r[mid * 2]) hi = mid - 1;
    else if (codepoint > r[mid * 2 + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

function normalizeWeight(weight) {
  if (weight === undefined) return undefined;
  if (weight === 'normal') return cssToFcWeight[400];
  if (weight === 'bold') return cssToFcWeight[700];
  const n = parseInt(weight, 10);
  if (Number.isNaN(n)) return undefined;
  return cssToFcWeight[n] !== undefined ? cssToFcWeight[n] : n;
}
