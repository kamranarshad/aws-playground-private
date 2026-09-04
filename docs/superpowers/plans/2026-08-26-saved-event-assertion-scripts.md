# Saved Event Assertion Scripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the (unreleased, branch-local) `SavedEvent.expectedStatus` field with a small Jest-flavored assertion script (`expect(...).toBe/toEqual/toContain/toMatch(...)`) that runs, on explicit button press, against the last invoke result and reports every assertion's pass/fail.

**Architecture:** A pure browser-side script engine (`web/src/lib/assertions.ts`) evaluates a saved event's script via `new Function`, exposing a non-throwing `expect()` so every assertion in the script always runs. `EventPanel` authors the script (CodeMirror JS editor in the save dialog) and triggers a check via a new "Run checks" button. `ResultPanel` renders the results in a new "Checks" tab plus a header summary chip. `routes/index.tsx` owns the state connecting "which script is active" to "what response to check it against."

**Tech Stack:** React, TypeScript, Vitest + Testing Library, CodeMirror (`@uiw/react-codemirror`), new dependency `@codemirror/lang-javascript`.

**Spec:** `docs/superpowers/specs/2026-08-26-saved-event-assertion-scripts-design.md`

## Global Constraints

- Scripts run browser-side only, via `new Function('response', 'error', 'report', 'expect', script)` — no server changes, no sandboxing beyond that (this is a local dev tool that already runs arbitrary handler code).
- `expect()` never throws. Each matcher call (`toBe`, `toEqual`, `toContain`, `toMatch`) records its own `{ matcher, actual, expected, pass }` result and returns `undefined` — every `expect()` line in a script always executes regardless of earlier failures.
- Exactly four matchers in v1: `toBe` (`===`), `toEqual` (deep equality), `toContain` (substring or array-includes), `toMatch` (regex, string patterns compiled via `new RegExp`). No `.not`, no numeric comparisons.
- A script that throws (syntax error, or a runtime error like `undefined.someProp`) is caught; any `expect()` results recorded before the throw are kept, plus a `scriptError: string` set to the thrown message.
- Checks run **only** when the user presses a "Run checks" button in `EventPanel` — never automatically after invoke.
- Check results (`checkResults` state) are cleared whenever the selected function changes, a new invoke happens, or the active saved event/assertion changes (different saved event picked, template loaded, or hand-edit) — never silently left stale against a response or script they no longer match.
- `SavedEvent.expectedStatus?: number` (added earlier on this branch, never released) is fully replaced by `SavedEvent.assertionScript?: string` — not kept alongside it.
- **Result row rendering resolves an ambiguity in the spec** (section 1's example showed `actual` on a passing row; the Web UI section said "actual value on failure"): this plan always shows both expected and actual, on pass and fail alike (e.g. `✓ toBe(200) — actual: 200` and `✗ toContain("ok") — actual: "hi"`), since it's simpler (one row template) and more informative.
- **Zero-assertion runs** (script ran but had no `expect()` calls, and didn't throw) are treated as a neutral "no assertions" state, not a failure — this is an implementation decision not spelled out in the spec.

---

## Task 1: Assertion engine — `runAssertions()`

**Files:**
- Modify: `web/src/lib/types.ts`
- Create: `web/src/lib/assertions.ts`
- Test: `web/src/lib/assertions.test.ts`

**Interfaces:**
- Produces: `CheckResult` (in `types.ts`) — `{ matcher: 'toBe' | 'toEqual' | 'toContain' | 'toMatch'; actual: unknown; expected: unknown; pass: boolean }`.
- Produces: `runAssertions(script: string, ctx: { response: unknown; error: LambdaError | null | undefined; report: Report | null }): AssertionRun` and `AssertionRun = { results: CheckResult[]; scriptError: string | null }`, both exported from `web/src/lib/assertions.ts`. Later tasks import both from this module.

- [ ] **Step 1: Add the `CheckResult` type**

In `web/src/lib/types.ts`, insert this new interface directly after the existing `LambdaError` interface (before `Report`):

```ts
export interface CheckResult {
  matcher: 'toBe' | 'toEqual' | 'toContain' | 'toMatch'
  actual: unknown
  expected: unknown
  pass: boolean
}
```

- [ ] **Step 2: Write the failing tests**

Create `web/src/lib/assertions.test.ts`:

```ts
import { expect, it } from 'vitest'
import { runAssertions } from '@/lib/assertions'

const ctx = { response: undefined, error: null, report: null }

it('passes toBe when values are strictly equal', () => {
  const { results, scriptError } = runAssertions('expect(200).toBe(200)', ctx)
  expect(scriptError).toBeNull()
  expect(results).toEqual([{ matcher: 'toBe', actual: 200, expected: 200, pass: true }])
})

it('fails toBe when values differ', () => {
  const { results } = runAssertions('expect(404).toBe(200)', ctx)
  expect(results).toEqual([{ matcher: 'toBe', actual: 404, expected: 200, pass: false }])
})

it('passes toEqual for deeply equal objects regardless of key order', () => {
  const { results } = runAssertions('expect({ a: 1, b: [1, 2] }).toEqual({ b: [1, 2], a: 1 })', ctx)
  expect(results[0].pass).toBe(true)
})

it('fails toEqual for objects that differ', () => {
  const { results } = runAssertions('expect({ a: 1 }).toEqual({ a: 2 })', ctx)
  expect(results[0].pass).toBe(false)
})

it('passes toContain for a substring', () => {
  const { results } = runAssertions('expect("hello world").toContain("world")', ctx)
  expect(results[0].pass).toBe(true)
})

it('passes toContain for an array element', () => {
  const { results } = runAssertions('expect([1, 2, 3]).toContain(2)', ctx)
  expect(results[0].pass).toBe(true)
})

it('fails toContain gracefully when actual is neither a string nor an array', () => {
  const { results } = runAssertions('expect(200).toContain(2)', ctx)
  expect(results[0]).toEqual({
    matcher: 'toContain', actual: 200, expected: 'toContain requires a string or array', pass: false,
  })
})

it('passes toMatch against a regex', () => {
  const { results } = runAssertions('expect("order-123").toMatch(/^order-\\d+$/)', ctx)
  expect(results[0].pass).toBe(true)
})

it('passes toMatch against a string pattern', () => {
  const { results } = runAssertions('expect("order-123").toMatch("order-\\\\d+")', ctx)
  expect(results[0].pass).toBe(true)
})

it('runs every expect() even after an earlier one fails', () => {
  const { results } = runAssertions('expect(1).toBe(2); expect(1).toBe(1)', ctx)
  expect(results.map((r) => r.pass)).toEqual([false, true])
})

it('keeps results recorded before a thrown error, and reports the error message', () => {
  const { results, scriptError } = runAssertions(
    'expect(1).toBe(1); response.nonexistent.deeper',
    ctx,
  )
  expect(results).toEqual([{ matcher: 'toBe', actual: 1, expected: 1, pass: true }])
  expect(scriptError).toMatch(/nonexistent/)
})

it('reports a syntax error as scriptError with no results', () => {
  const { results, scriptError } = runAssertions('expect(1).toBe(', ctx)
  expect(results).toEqual([])
  expect(scriptError).not.toBeNull()
})

it('returns empty results and no error for an empty script', () => {
  const { results, scriptError } = runAssertions('', ctx)
  expect(results).toEqual([])
  expect(scriptError).toBeNull()
})

it('exposes response, error, and report to the script', () => {
  const { results } = runAssertions(
    'expect(response.statusCode).toBe(200); expect(report.durationMs).toBe(12)',
    {
      response: { statusCode: 200 },
      error: null,
      report: { requestId: 'r1', durationMs: 12, billedMs: 13, memoryMb: 128, timedOut: false },
    },
  )
  expect(results.every((r) => r.pass)).toBe(true)
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/lib/assertions.test.ts`
Expected: FAIL — `Cannot find module '@/lib/assertions'` (the module doesn't exist yet).

- [ ] **Step 4: Implement `runAssertions`**

Create `web/src/lib/assertions.ts`:

```ts
import type { CheckResult, LambdaError, Report } from '@/lib/types'

interface AssertionContext {
  response: unknown
  error: LambdaError | null | undefined
  report: Report | null
}

export interface AssertionRun {
  results: CheckResult[]
  scriptError: string | null
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aKeys = Object.keys(a as Record<string, unknown>)
  const bKeys = Object.keys(b as Record<string, unknown>)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(b, key)
    && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

export function runAssertions(script: string, ctx: AssertionContext): AssertionRun {
  const results: CheckResult[] = []

  function record(matcher: CheckResult['matcher'], actual: unknown, expected: unknown, pass: boolean) {
    results.push({ matcher, actual, expected, pass })
  }

  function expect(actual: unknown) {
    return {
      toBe(expected: unknown) {
        record('toBe', actual, expected, actual === expected)
      },
      toEqual(expected: unknown) {
        record('toEqual', actual, expected, deepEqual(actual, expected))
      },
      toContain(expected: unknown) {
        if (typeof actual === 'string' && typeof expected === 'string') {
          record('toContain', actual, expected, actual.includes(expected))
        } else if (Array.isArray(actual)) {
          record('toContain', actual, expected, actual.includes(expected))
        } else {
          record('toContain', actual, 'toContain requires a string or array', false)
        }
      },
      toMatch(pattern: RegExp | string) {
        const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern)
        record('toMatch', actual, pattern, regex.test(String(actual)))
      },
    }
  }

  try {
    const run = new Function('response', 'error', 'report', 'expect', script) as
      (response: unknown, error: unknown, report: unknown, expect: unknown) => void
    run(ctx.response, ctx.error, ctx.report, expect)
    return { results, scriptError: null }
  } catch (e) {
    return { results, scriptError: (e as Error).message }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/lib/assertions.test.ts`
Expected: PASS (14 tests)

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/types.ts web/src/lib/assertions.ts web/src/lib/assertions.test.ts
git commit -m "feat(web): add the runAssertions script engine for saved-event checks"
```

---

## Task 2: Replace `expectedStatus` with `assertionScript`; script editor in the save dialog

This task swaps the data model field and gives `EventPanel`'s save dialog a CodeMirror JS editor to author the script. It also strips the now-obsolete `expectedStatus` prop and badge out of `ResultPanel` and `routes/index.tsx` (the real Checks UI is built fresh in Tasks 4–5) so the app keeps compiling and nothing dead is left half-wired.

**Files:**
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/components/event-panel.tsx`
- Modify: `web/src/components/result-panel.tsx`
- Modify: `web/src/routes/index.tsx`
- Modify: `web/package.json` (new dependency)
- Test: `web/src/components/event-panel.test.tsx`
- Test: `web/src/components/result-panel.test.tsx`

**Interfaces:**
- Consumes: nothing from Task 1 directly (this task doesn't touch the engine yet).
- Produces: `SavedEvent.assertionScript?: string` (replacing `expectedStatus?: number`); `EventPanel`'s save dialog writes this field. `EventPanel`'s prop signature is otherwise unchanged from before this feature (`onLoadSavedEvent: (saved: SavedEvent | null) => void` stays as-is — it already hands back the whole `SavedEvent`, so the new field rides along automatically).

- [ ] **Step 1: Add the new dependency**

Run: `cd web && npm install @codemirror/lang-javascript`

- [ ] **Step 2: Rename the field in `types.ts`**

In `web/src/lib/types.ts`, change:

```ts
export interface SavedEvent {
  name: string
  event: unknown
  expectedStatus?: number
}
```

to:

```ts
export interface SavedEvent {
  name: string
  event: unknown
  assertionScript?: string
}
```

- [ ] **Step 3: Write the updated/failing tests for `event-panel.test.tsx`**

Replace the full contents of `web/src/components/event-panel.test.tsx` with:

```tsx
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { updateFunction: vi.fn() },
}))

import { EventPanel } from '@/components/event-panel'
import { api } from '@/lib/api'
import type { FunctionDef, SavedEvent } from '@/lib/types'

afterEach(() => vi.clearAllMocks())

function makeFn(overrides: Partial<FunctionDef> = {}): FunctionDef {
  return {
    id: 'fn-1', name: 'fn', path: '/tmp/fn', runtime: 'node', handler: 'index.handler',
    timeoutMs: 3000, memoryMb: 128, jarPath: null, env: {}, envFile: '', buildCommand: '',
    localServices: [], trigger: null, savedEvents: [], ...overrides,
  }
}

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

// CodeMirror's own default keymap binds Mod-Enter to insertBlankLine (its
// documented "Ctrl-Enter / Cmd-Enter" behavior), which runs inside the
// editor before the app's window-level Cmd+Enter listener ever sees the
// event — so that listener's preventDefault is too late to stop a newline
// CodeMirror already inserted through its own transaction system.
it('invokes on Cmd+Enter from inside the JSON editor, instead of inserting a blank line', () => {
  const onInvoke = vi.fn()
  const onEventTextChange = vi.fn()
  render(
    <EventPanel
      fn={makeFn()} eventText={'{}'} onEventTextChange={onEventTextChange}
      onInvoke={onInvoke} invoking={false} onLoadSavedEvent={vi.fn()}
    />,
    { wrapper: Wrapper },
  )
  const editor = document.querySelector('.cm-content')
  if (!editor) throw new Error('CodeMirror content element did not mount')

  // CodeMirror's "Mod-Enter" binding normalizes to the platform's own
  // modifier — Meta (Cmd) on a real Mac, which is what a user pressing
  // Cmd+Enter sends, but Ctrl under jsdom's non-Mac platform detection.
  // Firing whichever one jsdom will actually match exercises the same
  // precedence fix regardless of which one a real browser resolves to.
  fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })

  expect(onInvoke).toHaveBeenCalledTimes(1)
  expect(onEventTextChange).not.toHaveBeenCalled()
})

// index.tsx's own window-level Cmd+Enter shortcut (for when focus is
// anywhere else in the app) sits above the editor in the same bubble chain.
// Handling the key inside CodeMirror without stopping propagation would let
// that outer listener fire too — two invokes for one keypress, which is
// exactly what trips the server's "an invoke is already in flight" guard.
it('does not also trigger a window-level Cmd+Enter listener above it', () => {
  const onInvoke = vi.fn()
  const windowHandler = vi.fn()
  window.addEventListener('keydown', windowHandler)
  try {
    render(
      <EventPanel
        fn={makeFn()} eventText={'{}'} onEventTextChange={vi.fn()}
        onInvoke={onInvoke} invoking={false} onLoadSavedEvent={vi.fn()}
      />,
      { wrapper: Wrapper },
    )
    const editor = document.querySelector('.cm-content')
    if (!editor) throw new Error('CodeMirror content element did not mount')

    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })

    expect(onInvoke).toHaveBeenCalledTimes(1)
    expect(windowHandler).not.toHaveBeenCalled()
  } finally {
    window.removeEventListener('keydown', windowHandler)
  }
})

it('saves an assertion script alongside a named event', async () => {
  vi.mocked(api.updateFunction).mockResolvedValue(makeFn())
  const user = userEvent.setup()
  render(
    <EventPanel
      fn={makeFn()} eventText={'{"a":1}'} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} onLoadSavedEvent={vi.fn()}
    />,
    { wrapper: Wrapper },
  )

  await user.click(screen.getByRole('button', { name: /save/i }))
  await user.type(screen.getByPlaceholderText('Event name'), 'foo')
  const dialog = screen.getByRole('dialog')
  const scriptEditor = dialog.querySelector('.cm-content')
  if (!scriptEditor) throw new Error('script CodeMirror did not mount')
  await user.click(scriptEditor)
  await user.keyboard('expect(response.statusCode).toBe(200)')
  await user.click(screen.getByRole('button', { name: 'Save' }))

  expect(api.updateFunction).toHaveBeenCalledWith('fn-1', {
    savedEvents: [{
      name: 'foo', event: { a: 1 }, assertionScript: 'expect(response.statusCode).toBe(200)',
    }],
  })
})

it('omits assertionScript when the field is left blank', async () => {
  vi.mocked(api.updateFunction).mockResolvedValue(makeFn())
  const user = userEvent.setup()
  render(
    <EventPanel
      fn={makeFn()} eventText={'{"a":1}'} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} onLoadSavedEvent={vi.fn()}
    />,
    { wrapper: Wrapper },
  )

  await user.click(screen.getByRole('button', { name: /save/i }))
  await user.type(screen.getByPlaceholderText('Event name'), 'foo')
  await user.click(screen.getByRole('button', { name: 'Save' }))

  expect(api.updateFunction).toHaveBeenCalledWith('fn-1', {
    savedEvents: [{ name: 'foo', event: { a: 1 } }],
  })
})

it('surfaces a saved event\'s assertion when it is loaded from the dropdown', async () => {
  const saved: SavedEvent = {
    name: 'foo', event: { a: 1 }, assertionScript: 'expect(response.statusCode).toBe(200)',
  }
  const onEventTextChange = vi.fn()
  const onLoadSavedEvent = vi.fn()
  const user = userEvent.setup()
  render(
    <EventPanel
      fn={makeFn({ savedEvents: [saved] })} eventText={'{}'} onEventTextChange={onEventTextChange}
      onInvoke={vi.fn()} invoking={false} onLoadSavedEvent={onLoadSavedEvent}
    />,
    { wrapper: Wrapper },
  )

  await user.click(screen.getAllByRole('combobox')[1])
  await user.click(screen.getByRole('option', { name: 'foo' }))

  expect(onEventTextChange).toHaveBeenCalledWith(JSON.stringify({ a: 1 }, null, 2))
  expect(onLoadSavedEvent).toHaveBeenCalledWith(saved)
})

it('clears the active assertion when a template is loaded instead', async () => {
  const saved: SavedEvent = {
    name: 'foo', event: { a: 1 }, assertionScript: 'expect(response.statusCode).toBe(200)',
  }
  const onLoadSavedEvent = vi.fn()
  const user = userEvent.setup()
  render(
    <EventPanel
      fn={makeFn({ savedEvents: [saved] })} eventText={'{}'} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} onLoadSavedEvent={onLoadSavedEvent}
    />,
    { wrapper: Wrapper },
  )

  await user.click(screen.getAllByRole('combobox')[0])
  await user.click(screen.getAllByRole('option')[0])

  expect(onLoadSavedEvent).toHaveBeenCalledWith(null)
})

it('clears the active assertion when the event is hand-edited', async () => {
  const saved: SavedEvent = {
    name: 'foo', event: { a: 1 }, assertionScript: 'expect(response.statusCode).toBe(200)',
  }
  const onLoadSavedEvent = vi.fn()
  const user = userEvent.setup()
  render(
    <EventPanel
      fn={makeFn({ savedEvents: [saved] })} eventText={'{}'} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} onLoadSavedEvent={onLoadSavedEvent}
    />,
    { wrapper: Wrapper },
  )
  const editor = document.querySelector('.cm-content')
  if (!editor) throw new Error('CodeMirror content element did not mount')

  await user.click(editor)
  await user.keyboard('x')

  expect(onLoadSavedEvent).toHaveBeenCalledWith(null)
})
```

- [ ] **Step 4: Run to verify the new/changed tests fail**

Run: `cd web && npx vitest run src/components/event-panel.test.tsx`
Expected: FAIL — `'saves an assertion script alongside a named event'` throws `script CodeMirror did not mount` (the dialog still has the old "Expected status" number input, no CodeMirror to click into). `'omits assertionScript...'` may already pass by coincidence (an untouched blank field omits the optional key either way) — that's fine, it still guards the behavior going forward once Step 5 lands.

- [ ] **Step 5: Update `event-panel.tsx`**

Replace the full contents of `web/src/components/event-panel.tsx` with:

```tsx
import { useEffect, useMemo, useState } from 'react'
import CodeMirror, { keymap, Prec } from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { Play, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { EVENT_TEMPLATES } from '@/lib/templates'
import { useUpdateFunction } from '@/lib/queries'
import { useTheme } from '@/lib/theme'
import type { FunctionDef, SavedEvent } from '@/lib/types'

export function EventPanel({ fn, eventText, onEventTextChange, onInvoke, invoking, onLoadSavedEvent }: {
  fn: FunctionDef
  eventText: string
  onEventTextChange: (text: string) => void
  onInvoke: () => void
  invoking: boolean
  onLoadSavedEvent: (saved: SavedEvent | null) => void
}) {
  const { theme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveAssertionScript, setSaveAssertionScript] = useState('')
  const update = useUpdateFunction()

  useEffect(() => setMounted(true), [])

  // CodeMirror's own default keymap binds Mod-Enter to insertBlankLine (its
  // documented Ctrl-/Cmd-Enter behavior) and runs it before the app's
  // window-level Cmd+Enter listener ever sees the event, so that listener's
  // preventDefault is too late to undo the blank line CodeMirror already
  // inserted. Prec.highest makes this binding win instead. stopPropagation
  // is required too: preventDefault alone stops the browser's own newline
  // but doesn't stop the event bubbling on to that window-level listener,
  // which would otherwise invoke a second time for the same keypress.
  const extensions = useMemo(() => [
    Prec.highest(keymap.of([
      { key: 'Mod-Enter', run: () => { onInvoke(); return true }, stopPropagation: true },
    ])),
    json(),
  ], [onInvoke])

  const jsonError = useMemo(() => {
    try {
      JSON.parse(eventText)
      return null
    } catch (e) {
      return (e as Error).message
    }
  }, [eventText])

  function saveEvent() {
    const name = saveName.trim()
    if (!name) return
    const assertionScript = saveAssertionScript.trim() || undefined
    const savedEvents = [
      ...fn.savedEvents.filter((s) => s.name !== name),
      {
        name,
        event: JSON.parse(eventText),
        ...(assertionScript !== undefined && { assertionScript }),
      },
    ]
    update.mutate({ id: fn.id, patch: { savedEvents } }, {
      onSuccess: () => {
        setSaveOpen(false)
        setSaveName('')
        setSaveAssertionScript('')
        toast.success(`Saved event "${name}"`)
      },
    })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="m-1.5 flex items-center gap-1.5 rounded-lg bg-surface-strip px-2.5 py-1.5">
        <Select value="" onValueChange={(name) => {
          onEventTextChange(JSON.stringify(EVENT_TEMPLATES[name], null, 2))
          onLoadSavedEvent(null)
        }}>
          <SelectTrigger className="h-8 w-40 text-xs"><SelectValue placeholder="Template…" /></SelectTrigger>
          <SelectContent>
            {Object.keys(EVENT_TEMPLATES).map((name) => (
              <SelectItem key={name} value={name}>{name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value="" onValueChange={(name) => {
          const saved = fn.savedEvents.find((s) => s.name === name)
          if (!saved) return
          onEventTextChange(JSON.stringify(saved.event, null, 2))
          onLoadSavedEvent(saved)
        }}>
          <SelectTrigger className="h-8 w-40 text-xs" disabled={fn.savedEvents.length === 0}>
            <SelectValue placeholder="Saved events…" />
          </SelectTrigger>
          <SelectContent>
            {fn.savedEvents.map((s) => (
              <SelectItem key={s.name} value={s.name}>{s.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="sm" disabled={!!jsonError}
          onClick={() => setSaveOpen(true)}>
          <Save className="size-3.5" /> Save
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {jsonError && (
            <span className="whitespace-nowrap text-xs text-destructive" title={jsonError}>
              invalid JSON
            </span>
          )}
          <Button size="sm" onClick={onInvoke} disabled={!!jsonError || invoking}>
            <Play className="size-3.5" /> {invoking ? 'Invoking…' : 'Invoke'}
            <kbd className="ml-1 font-mono text-[10px] opacity-70">⌘⏎</kbd>
          </Button>
        </div>
      </div>
      <div className="cm-host min-h-0 flex-1 overflow-auto font-mono text-sm">
        {mounted && (
          <CodeMirror value={eventText} height="100%" theme={theme}
            extensions={extensions}
            onChange={(text) => { onEventTextChange(text); onLoadSavedEvent(null) }} />
        )}
      </div>
      <Dialog open={saveOpen} onOpenChange={(o) => {
        setSaveOpen(o)
        if (!o) { setSaveName(''); setSaveAssertionScript('') }
      }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Save event</DialogTitle></DialogHeader>
          <Input value={saveName} onChange={(e) => setSaveName(e.target.value)}
            placeholder="Event name" autoComplete="off" />
          <div className="grid gap-2">
            <span className="text-sm font-medium">
              Assertion script <span className="font-normal text-muted-foreground">(optional)</span>
            </span>
            <div className="cm-host overflow-hidden rounded-md border font-mono text-sm">
              {mounted && (
                <CodeMirror value={saveAssertionScript} height="96px" theme={theme}
                  extensions={[javascript()]}
                  placeholder="expect(response.statusCode).toBe(200)"
                  onChange={setSaveAssertionScript} />
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost"
              onClick={() => { setSaveOpen(false); setSaveName(''); setSaveAssertionScript('') }}>
              Cancel
            </Button>
            <Button onClick={saveEvent} disabled={!saveName.trim() || update.isPending}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
```

- [ ] **Step 6: Revert `result-panel.tsx` to its pre-assertion-feature shape**

Replace the full contents of `web/src/components/result-panel.tsx` with:

```tsx
import { useMemo, type ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CopyButton } from '@/components/copy-button'
import { HttpStatusBadge } from '@/components/http-status-badge'
import { JsonTree } from '@/components/json-tree'
import { LogViewer } from '@/components/log-viewer'
import { cn } from '@/lib/utils'
import type { InvokeResult } from '@/lib/types'

// Reference look: the active tab is orange text on a flat background — no
// pill, no shadow — so all state lives in the text color. Both light and dark
// modes use orange text; shadows are suppressed at the specific selector depth.
const TAB =
  'text-xs data-[state=active]:bg-transparent data-[state=active]:text-brand group-data-[variant=default]/tabs-list:data-[state=active]:shadow-none dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-transparent dark:data-[state=active]:text-brand'

function Pane({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="h-full">
      <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs tabular-nums">{children}</pre>
    </ScrollArea>
  )
}

export function ResultPanel({ result, historyTab }: {
  result: InvokeResult | null
  historyTab?: ReactNode
}) {
  // Minified: the copy is a handoff to curl, an editor, or a test fixture, and
  // the tree already covers reading it here. Memoised because a response can be
  // large and only the copy button needs the flat text.
  const responseJson = useMemo(() => {
    if (!result?.ok) return null
    // A handler that returned nothing has no JSON to copy: stringify(undefined)
    // hands back undefined, not a string.
    const json: string | undefined = JSON.stringify(result.response)
    return json ?? null
  }, [result])

  return (
    <Tabs defaultValue="response" className="flex h-full flex-col gap-0">
      <div className="m-1.5 flex items-center gap-2 rounded-lg bg-surface-strip px-2.5 py-1.5">
        <TabsList className="h-8 bg-transparent">
          <TabsTrigger value="response" className={TAB}>Response</TabsTrigger>
          <TabsTrigger value="logs" className={TAB}>Logs</TabsTrigger>
          <TabsTrigger value="report" className={TAB}>Report</TabsTrigger>
          {historyTab && <TabsTrigger value="history" className={TAB}>History</TabsTrigger>}
        </TabsList>
        {result && (
          <div className="ml-auto flex items-center gap-1.5">
            {result.ok && <HttpStatusBadge response={result.response} />}
            <Badge
              variant={result.ok ? 'outline' : 'destructive'}
              className={cn(
                'font-mono tabular-nums text-[10px]',
                result.ok && 'border-transparent bg-success/15 text-success',
              )}
            >
              {result.ok ? 'OK' : result.error?.type ?? 'ERROR'}
              {' · '}{result.report.durationMs}ms
            </Badge>
          </div>
        )}
      </div>
      <TabsContent value="response" className="relative min-h-0 flex-1">
        {result?.ok
          ? (
            <>
              {responseJson != null && (
                <CopyButton
                  value={responseJson} label="Copy response JSON"
                  // Opaque, so rows scrolling under it stay legible.
                  className="absolute top-1.5 right-3 z-10 bg-background"
                />
              )}
              <ScrollArea className="h-full">
                {/* Re-keyed per invoke so the next response opens at its default
                    depth instead of inheriting the last one's expanded rows. */}
                <JsonTree key={result.report.requestId} value={result.response} className="pr-10" />
              </ScrollArea>
            </>
          )
          : (
            <Pane>
              {!result
                ? 'Invoke to see the response.'
                : `${result.error?.type}: ${result.error?.message}\n\n${(result.error?.stackTrace ?? []).join('\n')}`}
            </Pane>
          )}
      </TabsContent>
      <TabsContent value="logs" className="min-h-0 flex-1">
        {/* Re-keyed per invoke, like the response tree: rows are keyed by
            index, so without this an expanded structured entry would stay
            expanded over whatever landed at that index in the next run. */}
        <LogViewer key={result?.report.requestId ?? 'empty'} raw={result?.logs} />
      </TabsContent>
      <TabsContent value="report" className="min-h-0 flex-1">
        <Pane>
          {result
            ? `REPORT RequestId: ${result.report.requestId}\n` +
              `Duration: ${result.report.durationMs} ms\n` +
              `Billed Duration: ${result.report.billedMs} ms\n` +
              `Memory Size: ${result.report.memoryMb} MB\n` +
              (result.report.buildMs != null ? `Build Duration: ${result.report.buildMs} ms\n` : '') +
              (result.report.timedOut ? 'Status: TIMED OUT\n' : '')
            : 'No report yet.'}
        </Pane>
      </TabsContent>
      {historyTab && (
        <TabsContent value="history" className="min-h-0 flex-1">
          {historyTab}
        </TabsContent>
      )}
    </Tabs>
  )
}
```

- [ ] **Step 7: Remove the 4 obsolete assertion-chip tests from `result-panel.test.tsx`**

In `web/src/components/result-panel.test.tsx`, delete these four `it(...)` blocks entirely (they test the `expectedStatus` prop this task just removed):
- `'shows nothing for the assertion when no saved event is active'`
- `'marks the assertion as passing when the response status matches'`
- `'marks the assertion as failing when the response status does not match'`
- `'fails the assertion when the invoke itself errored'`

The file should end with the `'still says there are no logs when the run printed nothing'` test (no trailing tests after it).

- [ ] **Step 8: Remove the `expectedStatus` passthrough from `routes/index.tsx`**

In `web/src/routes/index.tsx`, make these changes:

1. Change the type import:

```ts
import type { InvokeResult, SavedEvent } from '@/lib/types'
```

to:

```ts
import type { InvokeResult } from '@/lib/types'
```

2. Remove the `activeAssertion` state (it'll be re-added properly, alongside `checkResults`, in Task 5):

```ts
  const [result, setResult] = useState<InvokeResult | null>(null)
  const [activeAssertion, setActiveAssertion] = useState<SavedEvent | null>(null)
  const invoke = useInvoke()
```

becomes:

```ts
  const [result, setResult] = useState<InvokeResult | null>(null)
  const invoke = useInvoke()
```

3. Remove the `setActiveAssertion(null)` line from `selectFunction`:

```ts
  function selectFunction(id: string | null) {
    setPinnedId(id)
    setResult(null)
    setActiveAssertion(null)
  }
```

becomes:

```ts
  function selectFunction(id: string | null) {
    setPinnedId(id)
    setResult(null)
  }
```

4. In the JSX, change `onLoadSavedEvent={setActiveAssertion}` to `onLoadSavedEvent={() => {}}`, and remove the `expectedStatus={activeAssertion?.expectedStatus}` line from `<ResultPanel>`:

```tsx
                  <EventPanel
                    fn={selected}
                    eventText={drafts[selected.id] ?? '{}'}
                    onEventTextChange={(text) =>
                      setDrafts((d) => ({ ...d, [selected.id]: text }))}
                    onInvoke={() => runInvoke(selected.id)}
                    invoking={invoke.isPending}
                    onLoadSavedEvent={() => {}}
                  />
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel defaultSize={50} minSize={25}>
                  <ResultPanel
                    result={result}
                    historyTab={
```

- [ ] **Step 9: Run the full web test suite, typecheck, and lint**

Run: `cd web && npx vitest run && npx tsc --noEmit`
Expected: all tests pass, no type errors.

Run (from repo root): `npx oxlint --react-plugin .`
Expected: no new errors (pre-existing `react/set-state-in-effect` warnings are fine).

- [ ] **Step 10: Commit**

```bash
git add web/package.json web/package-lock.json web/src/lib/types.ts \
  web/src/components/event-panel.tsx web/src/components/event-panel.test.tsx \
  web/src/components/result-panel.tsx web/src/components/result-panel.test.tsx \
  web/src/routes/index.tsx
git commit -m "feat(web): replace the expected-status field with an assertion script"
```

---

## Task 3: "Run checks" button in `EventPanel`

**Files:**
- Modify: `web/src/components/event-panel.tsx`
- Test: `web/src/components/event-panel.test.tsx`

**Interfaces:**
- Consumes: nothing new from other modules.
- Produces: `EventPanel` gains two new required props — `canRunChecks: boolean` and `onRunChecks: () => void` — that `routes/index.tsx` will supply in Task 5.

- [ ] **Step 1: Write the failing tests**

Add `canRunChecks={false}` and `onRunChecks={vi.fn()}` to **every** existing `<EventPanel ... />` render call in `web/src/components/event-panel.test.tsx` (all 7 of them), and append these two new tests at the end of the file:

```tsx
it('disables the Run checks button until there is an active assertion and a result', () => {
  render(
    <EventPanel
      fn={makeFn()} eventText={'{}'} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} onLoadSavedEvent={vi.fn()}
      canRunChecks={false} onRunChecks={vi.fn()}
    />,
    { wrapper: Wrapper },
  )

  expect(screen.getByRole('button', { name: /run checks/i })).toBeDisabled()
})

it('runs checks when the button is pressed', async () => {
  const onRunChecks = vi.fn()
  const user = userEvent.setup()
  render(
    <EventPanel
      fn={makeFn()} eventText={'{}'} onEventTextChange={vi.fn()}
      onInvoke={vi.fn()} invoking={false} onLoadSavedEvent={vi.fn()}
      canRunChecks={true} onRunChecks={onRunChecks}
    />,
    { wrapper: Wrapper },
  )

  await user.click(screen.getByRole('button', { name: /run checks/i }))

  expect(onRunChecks).toHaveBeenCalledTimes(1)
})
```

(For the 7 existing render calls, add `canRunChecks={false} onRunChecks={vi.fn()}` as extra props on each `<EventPanel ...>` — the exact value of `canRunChecks` doesn't matter for those tests since none of them interact with the new button.)

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd web && npx vitest run src/components/event-panel.test.tsx`
Expected: FAIL — `Unable to find an accessible element with the role "button" and name /run checks/i` (the button doesn't exist yet).

- [ ] **Step 3: Add the button and props**

In `web/src/components/event-panel.tsx`:

1. Add `ListChecks` to the lucide-react import:

```ts
import { ListChecks, Play, Save } from 'lucide-react'
```

2. Add the two new props to the function signature:

```tsx
export function EventPanel({
  fn, eventText, onEventTextChange, onInvoke, invoking, onLoadSavedEvent, canRunChecks, onRunChecks,
}: {
  fn: FunctionDef
  eventText: string
  onEventTextChange: (text: string) => void
  onInvoke: () => void
  invoking: boolean
  onLoadSavedEvent: (saved: SavedEvent | null) => void
  canRunChecks: boolean
  onRunChecks: () => void
}) {
```

3. Add the button right after the existing Save button:

```tsx
        <Button variant="ghost" size="sm" disabled={!!jsonError}
          onClick={() => setSaveOpen(true)}>
          <Save className="size-3.5" /> Save
        </Button>
        <Button variant="ghost" size="sm" disabled={!canRunChecks} onClick={onRunChecks}>
          <ListChecks className="size-3.5" /> Run checks
        </Button>
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `cd web && npx vitest run src/components/event-panel.test.tsx`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add web/src/components/event-panel.tsx web/src/components/event-panel.test.tsx
git commit -m "feat(web): add a Run checks button to the event panel"
```

---

## Task 4: "Checks" tab and summary chip in `ResultPanel`

**Files:**
- Modify: `web/src/components/result-panel.tsx`
- Test: `web/src/components/result-panel.test.tsx`

**Interfaces:**
- Consumes: `AssertionRun` type from `web/src/lib/assertions.ts` (Task 1).
- Produces: `ResultPanel` gains an optional prop `checkResults?: AssertionRun | null`, which `routes/index.tsx` will supply in Task 5.

- [ ] **Step 1: Write the failing tests**

Append these tests to the end of `web/src/components/result-panel.test.tsx` (after the existing `'still says there are no logs...'` test):

```tsx
const mixedChecks = {
  results: [
    { matcher: 'toBe' as const, actual: 200, expected: 200, pass: true },
    { matcher: 'toContain' as const, actual: 'hi', expected: 'ok', pass: false },
  ],
  scriptError: null,
}

it('shows neither the Checks tab nor a summary chip when no checks have run', () => {
  render(<ResultPanel result={ok} />)

  expect(screen.queryByRole('tab', { name: 'Checks' })).not.toBeInTheDocument()
  expect(screen.queryByText(/passed/)).not.toBeInTheDocument()
})

it('summarizes how many checks passed', () => {
  render(<ResultPanel result={ok} checkResults={mixedChecks} />)

  expect(screen.getByText('1/2 passed')).toBeInTheDocument()
})

it('lists each check with its matcher, expected, and actual value', async () => {
  render(<ResultPanel result={ok} checkResults={mixedChecks} />)

  await userEvent.click(screen.getByRole('tab', { name: 'Checks' }))

  expect(screen.getByText('toBe(200) — actual: 200')).toBeInTheDocument()
  expect(screen.getByText('toContain("ok") — actual: "hi"')).toBeInTheDocument()
  expect(screen.getByLabelText('Check passed')).toBeInTheDocument()
  expect(screen.getByLabelText('Check failed')).toBeInTheDocument()
})

it('shows a script-error row alongside any results gathered before it threw', async () => {
  render(
    <ResultPanel
      result={ok}
      checkResults={{
        results: [{ matcher: 'toBe' as const, actual: 200, expected: 200, pass: true }],
        scriptError: 'response.body.nope is not a function',
      }}
    />,
  )

  await userEvent.click(screen.getByRole('tab', { name: 'Checks' }))

  expect(screen.getByText('response.body.nope is not a function')).toBeInTheDocument()
  expect(screen.getByLabelText('Script error')).toBeInTheDocument()
})

it('says a script had no assertions rather than showing an empty list', async () => {
  render(<ResultPanel result={ok} checkResults={{ results: [], scriptError: null }} />)

  expect(screen.getByText('no assertions')).toBeInTheDocument()

  await userEvent.click(screen.getByRole('tab', { name: 'Checks' }))

  expect(screen.getByText('Script had no assertions.')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd web && npx vitest run src/components/result-panel.test.tsx`
Expected: FAIL — `checkResults` isn't a recognized prop yet and no "Checks" tab exists, so the new tests can't find the tab/text they're looking for.

- [ ] **Step 3: Implement the Checks tab**

Replace the full contents of `web/src/components/result-panel.tsx` with:

```tsx
import { useMemo, type ReactNode } from 'react'
import { CircleCheck, CircleX } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CopyButton } from '@/components/copy-button'
import { HttpStatusBadge } from '@/components/http-status-badge'
import { JsonTree } from '@/components/json-tree'
import { LogViewer } from '@/components/log-viewer'
import type { AssertionRun } from '@/lib/assertions'
import { cn } from '@/lib/utils'
import type { InvokeResult } from '@/lib/types'

// Reference look: the active tab is orange text on a flat background — no
// pill, no shadow — so all state lives in the text color. Both light and dark
// modes use orange text; shadows are suppressed at the specific selector depth.
const TAB =
  'text-xs data-[state=active]:bg-transparent data-[state=active]:text-brand group-data-[variant=default]/tabs-list:data-[state=active]:shadow-none dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-transparent dark:data-[state=active]:text-brand'

function Pane({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="h-full">
      <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs tabular-nums">{children}</pre>
    </ScrollArea>
  )
}

function ChecksSummaryBadge({ run }: { run: AssertionRun }) {
  const total = run.results.length
  const passed = run.results.filter((r) => r.pass).length
  if (total === 0 && !run.scriptError) {
    return (
      <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
        no assertions
      </Badge>
    )
  }
  const allPass = run.scriptError == null && passed === total
  return (
    <Badge
      variant="outline"
      className={cn(
        'font-mono tabular-nums text-[10px]',
        allPass ? 'border-transparent bg-success/15 text-success'
          : 'border-transparent bg-destructive/15 text-destructive',
      )}
    >
      {passed}/{total} passed
    </Badge>
  )
}

function ChecksList({ run }: { run: AssertionRun }) {
  if (run.results.length === 0 && !run.scriptError) {
    return <Pane>Script had no assertions.</Pane>
  }
  return (
    <ScrollArea className="h-full">
      <ul className="divide-y font-mono text-xs">
        {run.results.map((r, i) => (
          <li key={i} className="flex items-start gap-2 px-3 py-1.5">
            {r.pass
              ? <CircleCheck role="img" aria-label="Check passed" className="mt-0.5 size-3.5 shrink-0 text-success" />
              : <CircleX role="img" aria-label="Check failed" className="mt-0.5 size-3.5 shrink-0 text-destructive" />}
            <span>{r.matcher}({JSON.stringify(r.expected)}) — actual: {JSON.stringify(r.actual)}</span>
          </li>
        ))}
        {run.scriptError && (
          <li className="flex items-start gap-2 px-3 py-1.5">
            <CircleX role="img" aria-label="Script error" className="mt-0.5 size-3.5 shrink-0 text-destructive" />
            <span className="text-destructive">{run.scriptError}</span>
          </li>
        )}
      </ul>
    </ScrollArea>
  )
}

export function ResultPanel({ result, checkResults, historyTab }: {
  result: InvokeResult | null
  checkResults?: AssertionRun | null
  historyTab?: ReactNode
}) {
  // Minified: the copy is a handoff to curl, an editor, or a test fixture, and
  // the tree already covers reading it here. Memoised because a response can be
  // large and only the copy button needs the flat text.
  const responseJson = useMemo(() => {
    if (!result?.ok) return null
    // A handler that returned nothing has no JSON to copy: stringify(undefined)
    // hands back undefined, not a string.
    const json: string | undefined = JSON.stringify(result.response)
    return json ?? null
  }, [result])

  return (
    <Tabs defaultValue="response" className="flex h-full flex-col gap-0">
      <div className="m-1.5 flex items-center gap-2 rounded-lg bg-surface-strip px-2.5 py-1.5">
        <TabsList className="h-8 bg-transparent">
          <TabsTrigger value="response" className={TAB}>Response</TabsTrigger>
          <TabsTrigger value="logs" className={TAB}>Logs</TabsTrigger>
          <TabsTrigger value="report" className={TAB}>Report</TabsTrigger>
          {checkResults != null && <TabsTrigger value="checks" className={TAB}>Checks</TabsTrigger>}
          {historyTab && <TabsTrigger value="history" className={TAB}>History</TabsTrigger>}
        </TabsList>
        {result && (
          <div className="ml-auto flex items-center gap-1.5">
            {result.ok && <HttpStatusBadge response={result.response} />}
            {checkResults != null && <ChecksSummaryBadge run={checkResults} />}
            <Badge
              variant={result.ok ? 'outline' : 'destructive'}
              className={cn(
                'font-mono tabular-nums text-[10px]',
                result.ok && 'border-transparent bg-success/15 text-success',
              )}
            >
              {result.ok ? 'OK' : result.error?.type ?? 'ERROR'}
              {' · '}{result.report.durationMs}ms
            </Badge>
          </div>
        )}
      </div>
      <TabsContent value="response" className="relative min-h-0 flex-1">
        {result?.ok
          ? (
            <>
              {responseJson != null && (
                <CopyButton
                  value={responseJson} label="Copy response JSON"
                  // Opaque, so rows scrolling under it stay legible.
                  className="absolute top-1.5 right-3 z-10 bg-background"
                />
              )}
              <ScrollArea className="h-full">
                {/* Re-keyed per invoke so the next response opens at its default
                    depth instead of inheriting the last one's expanded rows. */}
                <JsonTree key={result.report.requestId} value={result.response} className="pr-10" />
              </ScrollArea>
            </>
          )
          : (
            <Pane>
              {!result
                ? 'Invoke to see the response.'
                : `${result.error?.type}: ${result.error?.message}\n\n${(result.error?.stackTrace ?? []).join('\n')}`}
            </Pane>
          )}
      </TabsContent>
      <TabsContent value="logs" className="min-h-0 flex-1">
        {/* Re-keyed per invoke, like the response tree: rows are keyed by
            index, so without this an expanded structured entry would stay
            expanded over whatever landed at that index in the next run. */}
        <LogViewer key={result?.report.requestId ?? 'empty'} raw={result?.logs} />
      </TabsContent>
      <TabsContent value="report" className="min-h-0 flex-1">
        <Pane>
          {result
            ? `REPORT RequestId: ${result.report.requestId}\n` +
              `Duration: ${result.report.durationMs} ms\n` +
              `Billed Duration: ${result.report.billedMs} ms\n` +
              `Memory Size: ${result.report.memoryMb} MB\n` +
              (result.report.buildMs != null ? `Build Duration: ${result.report.buildMs} ms\n` : '') +
              (result.report.timedOut ? 'Status: TIMED OUT\n' : '')
            : 'No report yet.'}
        </Pane>
      </TabsContent>
      {checkResults != null && (
        <TabsContent value="checks" className="min-h-0 flex-1">
          <ChecksList run={checkResults} />
        </TabsContent>
      )}
      {historyTab && (
        <TabsContent value="history" className="min-h-0 flex-1">
          {historyTab}
        </TabsContent>
      )}
    </Tabs>
  )
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `cd web && npx vitest run src/components/result-panel.test.tsx`
Expected: PASS (15 tests)

- [ ] **Step 5: Commit**

```bash
git add web/src/components/result-panel.tsx web/src/components/result-panel.test.tsx
git commit -m "feat(web): add a Checks tab and summary chip to the result panel"
```

---

## Task 5: Wire it all together in `routes/index.tsx`

**Files:**
- Modify: `web/src/routes/index.tsx`

**Interfaces:**
- Consumes: `runAssertions`/`AssertionRun` from `web/src/lib/assertions.ts` (Task 1); `EventPanel`'s `canRunChecks`/`onRunChecks` props (Task 3); `ResultPanel`'s `checkResults` prop (Task 4).
- Produces: nothing further downstream — this is the final integration point.

There's no dedicated test file for `routes/index.tsx` (consistent with the rest of this file, which has none today) — this task is verified by the full suite, typecheck, and a manual smoke test.

- [ ] **Step 1: Re-add `activeAssertion`, add `checkResults`, and wire the handlers**

Replace the full contents of `web/src/routes/index.tsx` with:

```tsx
import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { toast } from 'sonner'
import { AddFunctionDialog } from '@/components/add-function-dialog'
import { AppSidebar } from '@/components/app-sidebar'
import { CommandPalette } from '@/components/command-palette'
import { EnvEditor } from '@/components/env-editor'
import { EventPanel } from '@/components/event-panel'
import { FunctionHeader } from '@/components/function-header'
import { HealthChips } from '@/components/health-chips'
import { HistoryList } from '@/components/history-list'
import { ResultPanel } from '@/components/result-panel'
import { ThemeToggle } from '@/components/theme-toggle'
import {
  ResizableHandle, ResizablePanel, ResizablePanelGroup,
} from '@/components/ui/resizable'
import { runAssertions, type AssertionRun } from '@/lib/assertions'
import { useFunctions, useInvoke, useSelectionSync } from '@/lib/queries'
import type { InvokeResult, SavedEvent } from '@/lib/types'

export const Route = createFileRoute('/')({
  component: App,
})

function App() {
  const { data: functions = [] } = useFunctions()
  // The user's explicit pick, if it's still in the list; otherwise fall back
  // to the first function. Deriving this during render (rather than via an
  // effect that corrects a stale/unset id after the fact) means a function
  // list that arrives or changes never renders a transient "nothing
  // selected" frame first.
  const [pinnedId, setPinnedId] = useState<string | null>(null)
  const selectedId = pinnedId && functions.some((f) => f.id === pinnedId)
    ? pinnedId
    : functions[0]?.id ?? null
  const [addOpen, setAddOpen] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [result, setResult] = useState<InvokeResult | null>(null)
  const [activeAssertion, setActiveAssertion] = useState<SavedEvent | null>(null)
  const [checkResults, setCheckResults] = useState<AssertionRun | null>(null)
  const invoke = useInvoke()
  const selectionSync = useSelectionSync()
  const syncSelection = selectionSync.mutate

  // Every path that changes the selection goes through here so the invoke
  // result from the previous function never bleeds into the next one.
  function selectFunction(id: string | null) {
    setPinnedId(id)
    setResult(null)
    setActiveAssertion(null)
    setCheckResults(null)
  }

  // A saved event's script is checked against a specific response — once
  // either one changes, a stale verdict would be misleading, so both are
  // cleared together and the button must be pressed again.
  function loadSavedEvent(saved: SavedEvent | null) {
    setActiveAssertion(saved)
    setCheckResults(null)
  }

  // Tell the server which function is active so playground.json services
  // auto-start on selection and auto-stop after the grace period.
  useEffect(() => {
    syncSelection(selectedId)
  }, [selectedId, syncSelection])

  const selected = functions.find((f) => f.id === selectedId) ?? null

  function runInvoke(functionId: string) {
    let event: unknown
    try {
      event = JSON.parse(drafts[functionId] ?? '{}')
    } catch {
      toast.error('Event is not valid JSON')
      return
    }
    invoke.mutate({ functionId, event }, {
      onSuccess: (r) => {
        setResult(r)
        setCheckResults(null)
      },
    })
  }

  function runChecks() {
    if (!activeAssertion?.assertionScript || !result) return
    setCheckResults(runAssertions(activeAssertion.assertionScript, {
      response: result.response, error: result.error, report: result.report,
    }))
  }

  const canRunChecks = !!activeAssertion?.assertionScript && !!result

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      if (target?.closest?.('[role="dialog"], [role="alertdialog"]')) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && selectedId) {
        e.preventDefault()
        runInvoke(selectedId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <h1 className="text-sm font-semibold">Lambda Playground</h1>
        <div className="flex items-center gap-3">
          <HealthChips />
          <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">⌘K</kbd>
          <ThemeToggle />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <AppSidebar functions={functions} selectedId={selectedId}
          onSelect={selectFunction} onAdd={() => setAddOpen(true)} />
        <main className="min-w-0 flex-1">
          {selected ? (
            <div className="flex h-full flex-col">
              <FunctionHeader fn={selected} onDeleted={() => selectFunction(null)} />
              <EnvEditor key={selected.id} fn={selected} />
              <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
                <ResizablePanel defaultSize={50} minSize={25}>
                  <EventPanel
                    fn={selected}
                    eventText={drafts[selected.id] ?? '{}'}
                    onEventTextChange={(text) =>
                      setDrafts((d) => ({ ...d, [selected.id]: text }))}
                    onInvoke={() => runInvoke(selected.id)}
                    invoking={invoke.isPending}
                    onLoadSavedEvent={loadSavedEvent}
                    canRunChecks={canRunChecks}
                    onRunChecks={runChecks}
                  />
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel defaultSize={50} minSize={25}>
                  <ResultPanel
                    result={result}
                    checkResults={checkResults}
                    historyTab={
                      <HistoryList
                        key={selected.id}
                        fnId={selected.id}
                        onLoadEvent={(text) =>
                          setDrafts((d) => ({ ...d, [selected.id]: text }))}
                      />
                    }
                  />
                </ResizablePanel>
              </ResizablePanelGroup>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
              <span className="font-mono text-5xl leading-none text-foreground/20">λ</span>
              <div className="space-y-1">
                <p className="text-sm font-medium">No functions yet</p>
                <p className="max-w-xs text-xs text-muted-foreground">
                  Register a Lambda handler to run it locally — no deploy, no Docker.
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Add one from the sidebar, or press{' '}
                <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>.
              </p>
            </div>
          )}
        </main>
      </div>
      <AddFunctionDialog open={addOpen} onOpenChange={setAddOpen} onCreated={selectFunction} />
      <CommandPalette
        functions={functions}
        canInvoke={!!selectedId}
        onSelect={selectFunction}
        onAdd={() => setAddOpen(true)}
        onInvoke={() => selectedId && runInvoke(selectedId)}
      />
    </div>
  )
}
```

- [ ] **Step 2: Run the full suite, typecheck, and lint**

Run: `cd web && npx vitest run && npx tsc --noEmit`
Expected: all tests pass, no type errors.

Run (from repo root): `npx oxlint --react-plugin .`
Expected: no new errors.

- [ ] **Step 3: Manual smoke test**

Run: `cd web && npm run dev`, open the app, pick (or create) a function:
1. Enter an event, click Save, type a name and the script `expect(response.statusCode).toBe(200)`, save it.
2. Invoke the function. Confirm "Run checks" is disabled until you load that saved event from the "Saved events…" dropdown.
3. With the saved event loaded and a result present, click "Run checks". Confirm the header shows a summary chip and the "Checks" tab lists the result.
4. Invoke again — confirm the chip/tab disappear until "Run checks" is pressed again.
5. Edit the script to something that fails (e.g. `toBe(404)`) and re-save; load it, run checks, confirm the row shows a failure with actual/expected values.

- [ ] **Step 4: Commit**

```bash
git add web/src/routes/index.tsx
git commit -m "feat(web): wire saved-event assertion scripts into the app"
```
