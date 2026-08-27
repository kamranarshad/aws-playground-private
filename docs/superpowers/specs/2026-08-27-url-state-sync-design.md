# URL state sync for function selection and result tab

## Problem

On the main playground page (`/`), the selected function and the active
result tab (Response/Logs/Report/Checks/History) live only in component
state. Neither is reflected in the URL, so there's no way to link to,
bookmark, or use browser Back/Forward to move between a specific function
and tab.

## Scope

The `/` route only. Two pieces of state move into URL search params:

- `function` — the selected function's `name`
- `tab` — the active result tab: `response` | `logs` | `report` | `checks`
  | `history`

`/services` is out of scope — it has no comparable selection/tab state, only
free-text search and multi-select checkboxes.

## URL shape

```
http://localhost:3000/?function=s3&tab=history
```

Both params are optional and independent. Neither is written to the URL
until the user actually clicks something (see "Bare URL by default" below).

## Mechanism

Use TanStack Router's native search-param API (`validateSearch`,
`Route.useSearch()`, `navigate({ search })`) rather than raw
`URLSearchParams` or a manual `popstate` listener — it's the router already
in use throughout this app, and gives typed/validated search state plus
history handling for free. No new dependency (no zod): `validateSearch` is
a small plain function.

### `web/src/routes/index.tsx`

- Add `validateSearch` to the route definition:
  ```ts
  type ResultTab = 'response' | 'logs' | 'report' | 'checks' | 'history'
  const TABS: ResultTab[] = ['response', 'logs', 'report', 'checks', 'history']

  function validateSearch(search: Record<string, unknown>) {
    return {
      function: typeof search.function === 'string' ? search.function : undefined,
      tab: TABS.includes(search.tab as ResultTab) ? (search.tab as ResultTab) : undefined,
    }
  }
  ```
- `App` reads `Route.useSearch()` in place of the current `pinnedId`
  `useState`. The effective selected function is derived each render:
  `search.function` → match by `name` in the functions list → else fall
  back to `functions[0]`, preserving today's fallback behavior (a function
  list that arrives or changes never renders a transient "nothing selected"
  frame first).
- `activeTab` is derived from `search.tab ?? 'response'` and passed into
  `ResultPanel` as a controlled prop (see below), replacing `ResultPanel`'s
  internal `useState('response')`.
- `selectFunction(name)` (renamed from the current id-based version) calls
  `navigate({ search: (prev) => ({ ...prev, function: name, tab: undefined }) })`
  — selecting a function already clears `result`/`checkResults`/script draft
  today, so the tab resets to the default (`response`) alongside them.
- A new tab-change handler calls
  `navigate({ search: (prev) => ({ ...prev, tab }) })`.
- Default `navigate` calls **push** a new history entry. This is
  intentional: every explicit function click and every explicit tab click
  becomes a Back-able step, per requirement.

### `web/src/components/result-panel.tsx`

- Remove the internal `const [activeTab, setActiveTab] = useState('response')`.
- Accept `activeTab` and `onActiveTabChange` as props; wire them directly
  into the existing `Tabs value={...} onValueChange={...}` — the component
  was already structured as a controlled `Tabs` internally, so this is a
  narrow prop-plumbing change, not a rework.
- Keep the existing display fallback (`activeTab === 'checks' && checkResults
  == null ? 'response' : activeTab`) for the *visual* Tabs value. Separately,
  `App` is responsible for correcting the *URL* (see below) — `ResultPanel`
  itself does not call `navigate`.

### Checks-tab auto-correction

When `checkResults` becomes `null` (new invoke, or a function switch) while
`search.tab === 'checks'`, `App` corrects the URL param back to
`tab: undefined` (i.e. default/`response`) via
`navigate({ search: (prev) => ({ ...prev, tab: undefined }), replace: true })`.

This uses `replace: true`, not the default push, because it's a passive
side effect of state being cleared, not a click — using replace keeps the
Back button from making the user step through corrections they never
initiated. This is the one place that deviates from the general
"clicks push" rule, and is deliberate: it's not a click.

### Stale/unknown `function` param

If `search.function` doesn't match any function's `name` (renamed, deleted,
hand-edited URL, typo), the app falls back to `functions[0]` silently — same
as today's fallback logic for an invalid `pinnedId`. The URL is **not**
rewritten to "fix" the stale value; this avoids clobbering a value the user
may be mid-typing into the address bar, and avoids surprising URL rewrites
on every load after a rename.

### Bare URL by default

Because nothing writes a default `function` or `tab` back into the URL on
initial load, visiting `localhost:3000` with no query params stays bare
until the user clicks a function or a tab. The fallback-to-`functions[0]`
selection still happens internally for rendering — it just isn't reflected
in the URL until an explicit selection occurs.

### Existing call sites get sync for free

`CommandPalette`'s function selection and `AddFunctionDialog`'s `onCreated`
callback both already funnel through `App`'s single `selectFunction`
function, so they pick up URL sync automatically with no additional
wiring.

## Non-goals

- `/services` search/selection state.
- Persisting any other UI state (sidebar filters, resizable panel sizes,
  env editor state) to the URL.
- Deep-linking validation/redirects beyond the silent fallback described
  above (e.g. no toast/error when a `function` param doesn't resolve).

## Testing

No existing test exercises `index.tsx`'s `App` component through the
router (the one router-adjacent test, `app-sidebar.test.tsx`, tests
`AppSidebar` in isolation with plain props). This change introduces the
first search-param-driven behavior in the app, so tests should cover:

- Selecting a function via `AppSidebar` updates `search.function` in the
  URL.
- Selecting a tab in `ResultPanel` updates `search.tab`.
- Loading with `?function=<name>&tab=<tab>` in the URL selects that
  function and tab on mount.
- An unknown `function` value falls back to the first function without
  rewriting the URL.
- Clearing check results while `tab=checks` corrects the URL to
  `tab=response` (or removes the param) via `replace`, not `push`.

These will need a router test harness (e.g. `createMemoryHistory` +
`RouterProvider` with the route tree, or a minimal test route) since none
exists yet in this codebase — establishing that harness is part of the
implementation work, not a prerequisite blocking it.
