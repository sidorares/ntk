// Mermaid diagram tests: parsing via the mermaid package (headless) and
// native layout. Layout/draw tests need fontconfig for text measurement.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

import FontManager from '../lib/text/fontmanager.js';
import { layoutMermaid, parseMermaid } from '../lib/widgets/mermaid.js';
import MarkdownView from '../lib/widgets/markdownview.js';

let hasFontconfig = true;
try {
  execFileSync('fc-match', ['--version'], { stdio: 'ignore' });
} catch {
  hasFontconfig = false;
}
const needsFonts = { skip: !hasFontconfig && 'fc-match not installed' };
const fonts = hasFontconfig ? new FontManager() : null;

// ---------------------------------------------------------------------------
// parsing (mermaid's own grammar, normalized)

test('flowchart: shapes, edge styles and labels normalize from the mermaid db', async () => {
  const m = await parseMermaid(`flowchart LR
    A[Start] --> B{Ready?}
    B -->|yes| C([Go])
    B -->|no| D[(Store)]
    C -.-> E((End))
    D == retry ==> B
    F[[Sub]] --- G{{Hex}}
  `);
  assert.equal(m.type, 'flowchart');
  assert.equal(m.rankdir, 'LR');
  const shape = (id) => m.nodes.find((n) => n.id === id)?.shape;
  assert.equal(shape('A'), 'rect');
  assert.equal(shape('B'), 'diamond');
  assert.equal(shape('C'), 'stadium');
  assert.equal(shape('D'), 'cylinder');
  assert.equal(shape('E'), 'circle');
  assert.equal(shape('F'), 'subroutine');
  assert.equal(shape('G'), 'hexagon');

  const edge = (from, to) => m.edges.find((e) => e.from === from && e.to === to);
  assert.equal(edge('B', 'C').label, 'yes');
  assert.equal(edge('C', 'E').style, 'dotted');
  assert.equal(edge('D', 'B').style, 'thick');
  assert.equal(edge('D', 'B').label, 'retry');
  assert.equal(edge('F', 'G').arrow, false);
});

test('flowchart: graph TD header and chains', async () => {
  const m = await parseMermaid('graph TD\n  A --> B --> C\n  A & B --> D');
  assert.equal(m.rankdir, 'TB');
  const pairs = m.edges.map((e) => `${e.from}${e.to}`).sort();
  assert.deepEqual(pairs, ['AB', 'AD', 'BC', 'BD']);
});

test('sequence: actors, arrows, notes, frames and autonumber normalize', async () => {
  const m = await parseMermaid(`sequenceDiagram
    autonumber
    participant A as Alice
    actor B as Bob
    A->>B: Hello
    B-->>A: Hi
    A-xB: gone
    A->B: open
    loop retry
      A-)B: async
    end
    alt good
      A->>B: yes
    else bad
      B->>A: no
    end
    Note over A,B: done
    Note right of B: aside
    A->>A: think
  `);
  assert.equal(m.type, 'sequence');
  assert.deepEqual(
    m.participants.map((p) => [p.id, p.label, p.actor]),
    [['A', 'Alice', false], ['B', 'Bob', true]]
  );
  const msgs = m.items.filter((i) => i.kind === 'message');
  assert.equal(msgs[0].text, '1. Hello');
  assert.equal(msgs[0].head, 'arrow');
  assert.equal(msgs[1].dotted, true);
  assert.equal(msgs[2].head, 'cross');
  assert.equal(msgs[3].head, 'none');
  assert.equal(msgs[4].head, 'open');
  const frames = m.items.filter((i) => i.kind === 'frame').map((f) => f.frame);
  assert.deepEqual(frames, ['loop', 'alt']);
  assert.equal(m.items.filter((i) => i.kind === 'divider')[0].text, 'bad');
  assert.equal(m.items.filter((i) => i.kind === 'frameEnd').length, 2);
  const notes = m.items.filter((i) => i.kind === 'note');
  assert.deepEqual(notes[0].ids, ['A', 'B']);
  assert.equal(notes[0].pos, 'over');
  assert.equal(notes[1].pos, 'right of');
  const self = msgs[msgs.length - 1];
  assert.equal(self.from, self.to);
});

test('unsupported diagram types reject', async () => {
  await assert.rejects(() => parseMermaid('pie\n "a": 1\n "b": 2'), /no native renderer/);
  await assert.rejects(() => parseMermaid('not a diagram at all'));
});

// ---------------------------------------------------------------------------
// layout

test('flowchart layout: positive size, maxWidth shrinks to fit', needsFonts, async () => {
  const model = await parseMermaid(
    'flowchart LR\n A[one] --> B[two] --> C[three] --> D[four] --> E[five] --> F[six]'
  );
  const box = layoutMermaid(model, { fonts, size: 14 });
  assert.ok(box.width > 300 && box.height > 20);
  assert.equal(box.type, 'flowchart');

  const fitted = layoutMermaid(model, { fonts, size: 14, maxWidth: 420 });
  assert.ok(fitted.width < box.width, 'shrunk from the unconstrained layout');
  assert.ok(fitted.width <= 430, `fitted ${fitted.width} into ~420`);
  // impossible targets bottom out at the 8px font floor instead of looping
  const floor = layoutMermaid(model, { fonts, size: 14, maxWidth: 50 });
  assert.ok(floor.width > 50, 'floor respected');
});

test('sequence layout: gaps widen for long labels', needsFonts, async () => {
  const short = layoutMermaid(await parseMermaid('sequenceDiagram\n A->>B: hi'), { fonts });
  const long = layoutMermaid(
    await parseMermaid('sequenceDiagram\n A->>B: a rather long message label that needs space'),
    { fonts }
  );
  assert.ok(long.width > short.width);
});

test('layoutMermaid validates its input', needsFonts, () => {
  assert.throws(() => layoutMermaid('flowchart LR\n A --> B', { fonts }), /parseMermaid/);
  assert.throws(() => layoutMermaid({ type: 'flowchart', nodes: [], edges: [] }, {}), /fonts/);
});

// ---------------------------------------------------------------------------
// markdown integration

test('markdown: mermaid fence becomes a diagram box after async parse', needsFonts, async () => {
  const view = new MarkdownView(null, { fonts });
  view.setMarkdown('```mermaid\nflowchart LR\n A[Hello] --> B[World]\n```');
  view.layout(500); // kicks off the async parse; fence is a code block for now
  await new Promise((r) => setTimeout(r, 2000));
  view.layout(500);
  const diagram = view._items.find((i) => i.kind === 'tex' && i.box.type === 'flowchart');
  assert.ok(diagram, 'diagram item present after parse resolves');
  assert.ok(diagram.box.width > 100);
});

test('markdown: standalone view fires onInvalidate when the model arrives', needsFonts, async () => {
  let invalidated;
  const done = new Promise((r) => (invalidated = r));
  const view = new MarkdownView(null, { fonts, onInvalidate: invalidated });
  view.setMarkdown('```mermaid\nflowchart LR\n A[Hello] --> B[World]\n```');
  view.layout(500); // fence is a code block; parse resolves in the background
  await done;
  view.layout(500);
  assert.ok(
    view._items.some((i) => i.kind === 'tex' && i.box.type === 'flowchart'),
    'diagram item present after onInvalidate'
  );
});

test('markdown: unsupported mermaid stays a code block', needsFonts, async () => {
  const view = new MarkdownView(null, { fonts });
  view.setMarkdown('```mermaid\ngantt\n title x\n```');
  view.layout(500);
  await new Promise((r) => setTimeout(r, 2000));
  view.layout(500);
  assert.ok(!view._items.some((i) => i.kind === 'tex'), 'no diagram box');
  assert.ok(view._items.some((i) => i.kind === 'rect'), 'code block background present');
});
