# Project services file + selection-driven lifecycle

Lambda projects declare their local services in `playground.json`;
selecting the function auto-starts them, and auto-started services
stop 15 s after no selected function needs them.

## `playground.json`

- Location: project directory root. Shape: `{ "services":
  ["minio", "elasticmq", ...] }` — names validated against the
  service registry; unknown names ignored.
- Re-read fresh on every use (selection change, invoke, detect) —
  same freshness semantics as `.env`.
- When the file exists and has a `services` array, it is
  AUTHORITATIVE for that function: `fn.localServices` is ignored and
  the env-strip checkboxes are replaced by read-only chips labelled
  "from playground.json". Without the file, manual toggles work as
  today. Writing the file is the opt-in for auto-management.

## `server/projectconfig.js` (new)

`read(dir) -> { services: string[] | null }` — null when the file is
missing, unparsable, or has no `services` array; otherwise the
validated (registry-filtered) list. Never throws.

## Selection lifecycle (`server/services.js` additions)

- `GRACE_MS` = 15000, overridable via
  `AWS_PLAYGROUND_SERVICE_GRACE_MS` (tests use ~100 ms).
- Module state: `autoStarted: Set<name>`, `stopTimers: Map<name,
  Timeout>`, `currentNeeds: Set<name>`.
- `setSelection(services: string[])`:
  - For each needed service: cancel any pending stop timer; if not
    running, `start()` it (ready-wait included) and add to
    `autoStarted` (unless already running — a service found running
    was user- or previously-started and keeps its status).
  - For each `autoStarted` member no longer needed: schedule
    `stop()` after `GRACE_MS` (timer replaced, not stacked; removed
    from `autoStarted` after the stop fires).
  - Returns `{ started: [...], scheduledStop: [...] }` for the API.
- Manual `start()` via the menu deletes the name from `autoStarted`
  (promotion: never auto-stopped). Manual `stop()` clears any timer
  and membership.
- Accepted limitations (documented): closing the browser leaves the
  last selection's services running; a dev-mode backend reload
  (mtime cache-bust) resets timers and the autoStarted set.

## API

- `POST /api/selection` body `{ functionId: string | null }` →
  resolves the function's effective services (file over toggles,
  empty for null id) and calls `setSelection`; 200 with its result.
  Unknown functionId → 404.
- `effectiveServices(fn)` helper shared by selection and invoke:
  `projectconfig.read(fn.path).services ?? fn.localServices ?? []`.
- `detect` response gains `projectServices: string[] | null`.

## UI

- `index.tsx`: on `selectedId` change (and on load), POST
  `/api/selection`; invalidate the services query afterwards so menu
  states refresh.
- `env-editor`: when detect reports `projectServices`, render
  read-only chips (shortLabels + "from playground.json") instead of
  checkboxes.
- Services menu unchanged (manual actions already promote/demote).

## Testing

- `tests/projectconfig.test.js`: valid file, missing, invalid JSON,
  non-array services, unknown names filtered.
- `tests/services.test.js` (shim + 100 ms grace): selection starts
  missing services and marks them auto; deselection stops them after
  grace; reselection within grace cancels the stop; shared service
  across two selections never stops; already-running services are
  not adopted; manual start promotes (no auto-stop).
- `tests/api.test.js`: `/api/selection` endpoint (404, start flow);
  invoke uses file services over stale `fn.localServices`
  (env-echo project + shim).
- Browser (real docker): scratch project with `playground.json`
  declaring minio; select → MinIO running in menu + chips shown;
  select another function → MinIO stopped ~15 s later; console clean.

## README

Paragraph under Local services documenting the file, authority rule,
and the 15 s auto-stop with the browser-close caveat.

## Out of scope

Heartbeat-based cleanup on browser close, per-project grace override,
additional playground.json fields (handler/memory defaults), starting
services on invoke (selection is the trigger; invoke still fails fast
with Service.NotRunning if something isn't up).
