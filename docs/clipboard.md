# Clipboard

`app.clipboard` transfers plain text between X clients through selections —
lazily created on first use, like `app.fonts`.

X has no clipboard buffer: "copy" means owning a **selection** (the
`CLIPBOARD` atom for explicit copy/paste, `PRIMARY` for middle-click paste)
and answering conversion requests from whichever client pastes; "paste"
means asking the current owner to convert its data into a property and
reading it back. `app.clipboard` hides that ICCCM dance behind two
promises, using a hidden 1×1 never-mapped helper window as the selection
endpoint.

```js
import { createClient } from 'ntk';
const app = await createClient();

await app.clipboard.write('Hello, κόσμε!');
const text = await app.clipboard.read(); // from whoever owns CLIPBOARD now
```

## `app.clipboard.write(text, [options]) → Promise`

Takes ownership of a selection and serves `text` to anyone who pastes.

- `options.selection` — selection atom name, default `'CLIPBOARD'`; use
  `'PRIMARY'` for the middle-click paste buffer.
- Resolves once the server confirms the ownership; rejects if it could not
  be acquired.
- Ownership (and the text) is held until another client copies — the
  server's `SelectionClear` then drops the stored text — or the app closes.
  The text lives in this process: unlike desktops with a clipboard manager,
  closing the app makes the selection unavailable, which is normal X
  behavior.

Requestors are offered the targets `TARGETS`, `UTF8_STRING` and `STRING`
(latin-1, best effort — codepoints above U+00FF are lossy). Anything else
(`MULTIPLE`, `TIMESTAMP`, images, …) is refused with a `SelectionNotify`
carrying property `None`, as ICCCM prescribes.

## `app.clipboard.read([options]) → Promise<string>`

Reads the current text of a selection from whoever owns it.

- `options.selection` — as above, default `'CLIPBOARD'`.
- `options.timeout` — ms to wait for the owner at each protocol step,
  default 2000.
- Conversion is requested as `UTF8_STRING` first; if the owner refuses
  (old Xt/Motif apps), it is retried once as latin-1 `STRING`.
- Incremental (`INCR`) transfers are followed transparently, so pasting
  data larger than the server's single-transfer limit works.
- Rejects with a descriptive error when the selection has no owner, when
  the owner supports neither text target, or when the owner stops
  responding within `timeout`.

Concurrent `read()` calls on one app are serialized internally (they share
one transfer property on the helper window).

## Limitations

- Text only — no image or rich-content targets (yet).
- `INCR` is not implemented on the **write** side: when another client
  pastes, the whole payload goes to the server in a single `ChangeProperty`
  request. Texts approaching the server's maximum request length (~256 KB
  without BIG-REQUESTS, which node-x11 does not negotiate) may fail to
  paste into other applications.
- `SetSelectionOwner` is issued with `CurrentTime` — ntk has no "last user
  input" timestamp to arbitrate ownership races with.

## Testing without a display

The whole protocol runs against node-x11's in-process JS X server (which
routes `SetSelectionOwner` / `ConvertSelection` / `SendEvent` since x11
3.1.0) — see [xserver.md](xserver.md) and `test/clipboard.test.js`, where
two ntk clients and raw node-x11 clients (a `STRING`-only legacy owner, an
`INCR` owner) pass text to each other hermetically.
