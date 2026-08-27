# URL State Sync (function + tab) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reflect the selected function and the active result tab in the URL (`?function=<name>&tab=<tab>`) on the playground's `/` route, so both are linkable, bookmarkable, and Back/Forward-able.

**Architecture:** Use TanStack Router's native search-param API (`validateSearch`, `Route.useSearch()`, `Route.useNavigate()`) already used throughout this app. `App` (the `/` route's component) stops holding `pinnedId`/`activeTab` in local `useState` and instead derives both from `Route.useSearch()`, writing changes back via `navigate({ search })`. `ResultPanel`'s tab state is lifted from an internal `useState` to a controlled prop pair (`activeTab`/`onActiveTabChange`).

**Tech Stack:** React 19, TanStack Router 1.168 (`@tanstack/react-router`), TanStack Query 5, Vitest 3 + Testing Library, TypeScript 5.9.

**Spec:** `docs/superpowers/specs/2026-08-27-url-state-sync-design.md`

## Global Constraints

- Scope is the `/` route only (`web/src/routes/index.tsx`). `/services` is untouched.
- `function` search param holds the function's `name` (not `id`).
- `tab` search param is one of `response | logs | report | checks | history`.
- Explicit clicks (selecting a function, selecting a tab) **push** a new history entry — use the default `navigate({ search })`, not `{ replace: true }`.
- The one exception: when `checkResults` clears while `tab=checks` is active, the URL corrects itself to drop `tab` via `navigate({ search, replace: true })` — a passive correction, not a click.
- Nothing writes a default `function`/`tab` into the URL on initial load — the URL stays bare until the user clicks something.
- An unresolvable `function` name in the URL (renamed/deleted/typo) falls back to `functions[0]` silently; the URL is not rewritten to "fix" it.
- Existing child component prop contracts (`AppSidebar.onSelect(id)`, `CommandPalette.onSelect(id)`, `AddFunctionDialog.onCreated(id)`, `FunctionHeader.onDeleted()`) stay id-based — only `App`'s internal `selectFunction` translates id ↔ name at the URL boundary. Do not change these child components' prop signatures.

---

## Background for the implementer: the test harness

`web/src/routes/index.tsx`'s `App` component isn't currently covered by any test — this plan is the first thing to test it. `App` needs a real TanStack Router context to call `Route.useSearch()`/`Route.useNavigate()`, so tests need an actual router, not just React Testing Library's plain `render()`.

Two things were verified by hand before writing this plan (do not re-litigate them; just use them):

1. **Do not render the real `web/src/routes/__root.tsx`** in tests (e.g. via `getRouter()` from `web/src/router.tsx`). That root renders a full `<html><head><body>` SSR document shell (for TanStack Start). Nested inside React Testing Library's own container `<div>` (which is already inside the real jsdom `<body>`), it produces a duplicate `<body>` in the document — rendering itself succeeds, but any click anywhere in the tree afterward never resolves (the test hangs until timeout, no error). Confirmed by direct experiment: identical test code hung with the real root and completed in ~200ms with a bare test root.
2. **Build a from-scratch bare root + route in each test** (not the file-bound `Route` export from `index.tsx`) — reparenting the file-bound `Route` onto a different root throws `Invariant failed: Duplicate routes found with id: __root__`. Build a fresh `createRoute({ getParentRoute: () => rootRoute, path: '/', validateSearch, component: App })` per test instead, importing the real `App` and `validateSearch` (both need to be named exports from `index.tsx` — Task 1 adds this). `Route.useSearch()`/`Route.useNavigate()` called *inside* `App` still resolve correctly against this separately-built tree: they key off the route id (`"/"`) at render time via context, not the object identity of the `Route` export.

Task 2 below builds this into a shared harness module so later tasks reuse it rather than re-deriving it.

---

### Task 1: Extract `validateSearch` and export `App`

**Files:**
- Modify: `web/src/routes/index.tsx`
- Test: `web/src/routes/index.test.tsx` (new)

**Interfaces:**
- Produces: `export type ResultTab = 'response' | 'logs' | 'report' | 'checks' | 'history'`
- Produces: `export function validateSearch(search: Record<string, unknown>): { function?: string; tab?: ResultTab }`
- Produces: `export function App()` (was a local, unexported `function App()`)

- [ ] **Step 1: Write the failing test**

Create `web/src/routes/index.test.tsx`:

```tsx
import { expect, it } from 'vitest'
import { validateSearch } from '@/routes/index'

it('keeps a string function name from the URL', () => {
  expect(validateSearch({ function: 's3-handler' })).toEqual({ function: 's3-handler', tab: undefined })
})

it('drops a non-string function value', () => {
  expect(validateSearch({ function: 42 })).toEqual({ function: undefined, tab: undefined })
})

it('keeps a recognized tab value', () => {
  expect(validateSearch({ tab: 'logs' })).toEqual({ function: undefined, tab: 'logs' })
})

it('drops an unrecognized tab value', () => {
  expect(validateSearch({ tab: 'nope' })).toEqual({ function: undefined, tab: undefined })
})

it('handles an empty search', () => {
  expect(validateSearch({})).toEqual({ function: undefined, tab: undefined })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web run test -- run src/routes/index.test.tsx`
Expected: FAIL — `validateSearch` is not exported from `@/routes/index` (module has no such export).

- [ ] **Step 3: Implement `validateSearch` and export `App`**

In `web/src/routes/index.tsx`, replace:

```tsx
export const Route = createFileRoute('/')({
  component: App,
})

function App() {
```

with:

```tsx
export type ResultTab = 'response' | 'logs' | 'report' | 'checks' | 'history'
const RESULT_TABS: ResultTab[] = ['response', 'logs', 'report', 'checks', 'history']

export function validateSearch(search: Record<string, unknown>): { function?: string; tab?: ResultTab } {
  return {
    function: typeof search.function === 'string' ? search.function : undefined,
    tab: RESULT_TABS.includes(search.tab as ResultTab) ? (search.tab as ResultTab) : undefined,
  }
}

export const Route = createFileRoute('/')({
  component: App,
  validateSearch,
})

export function App() {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix web run test -- run src/routes/index.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/index.tsx web/src/routes/index.test.tsx
git commit -m "feat(web): validate function/tab search params on the playground route"
```

---

### Task 2: Build the shared route test harness, and derive `selectedId` from the URL

**Files:**
- Create: `web/src/test/route-harness.tsx`
- Modify: `web/src/test/setup.ts`
- Modify: `web/src/routes/index.tsx`
- Test: `web/src/routes/index.test.tsx`

**Interfaces:**
- Consumes: `App`, `validateSearch` from `@/routes/index` (Task 1)
- Produces: `export async function renderApp(initialEntry: string)` from `web/src/test/route-harness.tsx` — mounts the real `App` under a bare test root at the given URL and returns the live router (return type left inferred from `createRouter(...)`; no explicit type export needed since every consumer just calls `.history`/`.state` on the returned value).
- Produces (in `App`): `selectedId` is now derived from `Route.useSearch()` + `functions`, not a `pinnedId` local state.

- [ ] **Step 1: Add the jsdom `matchMedia` stub to test setup**

In `web/src/test/setup.ts`, add (matching the file's existing style of stubbing missing jsdom APIs, e.g. the `ResizeObserver` stub above it):

```ts
// jsdom has no matchMedia. Rendering `App` through a real router (the route
// test harness) ends up exercising something in the tree that reads it on
// mount — without a stub the render silently produces an empty document
// instead of the app (no thrown error to point at the cause).
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}
```

- [ ] **Step 2: Write the failing test for URL-driven selection**

Add to `web/src/routes/index.test.tsx`, merging `vi` into the existing `import { expect, it } from 'vitest'` line from Task 1 (so it reads `import { expect, it, vi } from 'vitest'`):

```tsx
import { screen } from '@testing-library/react'

vi.mock('@/lib/api', () => ({
  api: {
    health: vi.fn(async () => ({ runtimes: {} })),
    listFunctions: vi.fn(async () => ({
      functions: [
        { id: 'fn-1', name: 'order-lookup', path: '/tmp', runtime: 'node', handler: 'index.handler', timeoutMs: 3000, memoryMb: 128, jarPath: null, env: {}, envFile: '', buildCommand: '', localServices: [], trigger: null, savedEvents: [] },
        { id: 'fn-2', name: 's3-handler', path: '/tmp2', runtime: 'python', handler: 'index.handler', timeoutMs: 3000, memoryMb: 128, jarPath: null, env: {}, envFile: '', buildCommand: '', localServices: [], trigger: null, savedEvents: [] },
      ],
    })),
    setSelection: vi.fn(async () => ({})),
    listServices: vi.fn(async () => ({ services: [], docker: { available: false } })),
    listTriggerStatus: vi.fn(async () => ({})),
    detect: vi.fn(async () => ({ envFiles: [], projectTrigger: null })),
    listHistory: vi.fn(async () => ({ entries: [] })),
    deleteFunction: vi.fn(async () => ({})),
  },
}))

import { renderApp } from '@/test/route-harness'

it('selects the function named in the URL on load', async () => {
  await renderApp('/?function=s3-handler')

  expect(await screen.findByRole('heading', { name: 's3-handler' })).toBeInTheDocument()
})

it('falls back to the first function when the URL names one that does not exist', async () => {
  await renderApp('/?function=does-not-exist')

  expect(await screen.findByRole('heading', { name: 'order-lookup' })).toBeInTheDocument()
})

it('falls back to the first function when the URL has no function param', async () => {
  await renderApp('/')

  expect(await screen.findByRole('heading', { name: 'order-lookup' })).toBeInTheDocument()
})
```

(`FunctionHeader` renders the selected function's name as an `<h2>` — confirm with `npm --prefix web run test -- run src/routes/index.test.tsx` after Step 4 that `getByRole('heading', { name: ... })` matches it; `web/src/components/function-header.tsx:` renders `<h2 className="truncate text-sm font-semibold">{fn.name}</h2>`.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npm --prefix web run test -- run src/routes/index.test.tsx`
Expected: FAIL — `@/test/route-harness` does not exist yet.

- [ ] **Step 4: Create the shared harness**

Create `web/src/test/route-harness.tsx`:

```tsx
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { App, validateSearch } from '@/routes/index'

// Deliberately not the real `web/src/routes/__root.tsx` (via `getRouter()`
// from `@/router`): that root renders a full <html><head><body> shell for
// TanStack Start's SSR. Nested inside RTL's own container div, that
// produces a duplicate <body> — the render succeeds but every click
// afterward silently never resolves. This bare root sidesteps that.
//
// Also deliberately not the file-bound `Route` export from `@/routes/index`:
// reparenting it onto a different root throws "Duplicate routes found with
// id: __root__". A fresh `createRoute` reusing the real `App` and
// `validateSearch` avoids that — `Route.useSearch()`/`Route.useNavigate()`
// inside `App` still resolve correctly here, keyed by route id ("/"), not
// by the object identity of the original `Route` export.
export async function renderApp(initialEntry: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({
    component: () => <QueryClientProvider client={qc}><Outlet /></QueryClientProvider>,
  })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch,
    component: App,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  await router.load()
  render(<RouterProvider router={router} />)
  return router
}
```

- [ ] **Step 5: Run test to verify it still fails, for the right reason**

Run: `npm --prefix web run test -- run src/routes/index.test.tsx`
Expected: The 3 new tests FAIL because `App` still selects via `pinnedId` local state (ignores the URL) rather than reading `Route.useSearch()`. The 5 `validateSearch` tests from Task 1 still PASS.

- [ ] **Step 6: Derive `selectedId` from the URL in `App`**

In `web/src/routes/index.tsx`, inside `App`, replace:

```tsx
export function App() {
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
```

with:

```tsx
export function App() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { data: functions = [] } = useFunctions()
  // The URL's pick, if it's still in the list; otherwise fall back to the
  // first function. Deriving this during render (rather than via an effect
  // that corrects a stale/unset id after the fact) means a function list
  // that arrives or changes never renders a transient "nothing selected"
  // frame first. A `function` param that doesn't match anything (renamed,
  // deleted, typo'd) falls back silently — the URL is not rewritten to
  // "fix" it.
  const selectedId = (search.function && functions.find((f) => f.name === search.function)?.id)
    ?? functions[0]?.id
    ?? null
```

`selectFunction` still takes an `id: string | null` (unchanged signature — every caller stays id-based per this plan's global constraints) but now needs to translate to a name and navigate instead of calling `setPinnedId`. Replace:

```tsx
  // Every path that changes the selection goes through here so the invoke
  // result from the previous function never bleeds into the next one.
  function selectFunction(id: string | null) {
    setPinnedId(id)
    setResult(null)
    setCheckResults(null)
    setCurrentScript('')
  }
```

with:

```tsx
  // Every path that changes the selection goes through here so the invoke
  // result from the previous function never bleeds into the next one.
  function selectFunction(id: string | null) {
    const name = id ? functions.find((f) => f.id === id)?.name : undefined
    navigate({ search: (prev) => ({ ...prev, function: name, tab: undefined }) })
    setResult(null)
    setCheckResults(null)
    setCurrentScript('')
  }
```

Also remove `useState` from the `react` import if it's no longer used for anything else in the file — it still is (`addOpen`, `drafts`, `result`, `checkResults`, `currentScript` all remain `useState`), so leave the import as-is; only `pinnedId`'s own `useState` call is removed.

- [ ] **Step 7: Run test to verify it passes**

Run: `npm --prefix web run test -- run src/routes/index.test.tsx`
Expected: PASS (8 tests: 5 from Task 1 + 3 new)

- [ ] **Step 8: Run the full web test suite to check for regressions**

Run: `npm --prefix web run test`
Expected: PASS. (No other test renders `App`, so no other suite should be affected yet.)

- [ ] **Step 9: Commit**

```bash
git add web/src/test/route-harness.tsx web/src/test/setup.ts web/src/routes/index.tsx web/src/routes/index.test.tsx
git commit -m "feat(web): select the function named in the URL's function param"
```

---

### Task 3: Clicking a function pushes its name into the URL

**Files:**
- Modify: `web/src/routes/index.tsx` (no production code change expected — `selectFunction` from Task 2 already navigates; this task is test coverage plus verifying the push-not-replace behavior)
- Test: `web/src/routes/index.test.tsx`

**Interfaces:**
- Consumes: `renderApp` from `@/test/route-harness` (Task 2)
- Consumes: `router.history.length` (public TanStack Router API — reflects push/replace: `pushState` grows it, `replaceState` does not) and `router.state.location.search` / `router.state.location.href`

- [ ] **Step 1: Write the failing test**

Add to `web/src/routes/index.test.tsx`, merging `fireEvent` into the existing `import { screen } from '@testing-library/react'` line from Task 2 (so it reads `import { fireEvent, screen } from '@testing-library/react'`):

```tsx
it('pushes the clicked function\'s name into the URL as a new history entry', async () => {
  const router = await renderApp('/')
  await screen.findByText('s3-handler')
  const historyLenBefore = router.history.length

  fireEvent.click(screen.getByText('s3-handler'))

  expect(await screen.findByRole('heading', { name: 's3-handler' })).toBeInTheDocument()
  expect(router.state.location.search).toEqual({ function: 's3-handler', tab: undefined })
  expect(router.history.length).toBe(historyLenBefore + 1)
})

it('clears the function param when the selected function is deleted', async () => {
  const router = await renderApp('/?function=s3-handler')
  await screen.findByRole('heading', { name: 's3-handler' })

  // FunctionHeader (web/src/components/function-header.tsx) puts the
  // delete trigger behind an AlertDialog: an icon-only button labeled via
  // aria-label "Delete function" opens it, and the confirm action's visible
  // text is "Delete" ("Deleting…" while pending).
  fireEvent.click(screen.getByRole('button', { name: 'Delete function' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

  await screen.findByRole('heading', { name: 'order-lookup' })
  expect(router.state.location.search.function).toBeUndefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web run test -- run src/routes/index.test.tsx`
Expected: Both new tests FAIL if `selectFunction`'s navigate call is missing or wrong — but per Task 2 Step 6, `selectFunction` already navigates. Run this first to confirm whether it already passes (Task 2's change may already satisfy this task) or reveals a gap (e.g. `tab: undefined` not included, or delete's `onDeleted={() => selectFunction(null)}` in `web/src/routes/index.tsx` not wired — check the JSX still has `onDeleted={() => selectFunction(null)}` on `<FunctionHeader>`, unchanged from before Task 2).

- [ ] **Step 3: Fix any gap found**

If the delete test fails because `search.function` isn't cleared: confirm `<FunctionHeader fn={selected} onDeleted={() => selectFunction(null)} />` is still present unchanged in the JSX (Task 2 didn't touch this line — only the `selectFunction` function body changed). If it's missing or was accidentally altered, restore it.

If the click test fails on `tab: undefined` not being present in `search`: this is expected shape per `selectFunction`'s `navigate({ search: (prev) => ({ ...prev, function: name, tab: undefined }) })` from Task 2 — TanStack Router strips `undefined` values when building the href but the in-memory `search` object on `router.state.location.search` may or may not include the literal key depending on version behavior. If the equality check is too strict, relax it to `expect(router.state.location.search.function).toBe('s3-handler')` and `expect(router.state.location.search.tab).toBeUndefined()` instead of one `toEqual` — prefer this looser form if the first run shows a mismatch only in whether the `tab` key is present vs. absent, not in its value.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix web run test -- run src/routes/index.test.tsx`
Expected: PASS (10 tests total)

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/index.tsx web/src/routes/index.test.tsx
git commit -m "test(web): cover URL push/clear behavior when selecting or deleting a function"
```

---

### Task 4: Lift the result tab to a controlled prop, driven by the URL

**Files:**
- Modify: `web/src/components/result-panel.tsx`
- Modify: `web/src/components/result-panel.test.tsx`
- Modify: `web/src/routes/index.tsx`
- Test: `web/src/routes/index.test.tsx`

**Interfaces:**
- Produces (in `ResultPanel`): new required props `activeTab: string` and `onActiveTabChange: (tab: string) => void`, replacing the internal `useState('response')`.
- Produces (in `App`): `activeTab` derived from `search.tab ?? 'response'`, passed into `ResultPanel`; a new `onActiveTabChange` handler that navigates.

- [ ] **Step 1: Update `ResultPanel` to accept controlled tab props**

In `web/src/components/result-panel.tsx`, change the import line (remove `useState` if nothing else in the file needs it — check first: `useMemo` is also imported and still used, so just drop `useState` from that import if it becomes unused) and the component signature:

```tsx
import { useMemo, type ReactNode } from 'react'
```

```tsx
export function ResultPanel({ result, checkResults, historyTab, activeTab, onActiveTabChange }: {
  result: InvokeResult | null
  checkResults?: AssertionRun | null
  historyTab?: ReactNode
  activeTab: string
  onActiveTabChange: (tab: string) => void
}) {
```

Remove the line `const [activeTab, setActiveTab] = useState('response')`.

Change the `Tabs` element's `onValueChange` from `setActiveTab` to `onActiveTabChange`:

```tsx
    <Tabs
      value={activeTab === 'checks' && checkResults == null ? 'response' : activeTab}
      onValueChange={onActiveTabChange}
      className="flex h-full flex-col gap-0"
    >
```

Everything else in the file (the fallback display logic on `value`, the `TabsContent` blocks) stays exactly as-is.

- [ ] **Step 2: Run the existing `result-panel.test.tsx` to see it fail**

Run: `npm --prefix web run test -- run src/components/result-panel.test.tsx`
Expected: FAIL — every test that renders `<ResultPanel result={...} />` without `activeTab`/`onActiveTabChange` now has a broken/no-op `Tabs` (clicking a tab does nothing, since there's no state to change and no handler wired). Tests that click a tab and assert on its content (e.g. `'reports build duration separately from handler duration'`, `'renders logs as parsed rows...'`, the Checks-tab tests, and the `rerender`-based fallback test) will fail.

- [ ] **Step 3: Add a controlled wrapper to the test file and use it everywhere**

In `web/src/components/result-panel.test.tsx`, add near the top (after imports, before the first `it`):

```tsx
import { useState } from 'react'
import type { ComponentProps } from 'react'

function ControlledResultPanel(props: Omit<ComponentProps<typeof ResultPanel>, 'activeTab' | 'onActiveTabChange'>) {
  const [tab, setTab] = useState('response')
  return <ResultPanel {...props} activeTab={tab} onActiveTabChange={setTab} />
}
```

Then replace every `<ResultPanel` occurrence in this file with `<ControlledResultPanel` (19 occurrences as of this plan's writing — confirm the current count with `grep -c "<ResultPanel" web/src/components/result-panel.test.tsx` since it's plain textual substitution: same props, same closing, just the tag name changes). This covers both the plain `render(<ResultPanel ... />)` calls and the one `const { rerender } = render(<ResultPanel ... />)` plus its matching `rerender(<ResultPanel ... />)` call. The `rerender` call (in `'falls back to the Response tab when the Checks tab disappears mid-selection'`) becomes `rerender(<ControlledResultPanel result={ok} checkResults={null} />)` — the wrapper's own `useState('response')` persists across that rerender exactly like the old internal state did (it's the same component instance), so the test's behavior is unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix web run test -- run src/components/result-panel.test.tsx`
Expected: PASS (all pre-existing tests, unchanged assertions)

- [ ] **Step 5: Wire `App` to pass `activeTab`/`onActiveTabChange` and write the URL-driven tab test**

Add to `web/src/routes/index.test.tsx`:

```tsx
it('selects the tab named in the URL on load', async () => {
  await renderApp('/?function=order-lookup&tab=logs')

  expect(await screen.findByRole('tab', { name: 'Logs' })).toHaveAttribute('aria-selected', 'true')
})

it('pushes the clicked tab into the URL as a new history entry', async () => {
  const router = await renderApp('/?function=order-lookup')
  await screen.findByRole('tab', { name: 'Report' })
  const historyLenBefore = router.history.length

  fireEvent.click(screen.getByRole('tab', { name: 'Report' }))

  expect(router.state.location.search.tab).toBe('report')
  expect(router.history.length).toBe(historyLenBefore + 1)
})
```

- [ ] **Step 6: Run to verify these two fail**

Run: `npm --prefix web run test -- run src/routes/index.test.tsx`
Expected: FAIL — `App` doesn't pass `activeTab`/`onActiveTabChange` to `ResultPanel` yet (this is now a TypeScript error too: `ResultPanel` requires those props). Confirm with `npm --prefix web run typecheck` that it reports the missing props on the `<ResultPanel ... />` usage in `index.tsx`.

- [ ] **Step 7: Wire `App`**

In `web/src/routes/index.tsx`, add after the `selectedId` derivation (from Task 2):

```tsx
  const activeTab = search.tab ?? 'response'

  function onActiveTabChange(tab: string) {
    navigate({ search: (prev) => ({ ...prev, tab: tab as ResultTab }) })
  }
```

And update the `<ResultPanel>` usage:

```tsx
                <ResultPanel
                  result={result}
                  checkResults={checkResults}
                  activeTab={activeTab}
                  onActiveTabChange={onActiveTabChange}
                  historyTab={
```

(keep the rest of that block — `historyTab={...}` and its closing — unchanged).

- [ ] **Step 8: Run tests and typecheck**

Run: `npm --prefix web run test -- run src/routes/index.test.tsx`
Expected: PASS (12 tests total: 5 from Task 1 + 3 from Task 2 + 2 from Task 3 + 2 new)

Run: `npm --prefix web run typecheck`
Expected: no errors

- [ ] **Step 9: Run the full web test suite**

Run: `npm --prefix web run test`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add web/src/components/result-panel.tsx web/src/components/result-panel.test.tsx web/src/routes/index.tsx web/src/routes/index.test.tsx
git commit -m "feat(web): drive the result tab from the URL's tab param"
```

---

### Task 5: Correct the URL when the Checks tab disappears

**Files:**
- Modify: `web/src/routes/index.tsx`
- Test: `web/src/routes/index.test.tsx`

**Interfaces:**
- Consumes: `activeTab`, `checkResults`, `navigate` (all already present in `App` after Task 4)

- [ ] **Step 1: Write the failing test**

The effect being tested fires whenever `activeTab === 'checks' && checkResults == null` — that condition is true on a fresh page load with `?tab=checks` in the URL (before any invoke has ever run, `checkResults` is `null`), so the test doesn't need to drive a real invoke or type into the assertion-script editor to exercise it — loading straight into that state covers the same branch in `App`'s effect:

Add to `web/src/routes/index.test.tsx`:

```tsx
it('corrects the URL off the Checks tab (via replace) when there are no check results', async () => {
  const router = await renderApp('/?function=order-lookup&tab=checks')
  const historyLenBefore = router.history.length

  await screen.findByRole('tab', { name: 'Response' })

  expect(router.state.location.search.tab).toBeUndefined()
  // replace, not push: the correction must not add a Back-able history entry
  expect(router.history.length).toBe(historyLenBefore)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web run test -- run src/routes/index.test.tsx`
Expected: FAIL — no effect exists yet to correct the URL.

- [ ] **Step 3: Implement the correction effect**

In `web/src/routes/index.tsx`, `App` needs `useEffect` (already imported). Add, near the existing `useEffect` that calls `syncSelection`:

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

Place this after `checkResults` and `activeTab` are both defined (i.e. after the `const activeTab = search.tab ?? 'response'` line from Task 4, and after `const [checkResults, setCheckResults] = useState<AssertionRun | null>(null)` which already exists earlier in the file).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix web run test -- run src/routes/index.test.tsx`
Expected: PASS (13 tests total: 12 from Task 4 + 1 new)

- [ ] **Step 5: Run the full web test suite**

Run: `npm --prefix web run test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/src/routes/index.tsx web/src/routes/index.test.tsx
git commit -m "fix(web): correct the URL off the Checks tab when results clear"
```

---

### Task 6: Final verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm run test` (from the repo root — runs both `test:server` and `test:web`)
Expected: PASS, no regressions anywhere.

- [ ] **Step 2: Typecheck**

Run: `npm --prefix web run typecheck`
Expected: no errors

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors

- [ ] **Step 4: Manual smoke test**

Run: `npm run dev` (starts the web dev server), open `http://localhost:3000` in a browser:
- Confirm the URL is bare (`http://localhost:3000/`) on first load.
- Click a function in the sidebar — confirm the URL updates to `?function=<name>`.
- Click a result tab (e.g. Logs) — confirm the URL updates to add `&tab=logs`.
- Click Back — confirm it steps back through the tab click, then the function click.
- Copy the URL with `?function=<name>&tab=<tab>`, open it in a new tab — confirm it loads with that function and tab selected.
- Run an invoke with a check script typed in, click the Checks tab, then run another invoke without a script — confirm the tab falls back to Response and the URL's `tab` param is gone, and confirm Back does *not* land on a "tab=checks" URL (i.e. the correction didn't get pushed).

Report the outcome of each bullet above explicitly — this is a UI behavior change, so passing tests alone don't confirm it; note here if a shell/environment lacks a way to open a browser, do not assume this step passed.

- [ ] **Step 5: No commit for this task** (verification only; if Step 4 finds a bug, fix it, add/adjust a test in the relevant earlier task's test file, and commit that fix with a message describing the bug, not this task).

---

## Self-Review Notes

- **Spec coverage:** URL shape (`?function=&tab=`) — Tasks 1, 2, 4. Push on explicit click — Tasks 3, 4 (asserted via `router.history.length`). Replace-only correction for the Checks tab — Task 5. Bare URL on initial load — Task 2 (nothing writes defaults back; implicitly covered by every test that loads `/` with no params and asserts on rendered content, not on `search` equaling a default). Stale `function` param falls back silently — Task 2, Step 2's second test. Existing call sites (`CommandPalette`, `AddFunctionDialog`) needing no changes — covered by the Global Constraints section keeping their signatures id-based; no dedicated task needed since `selectFunction`'s signature is unchanged.
- **Placeholder scan:** none found — every step has concrete code. Task 5's test was rewritten during self-review to avoid driving a full invoke + assertion-script flow (which would have needed unverified CodeMirror interaction inside the route harness); it instead loads directly into the state the effect's condition checks (`activeTab === 'checks' && checkResults == null`), which a fresh `?tab=checks` load satisfies without any invoke.
- **Type consistency:** `selectFunction(id: string | null)` (Task 2) matches its existing callers (`onSelect={selectFunction}` on `AppSidebar`, `onSelect={selectFunction}` on `CommandPalette`, `onCreated={selectFunction}` on `AddFunctionDialog`, `onDeleted={() => selectFunction(null)}` on `FunctionHeader`) — none of those call sites change. `ResultTab` (Task 1) is reused as the cast target in both `selectFunction`'s `tab: undefined` (Task 2) and `onActiveTabChange`'s `tab as ResultTab` (Task 4). `ResultPanel`'s new `activeTab: string` / `onActiveTabChange: (tab: string) => void` props (Task 4) match how `App` calls them (Task 4, Step 7).
