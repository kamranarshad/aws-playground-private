# Datadog-style Log Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Logs tab's raw `<pre>` dump with a row-per-line viewer carrying parsed time and level columns, in the visual idiom of the Datadog log list.

**Architecture:** A pure parser (`web/src/lib/log-lines.ts`) turns the raw stdout+stderr string into `LogRow[]`, stripping leading timestamps and level markers off each line and folding stack-trace continuation lines into the row above. A presentational component (`web/src/components/log-viewer.tsx`) renders those rows with a level-coloured left bar, fixed-width time and level cells, and a wrapping message. `ResultPanel` swaps its `<Pane>` for the new component.

**Tech Stack:** React 19, TypeScript, Tailwind v4, vitest + @testing-library/react, jsdom.

## Global Constraints

- Client-side only. No changes to `server/`, `harnesses/`, or `bin/`.
- Spec: `docs/superpowers/specs/2026-07-30-log-viewer-design.md`.
- Imports use the `@/` alias (`@/lib/...`, `@/components/...`), matching every other file in `web/src`.
- Level colours are light/dark pairs following `web/src/components/json-tree.tsx:99-102`: error `text-red-600 dark:text-red-400`, warn `text-amber-600 dark:text-amber-400`, info `text-sky-700 dark:text-sky-300`, debug/trace `text-muted-foreground`.
- Tests run from the repo root as `npm --prefix web run test`. A single file: `npm --prefix web run test -- <name-fragment>`.
- Typecheck: `npm --prefix web run typecheck`.
- Out of scope, do not build: level filter chips, search box, copy button, `JsonTree` expansion of structured log lines, log streaming, virtualisation.

---

### Task 1: Parser — timestamps and levels

**Files:**
- Create: `web/src/lib/log-lines.ts`
- Test: `web/src/lib/log-lines.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace'`
  - `type LogRow = { kind: 'divider'; label: string } | { kind: 'line'; time: string | null; level: LogLevel | null; message: string }`
  - `function parseLogs(raw: string): LogRow[]`

  Task 2 extends `parseLogs` in place. Task 3 imports `parseLogs` and `LogLevel`.

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/log-lines.test.ts`:

```ts
import { expect, it } from 'vitest'
import { parseLogs, type LogRow } from '@/lib/log-lines'

// Only `line` rows exist until Task 2 adds dividers; narrowing here keeps the
// assertions readable. The predicate is written out rather than left to
// inference so `rows[0].message` typechecks regardless of TS version.
function lines(raw: string) {
  return parseLogs(raw).filter(
    (r): r is Extract<LogRow, { kind: 'line' }> => r.kind === 'line',
  )
}

it('returns nothing for empty input', () => {
  expect(parseLogs('')).toEqual([])
})

// Child output ends with a newline; that trailing empty string is not a log line.
it('ignores the trailing newline the runtime emits', () => {
  expect(lines('one\ntwo\n')).toHaveLength(2)
})

it('keeps an unadorned line whole, with no time and no level', () => {
  expect(lines('hello from the handler')).toEqual([
    { kind: 'line', time: null, level: null, message: 'hello from the handler' },
  ])
})

it.each([
  ['2026-07-30T10:23:45.123Z boot', '10:23:45.123', 'boot'],
  ['2026-07-30T10:23:45Z boot', '10:23:45.000', 'boot'],
  ['2026-07-30T10:23:45.123+02:00 boot', '10:23:45.123', 'boot'],
  ['2026-07-30 10:23:45,123 boot', '10:23:45.123', 'boot'],
  ['[10:23:45] boot', '10:23:45.000', 'boot'],
  ['[10:23:45.123] boot', '10:23:45.123', 'boot'],
  ['[2026-07-30 10:23:45] boot', '10:23:45.000', 'boot'],
])('pulls the time out of %s', (raw, time, message) => {
  expect(lines(raw)[0]).toMatchObject({ time, message })
})

// Sub-millisecond precision is truncated, not rounded — the column is fixed width.
it('truncates microsecond precision to milliseconds', () => {
  expect(lines('2026-07-30T10:23:45.123456Z boot')[0]).toMatchObject({ time: '10:23:45.123' })
})

it('leaves a date with no time of day in the message', () => {
  expect(lines('2026-07-30 shipped')[0]).toMatchObject({
    time: null, message: '2026-07-30 shipped',
  })
})

it.each([
  ['ERROR connection refused', 'error', 'connection refused'],
  ['ERROR: connection refused', 'error', 'connection refused'],
  ['[ERROR] connection refused', 'error', 'connection refused'],
  ['ERROR:root:connection refused', 'error', 'connection refused'],
  ['WARNING slow query', 'warn', 'slow query'],
  ['WARN slow query', 'warn', 'slow query'],
  ['info listening', 'info', 'listening'],
  ['DEBUG payload parsed', 'debug', 'payload parsed'],
  ['TRACE entering handler', 'trace', 'entering handler'],
])('pulls the level out of %s', (raw, level, message) => {
  expect(lines(raw)[0]).toMatchObject({ level, message })
})

// FATAL and CRITICAL are error by another name; the viewer has no fifth colour.
it.each(['FATAL out of memory', 'CRITICAL out of memory'])('treats %s as an error', (raw) => {
  expect(lines(raw)[0]).toMatchObject({ level: 'error', message: 'out of memory' })
})

// Anchored to the start, so prose that merely mentions a level is left alone.
it.each([
  'no error found',
  'the info you asked for',
  'ERRORS happened',
])('does not take a level out of %s', (raw) => {
  expect(lines(raw)[0]).toMatchObject({ level: null, message: raw })
})

it('reads a time and a level off the same line', () => {
  expect(lines('2026-07-30 10:23:45,123 ERROR:root:boom')[0]).toEqual({
    kind: 'line', time: '10:23:45.123', level: 'error', message: 'boom',
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix web run test -- log-lines`
Expected: FAIL — `Failed to resolve import "@/lib/log-lines"`.

- [ ] **Step 3: Write the implementation**

Create `web/src/lib/log-lines.ts`:

```ts
// Nothing in the invoke pipeline stamps a log line: server/invoker.js just
// concatenates the child's stdout and stderr. So a time and a level are only
// available when the handler printed them itself, and everything here is a
// best-effort read of the front of each line.

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace'

export type LogRow =
  | { kind: 'divider'; label: string }
  | { kind: 'line'; time: string | null; level: LogLevel | null; message: string }

// Both shapes capture (hh, mm, ss, fraction) in that order so one reader
// handles either. The date is non-capturing and, for the bracketed form,
// optional — `[10:23:45]` is as common as `[2026-07-30 10:23:45]`.
// ISO covers python logging's `2026-07-30 10:23:45,123` too: space for the
// separator, comma for the decimal point.
const ISO_TIME =
  /^(?:\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?(?:Z|[+-]\d{2}:?\d{2})?(?=\s|$)/
const BRACKET_TIME =
  /^\[(?:\d{4}-\d{2}-\d{2}[T ])?(\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?(?:Z|[+-]\d{2}:?\d{2})?\]/

const LEVEL_NAMES = 'ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL|CRITICAL'
// Order matters: the python form has to be tried before the bare one, or
// `ERROR:root:boom` loses only `ERROR:` and keeps `root:boom` as its message.
const LEVEL_PATTERNS = [
  new RegExp(`^\\[(${LEVEL_NAMES})\\]\\s*`, 'i'),
  new RegExp(`^(${LEVEL_NAMES}):[\\w.]+:\\s*`, 'i'),
  // \b keeps `ERRORS happened` from reading as an error.
  new RegExp(`^(${LEVEL_NAMES})\\b[\\s:-]*`, 'i'),
]

// The column is fixed width, so pad a short fraction and drop anything past
// milliseconds rather than rounding.
function milliseconds(fraction: string | undefined): string {
  return (fraction ?? '').padEnd(3, '0').slice(0, 3)
}

function takeTime(text: string): { time: string | null; rest: string } {
  for (const pattern of [ISO_TIME, BRACKET_TIME]) {
    const m = pattern.exec(text)
    if (!m) continue
    const time = `${m[1]}:${m[2]}:${m[3]}.${milliseconds(m[4])}`
    return { time, rest: text.slice(m[0].length).trimStart() }
  }
  return { time: null, rest: text }
}

function toLevel(name: string): LogLevel {
  const n = name.toLowerCase()
  // The viewer has four colours, not six: the two names for "worse than an
  // error" fold into error, and WARNING into WARN.
  if (n === 'fatal' || n === 'critical') return 'error'
  if (n === 'warning') return 'warn'
  return n as LogLevel
}

function takeLevel(text: string): { level: LogLevel | null; message: string } {
  for (const pattern of LEVEL_PATTERNS) {
    const m = pattern.exec(text)
    if (!m) continue
    return { level: toLevel(m[1]), message: text.slice(m[0].length) }
  }
  return { level: null, message: text }
}

export function parseLogs(raw: string): LogRow[] {
  const lines = raw.split('\n')
  // Child output ends with a newline, which split turns into a phantom
  // trailing entry. One only: blank lines the handler meant are its own.
  if (lines.length && lines[lines.length - 1] === '') lines.pop()

  const rows: LogRow[] = []
  for (const line of lines) {
    const { time, rest } = takeTime(line)
    const { level, message } = takeLevel(rest)
    rows.push({ kind: 'line', time, level, message })
  }
  return rows
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix web run test -- log-lines`
Expected: PASS, all tests green.

- [ ] **Step 5: Typecheck**

Run: `npm --prefix web run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/log-lines.ts web/src/lib/log-lines.test.ts
git commit -m "feat(logs): parse a time and a level off each log line

Nothing in the invoke pipeline stamps a log line, so read the front of
each one for whatever the handler printed itself: ISO 8601, python
logging's comma-decimal form, or a bracketed clock, then a level marker
bare, bracketed, or python-style. Anchored to the start so prose that
mentions a level keeps its whole message.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Parser — dividers and continuation folding

**Files:**
- Modify: `web/src/lib/log-lines.ts` (extend `parseLogs`)
- Test: `web/src/lib/log-lines.test.ts` (append)

**Interfaces:**
- Consumes: `parseLogs`, `LogRow` from Task 1.
- Produces: no new exports. `parseLogs` now also emits `{ kind: 'divider'; label: 'build' | 'invoke' }` rows and folds continuation lines into the preceding `line` row's `message`.

- [ ] **Step 1: Write the failing test**

Append to `web/src/lib/log-lines.test.ts`:

```ts
// server/api.js:151 prepends these when a build ran.
it('turns the build and invoke markers into dividers', () => {
  const rows = parseLogs('=== build ===\ntsc ok\n=== invoke ===\nhello\n')

  expect(rows).toEqual([
    { kind: 'divider', label: 'build' },
    { kind: 'line', time: null, level: null, message: 'tsc ok' },
    { kind: 'divider', label: 'invoke' },
    { kind: 'line', time: null, level: null, message: 'hello' },
  ])
})

// The whole point of the tidy-up: a traceback is one entry, not a dozen
// level-less rows trailing after the line that explains them.
it('folds an indented traceback into the line above it', () => {
  const rows = lines(
    'ERROR boom\nTraceback (most recent call last):\n  File "h.py", line 3\n    raise ValueError\n',
  )

  expect(rows).toHaveLength(1)
  expect(rows[0]).toEqual({
    kind: 'line',
    time: null,
    level: 'error',
    message: 'boom\nTraceback (most recent call last):\n  File "h.py", line 3\n    raise ValueError',
  })
})

it('folds a java stack frame into the line above it', () => {
  const rows = lines('ERROR boom\n\tat Handler.run(Handler.java:12)\n')

  expect(rows).toHaveLength(1)
  expect(rows[0].message).toBe('boom\n\tat Handler.run(Handler.java:12)')
})

// Logs that open mid-trace have nothing to fold into; the line is still content.
it('keeps a continuation with no line above it as its own row', () => {
  expect(lines('  File "h.py", line 3\n')).toEqual([
    { kind: 'line', time: null, level: null, message: '  File "h.py", line 3' },
  ])
})

// A divider is not a fold target — a trace cannot continue across a phase.
it('does not fold a continuation into a divider', () => {
  const rows = parseLogs('=== invoke ===\n  indented first line\n')

  expect(rows).toHaveLength(2)
  expect(rows[1]).toMatchObject({ kind: 'line', message: '  indented first line' })
})

// A bare blank line would render as an empty bordered row, which reads as a
// glitch rather than as spacing.
it('drops blank lines between entries', () => {
  expect(lines('one\n\n\ntwo\n')).toHaveLength(2)
})

// ...but a blank line inside a trace is part of it, and is indented or folded
// by position, so it survives as part of the parent message.
it('keeps a whitespace-only line inside a folded trace', () => {
  const rows = lines('ERROR boom\n  File "h.py", line 3\n   \n')

  expect(rows).toHaveLength(1)
  expect(rows[0].message).toBe('boom\n  File "h.py", line 3\n   ')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix web run test -- log-lines`
Expected: FAIL — the divider test gets four `line` rows instead of dividers; the folding tests get 4 rows instead of 1.

- [ ] **Step 3: Write the implementation**

In `web/src/lib/log-lines.ts`, add these below `LEVEL_PATTERNS`:

```ts
// server/api.js:151 frames a two-phase run with these when a build ran.
const DIVIDER = /^=== (build|invoke) ===$/

// A continuation is output that belongs to the entry above it: an indented
// stack frame, or the header python prints before one.
const TRACEBACK_HEADER = /^Traceback \(most recent call last\):/
function isContinuation(line: string): boolean {
  return /^\s/.test(line) || TRACEBACK_HEADER.test(line)
}
```

Then replace the body of the `for` loop in `parseLogs` with:

```ts
  for (const line of lines) {
    // A blank line would render as an empty bordered row, which reads as a
    // glitch. Whitespace-only lines are not blank — they fold below.
    if (line === '') continue

    const divider = DIVIDER.exec(line)
    if (divider) {
      rows.push({ kind: 'divider', label: divider[1] })
      continue
    }

    const previous = rows[rows.length - 1]
    if (isContinuation(line) && previous?.kind === 'line') {
      previous.message += `\n${line}`
      continue
    }

    const { time, rest } = takeTime(line)
    const { level, message } = takeLevel(rest)
    rows.push({ kind: 'line', time, level, message })
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix web run test -- log-lines`
Expected: PASS, all tests green including Task 1's.

- [ ] **Step 5: Typecheck**

Run: `npm --prefix web run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/log-lines.ts web/src/lib/log-lines.test.ts
git commit -m "feat(logs): fold stack traces into the line that explains them

An indented frame or a python traceback header belongs to the entry
above it, so append it there and let it inherit that entry's level. A
traceback becomes one row instead of a dozen level-less ones, which is
most of what makes the tab unreadable today.

The build and invoke markers api.js frames a two-phase run with become
divider rows rather than log lines.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: The `LogViewer` component

**Files:**
- Create: `web/src/components/log-viewer.tsx`
- Test: `web/src/components/log-viewer.test.tsx`

**Interfaces:**
- Consumes: `parseLogs`, `LogLevel` from `@/lib/log-lines`; `ScrollArea` from `@/components/ui/scroll-area`; `cn` from `@/lib/utils`.
- Produces: `function LogViewer({ raw }: { raw: string | undefined }): JSX.Element`. Task 4 renders it.

- [ ] **Step 1: Write the failing test**

Create `web/src/components/log-viewer.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'

import { LogViewer } from '@/components/log-viewer'

it.each([undefined, '', '\n'])('says there are no logs for %p', (raw) => {
  render(<LogViewer raw={raw} />)

  expect(screen.getByText('No logs.')).toBeInTheDocument()
})

it('shows the time and level alongside the message', () => {
  // Braces, not a quoted attribute: JSX string attributes do not process \n.
  render(<LogViewer raw={'2026-07-30T10:23:45.123Z ERROR connection refused\n'} />)

  expect(screen.getByText('10:23:45.123')).toBeInTheDocument()
  expect(screen.getByText('ERROR')).toBeInTheDocument()
  expect(screen.getByText('connection refused')).toBeInTheDocument()
})

// The level is uppercased in the markup, not by CSS, so what a screen reader
// and a test see is what is on screen.
it('renders a plain line with no level text at all', () => {
  render(<LogViewer raw={'hello from the handler\n'} />)

  expect(screen.getByText('hello from the handler')).toBeInTheDocument()
  expect(screen.queryByText('INFO')).not.toBeInTheDocument()
})

it('renders a folded traceback as a single row', () => {
  const { container } = render(
    <LogViewer raw={'ERROR boom\n  File "h.py", line 3\n    raise ValueError\n'} />,
  )

  expect(container.querySelectorAll('[data-log-row]')).toHaveLength(1)
  expect(screen.getByText(/raise ValueError/)).toBeInTheDocument()
})

it('labels the build and invoke phases', () => {
  render(<LogViewer raw={'=== build ===\ntsc ok\n=== invoke ===\nhello\n'} />)

  expect(screen.getByText('build')).toBeInTheDocument()
  expect(screen.getByText('invoke')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix web run test -- log-viewer`
Expected: FAIL — `Failed to resolve import "@/components/log-viewer"`.

- [ ] **Step 3: Write the implementation**

Create `web/src/components/log-viewer.tsx`:

```tsx
import { useMemo } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { parseLogs, type LogLevel } from '@/lib/log-lines'
import { cn } from '@/lib/utils'

// Light/dark pairs, matching the leaf colours in json-tree.tsx.
const LEVEL_TEXT: Record<LogLevel, string> = {
  error: 'text-red-600 dark:text-red-400',
  warn: 'text-amber-600 dark:text-amber-400',
  info: 'text-sky-700 dark:text-sky-300',
  debug: 'text-muted-foreground',
  trace: 'text-muted-foreground',
}

// The left edge bar is the tell that reads before any text does, so it wants
// a flat saturated colour rather than the text pair.
const LEVEL_BAR: Record<LogLevel, string> = {
  error: 'bg-red-500',
  warn: 'bg-amber-500',
  info: 'bg-sky-500',
  debug: 'bg-muted-foreground/40',
  trace: 'bg-muted-foreground/40',
}

// Fixed cell widths rather than one grid spanning the list: a cross-row grid
// needs display:contents on the row wrappers, which drops the per-row hover,
// border, and error tint. The time is always the 12 characters of
// HH:mm:ss.SSS in a tabular face, so the columns line up regardless.
const TIME_CELL = 'w-[12ch] shrink-0 py-1 font-mono text-[11px] tabular-nums text-muted-foreground'
const LEVEL_CELL = 'w-12 shrink-0 py-1 text-[10px] font-semibold'

export function LogViewer({ raw }: { raw: string | undefined }) {
  const rows = useMemo(() => parseLogs(raw ?? ''), [raw])

  if (!rows.length) {
    return <p className="p-3 font-mono text-xs text-muted-foreground">No logs.</p>
  }

  return (
    <ScrollArea className="h-full">
      {rows.map((row, i) => (
        row.kind === 'divider'
          ? (
            <div key={i} className="flex items-center gap-2 bg-surface-strip px-3 py-1">
              <span className="h-px flex-1 bg-border" aria-hidden="true" />
              <span className="font-mono text-[10px] tracking-wider text-muted-foreground">
                {row.label}
              </span>
              <span className="h-px flex-1 bg-border" aria-hidden="true" />
            </div>
          )
          : (
            <div
              key={i} data-log-row
              className={cn(
                'flex items-start gap-2 border-b border-border/40 pr-3 hover:bg-muted/40',
                row.level === 'error' && 'bg-red-500/5',
              )}
            >
              {/* self-stretch so the bar runs the full height of a folded trace. */}
              <span
                aria-hidden="true"
                className={cn('w-0.5 shrink-0 self-stretch',
                  row.level ? LEVEL_BAR[row.level] : 'bg-transparent')}
              />
              {/* Both cells keep their width when empty, so the message column
                  stays put down a list of mixed lines. */}
              <span className={TIME_CELL}>{row.time}</span>
              <span className={cn(LEVEL_CELL, row.level && LEVEL_TEXT[row.level])}>
                {row.level?.toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 py-1 font-mono text-xs break-all whitespace-pre-wrap">
                {row.message}
              </span>
            </div>
          )
      ))}
    </ScrollArea>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix web run test -- log-viewer`
Expected: PASS, all five tests green.

- [ ] **Step 5: Typecheck**

Run: `npm --prefix web run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/log-viewer.tsx web/src/components/log-viewer.test.tsx
git commit -m "feat(logs): add a Datadog-style log viewer component

A level-coloured bar down the left edge, then fixed-width time and
level cells, then a wrapping message. Fixed widths rather than one grid
spanning the list: a cross-row grid needs display:contents on the row
wrappers, which drops the per-row hover, border, and error tint.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Wire it into the Logs tab

**Files:**
- Modify: `web/src/components/result-panel.tsx:86`
- Test: `web/src/components/result-panel.test.tsx` (append)

**Interfaces:**
- Consumes: `LogViewer` from Task 3.
- Produces: nothing further.

- [ ] **Step 1: Write the failing test**

Append to `web/src/components/result-panel.test.tsx`:

```tsx
// The Logs tab used to be a raw <pre>: a traceback was a dozen unstructured
// rows and nothing separated an error from an info line.
it('renders logs as parsed rows rather than one flat blob', async () => {
  render(<ResultPanel result={{ ...ok, logs: '2026-07-30T10:23:45.123Z ERROR boom\n' }} />)

  await userEvent.click(screen.getByRole('tab', { name: 'Logs' }))

  expect(screen.getByText('10:23:45.123')).toBeInTheDocument()
  expect(screen.getByText('ERROR')).toBeInTheDocument()
  expect(screen.getByText('boom')).toBeInTheDocument()
})

it('still says there are no logs when the run printed nothing', async () => {
  render(<ResultPanel result={{ ...ok, logs: '' }} />)

  await userEvent.click(screen.getByRole('tab', { name: 'Logs' }))

  expect(screen.getByText('No logs.')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix web run test -- result-panel`
Expected: FAIL — `Unable to find an element with the text: 10:23:45.123`. The second test passes already, since the `<pre>` also renders `No logs.`

- [ ] **Step 3: Write the implementation**

In `web/src/components/result-panel.tsx`, add the import beside the other component imports:

```tsx
import { LogViewer } from '@/components/log-viewer'
```

Replace the logs `TabsContent` body:

```tsx
      <TabsContent value="logs" className="min-h-0 flex-1">
        <LogViewer raw={result?.logs} />
      </TabsContent>
```

Leave `Pane` in place — the Response error state and the Report tab still use it.

- [ ] **Step 4: Run the full web suite**

Run: `npm --prefix web run test`
Expected: PASS, every file green — the new tests plus the existing `result-panel`, `json-tree`, `env-editor`, `service-row`, `copyable-value`, `secrets`, and `queries` suites.

- [ ] **Step 5: Typecheck**

Run: `npm --prefix web run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Verify in the browser**

Run: `npm start`, open the playground, select a fixture, and invoke it.

Check on the Logs tab:
- Columns line up down the list when some lines have a time and others do not.
- A thrown handler's stack trace is one row with a red bar, not a dozen rows.
- A two-phase run (a function with a build command) shows the `build` and `invoke` dividers.
- Both themes read correctly — toggle with the theme switch in the nav.
- The browser console is clean.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/result-panel.tsx web/src/components/result-panel.test.tsx
git commit -m "feat(logs): render the Logs tab with the log viewer

Swaps the raw <pre> for LogViewer. Pane stays: the Response error
state and the Report tab still use it.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Notes for the reviewer

Two behaviours the spec did not pin down, decided here and covered by tests:

- **Blank lines are dropped** (Task 2). A bare empty line would render as an empty bordered row, which reads as a rendering glitch rather than as spacing. Whitespace-only lines are *not* dropped — they match the continuation rule and fold into the trace above them.
- **Sub-millisecond precision is truncated, not rounded** (Task 1). The time column is fixed width and the value is a label, not an arithmetic input.
