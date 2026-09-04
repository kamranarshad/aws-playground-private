# Trace View URL Sync — Design

**Goal:** Make the Trace tab's List/Timeline choice reflect in the URL, so a link can be shared/reloaded to reopen the same view — following the same URL-sync pattern the route already uses for the active result tab.

## Current state

`TraceTab` (`web/src/components/trace-tab.tsx`) owns its List/Timeline choice as local `useState<TraceView>('list')`. It resets to `'list'` on every remount and never appears in the URL.

The route (`web/src/routes/index.tsx`) already URL-syncs the active result tab via a `tab` search param: `validateSearch` type-checks it against `RESULT_TABS`, `Route.useSearch()` reads it, `onActiveTabChange` pushes a new value via `navigate()`. A second existing pattern — an effect that corrects a now-invalid `tab` value via a `replace` navigation (used when the Checks tab loses its check results) — is the model for enforcing a value that's only valid in combination with another field.

## Design

**1. Search param.** Add `traceView?: 'timeline'` to `validateSearch`'s return type and validation:

```ts
traceView: search.traceView === 'timeline' ? 'timeline' : undefined,
```

Only `'timeline'` is ever a meaningful URL value. `'list'` is the implicit default — choosing List omits the param entirely rather than writing `traceView=list`. This keeps the common case (`list`) out of the URL, matching the ask that the param should default to list.

**2. Scoping to the Trace tab.** `traceView` must only appear in the URL while `tab=trace`. Add an effect alongside the existing Checks-tab-correction effect:

```ts
useEffect(() => {
  if (search.traceView && activeTab !== 'trace') {
    navigate({ search: (prev) => ({ ...prev, traceView: undefined }), replace: true })
  }
}, [search.traceView, activeTab, navigate])
```

This runs whenever the active tab changes away from `trace` while a `traceView` value is present, stripping it via `replace` (a passive correction, not a user-initiated navigation — same justification as the existing Checks-tab effect).

**3. Component change.** `TraceTab` becomes a controlled component:

```ts
export function TraceTab({
  spans, view, onViewChange,
}: { spans: Span[]; view: TraceView; onViewChange: (view: TraceView) => void })
```

It no longer owns `useState` for `view`; the List/Timeline buttons call `onViewChange('list' | 'timeline')` instead of a local setter. `TraceView` stays exported from this file as before.

**4. Wiring in the route.** In `App()`:

```ts
const traceView = search.traceView ?? 'list'
function onTraceViewChange(view: TraceView) {
  navigate({ search: (prev) => ({ ...prev, traceView: view === 'timeline' ? 'timeline' : undefined }) })
}
```

`onTraceViewChange` is a push navigation (new history entry), matching `onActiveTabChange`'s existing behavior for tab clicks — so a browser Back after switching List → Timeline returns to List, the same way switching result tabs is already undoable.

Wherever `TraceTab` is currently rendered (inside `ResultPanel`, for the `trace` tab's content) passes `view={traceView}` and `onViewChange={onTraceViewChange}` down from the route — following the same prop-drilling `ResultPanel` already does for `activeTab`/`onActiveTabChange`.

**5. Persistence across re-invokes.** The chosen view persists in the URL across re-invokes on the same function — invoking again does not reset it back to `list`, since `tab`/`traceView` are search-param state, untouched by the invoke lifecycle. Switching functions is a separate case: it already resets `tab` back to `'response'` (pre-existing behavior in `selectByName`, unrelated to this feature), and the scoping effect in point 2 then clears `traceView` too as a consequence — not a special-cased reset added by this feature. No new reset logic is added anywhere.

## Testing

- `validateSearch` unit test: `traceView=timeline` in the raw search → `'timeline'`; anything else (`'list'`, missing, garbage) → `undefined`.
- Route-level test (extends the existing `index.test.tsx` URL-sync tests): clicking Timeline while on the Trace tab pushes `traceView=timeline` into the URL; clicking List removes it; switching to a different result tab while `traceView=timeline` is set strips it via a replace navigation (no new history entry); loading a URL with `?tab=trace&traceView=timeline` opens directly on the Timeline view.
- `TraceTab` component test: update existing tests (`trace-tab.test.tsx`) to pass `view`/`onViewChange` as controlled props instead of relying on internal state; assert `onViewChange` is called with the right value on each button click.

## Out of scope

- No change to `TraceWaterfall`, `TracePanel`, or the underlying span data/layout — this is purely URL-syncing the existing List/Timeline choice.
- No reset-on-switch behavior — the view stays as the user left it, consistent with how the app already treats the result tab selection.
