// Mermaid diagram rendering for the markdown widget (```mermaid fences).
//
// Parsing uses the mermaid package's own grammar (lazily imported, run
// headless — see loadMermaid()); mermaid's *renderer* is the only part
// that needs a browser, so the two most-used diagram types are drawn
// natively instead: **flowcharts** laid out by @dagrejs/dagre and
// **sequence diagrams** with a classic column/row layout. Text is measured
// with the ntk font pipeline and everything draws through the 2d context —
// no SVG round-trip, no browser. Diagram types without a native renderer
// here throw from parseMermaid(), and MarkdownView falls back to a plain
// code block (same contract as invalid math).
//
//   const model = await parseMermaid('flowchart LR\n A[Start] --> B{OK?}');
//   const box = layoutMermaid(model, { fonts });
//   box.draw(ctx, x, y);   // box.width / box.height
import dagre from '@dagrejs/dagre';

const DEFAULT_THEME = {
  nodeFill: '#ececff',
  nodeBorder: '#9370db',
  line: '#555555',
  text: '#333333',
  labelBg: '#ffffff', // behind edge labels; set to the page background
  actorFill: '#ececff',
  actorBorder: '#9370db',
  noteFill: '#fff5ad',
  noteBorder: '#b8b855',
  frameBorder: '#999999',
  frameLabel: '#666666'
};

// ---------------------------------------------------------------------------
// parsing: the mermaid package's own grammar, run headless
//
// mermaid's renderer needs a browser (getBBox and friends), but its parsers
// and diagram DBs work in Node once DOMPurify — which mermaid only uses to
// sanitize label HTML for browser injection — is shimmed to the identity.
// Labels here never reach a DOM: they are drawn as plain text.

let mermaidLoad = null;

function loadMermaid() {
  if (!mermaidLoad) {
    mermaidLoad = (async () => {
      const DOMPurify = (await import('dompurify')).default;
      if (typeof DOMPurify.sanitize !== 'function') {
        DOMPurify.sanitize = (s) => String(s);
        DOMPurify.addHook = () => {};
      }
      const mermaid = (await import('mermaid')).default;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });
      return mermaid;
    })();
  }
  return mermaidLoad;
}

function cleanLabel(text) {
  return String(text ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .trim();
}

const SHAPE_MAP = {
  square: 'rect',
  rect: 'rect',
  round: 'round',
  rounded: 'round',
  stadium: 'stadium',
  subroutine: 'subroutine',
  cylinder: 'cylinder',
  cyl: 'cylinder',
  circle: 'circle',
  doublecircle: 'circle',
  dbl_circ: 'circle',
  diamond: 'diamond',
  question: 'diamond',
  decision: 'diamond',
  hexagon: 'hexagon',
  hex: 'hexagon'
};

function normalizeFlowchart(db) {
  const nodes = [];
  for (const [id, v] of db.getVertices()) {
    const kind = v.type ?? v.shape;
    nodes.push({ id, shape: SHAPE_MAP[kind] ?? 'rect', label: cleanLabel(v.text ?? id) || id });
  }
  const edges = db.getEdges().map((e) => ({
    from: e.start,
    to: e.end,
    label: cleanLabel(e.text) || null,
    style: e.stroke === 'dotted' ? 'dotted' : e.stroke === 'thick' ? 'thick' : 'solid',
    arrow: e.type !== 'arrow_open'
  }));
  if (nodes.length === 0) throw new Error('flowchart: no nodes');
  const dir = db.getDirection?.() ?? 'TB';
  const rankdir = { TD: 'TB' }[dir] ?? (['TB', 'BT', 'LR', 'RL'].includes(dir) ? dir : 'TB');
  return { type: 'flowchart', rankdir, nodes, edges, warnings: [] };
}

// sequenceDb LINETYPE values (stable across mermaid 8-11)
const LT = {
  SOLID: 0, DOTTED: 1, NOTE: 2, SOLID_CROSS: 3, DOTTED_CROSS: 4,
  SOLID_OPEN: 5, DOTTED_OPEN: 6,
  LOOP_START: 10, LOOP_END: 11, ALT_START: 12, ALT_ELSE: 13, ALT_END: 14,
  OPT_START: 15, OPT_END: 16, ACTIVE_START: 17, ACTIVE_END: 18,
  PAR_START: 19, PAR_AND: 20, PAR_END: 21, RECT_START: 22, RECT_END: 23,
  SOLID_POINT: 24, DOTTED_POINT: 25, AUTONUMBER: 26,
  CRITICAL_START: 27, CRITICAL_OPTION: 28, CRITICAL_END: 29,
  BREAK_START: 30, BREAK_END: 31, PAR_OVER_START: 32
};

const SEQ_LINE = {
  [LT.SOLID]: { dotted: false, head: 'arrow' },
  [LT.DOTTED]: { dotted: true, head: 'arrow' },
  [LT.SOLID_CROSS]: { dotted: false, head: 'cross' },
  [LT.DOTTED_CROSS]: { dotted: true, head: 'cross' },
  [LT.SOLID_OPEN]: { dotted: false, head: 'none' },
  [LT.DOTTED_OPEN]: { dotted: true, head: 'none' },
  [LT.SOLID_POINT]: { dotted: false, head: 'open' },
  [LT.DOTTED_POINT]: { dotted: true, head: 'open' }
};

const FRAME_START = {
  [LT.LOOP_START]: 'loop', [LT.ALT_START]: 'alt', [LT.OPT_START]: 'opt',
  [LT.PAR_START]: 'par', [LT.PAR_OVER_START]: 'par',
  [LT.CRITICAL_START]: 'critical', [LT.BREAK_START]: 'break'
};
const FRAME_END = new Set([LT.LOOP_END, LT.ALT_END, LT.OPT_END, LT.PAR_END, LT.CRITICAL_END, LT.BREAK_END]);
const FRAME_DIVIDER = new Set([LT.ALT_ELSE, LT.PAR_AND, LT.CRITICAL_OPTION]);

function normalizeSequence(db) {
  const participants = [];
  for (const [id, a] of db.getActors()) {
    participants.push({ id, label: cleanLabel(a.description) || id, actor: a.type === 'actor' });
  }
  if (participants.length === 0) throw new Error('sequence: no participants');

  const items = [];
  const warnings = [];
  let numbering = db.showSequenceNumbers?.() ? 1 : 0;
  const actorId = (v) => (typeof v === 'object' && v !== null ? v.actor : v);

  for (const m of db.getMessages()) {
    const t = m.type;
    if (t === LT.AUTONUMBER) {
      numbering = m.message?.visible === false ? 0 : 1;
      continue;
    }
    if (t === LT.NOTE) {
      const pos = m.placement === 0 ? 'left of' : m.placement === 1 ? 'right of' : 'over';
      const ids = [actorId(m.from)];
      const to = actorId(m.to);
      if (to && to !== ids[0]) ids.push(to);
      items.push({ kind: 'note', pos, ids, text: cleanLabel(m.message) });
      continue;
    }
    if (t in FRAME_START) {
      items.push({ kind: 'frame', frame: FRAME_START[t], text: cleanLabel(m.message ?? '') });
      continue;
    }
    if (FRAME_END.has(t)) {
      items.push({ kind: 'frameEnd' });
      continue;
    }
    if (FRAME_DIVIDER.has(t)) {
      items.push({ kind: 'divider', text: cleanLabel(m.message ?? '') });
      continue;
    }
    const line = SEQ_LINE[t];
    if (line) {
      let text = cleanLabel(m.message);
      if (numbering) text = `${numbering++}. ${text}`;
      items.push({ kind: 'message', from: actorId(m.from), to: actorId(m.to), text, ...line });
      continue;
    }
    if (t !== LT.ACTIVE_START && t !== LT.ACTIVE_END && t !== LT.RECT_START && t !== LT.RECT_END) {
      warnings.push(`sequence: ignored message type ${t}`);
    }
  }
  return { type: 'sequence', participants, items, warnings };
}

/**
 * Parse mermaid source with the mermaid package's own parser (loaded
 * lazily, headless) and normalize the diagram DB into the model consumed
 * by layoutMermaid(). Throws for diagram types without a native renderer
 * here (anything but flowchart / sequence).
 */
export async function parseMermaid(text) {
  const mermaid = await loadMermaid();
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(String(text));
  const type = diagram.type;
  if (/^flowchart/.test(type) || type === 'graph') return normalizeFlowchart(diagram.db);
  if (/^sequence/.test(type)) return normalizeSequence(diagram.db);
  throw new Error(`mermaid: no native renderer for diagram type "${type}"`);
}

// ---------------------------------------------------------------------------
// text measurement helpers

function makeMeasurer(fonts, family, size) {
  const style = { family, size, weight: 'normal', style: 'normal' };
  style.font = fonts.match(family, style);
  const metrics = style.font.metrics(size);
  const lineH = Math.ceil((metrics.ascent + metrics.descent) * 1.25);
  return {
    style,
    lineH,
    ascent: metrics.ascent,
    width: (s) => (s ? fonts.shape(s, style).width : 0),
    linesOf: (s) => String(s ?? '').split('\n'),
    block(s) {
      const lines = this.linesOf(s);
      let w = 0;
      for (const l of lines) w = Math.max(w, this.width(l));
      return { lines, w, h: lines.length * lineH };
    }
  };
}

function drawTextBlock(ctx, meas, family, size, color, lines, cx, topY) {
  ctx.fillStyle = color;
  ctx.font = `${size}px ${family}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  let y = topY + meas.ascent;
  for (const line of lines) {
    const w = meas.width(line);
    ctx.fillText(line, cx - w / 2, y);
    y += meas.lineH;
  }
}

// manual dashes (the 2d context has no setLineDash)
function dashedLine(ctx, x0, y0, x1, y1, dash = 4, gap = 4) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (!len) return;
  const ux = dx / len;
  const uy = dy / len;
  let t = 0;
  ctx.beginPath();
  while (t < len) {
    const e = Math.min(t + dash, len);
    ctx.moveTo(x0 + ux * t, y0 + uy * t);
    ctx.lineTo(x0 + ux * e, y0 + uy * e);
    t = e + gap;
  }
  ctx.stroke();
}

function dashedPolyline(ctx, pts, dash = 4, gap = 4) {
  for (let i = 0; i + 1 < pts.length; i++) dashedLine(ctx, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, dash, gap);
}

function arrowHead(ctx, x, y, fromX, fromY, size, color) {
  const a = Math.atan2(y - fromY, x - fromX);
  const s = size;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - s * Math.cos(a - 0.45), y - s * Math.sin(a - 0.45));
  ctx.lineTo(x - s * Math.cos(a + 0.45), y - s * Math.sin(a + 0.45));
  ctx.closePath();
  ctx.fill();
}

// ---------------------------------------------------------------------------
// flowchart layout + drawing

function nodeSize(node, meas) {
  const { w, h } = meas.block(node.label);
  const padX = 14;
  const padY = 9;
  switch (node.shape) {
    case 'diamond':
      return { w: w * 1.5 + 28, h: h * 2 + 18 };
    case 'circle': {
      const d = Math.max(w, h) + 24;
      return { w: d, h: d };
    }
    case 'hexagon':
      return { w: w + padX * 2 + h + 12, h: h + padY * 2 };
    case 'cylinder':
      return { w: w + padX * 2, h: h + padY * 2 + 14 };
    case 'subroutine':
      return { w: w + padX * 2 + 12, h: h + padY * 2 };
    case 'stadium':
      return { w: w + padX * 2 + h, h: h + padY * 2 };
    default:
      return { w: w + padX * 2, h: h + padY * 2 };
  }
}

function nodePath(ctx, node, x, y, w, h) {
  // (x, y) is the node center
  ctx.beginPath();
  switch (node.shape) {
    case 'round':
      ctx.roundRect(x - w / 2, y - h / 2, w, h, 6);
      break;
    case 'stadium':
      ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
      break;
    case 'circle':
      ctx.arc(x, y, w / 2, 0, Math.PI * 2);
      break;
    case 'diamond':
      ctx.moveTo(x, y - h / 2);
      ctx.lineTo(x + w / 2, y);
      ctx.lineTo(x, y + h / 2);
      ctx.lineTo(x - w / 2, y);
      ctx.closePath();
      break;
    case 'hexagon': {
      const c = h / 2;
      ctx.moveTo(x - w / 2 + c, y - h / 2);
      ctx.lineTo(x + w / 2 - c, y - h / 2);
      ctx.lineTo(x + w / 2, y);
      ctx.lineTo(x + w / 2 - c, y + h / 2);
      ctx.lineTo(x - w / 2 + c, y + h / 2);
      ctx.lineTo(x - w / 2, y);
      ctx.closePath();
      break;
    }
    default:
      ctx.rect(x - w / 2, y - h / 2, w, h);
  }
}

function layoutFlowchart(model, meas, family, size, theme) {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  // separations follow the font size so shrink-to-fit scales ~linearly
  g.setGraph({
    rankdir: model.rankdir,
    nodesep: Math.round(size * 2.8),
    ranksep: Math.round(size * 3),
    marginx: 6,
    marginy: 6
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of model.nodes) {
    const { w, h } = nodeSize(node, meas);
    g.setNode(node.id, { width: w, height: h, node });
  }
  model.edges.forEach((edge, i) => {
    const attrs = { edge };
    if (edge.label) {
      const { w, h } = meas.block(edge.label);
      attrs.width = w + 8;
      attrs.height = h + 4;
      attrs.labelpos = 'c';
    }
    g.setEdge(edge.from, edge.to, attrs, `e${i}`);
  });

  dagre.layout(g);
  const gw = Math.ceil(g.graph().width ?? 0);
  const gh = Math.ceil(g.graph().height ?? 0);

  return {
    type: 'flowchart',
    width: gw,
    height: gh,
    warnings: model.warnings,
    draw(ctx, ox = 0, oy = 0) {
      // edges under nodes
      for (const e of g.edges()) {
        const info = g.edge(e);
        const edge = info.edge;
        const pts = info.points.map((p) => ({ x: p.x + ox, y: p.y + oy }));
        ctx.strokeStyle = theme.line;
        ctx.lineWidth = edge.style === 'thick' ? 2.6 : 1.4;
        if (edge.style === 'dotted') {
          dashedPolyline(ctx, pts, 3, 3.5);
        } else {
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          if (pts.length === 2) {
            ctx.lineTo(pts[1].x, pts[1].y);
          } else {
            for (let i = 1; i < pts.length - 1; i++) {
              const mx = (pts[i].x + pts[i + 1].x) / 2;
              const my = (pts[i].y + pts[i + 1].y) / 2;
              if (i === pts.length - 2) ctx.quadraticCurveTo(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
              else ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
            }
          }
          ctx.stroke();
        }
        if (edge.arrow) {
          const tip = pts[pts.length - 1];
          const before = pts[pts.length - 2] ?? pts[0];
          arrowHead(ctx, tip.x, tip.y, before.x, before.y, 7 + (edge.style === 'thick' ? 2 : 0), theme.line);
        }
        if (edge.label) {
          const { lines, w, h } = meas.block(edge.label);
          const lx = info.x + ox;
          const ly = info.y + oy;
          ctx.fillStyle = theme.labelBg;
          ctx.fillRect(Math.round(lx - w / 2 - 3), Math.round(ly - h / 2 - 1), Math.ceil(w + 6), Math.ceil(h + 2));
          drawTextBlock(ctx, meas, family, size, theme.text, lines, lx, ly - h / 2);
        }
      }
      // nodes
      for (const id of g.nodes()) {
        const info = g.node(id);
        const node = info.node;
        const x = info.x + ox;
        const y = info.y + oy;
        ctx.fillStyle = theme.nodeFill;
        ctx.strokeStyle = theme.nodeBorder;
        ctx.lineWidth = 1.3;
        if (node.shape === 'cylinder') {
          const capH = 10;
          const w = info.width;
          const h = info.height;
          const top = y - h / 2;
          ctx.beginPath();
          ctx.rect(x - w / 2, top + capH / 2, w, h - capH);
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(x - w / 2, top + capH / 2);
          ctx.lineTo(x - w / 2, top + h - capH / 2);
          ctx.moveTo(x + w / 2, top + capH / 2);
          ctx.lineTo(x + w / 2, top + h - capH / 2);
          ctx.stroke();
          ctx.beginPath();
          ctx.ellipse(x, top + h - capH / 2, w / 2, capH / 2, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.beginPath();
          ctx.ellipse(x, top + capH / 2, w / 2, capH / 2, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else {
          nodePath(ctx, node, x, y, info.width, info.height);
          ctx.fill();
          nodePath(ctx, node, x, y, info.width, info.height);
          ctx.stroke();
          if (node.shape === 'subroutine') {
            ctx.beginPath();
            ctx.moveTo(x - info.width / 2 + 5, y - info.height / 2);
            ctx.lineTo(x - info.width / 2 + 5, y + info.height / 2);
            ctx.moveTo(x + info.width / 2 - 5, y - info.height / 2);
            ctx.lineTo(x + info.width / 2 - 5, y + info.height / 2);
            ctx.stroke();
          }
        }
        const { lines, h } = meas.block(node.label);
        drawTextBlock(ctx, meas, family, size, theme.text, lines, x, y - h / 2);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// sequence layout + drawing

function layoutSequence(model, meas, family, size, theme) {
  const P = model.participants;
  const idx = new Map(P.map((p, i) => [p.id, i]));
  const actorPadX = 12;
  const actorH = meas.lineH + 16;
  const boxW = P.map((p) => Math.max(60, meas.width(p.label) + actorPadX * 2));

  // gaps between adjacent lifelines, widened until every message/note fits
  const gaps = new Array(Math.max(0, P.length - 1)).fill(110);
  const need = (a, b, w) => {
    if (a === b) return;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    let sum = 0;
    for (let i = lo; i < hi; i++) sum += gaps[i];
    if (sum < w) {
      const add = (w - sum) / (hi - lo);
      for (let i = lo; i < hi; i++) gaps[i] += add;
    }
  };
  for (const item of model.items) {
    if (item.kind === 'message' && item.from !== item.to) {
      need(idx.get(item.from), idx.get(item.to), meas.width(item.text) + 36);
    } else if (item.kind === 'note' && item.pos === 'over' && item.ids.length > 1) {
      need(idx.get(item.ids[0]), idx.get(item.ids[item.ids.length - 1]), meas.block(item.text).w + 30);
    }
  }
  // lifeline x positions
  const cx = [];
  let x = Math.max(20, boxW[0] / 2 + 8);
  for (let i = 0; i < P.length; i++) {
    if (i > 0) x += Math.max(gaps[i - 1], boxW[i - 1] / 2 + boxW[i] / 2 + 20);
    cx.push(x);
  }

  // vertical layout pass: assign a y to every item
  const rows = [];
  const frames = [];
  const openFrames = [];
  let y = actorH + 14;
  const frameInset = () => openFrames.length * 8;
  for (const item of model.items) {
    if (item.kind === 'frame') {
      openFrames.push({ item, top: y, dividers: [] });
      y += meas.lineH + 12;
      continue;
    }
    if (item.kind === 'divider') {
      const f = openFrames[openFrames.length - 1];
      y += 8;
      if (f) f.dividers.push({ y, text: item.text });
      y += meas.lineH + 6;
      continue;
    }
    if (item.kind === 'frameEnd') {
      const f = openFrames.pop();
      if (f) {
        y += 8;
        frames.push({ ...f, bottom: y });
        y += 10;
      }
      continue;
    }
    if (item.kind === 'note') {
      const { w, h } = { w: meas.block(item.text).w, h: meas.block(item.text).h };
      rows.push({ item, y, noteW: w + 20, noteH: h + 10 });
      y += h + 24;
      continue;
    }
    // message
    const self = item.from === item.to;
    rows.push({ item, y });
    y += meas.lineH + (self ? 26 : 16);
  }
  while (openFrames.length) {
    const f = openFrames.pop();
    frames.push({ ...f, bottom: y });
    y += 10;
  }
  const bodyBottom = y + 6;
  const height = Math.ceil(bodyBottom + actorH);
  const width = Math.ceil(cx[cx.length - 1] + Math.max(24, boxW[P.length - 1] / 2 + 10));

  const drawActor = (ctx, i, ox, top) => {
    const w = boxW[i];
    const h = actorH;
    const x0 = ox + cx[i] - w / 2;
    ctx.fillStyle = theme.actorFill;
    ctx.strokeStyle = theme.actorBorder;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.roundRect(x0, top, w, h, 4);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(x0, top, w, h, 4);
    ctx.stroke();
    drawTextBlock(ctx, meas, family, size, theme.text, [P[i].label], ox + cx[i], top + (h - meas.lineH) / 2);
  };

  return {
    type: 'sequence',
    width,
    height,
    warnings: model.warnings,
    draw(ctx, ox = 0, oy = 0) {
      // lifelines
      ctx.strokeStyle = theme.frameBorder;
      ctx.lineWidth = 1;
      for (let i = 0; i < P.length; i++) {
        dashedLine(ctx, cx[i] + ox, oy + actorH, cx[i] + ox, oy + bodyBottom, 4, 4);
      }
      // frames (behind messages, above lifelines)
      for (const f of frames) {
        const x0 = ox + 8;
        const x1 = ox + width - 8;
        ctx.strokeStyle = theme.frameBorder;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(x0, oy + f.top, x1 - x0, f.bottom - f.top);
        ctx.stroke();
        const tag = f.item.frame;
        const tagW = meas.width(tag) + 14;
        ctx.fillStyle = theme.actorFill;
        ctx.fillRect(x0, oy + f.top, tagW, meas.lineH + 6);
        ctx.strokeRect(x0, oy + f.top, tagW, meas.lineH + 6);
        drawTextBlock(ctx, meas, family, size, theme.text, [tag], x0 + tagW / 2, oy + f.top + 3);
        if (f.item.text) {
          drawTextBlock(ctx, meas, family, size, theme.frameLabel, [`[${f.item.text}]`], x0 + tagW + meas.width(`[${f.item.text}]`) / 2 + 10, oy + f.top + 3);
        }
        for (const d of f.dividers) {
          dashedLine(ctx, x0, oy + d.y, x1, oy + d.y, 5, 4);
          if (d.text) {
            drawTextBlock(ctx, meas, family, size, theme.frameLabel, [`[${d.text}]`], x0 + 30 + meas.width(`[${d.text}]`) / 2, oy + d.y + 3);
          }
        }
      }
      // messages and notes
      for (const row of rows) {
        const item = row.item;
        if (item.kind === 'note') {
          const ids = item.ids.map((id) => idx.get(id));
          let nx;
          if (item.pos === 'over') {
            const lo = Math.min(...ids);
            const hi = Math.max(...ids);
            nx = (cx[lo] + cx[hi]) / 2;
          } else if (item.pos === 'right of') {
            nx = cx[ids[0]] + row.noteW / 2 + 12;
          } else {
            nx = cx[ids[0]] - row.noteW / 2 - 12;
          }
          const { lines } = meas.block(item.text);
          ctx.fillStyle = theme.noteFill;
          ctx.strokeStyle = theme.noteBorder;
          ctx.lineWidth = 1;
          ctx.fillRect(ox + nx - row.noteW / 2, oy + row.y, row.noteW, row.noteH);
          ctx.strokeRect(ox + nx - row.noteW / 2, oy + row.y, row.noteW, row.noteH);
          drawTextBlock(ctx, meas, family, size, theme.text, lines, ox + nx, oy + row.y + 5);
          continue;
        }
        // message
        const a = idx.get(item.from);
        const b = idx.get(item.to);
        const lineY = oy + row.y + meas.lineH + 4;
        ctx.strokeStyle = theme.line;
        ctx.lineWidth = 1.3;
        if (a === b) {
          // self message: out, down, back
          const x0 = ox + cx[a];
          const loopW = 28;
          const pts = [
            { x: x0, y: lineY },
            { x: x0 + loopW, y: lineY },
            { x: x0 + loopW, y: lineY + 14 },
            { x: x0, y: lineY + 14 }
          ];
          if (item.dotted) dashedPolyline(ctx, pts, 4, 3);
          else {
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
            ctx.stroke();
          }
          arrowHead(ctx, x0 + 2, lineY + 14, x0 + loopW, lineY + 14, 7, theme.line);
          drawTextBlock(ctx, meas, family, size, theme.text, meas.linesOf(item.text), x0 + loopW + 8 + meas.width(item.text) / 2, oy + row.y + 6);
          continue;
        }
        const x0 = ox + cx[a];
        const x1 = ox + cx[b];
        if (item.dotted) dashedLine(ctx, x0, lineY, x1, lineY, 5, 4);
        else {
          ctx.beginPath();
          ctx.moveTo(x0, lineY);
          ctx.lineTo(x1, lineY);
          ctx.stroke();
        }
        const dir = x1 > x0 ? 1 : -1;
        if (item.head === 'cross') {
          const cxx = x1 - dir * 6;
          ctx.beginPath();
          ctx.moveTo(cxx - 5, lineY - 5);
          ctx.lineTo(cxx + 5, lineY + 5);
          ctx.moveTo(cxx - 5, lineY + 5);
          ctx.lineTo(cxx + 5, lineY - 5);
          ctx.stroke();
        } else if (item.head !== 'none') {
          arrowHead(ctx, x1, lineY, x0, lineY, 8, theme.line);
        }
        if (item.text) {
          drawTextBlock(ctx, meas, family, size, theme.text, [item.text], (x0 + x1) / 2, oy + row.y);
        }
      }
      // actors, top and bottom
      for (let i = 0; i < P.length; i++) {
        drawActor(ctx, i, ox, oy);
        drawActor(ctx, i, ox, oy + bodyBottom);
      }
    }
  };
}

// ---------------------------------------------------------------------------

/**
 * Lay out a mermaid diagram without drawing it. Returns a box:
 * `{ width, height, type, warnings, draw(ctx, x, y) }`.
 *
 * Supported: `flowchart`/`graph` (TB/TD/BT/LR/RL, all common node shapes,
 * solid/dotted/thick edges with labels, chains and `&` fans) and
 * `sequenceDiagram` (participants/actors, all arrow kinds, notes,
 * loop/opt/alt/par frames with else/and dividers, autonumber).
 * Anything else throws — callers fall back to a code block.
 *
 * @param {object} model parsed diagram from `await parseMermaid(text)`
 * @param {object} options { fonts, size = 13, family = 'sans-serif', theme,
 *   maxWidth } — when maxWidth is given and the diagram comes out wider,
 *   it is laid out again at a proportionally smaller font size (floor 8px)
 */
export function layoutMermaid(model, { fonts, size = 13, family = 'sans-serif', theme = {}, maxWidth } = {}) {
  if (!fonts) throw new Error('layoutMermaid: fonts (FontManager) is required');
  if (!model || (model.type !== 'flowchart' && model.type !== 'sequence')) {
    throw new Error('layoutMermaid: expected a model from parseMermaid()');
  }
  const th = { ...DEFAULT_THEME, ...theme };
  const attempt = (px) => {
    const meas = makeMeasurer(fonts, family, px);
    return model.type === 'flowchart'
      ? layoutFlowchart(model, meas, family, px, th)
      : layoutSequence(model, meas, family, px, th);
  };
  let box = attempt(size);
  let px = size;
  for (let i = 0; maxWidth && box.width > maxWidth && px > 8 && i < 4; i++) {
    px = Math.max(8, Math.floor((px * maxWidth) / box.width));
    box = attempt(px);
  }
  return box;
}
