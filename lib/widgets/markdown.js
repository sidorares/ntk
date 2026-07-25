// Minimal CommonMark-ish markdown parser — pure JS, no dependencies.
//
// Supported blocks: ATX headings (# .. ######), paragraphs, fenced code
// blocks (```), blockquotes (>), unordered (-/*/+) and ordered (1.) lists
// with nesting by indentation, and thematic breaks (---).
// Supported inlines: **strong**, *em*/_em_, `code`, [links](url) and
// backslash escapes.
//
// The output is a small AST consumed by MarkdownView:
//   block: { type: 'heading', level, children }
//        | { type: 'paragraph', children }
//        | { type: 'code', text, lang }
//        | { type: 'blockquote', blocks }
//        | { type: 'list', ordered, start, items: [ blocks ] }
//        | { type: 'hr' }
//   inline: { type: 'text', text }
//         | { type: 'strong'|'em', children }
//         | { type: 'code', text }
//         | { type: 'link', children, href }

export function parseMarkdown(src) {
  return parseBlocks(String(src ?? '').replace(/\r\n?/g, '\n').split('\n'));
}

const FENCE = /^(\s*)(`{3,}|~{3,})\s*(\S*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const UL_ITEM = /^(\s*)([-*+])\s+(.*)$/;
const OL_ITEM = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;

function parseBlocks(lines) {
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }

    let m = FENCE.exec(line);
    if (m) {
      const fence = m[2][0];
      const lang = m[3];
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${fence}{3,}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence (or EOF)
      blocks.push({ type: 'code', text: body.join('\n'), lang });
      continue;
    }

    m = HEADING.exec(line);
    if (m) {
      blocks.push({ type: 'heading', level: m[1].length, children: parseInline(m[2]) });
      i++;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    m = QUOTE.exec(line);
    if (m) {
      const inner = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i]);
        if (q) inner.push(q[1]);
        else if (lines[i].trim() !== '' && inner.length) inner.push(lines[i]); // lazy continuation
        else break;
        i++;
      }
      blocks.push({ type: 'blockquote', blocks: parseBlocks(inner) });
      continue;
    }

    m = UL_ITEM.exec(line) || OL_ITEM.exec(line);
    if (m) {
      const ordered = /\d/.test(m[2]);
      const start = ordered ? parseInt(m[2], 10) : 1;
      const baseIndent = m[1].length;
      const items = [];
      let itemLines = null;
      const flush = () => {
        if (itemLines) items.push(parseBlocks(itemLines));
        itemLines = null;
      };
      while (i < lines.length) {
        const l = lines[i];
        const im = UL_ITEM.exec(l) || OL_ITEM.exec(l);
        if (im && im[1].length === baseIndent && /\d/.test(im[2]) === ordered) {
          flush();
          itemLines = [im[3]];
          i++;
        } else if (im && im[1].length > baseIndent) {
          // nested list line: keep, dedent by the parent marker width
          itemLines.push(l.slice(baseIndent + 2));
          i++;
        } else if (l.trim() === '') {
          // blank line ends the list unless the next line continues it
          const next = lines[i + 1];
          if (next !== undefined && (UL_ITEM.test(next) || OL_ITEM.test(next) || /^\s{2,}\S/.test(next))) {
            itemLines.push('');
            i++;
          } else {
            break;
          }
        } else if (/^\s{2,}\S/.test(l) && itemLines) {
          itemLines.push(l.slice(baseIndent + 2));
          i++;
        } else {
          break;
        }
      }
      flush();
      blocks.push({ type: 'list', ordered, start, items });
      continue;
    }

    // paragraph: consecutive plain lines soft-wrapped into one
    const para = [];
    while (i < lines.length) {
      const l = lines[i];
      if (
        l.trim() === '' ||
        FENCE.test(l) ||
        HEADING.test(l) ||
        HR.test(l) ||
        QUOTE.test(l) ||
        UL_ITEM.test(l) ||
        OL_ITEM.test(l)
      ) {
        break;
      }
      para.push(l.trim());
      i++;
    }
    blocks.push({ type: 'paragraph', children: parseInline(para.join(' ')) });
  }

  return blocks;
}

export function parseInline(text) {
  const nodes = [];
  let plain = '';
  const flush = () => {
    if (plain) nodes.push({ type: 'text', text: plain });
    plain = '';
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === '\\' && i + 1 < text.length) {
      plain += text[i + 1];
      i += 2;
      continue;
    }

    if (ch === '`') {
      let fence = 1;
      while (text[i + fence] === '`') fence++;
      const close = text.indexOf('`'.repeat(fence), i + fence);
      if (close !== -1) {
        flush();
        nodes.push({ type: 'code', text: text.slice(i + fence, close).trim() });
        i = close + fence;
        continue;
      }
    }

    if (text.startsWith('**', i) || text.startsWith('__', i)) {
      const marker = text.slice(i, i + 2);
      const close = text.indexOf(marker, i + 2);
      if (close !== -1 && close > i + 2) {
        flush();
        nodes.push({ type: 'strong', children: parseInline(text.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }

    if ((ch === '*' || ch === '_') && text[i + 1] !== ch) {
      const close = text.indexOf(ch, i + 1);
      if (close !== -1 && close > i + 1) {
        flush();
        nodes.push({ type: 'em', children: parseInline(text.slice(i + 1, close)) });
        i = close + 1;
        continue;
      }
    }

    if (ch === '[') {
      const closeBracket = text.indexOf(']', i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          flush();
          nodes.push({
            type: 'link',
            children: parseInline(text.slice(i + 1, closeBracket)),
            href: text.slice(closeBracket + 2, closeParen)
          });
          i = closeParen + 1;
          continue;
        }
      }
    }

    plain += ch;
    i++;
  }
  flush();
  return nodes;
}
