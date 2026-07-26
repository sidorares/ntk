// Mermaid diagrams inside markdown: ```mermaid fences are parsed by the
// mermaid package's own grammar (headless) and rendered natively — dagre
// layout for flowcharts, classic column/row layout for sequence diagrams,
// all drawn server-side through the 2d context. Unsupported diagram types
// (here: the gantt at the bottom) fall back to a plain code block.
import { createClient, MarkdownView } from '../lib/index.js';

const doc = `# Mermaid

## Flowchart — shapes, edge styles, labels

\`\`\`mermaid
flowchart LR
  A[Request] --> B{Cached?}
  B -->|yes| C([Serve from cache])
  B -->|no| D[(Database)]
  D --> E[[Render]]
  E -.-> F((Done))
  C ==> F
\`\`\`

## Flowchart — top-down

\`\`\`mermaid
flowchart TD
  start([Start]) --> input[Read config]
  input --> valid{Valid?}
  valid -->|yes| run{{Run job}}
  valid -->|no| err[Report error]
  err --> input
  run --> done((OK))
\`\`\`

## Sequence diagram

\`\`\`mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant S as Server
  participant D as DB
  C->>S: GET /report
  S->>D: query
  D-->>S: rows
  alt cache hit
    S-->>C: 200 (cached)
  else miss
    S-->>C: 200 (fresh)
  end
  loop every 30s
    C->>S: poll status
    S-xC: timeout
  end
  Note over C,S: connection closed
  S->>S: cleanup
\`\`\`

## Unsupported types fall back to code

\`\`\`mermaid
gantt
  title A Gantt chart
  section One
  Task :a1, 2024-01-01, 30d
\`\`\`
`;

const app = await createClient();
const wnd = app.createWindow({ width: 700, height: 900, title: 'ntk mermaid' });
const view = new MarkdownView(wnd, {});
view.setMarkdown(doc);
wnd.map();
console.log('diagrams render once the mermaid grammar finishes loading; wheel scrolls');
