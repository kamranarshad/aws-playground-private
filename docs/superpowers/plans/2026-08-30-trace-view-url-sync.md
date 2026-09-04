# Trace View URL Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Trace tab's List/Timeline choice reflect in the URL (as `?tab=trace&traceView=timeline`), so it survives reload and is shareable, following the same URL-sync pattern the route already uses for the active result tab.

**Architecture:** `TraceTab` stops owning its view choice as local state and becomes a controlled component (`view`/`onViewChange` props). `ResultPanel` threads those props through from the route, exactly the way it already threads `activeTab`/`onActiveTabChange`. The route (`web/src/routes/index.tsx`) adds a `traceView` search param (only `'timeline'` is ever written; `'list'` is the implicit default/absence) plus a corrective effect that strips it from the URL whenever the active tab isn't `'trace'`, mirroring the existing Checks-tab-correction effect.

**Tech Stack:** React, TanStack Router (file-based routing, `validateSearch`, `Route.useSearch()`/`useNavigate()`), Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-30-trace-view-url-sync-design.md`

## Global Constraints

- `traceView` only ever appears in the URL as the literal string `'timeline'`; `'list'` is never written — its absence (or any other value) means list view.
- `traceView` must not appear in the URL unless `tab=trace` is also active; enforce this via a `replace` navigation effect (a passive correction), not inside `validateSearch` itself — `validateSearch` stays a simple per-field parser, matching how `tab` and `function` are already validated independently.
- Switching to `traceView=timeline` is a **push** navigation (new history entry), matching how clicking a result tab already behaves — not a `replace`.
- The chosen view persists across re-invokes on the same function (invoking again doesn't reset it to list). Switching functions already resets `tab` to `'response'` (pre-existing, unrelated to this feature) — `traceView` then clears too, as a consequence of the scoping effect in Task 3, not a new reset added by this feature.
- No changes to `TraceWaterfall`, `TracePanel`, or span data/layout.

---

### Task 1: Make `TraceTab` a controlled component

**Files:**
- Modify: `web/src/components/trace-tab.tsx`
- Test: `web/src/components/trace-tab.test.tsx`

**Interfaces:**
- Produces: `export type TraceView = 'list' | 'timeline'` (exported for the first time — Task 2 imports it). `TraceTab` becomes `TraceTab({ spans, view, onViewChange }: { spans: Span[]; view: TraceView; onViewChange: (view: TraceView) => void })`.

Current `web/src/components/trace-tab.tsx` in full:

```tsx
import { useState } from 'react'
import { TracePanel } from '@/components/trace-panel'
import { TraceWaterfall } from '@/components/trace-waterfall'
import { cn } from '@/lib/utils'
import type { Span } from '@/lib/types'

type TraceView = 'list' | 'timeline'

const VIEW_BUTTON =
  'rounded px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground data-[active=true]:bg-background data-[active=true]:text-foreground data-[active=true]:shadow-sm'

export function TraceTab({ spans }: { spans: Span[] }) {
  const [view, setView] = useState<TraceView>('list')

  return (
    <div className="flex h-full flex-col">
      <div className="flex justify-end gap-1 border-b px-2 py-1">
        <button
          type="button"
          data-active={view === 'list'}
          className={cn(VIEW_BUTTON)}
          onClick={() => setView('list')}
        >
          List
        </button>
        <button
          type="button"
          data-active={view === 'timeline'}
          className={cn(VIEW_BUTTON)}
          onClick={() => setView('timeline')}
        >
          Timeline
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {view === 'list' ? <TracePanel spans={spans} /> : <TraceWaterfall spans={spans} />}
      </div>
    </div>
  )
}
```

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `web/src/components/trace-tab.test.tsx` with:

```tsx
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import { TraceTab, type TraceView } from '@/components/trace-tab'
import type { Span } from '@/lib/types'

function span(overrides: Partial<Span> = {}): Span {
  return {
    traceId: 'aa', spanId: 'bb', parentSpanId: null, name: 'do-work',
    startTimeUnixNano: '1000000000', endTimeUnixNano: '1005000000',
    attributes: {}, ...overrides,
  }
}

function ControlledTraceTab({ spans, initialView = 'list' }: { spans: Span[]; initialView?: TraceView }) {
  const [view, setView] = useState<TraceView>(initialView)
  return <TraceTab spans={spans} view={view} onViewChange={setView} />
}

it('defaults to the list view', () => {
  render(<ControlledTraceTab spans={[span()]} />)
  // The list view renders duration text inline with the name; the
  // timeline view renders it only in a title attribute and the detail
  // panel, so this line existing as visible text is list-view-specific.
  expect(screen.getByText('5.00ms')).toBeInTheDocument()
})

it('switches to the timeline view and back', async () => {
  render(<ControlledTraceTab spans={[span()]} />)
  await userEvent.click(screen.getByRole('button', { name: 'Timeline' }))
  expect(screen.getByTestId('trace-bar-bb')).toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: 'List' }))
  expect(screen.queryByTestId('trace-bar-bb')).not.toBeInTheDocument()
  expect(screen.getByText('5.00ms')).toBeInTheDocument()
})

it('shows the shared empty state in either view', async () => {
  render(<ControlledTraceTab spans={[]} />)
  expect(screen.getByText(/No spans received/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Timeline' }))
  expect(screen.getByText(/No spans received/)).toBeInTheDocument()
})

it('renders whichever view the view prop names, without owning its own state', () => {
  const onViewChange = () => {}
  render(<TraceTab spans={[span()]} view="timeline" onViewChange={onViewChange} />)
  expect(screen.getByTestId('trace-bar-bb')).toBeInTheDocument()
})

it('calls onViewChange with the clicked view instead of switching itself', async () => {
  const seen: TraceView[] = []
  render(<TraceTab spans={[span()]} view="list" onViewChange={(v) => seen.push(v)} />)
  await userEvent.click(screen.getByRole('button', { name: 'Timeline' }))
  // The component is controlled: clicking Timeline reports the intent via
  // onViewChange but does not switch the rendered view itself, since `view`
  // prop stayed 'list' in this test (no state lifted here).
  expect(seen).toEqual(['timeline'])
  expect(screen.getByText('5.00ms')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix web run test -- trace-tab.test.tsx`
Expected: FAIL — `TraceTab` doesn't yet accept `view`/`onViewChange` props, and `TraceView` isn't exported.

- [ ] **Step 3: Update the implementation**

Replace the full contents of `web/src/components/trace-tab.tsx` with:

```tsx
import { TracePanel } from '@/components/trace-panel'
import { TraceWaterfall } from '@/components/trace-waterfall'
import { cn } from '@/lib/utils'
import type { Span } from '@/lib/types'

export type TraceView = 'list' | 'timeline'

const VIEW_BUTTON =
  'rounded px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground data-[active=true]:bg-background data-[active=true]:text-foreground data-[active=true]:shadow-sm'

export function TraceTab({ spans, view, onViewChange }: {
  spans: Span[]
  view: TraceView
  onViewChange: (view: TraceView) => void
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex justify-end gap-1 border-b px-2 py-1">
        <button
          type="button"
          data-active={view === 'list'}
          className={cn(VIEW_BUTTON)}
          onClick={() => onViewChange('list')}
        >
          List
        </button>
        <button
          type="button"
          data-active={view === 'timeline'}
          className={cn(VIEW_BUTTON)}
          onClick={() => onViewChange('timeline')}
        >
          Timeline
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {view === 'list' ? <TracePanel spans={spans} /> : <TraceWaterfall spans={spans} />}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix web run test -- trace-tab.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Typecheck**

Run: `npm --prefix web run typecheck`
Expected: FAILS at this point, specifically at the call site in `web/src/components/result-panel.tsx` (`<TraceTab ... spans={...} />` is now missing required `view`/`onViewChange` props) — this is expected and fixed in Task 2. Confirm the only error is that one call site, then proceed.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/trace-tab.tsx web/src/components/trace-tab.test.tsx
git commit -m "refactor(web): make TraceTab a controlled component"
```

---

### Task 2: Thread `traceView` through `ResultPanel`

**Files:**
- Modify: `web/src/components/result-panel.tsx`
- Test: `web/src/components/result-panel.test.tsx`

**Interfaces:**
- Consumes: `TraceTab` and `type TraceView` from `@/components/trace-tab` (Task 1).
- Produces: `ResultPanel` gains two new required props, `traceView: TraceView` and `onTraceViewChange: (view: TraceView) => void`, alongside its existing `activeTab`/`onActiveTabChange`. Task 3 (the route) passes these in.

- [ ] **Step 1: Write the failing test**

In `web/src/components/result-panel.test.tsx`, the `ControlledResultPanel` wrapper currently reads (line 12-15):

```tsx
function ControlledResultPanel(props: Omit<ComponentProps<typeof ResultPanel>, 'activeTab' | 'onActiveTabChange'>) {
  const [tab, setTab] = useState<ResultTab>('response')
  return <ResultPanel {...props} activeTab={tab} onActiveTabChange={setTab} />
}
```

Change it to also manage `traceView` locally, the same way it already manages `tab`:

```tsx
function ControlledResultPanel(props: Omit<ComponentProps<typeof ResultPanel>, 'activeTab' | 'onActiveTabChange' | 'traceView' | 'onTraceViewChange'>) {
  const [tab, setTab] = useState<ResultTab>('response')
  const [traceView, setTraceView] = useState<TraceView>('list')
  return <ResultPanel {...props} activeTab={tab} onActiveTabChange={setTab} traceView={traceView} onTraceViewChange={setTraceView} />
}
```

Add the import (alongside the existing `InvokeResult`/`ResultTab` import at the top of the file):

```tsx
import type { TraceView } from '@/components/trace-tab'
```

Then add this new test anywhere after the existing trace-related tests in the file (search the file for `withSpans` to find the existing trace test block and add this one near it):

```tsx
it('opens on the timeline view when traceView is controlled to "timeline"', async () => {
  const withSpans: InvokeResult = {
    ...ok,
    trace: {
      spans: [{
        traceId: 'aa', spanId: 'bb', parentSpanId: null, name: 'do-work',
        startTimeUnixNano: '1000000000', endTimeUnixNano: '1005000000', attributes: {},
      }],
    },
  }
  function ControlledAtTimeline() {
    const [tab, setTab] = useState<ResultTab>('trace')
    return (
      <ResultPanel
        result={withSpans} activeTab={tab} onActiveTabChange={setTab}
        traceView="timeline" onTraceViewChange={() => {}}
      />
    )
  }
  render(<ControlledAtTimeline />)
  expect(await screen.findByTestId('trace-bar-bb')).toBeInTheDocument()
})
```

(This mirrors whatever the existing `withSpans`/trace test in the file already does to build a result with spans — if the file already defines a `withSpans` constant near the top, reuse it instead of redefining one inline; check before adding a duplicate.)

- [ ] **Step 2: Run tests to verify the new test fails and existing ones still compile**

Run: `npm --prefix web run test -- result-panel.test.tsx`
Expected: FAIL on the new test (`ResultPanel` doesn't accept `traceView`/`onTraceViewChange` yet) — every other existing test in the file should still pass once Step 3 below lands, but at this exact point (before Step 3) TypeScript will also flag the whole file since `ResultPanel`'s props don't yet include `traceView`/`onTraceViewChange`. That's expected; proceed to Step 3.

- [ ] **Step 3: Update the implementation**

In `web/src/components/result-panel.tsx`:

Change the import on line 10 from:
```tsx
import { TraceTab } from '@/components/trace-tab'
```
to:
```tsx
import { TraceTab, type TraceView } from '@/components/trace-tab'
```

Change the `ResultPanel` function signature (currently lines 85-91):
```tsx
export function ResultPanel({ result, checkResults, historyTab, activeTab, onActiveTabChange }: {
  result: InvokeResult | null
  checkResults?: AssertionRun | null
  historyTab?: ReactNode
  activeTab: ResultTab
  onActiveTabChange: (tab: ResultTab) => void
}) {
```
to:
```tsx
export function ResultPanel({
  result, checkResults, historyTab, activeTab, onActiveTabChange, traceView, onTraceViewChange,
}: {
  result: InvokeResult | null
  checkResults?: AssertionRun | null
  historyTab?: ReactNode
  activeTab: ResultTab
  onActiveTabChange: (tab: ResultTab) => void
  traceView: TraceView
  onTraceViewChange: (view: TraceView) => void
}) {
```

Change the `TraceTab` render call (currently line 185):
```tsx
        <TraceTab key={result?.report.requestId ?? 'empty'} spans={result?.trace?.spans ?? []} />
```
to:
```tsx
        <TraceTab
          key={result?.report.requestId ?? 'empty'}
          spans={result?.trace?.spans ?? []}
          view={traceView}
          onViewChange={onTraceViewChange}
        />
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix web run test -- result-panel.test.tsx`
Expected: PASS (all existing tests plus the new one)

- [ ] **Step 5: Typecheck**

Run: `npm --prefix web run typecheck`
Expected: FAILS at this point, specifically at the call site in `web/src/routes/index.tsx` (`<ResultPanel ... />` is now missing required `traceView`/`onTraceViewChange` props) — expected, fixed in Task 3.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/result-panel.tsx web/src/components/result-panel.test.tsx
git commit -m "feat(web): thread a controlled traceView through ResultPanel"
```

---

### Task 3: URL-sync the Trace tab's view choice

**Files:**
- Modify: `web/src/routes/index.tsx`
- Test: `web/src/routes/index.test.tsx`

**Interfaces:**
- Consumes: `ResultPanel`'s new `traceView`/`onTraceViewChange` props (Task 2); `type TraceView` from `@/components/trace-tab` (Task 1).
- Produces: `validateSearch(search): { function?: string; tab?: ResultTab; traceView?: 'timeline' }` — the return type gains one field. Nothing outside this file consumes `validateSearch`'s return type by name, so this is not a breaking change to any other module.

- [ ] **Step 1: Write the failing tests**

In `web/src/routes/index.test.tsx`, add these after the existing `validateSearch` tests (after the `handles an empty search` test, before the `import { act, fireEvent, ... }` line):

```tsx
it('keeps traceView=timeline when present', () => {
  expect(validateSearch({ traceView: 'timeline' })).toEqual({ function: undefined, tab: undefined, traceView: 'timeline' })
})

it('drops any traceView value other than "timeline"', () => {
  expect(validateSearch({ traceView: 'list' })).toEqual({ function: undefined, tab: undefined, traceView: undefined })
  expect(validateSearch({ traceView: 'nope' })).toEqual({ function: undefined, tab: undefined, traceView: undefined })
})
```

(The five existing `validateSearch` tests in this file do not need editing: `toEqual` treats a missing key and an explicit `traceView: undefined` as equal, so their current expectations keep passing once `validateSearch` starts returning that field.)

Then, in the integration test section (after the `it('corrects the URL off the Checks tab ...)` test, so it sits alongside the other tab/URL tests), add:

```tsx
it('pushes traceView=timeline into the URL when Timeline is clicked on the Trace tab, and clears it when List is clicked', async () => {
  const router = await renderApp('/?function=order-lookup&tab=trace')
  await screen.findByRole('tab', { name: 'Trace' })
  const historyLenBefore = router.history.length

  await userEvent.click(screen.getByRole('button', { name: 'Timeline' }))

  expect(router.state.location.search.traceView).toBe('timeline')
  expect(router.history.length).toBe(historyLenBefore + 1)

  await userEvent.click(screen.getByRole('button', { name: 'List' }))

  expect(router.state.location.search.traceView).toBeUndefined()
})

it('opens directly on the timeline view when the URL already names it', async () => {
  await renderApp('/?function=order-lookup&tab=trace&traceView=timeline')

  expect(screen.getByRole('button', { name: 'Timeline' })).toHaveAttribute('data-active', 'true')
})

it('strips traceView from the URL (via replace) when navigating off the Trace tab', async () => {
  const router = await renderApp('/?function=order-lookup&tab=trace&traceView=timeline')
  await screen.findByRole('button', { name: 'Timeline' })
  const historyLenBefore = router.history.length

  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Report' }), { button: 0 })

  await waitFor(() => expect(router.state.location.search.traceView).toBeUndefined())
  // replace, not push: the correction must not add a Back-able history entry
  expect(router.history.length).toBe(historyLenBefore + 1) // +1 for the Report tab click itself, +0 more for the correction
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix web run test -- routes/index.test.tsx`
Expected: FAIL — `validateSearch` doesn't return `traceView` yet, and the Trace tab has no URL wiring yet, so clicking Timeline/List has no effect on `router.state.location.search`.

- [ ] **Step 3: Update the implementation**

In `web/src/routes/index.tsx`:

Add the import (alongside the existing `ResultTab` import on line 20):
```tsx
import { RESULT_TABS, type InvokeResult, type ResultTab } from '@/lib/types'
```
becomes:
```tsx
import { RESULT_TABS, type InvokeResult, type ResultTab } from '@/lib/types'
import type { TraceView } from '@/components/trace-tab'
```

Change `validateSearch` (currently lines 22-27):
```tsx
export function validateSearch(search: Record<string, unknown>): { function?: string; tab?: ResultTab } {
  return {
    function: typeof search.function === 'string' ? search.function : undefined,
    tab: RESULT_TABS.includes(search.tab as ResultTab) ? (search.tab as ResultTab) : undefined,
  }
}
```
to:
```tsx
export function validateSearch(search: Record<string, unknown>): { function?: string; tab?: ResultTab; traceView?: 'timeline' } {
  return {
    function: typeof search.function === 'string' ? search.function : undefined,
    tab: RESULT_TABS.includes(search.tab as ResultTab) ? (search.tab as ResultTab) : undefined,
    traceView: search.traceView === 'timeline' ? 'timeline' : undefined,
  }
}
```

Add the derived value and change handler right after the existing `activeTab`/`onActiveTabChange` block (currently lines 49-51):
```tsx
  const activeTab = search.tab ?? 'response'

  function onActiveTabChange(tab: ResultTab) {
    navigate({ search: (prev) => ({ ...prev, tab }) })
  }
```
becomes:
```tsx
  const activeTab = search.tab ?? 'response'

  function onActiveTabChange(tab: ResultTab) {
    navigate({ search: (prev) => ({ ...prev, tab }) })
  }
  const traceView: TraceView = search.traceView ?? 'list'

  function onTraceViewChange(view: TraceView) {
    navigate({ search: (prev) => ({ ...prev, traceView: view === 'timeline' ? 'timeline' : undefined }) })
  }
```

Add the corrective effect right after the existing Checks-tab-correction effect (currently lines 107-117):
```tsx
  // The Checks tab only exists while there are check results (see
  // ResultPanel): the next invoke or a function switch clears them, and
  // ResultPanel's own display already falls back to "Response" visually.
  // This corrects the URL to match — via replace, since it's a passive
  // consequence of state clearing, not a click, so it shouldn't add a
  // Back-able history entry.
  useEffect(() => {
    if (activeTab === 'checks' && checkResults == null) {
      navigate({ search: (prev) => ({ ...prev, tab: undefined }), replace: true })
    }
  }, [activeTab, checkResults, navigate])
```
add immediately after it:
```tsx

  // traceView is only meaningful while the Trace tab is active; leaving it
  // in the URL after switching away would let a stale value silently apply
  // the next time the Trace tab is reopened via the URL alone. Same
  // replace-not-push justification as the Checks-tab effect above.
  useEffect(() => {
    if (activeTab !== 'trace' && search.traceView) {
      navigate({ search: (prev) => ({ ...prev, traceView: undefined }), replace: true })
    }
  }, [activeTab, search.traceView, navigate])
```

Finally, find the `<ResultPanel ... />` call site (passing `result`, `checkResults`, `activeTab`, `onActiveTabChange`, `historyTab`) and add the two new props:
```tsx
                  <ResultPanel
                    result={result}
                    checkResults={checkResults}
                    activeTab={activeTab}
                    onActiveTabChange={onActiveTabChange}
                    traceView={traceView}
                    onTraceViewChange={onTraceViewChange}
                    historyTab={
```
(only the two new lines are added; everything else in that call site is unchanged).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix web run test -- routes/index.test.tsx`
Expected: PASS (all existing tests plus the 5 new ones)

- [ ] **Step 5: Run the full web test suite and typecheck**

Run: `npm --prefix web run test`
Expected: PASS, all files (this is the task that resolves the two intentionally-broken typechecks left dangling by Tasks 1 and 2)

Run: `npm --prefix web run typecheck`
Expected: clean, no errors

- [ ] **Step 6: Commit**

```bash
git add web/src/routes/index.tsx web/src/routes/index.test.tsx
git commit -m "feat(web): sync the Trace tab's List/Timeline choice to the URL"
```
