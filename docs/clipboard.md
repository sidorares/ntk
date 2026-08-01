# Clipboard

`app.clipboard` transfers data between X clients through selections —
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

## `app.clipboard.write(data, [options]) → Promise`

Takes ownership of a selection and serves `data` to anyone who pastes.

- `data` — a string, or an object (or `Map`) from **target name** to
  payload for multi-format ownership:

  ```js
  await app.clipboard.write({
    'text/plain;charset=utf-8': 'hello',
    'text/html': '<b>hello</b>',
    'image/png': pngBuffer
  });
  ```

  String payloads are encoded UTF-8 (latin-1 for the `STRING` target, which
  is defined as latin-1); `Buffer`s and typed arrays are served as-is, so
  the target name is the only thing that says what the bytes mean. A bare
  string is shorthand for offering `UTF8_STRING` and `STRING`.
- `options.selection` — selection atom name, default `'CLIPBOARD'`; use
  `'PRIMARY'` for the middle-click paste buffer.
- `options.time` — the server timestamp of the event that triggered the
  copy (the `time` field of the key or button event you handled). ICCCM 2.1
  requires ownership to be taken with such a timestamp, and it is what
  arbitrates a race with another client copying at the same moment. Without
  one, ntk asks the server for the current time rather than using
  `CurrentTime`, which ICCCM forbids.
- Resolves once the server confirms the ownership; rejects if it could not
  be acquired.
- Ownership (and the data) is held until another client copies — the
  server's `SelectionClear` then drops it — or the app closes. The data
  lives in this process: unlike desktops with a clipboard manager, closing
  the app makes the selection unavailable, which is normal X behavior.

Requestors are offered the three targets ICCCM 2.6.2 makes mandatory —
`TARGETS`, `TIMESTAMP` (the ownership timestamp, as an `INTEGER`) and
`MULTIPLE` (a batch of conversions listed in an `ATOM_PAIR` property; pairs
that cannot be converted come back with their property set to `None`) —
plus whatever the call offered, in the order it offered them. Because ntk
answers those three itself, they cannot be used as target names in `data`.
Any other target is refused with a `SelectionNotify` carrying property
`None`.

Payloads too large for a single X request are transferred incrementally
(`INCR`, ICCCM 2.7.2): the conversion is answered with an `INCR` property
holding the byte count, and the chunks follow as the requestor consumes
them. This is transparent to both sides — nothing in the API changes with
size. A requestor that abandons a transfer is dropped after 10 seconds of
silence.

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

## `app.clipboard.watch(selection, handler) → Promise<function>`

Call `handler` whenever a selection changes hands — the event an edit menu
needs to grey out Paste, and what a clipboard-manager-style tool is built on.

```js
const unwatch = await app.clipboard.watch('CLIPBOARD', (ev) => {
  pasteItem.disabled = ev.owner === 0;
});

unwatch(); // stop listening
```

The handler gets:

| field | |
| --- | --- |
| `selection` | the name you asked for, e.g. `'CLIPBOARD'` |
| `owner` | window now owning it, or `0` when it is unowned |
| `timestamp` | server time of the change |
| `selectionTimestamp` | time the current owner acquired it |
| `reason` | `'new-owner'`, `'destroyed'` or `'closed'` |

`'destroyed'` means the owning window went away, `'closed'` that the owning
client disconnected. Both usually leave `owner` at `0`, which is the case
worth acting on: there is nothing to paste.

The alternative is polling `read()`, which is a full conversion round trip
against whatever foreign client owns the selection — and a two second wait
when that client is wedged. This is a server-side subscription instead, so it
costs nothing until something changes.

Watchers share one server-side registration per selection: watching
`CLIPBOARD` twice is one extra callback and no extra protocol, and the
registration is dropped only when the last watcher for that selection
unsubscribes. `unwatch()` is idempotent. A handler that throws is reported
with `console.warn` and does not cost the other watchers their event.

Built on XFixes `SelectSelectionInput`. Every X server since about 2004 has
the extension; on one that does not, `watch()` rejects saying so, rather than
silently never firing.

## Limitations

- `read()` is text: it converts `UTF8_STRING`/`STRING` and returns a
  string. Reading an arbitrary target (the `image/png` an owner offers, say)
  is not exposed yet, even though writing one is.
- Nothing negotiates with a clipboard manager (`SAVE_TARGETS`), so the data
  really does vanish when the app exits.
- The `STRING` target is latin-1 by definition — codepoints above U+00FF
  are lossy there. Modern requestors ask for `UTF8_STRING`, which is not.

## Testing without a display

The whole protocol runs against node-x11's in-process JS X server (which
routes `SetSelectionOwner` / `ConvertSelection` / `SendEvent` since x11
3.1.0) — see [xserver.md](xserver.md) and `test/clipboard.test.js`, where
two ntk clients and raw node-x11 clients (a `STRING`-only legacy owner, an
`INCR` owner, requestors asking for `TARGETS`, `TIMESTAMP`, `MULTIPLE` and
`INCR` payloads) pass data to each other hermetically.
