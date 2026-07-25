// Fence syntax highlighting for MarkdownView — a thin adapter over
// highlight.js (the `common` build: ~36 languages plus their aliases),
// mapping its output onto flat { text, kind } tokens. The tokenizer used
// to be hand-rolled here; highlight.js is maintained, pure JS and far more
// accurate.
//
// tokenize(code, lang) returns [{ text, kind }] with kinds:
//   'keyword' | 'literal' | 'string' | 'number' | 'comment' | 'tag'
//   | 'attr' | 'function' | 'plain'
// Token texts concatenate back to the exact input.

import hljs from 'highlight.js/lib/common';

// highlight.js scope -> token kind; unlisted scopes inherit the enclosing
// span's kind (nested spans) or fall back to 'plain'
const SCOPE_KINDS = {
  keyword: 'keyword',
  built_in: 'keyword',
  type: 'keyword',
  section: 'keyword',
  meta: 'keyword',
  'selector-tag': 'keyword',
  literal: 'literal',
  symbol: 'literal',
  string: 'string',
  regexp: 'string',
  addition: 'string',
  number: 'number',
  comment: 'comment',
  quote: 'comment',
  doctag: 'comment',
  deletion: 'comment',
  name: 'tag',
  tag: 'tag',
  'selector-id': 'tag',
  'selector-class': 'tag',
  attr: 'attr',
  attribute: 'attr',
  property: 'attr',
  variable: 'attr',
  'template-variable': 'attr',
  title: 'function'
};

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" };

function unescapeHtml(text) {
  return text.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (m) => ENTITIES[m]);
}

/**
 * Tokenize source code for a fence language tag. Unknown languages fall
 * back to a single plain token, so callers can highlight unconditionally.
 *
 * @param {string} code
 * @param {string} [lang] fence tag, e.g. 'js', 'python'; hljs aliases work
 * @returns {Array<{text: string, kind: string}>}
 */
export function tokenize(code, lang) {
  code = String(code ?? '');
  if (!code) return [];
  const name = String(lang ?? '').toLowerCase();
  if (!name || !hljs.getLanguage(name)) return [{ text: code, kind: 'plain' }];

  let html;
  try {
    html = hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
  } catch {
    return [{ text: code, kind: 'plain' }];
  }

  // flatten the emitted <span class="hljs-scope"> tree, tracking nesting
  const tokens = [];
  const stack = ['plain'];
  const emit = (text, kind) => {
    if (!text) return;
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind) last.text += text;
    else tokens.push({ text, kind });
  };
  const re = /<span class="([^"]*)">|<\/span>|([^<]+)|</g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) {
      const scope = m[1]
        .split(/\s+/)
        .map((c) => (c.startsWith('hljs-') ? c.slice(5) : null))
        .find(Boolean);
      stack.push(SCOPE_KINDS[scope] ?? stack[stack.length - 1]);
    } else if (m[0] === '</span>') {
      if (stack.length > 1) stack.pop();
    } else {
      emit(unescapeHtml(m[0]), stack[stack.length - 1]);
    }
  }
  return tokens;
}
