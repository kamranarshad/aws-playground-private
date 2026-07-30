# Datadog-style log viewer (Logs tab)

The Logs tab renders `result.logs` — the raw stdout+stderr string the
invoker concatenates (`server/invoker.js:102-103`) — into a single
`<pre>` (`web/src/components/result-panel.tsx:86`). A traceback is a
dozen unstructured rows, and nothing distinguishes an error from an
info line. Replace the `<pre>` with a row-per-line viewer carrying a
time column, a level column, and level colouring, in the visual idiom
of the Datadog log list.

Client-side only. No server or harness changes: times and levels are
parsed out of whatever the handler itself printed, so a bare
`console.log("hi")` renders as a neutral row with a blank time and no
level. Producing a time and level for *every* line would mean
stamping lines in the invoker or patching `console`/`logging` in all
four harnesses — deliberately out of scope.

## Parser (`web/src/lib/log-lines.ts`)

Pure, no React, unit-tested. `parseLogs(raw: string): LogRow[]`.

```ts
type Level = 'error' | 'warn' | 'info' | 'debug' | 'trace'
type LogRow =
  | { kind: 'divider'; label: string }
  | { kind: 'line'; time: string | null; level: Level | null; message: string }
```

Split on `\n`; drop a single trailing empty line (child output ends
with one). Then per line, in order:

1. **Section markers.** `=== build ===` / `=== invoke ===`, which
   `server/api.js:151` prepends when a build ran, become
   `{ kind: 'divider' }` rows rather than log lines.
2. **Leading timestamp**, stripped from the message and kept:
   - ISO 8601 — `2026-07-30T10:23:45.123Z`, optional fractional
     seconds, `Z` or `±HH:MM` offset
   - python `logging` default — `2026-07-30 10:23:45,123`
   - bracketed clock — `[10:23:45]`, `[10:23:45.123]`,
     `[2026-07-30 10:23:45]`

   Normalised for display to `HH:mm:ss.SSS`, zero-filling absent
   milliseconds. A date-only or unrecognised prefix is left in the
   message. No match → `time: null`, blank cell.
3. **Leading level marker**, stripped and kept. `ERROR`, `WARN`,
   `WARNING`, `INFO`, `DEBUG`, `TRACE`, `FATAL`, `CRITICAL`
   (case-insensitive), in any of three shapes: bare (`ERROR foo`),
   bracketed (`[ERROR] foo`), or python-style (`ERROR:root:foo`,
   `ERROR:foo`). `fatal`/`critical` map to `error`. Anchored to the
   start of the remaining text, so `no error found` keeps its whole
   message and gets no level.
4. **Continuation lines fold into the row above.** A line is a
   continuation when it starts with whitespace (`  File "..."`,
   `    at Foo.bar`) or matches `Traceback (most recent call last):`,
   and a previous `line` row exists. Its text is appended to that
   row's message with a `\n`, inheriting the parent's level. This is
   the actual tidy-up: a stack trace becomes one entry instead of a
   dozen level-less rows.

A continuation with no preceding line row (logs opening mid-trace)
stays a row of its own rather than being dropped.

## Viewer (`web/src/components/log-viewer.tsx`)

`<LogViewer raw={string | undefined} />`. Empty or whitespace-only
input renders the existing `No logs.` copy in the same muted style the
other tabs use for their empty states.

Each row is its own flex container with fixed-width leading cells,
rather than one grid spanning the list. A cross-row grid would need
`display: contents` on the row wrappers, which drops the per-row
hover, border, and tint. Fixed widths align just as well here: the
time is always the 12 characters of `HH:mm:ss.SSS` in a monospace,
tabular-nums face, and the level is a short closed set. Four cells
per `line` row:

- **Bar.** `w-0.5` self-stretching level colour down the left edge;
  Datadog's signature tell. Transparent when there is no level.
- **Time.** `HH:mm:ss.SSS` in a fixed `w-[12ch]`, `font-mono
  tabular-nums text-[11px] text-muted-foreground`. Blank when `time`
  is null; the cell keeps its width so the message column stays put.
- **Level.** Fixed `w-12`, uppercase, `text-[10px] font-semibold`,
  colour-coded. Blank when `level` is null.
- **Message.** `font-mono text-xs whitespace-pre-wrap break-all`, so
  a folded trace keeps its indentation and a long line wraps under
  the message column instead of widening the grid.

Colours follow the `json-tree.tsx` convention of a light/dark pair:
error `text-red-600 dark:text-red-400`, warn `text-amber-600
dark:text-amber-400`, info `text-sky-700 dark:text-sky-300`,
debug/trace `text-muted-foreground`.

Rows get a hairline bottom border at `border-border/40`, a
`hover:bg-muted/40` highlight, and — for error rows only — a faint
`bg-red-500/5` tint. A `divider` row is full-width: a centred
uppercase label with a rule through it, reusing `bg-surface-strip`
for continuity with the tab bar.

The whole list sits in the existing `ScrollArea`.

## Wiring

`result-panel.tsx` drops the `logs` `<Pane>` for `<LogViewer
raw={result?.logs} />`. `Pane` stays — the Response error state and
the Report tab still use it.

## Out of scope

Level filter chips, a search box, a copy button, expanding structured
JSON log lines into `JsonTree`, log streaming, virtualisation, and
any server- or harness-side timestamping.

## Testing

- `web/src/lib/log-lines.test.ts` — the parser: each timestamp shape
  and its normalisation; each level marker shape incl. python
  `ERROR:root:`; the `no error found` non-match; continuation folding
  into the parent message and level; a leading continuation with no
  parent; `=== build ===` dividers; trailing-newline handling; empty
  input.
- `web/src/components/log-viewer.test.tsx` — an error line renders
  its level and message; a folded trace renders as one row; empty
  input renders `No logs.`.
- `web/src/components/result-panel.test.tsx` — the Logs tab shows
  parsed rows rather than the raw blob.
- Browser: invoke a fixture that logs at several levels and throws,
  confirm the trace is one row and the columns line up in both
  themes; console clean.
