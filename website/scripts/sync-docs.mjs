// Sync the repo's hand-written API reference (docs/) into the website's
// docs/reference/ directory, which is gitignored and regenerated on every
// build (`prebuild`) and on `npm start`.
//
// ntk's docs/ is flat: README.md (the index) plus one .md file per topic,
// with image assets referenced relatively (docs/img/*, docs/*.png). For each
// markdown file this script:
//   - adds Docusaurus front matter (title from the first `# heading`,
//     sidebar_position following the section order in docs/README.md, and a
//     custom_edit_url pointing at the real source file in the repo, since
//     the synced copy is not committed);
//   - rewrites links to README.md -> index.md (the file is renamed so that
//     Docusaurus serves it as /docs/reference);
//   - keeps relative links to co-located assets (images) intact and copies
//     the assets through — Docusaurus serves assets co-located with docs;
//   - rewrites relative links to other repo files (../examples/foo.js,
//     ../lib/bar.js) as absolute GitHub URLs;
//   - keeps the .md extension so Docusaurus (with `markdown.format:
//     'detect'`) parses the files as CommonMark, not MDX — the reference
//     contains angle-bracket placeholders and brace literals that are not
//     valid MDX.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const websiteDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoDir = path.dirname(websiteDir);
const srcDir = path.join(repoDir, 'docs');
const outDir = path.join(websiteDir, 'docs', 'reference');

const EDIT_BASE = 'https://github.com/sidorares/ntk/tree/master/docs/';
const REPO_BASE = 'https://github.com/sidorares/ntk/tree/master/';

/** Extract the first `# Heading` as the page title. */
function extractTitle(markdown, fallback) {
  const m = markdown.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

/**
 * Rewrite one markdown link target for the new layout. `srcRel` is the
 * source file's path relative to the repo's docs/ dir.
 *   - absolute URLs and #anchors pass through;
 *   - *.md links stay relative (they move together); README.md is renamed
 *     to index.md so links to it are renamed too;
 *   - links to files that exist inside docs/ (image assets) stay relative —
 *     the assets are copied into the output tree below;
 *   - anything else is a repo source file (../examples/foo.js, ../lib/…):
 *     resolve it against the source file's repo location and point it at
 *     GitHub.
 */
function rewriteTarget(target, srcRel) {
  if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) return target; // absolute/anchor
  const [file, anchor = ''] = target.split(/(?=#)/);
  if (file.endsWith('.md')) {
    // keep relative; only the README.md -> index.md rename applies
    return `${file.replace(/README\.md$/, 'index.md')}${anchor}`;
  }
  const srcDirRel = path.posix.dirname(srcRel.split(path.sep).join('/'));
  const inDocs = path.posix.normalize(path.posix.join(srcDirRel, file));
  if (!inDocs.startsWith('..') && fs.existsSync(path.join(srcDir, inDocs))) {
    return target; // co-located asset, copied through by copyAssets()
  }
  const repoPath = path.posix.normalize(path.posix.join('docs', srcDirRel, file));
  return `${REPO_BASE}${repoPath}${anchor}`;
}

/**
 * Apply `fn` to every line segment that is outside fenced code blocks and
 * inline code spans — both the link rewriter and the sanitizer must leave
 * code examples alone (e.g. the literal `[links](url)` in docs/text.md).
 */
function mapOutsideCode(markdown, fn) {
  const lines = markdown.split('\n');
  let inFence = false;
  const out = lines.map(line => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    return line
      .split(/(`+[^`]*`+)/)
      .map((part, i) => (i % 2 === 1 ? part : fn(part)))
      .join('');
  });
  return out.join('\n');
}

function rewriteLinks(markdown, srcRel) {
  return mapOutsideCode(markdown, text =>
    text.replace(
      /(!?\]\()([^()\s]+)(\))/g,
      (all, open, target, close) => `${open}${rewriteTarget(target, srcRel)}${close}`
    )
  );
}

/**
 * Guard against constructs that CommonMark would pass through as raw HTML:
 * angle-bracket placeholders like <wid> outside code spans/fences must not
 * silently disappear from the rendered page, so wrap them in backticks.
 */
function sanitize(markdown) {
  return mapOutsideCode(markdown, text =>
    text.replace(
      /<(?!\/?(?:a|b|i|em|strong|code|pre|br|hr|img|sub|sup|table|thead|tbody|tr|td|th|ul|ol|li|p|div|span|details|summary|kbd)\b)(?!https?:)([A-Za-z_][\w.-]*)>/g,
      '`<$1>`'
    )
  );
}

function frontMatter(fields) {
  const body = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) =>
      typeof v === 'string' ? `${k}: ${JSON.stringify(v)}` : `${k}: ${v}`
    )
    .join('\n');
  return `---\n${body}\n---\n\n`;
}

function syncFile(srcRel, outRel, { title, sidebarPosition, slug } = {}) {
  const srcPath = path.join(srcDir, srcRel);
  const outPath = path.join(outDir, outRel);
  let markdown = fs.readFileSync(srcPath, 'utf8');
  markdown = sanitize(rewriteLinks(markdown, srcRel));
  const fm = frontMatter({
    title: title ?? extractTitle(markdown, path.basename(srcRel, '.md')),
    sidebar_position: sidebarPosition,
    slug,
    custom_edit_url: EDIT_BASE + srcRel.split(path.sep).join('/'),
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, fm + markdown);
}

/** Copy every non-markdown file in docs/ through (images and other assets). */
function copyAssets(dir = '') {
  let n = 0;
  for (const entry of fs.readdirSync(path.join(srcDir, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      n += copyAssets(rel);
    } else if (!entry.name.endsWith('.md')) {
      const outPath = path.join(outDir, rel);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.copyFileSync(path.join(srcDir, rel), outPath);
      n++;
    }
  }
  return n;
}

// Regenerate from scratch so deletions in docs/ propagate.
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// Sidebar order mirrors the section list in docs/README.md.
const ORDER = [
  'getting-started.md',
  'app.md',
  'window.md',
  'pixmap.md',
  'context-2d.md',
  'images.md',
  'fonts.md',
  'text.md',
  'tex.md',
  'mermaid.md',
  'html.md',
  'svg.md',
  'context-opengl.md',
  'context-x11.md',
  'resource-management.md',
];

syncFile('README.md', 'index.md', {
  title: 'Overview',
  sidebarPosition: 1,
  slug: '/reference',
});

const topicFiles = fs
  .readdirSync(srcDir)
  .filter(f => f.endsWith('.md') && f !== 'README.md')
  .sort((a, b) => {
    const ia = ORDER.indexOf(a);
    const ib = ORDER.indexOf(b);
    // files missing from ORDER (newly added docs) trail, alphabetically
    return (ia === -1 ? ORDER.length : ia) - (ib === -1 ? ORDER.length : ib) ||
      a.localeCompare(b);
  });
topicFiles.forEach((file, i) => {
  syncFile(file, file, { sidebarPosition: i + 2 });
});

const assets = copyAssets();

console.log(
  `sync-docs: wrote ${1 + topicFiles.length} reference pages ` +
    `(+ ${assets} assets) to ${path.relative(websiteDir, outDir)}`
);
