# Local services move to their own page

Move Local services out of the header dropdown into a dedicated
`/services` route, reached by a new left icon rail. Room for the
service list — and future top-level pages — to grow. No backend or
lifecycle changes.

## Navigation: left icon rail

- New `AppNav` component: a thin (~52 px) vertical rail on the far
  left, present on every route via the root layout. Two items now:
  - Playground — λ mark → `/`
  - Services — database icon → `/services`
  - Built to take more entries later (Settings, Logs).
- Active item: filled cream pill (matches the sidebar active-item
  treatment); inactive: muted, warm hover. Tooltip per item
  (wrapped in a single TooltipProvider — Task 7's lesson).
- The header's `λ Lambda Playground` title stays; the header
  database-icon `ServicesMenu` dropdown is removed (its quick
  start/stop now lives on the page). Health chips, ⌘K hint, and
  theme toggle stay in the header.

## Routing

- Convert the single-page app to nested routes:
  - `__root.tsx`: wrap `<Outlet/>` in a flex row — `<AppNav/>` +
    the routed content — so every page gets the rail.
  - `/` (index): the existing function workspace, unchanged except
    it no longer renders `ServicesMenu` and now sits inside the
    rail layout.
  - `/services`: the new page.
- TanStack Router file routes; `Link`/`useRouterState` for active
  state (already a dependency).

## `/services` page

- Header row: "Local services" title + a search input (filters by
  label/shortLabel/name, case-insensitive; empty = all).
- Docker-unavailable: one explanatory panel (as today), no list.
- Otherwise a **list** (rows, not a card grid) — one row per registry
  entry, each with:
  - a **selection checkbox** (left),
  - state dot + label + state badge,
  - endpoint (mono) and note (e.g. ElasticMQ ephemeral) when present,
  - a per-row Start/Stop button (per-row pending via the existing
    per-button mutation pattern — the recent fix),
  - "Open console" link when running and a console exists; the MinIO
    console-login hint for minio only.
- **Bulk start bar**: a checkbox in the header row toggles select-all
  (of the currently-filtered, not-yet-running rows). When any row is
  selected, a bar shows "Start selected (N)" plus "Clear". Clicking
  it starts every selected service that isn't already running by
  firing the existing per-service start mutation for each (client-side,
  in parallel; no batch endpoint). Each started row shows its own
  pending state; selection clears on completion. Already-running
  selected services are skipped.
- Empty search result: a muted "no services match" line.
- Data via the existing `useServices` query; refetch on mount and
  after each mutation (unchanged hooks).

## Component changes

- New: `web/src/components/app-nav.tsx`, `web/src/routes/services.tsx`.
- `web/src/components/services-menu.tsx` → renamed/reshaped into a
  reusable `ServiceRow` + `ServiceActionButton` (keep the button
  component as-is) used by the page; delete the dropdown wrapper.
- `index.tsx`: drop the `ServicesMenu` import/usage; wrap logic
  unchanged otherwise.
- Env-editor per-function service toggles: unchanged.

## Testing

- No backend/test changes required (endpoints identical).
- `tests/web.test.js` (built-server smoke): add asserts that
  `GET /services` returns 200 with the app shell (route renders
  server-side).
- Browser (real docker): nav rail switches `/` ↔ `/services`; the
  page lists all five services as rows; search filters; select two
  rows and "Start selected" starts both (each shows its own pending);
  Start/Stop on one row shows pending only on that row and flips its
  state; console link works; per-function toggle still present on `/`.
  Screens in dark; console clean.

## README

Update the Local services paragraph: manage services from the
Services page (left rail) rather than the header menu.

## Out of scope

Per-service detail pages, bulk start/stop, drag-reordering,
persisting search, additional nav destinations (rail is built to
extend but ships with two).
