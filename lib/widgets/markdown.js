// Markdown parsing for MarkdownView — a thin adapter over the `marked`
// lexer (CommonMark + GFM), mapping its token stream onto the small block /
// inline AST the widget renders. The parser used to be hand-rolled here;
// it was replaced after subtle divergences from CommonMark surfaced
// (e.g. intra-word `WM_DELETE_WINDOW` sprouting emphasis).
//
//   block: { type: 'heading', level, children }
//        | { type: 'paragraph', children }
//        | { type: 'code', text, lang }
//        | { type: 'blockquote', blocks }
//        | { type: 'list', ordered, start, items: [ blocks ] }
//        | { type: 'hr' }
//        | { type: 'table', align: ['left'|'center'|'right'],
//            header: [ inline[] ], rows: [ [ inline[] ] ] }
//   inline: { type: 'text', text }
//         | { type: 'strong'|'em', children }
//         | { type: 'code', text }
//         | { type: 'link', children, href }

import { Lexer } from 'marked';

export function parseMarkdown(src) {
  return mapBlocks(new Lexer({ gfm: true }).lex(String(src ?? '')));
}

/** inline-only parsing (exported for tests / embedders) */
export function parseInline(text) {
  return mapInline(Lexer.lexInline(String(text ?? '')));
}

function mapBlocks(tokens) {
  const blocks = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'heading':
        blocks.push({ type: 'heading', level: t.depth, children: mapInline(t.tokens) });
        break;
      case 'paragraph':
      // tight list items carry their inline content in a block-level 'text'
      case 'text':
        blocks.push({ type: 'paragraph', children: mapInline(t.tokens ?? [t]) });
        break;
      case 'code':
        blocks.push({
          type: 'code',
          text: t.text,
          lang: (t.lang || '').split(/\s+/)[0]
        });
        break;
      case 'blockquote':
        blocks.push({ type: 'blockquote', blocks: mapBlocks(t.tokens) });
        break;
      case 'list':
        blocks.push({
          type: 'list',
          ordered: !!t.ordered,
          start: typeof t.start === 'number' ? t.start : 1,
          items: t.items.map((item) => mapBlocks(item.tokens))
        });
        break;
      case 'hr':
        blocks.push({ type: 'hr' });
        break;
      case 'table':
        blocks.push({
          type: 'table',
          align: t.align.map((a) => a ?? 'left'),
          header: t.header.map((cell) => mapInline(cell.tokens)),
          rows: t.rows.map((row) => row.map((cell) => mapInline(cell.tokens)))
        });
        break;
      case 'html':
        blocks.push({ type: 'paragraph', children: [{ type: 'text', text: t.text.trim() }] });
        break;
      case 'space':
      case 'def':
        break;
      default:
        if (t.tokens) blocks.push({ type: 'paragraph', children: mapInline(t.tokens) });
        else if (t.text) blocks.push({ type: 'paragraph', children: [{ type: 'text', text: t.text }] });
        break;
    }
  }
  return blocks;
}

function mapInline(tokens) {
  const nodes = [];
  const pushText = (text) => {
    // soft line breaks inside a paragraph render as spaces (the layout
    // engine treats \n as a hard break)
    text = text.replace(/\n/g, ' ');
    const last = nodes[nodes.length - 1];
    if (last && last.type === 'text') last.text += text;
    else nodes.push({ type: 'text', text });
  };
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'text':
        if (t.tokens) nodes.push(...mapInline(t.tokens));
        else pushText(t.escaped ? unescapeHtml(t.text) : t.text);
        break;
      case 'escape':
        pushText(t.text);
        break;
      case 'strong':
        nodes.push({ type: 'strong', children: mapInline(t.tokens) });
        break;
      case 'em':
        nodes.push({ type: 'em', children: mapInline(t.tokens) });
        break;
      case 'del':
        // no strikethrough decoration (yet): render the content plainly
        nodes.push(...mapInline(t.tokens));
        break;
      case 'codespan':
        nodes.push({ type: 'code', text: t.text });
        break;
      case 'link':
        nodes.push({ type: 'link', children: mapInline(t.tokens), href: t.href });
        break;
      case 'image':
        // no image rendering: alt text as a link to the source
        nodes.push({
          type: 'link',
          children: [{ type: 'text', text: t.text || t.href }],
          href: t.href
        });
        break;
      case 'br':
        pushText(' ');
        break;
      case 'html':
        pushText(t.raw);
        break;
      default:
        if (t.text) pushText(t.text);
        break;
    }
  }
  return nodes;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

function unescapeHtml(text) {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m]);
}
