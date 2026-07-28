# Code review pass: performance and structure — 2026-07-28

A review pass over the whole codebase. Behaviour is unchanged throughout;
every item is either a measured cost removed or a file that was doing more
than one job. Measurements are from this machine, not estimates.

## Performance

### 1. One `docker ps -a` instead of a call per service

`services.list()` ran `docker info` plus one `docker inspect` per registered
service — six process spawns. That was tolerable when the list was fetched
once on mount; the 5 s poll added on 2026-07-26 made it a standing cost.

`statusAll()` reads every container's state from a single `docker ps -a
--format '{{.Names}} {{.State}}'`, which also answers "is the daemon up?"
(it fails exactly when `docker info` would), so `dockerAvailable()` is gone.

Measured on the Services page: **6 docker invocations over 21 s (6 polls),
against 36 before** — one per poll instead of six.

The same probe replaced per-service checks in two more places:

- `setSelection()` probed each declared service, then `start()` probed the
  same container again — 2N spawns before a single container was launched.
  It now probes once and passes the state to `start()` via `knownState`.
- `invokeFunction()` probed each enabled service **on every invoke**, and on
  failure called `list()` (another docker round trip) purely to read a
  label. Now: one probe, and `labelFor()` reads the registry.

### 2. History append stopped rewriting the whole file

`history.append()` read the file, parsed every retained entry, pushed,
sliced to 50 and rewrote all of it — on every invoke. The file is JSONL;
appending is the whole point of the format.

Now `append()` writes one line, and trimming moved to `list()`, where the
entries are already parsed and the write amortizes across the 50 appends
that produced the overflow. A cheap `statSync` guard in `append()` (no
parse) compacts if the file passes 4 MB, so a long session that never opens
the History tab still can't grow without bound.

Measured, 500 appends of ~8 KB entries: **952 ms → 84 ms (11.3x)**.

### 3. Project detection fetched once, not once per consumer

`env-editor` ran two `useQuery`s with different keys (`['envfiles', path]`,
`['projectservices', path]`) and the *same* `queryFn`. Every function click
ran the server-side project scan (readdir plus source regexes) twice for the
same answer. A shared `useDetect(path, select)` hook keys them together;
`select` narrows per consumer without refetching.

## Structure

`web/src/lib/types.ts` was **left alone deliberately**. It holds one
concern — the shapes the server returns — and splitting it would only add
import churn. The files that genuinely mixed concerns were components:

- `service-row.tsx` exported three components. `CopyableValue` is a generic
  click-to-copy control with nothing to do with services; it moved to
  `copyable-value.tsx` and gained its own tests, including the
  clipboard-denied path that had no coverage.
- `env-editor.tsx` was one component doing three jobs — env rows, local
  service toggles, and the .env file picker — with the picker mis-nested
  inside the toggles' container. Split into `LocalServiceToggles`,
  `EnvFilePicker` and `EnvVarRow`. The two children read the shared
  `useDetect` query, so being separate components costs no extra requests.

Eight characterization tests were written against the old component first,
then held green across the split — including the "detection once" test,
which proves the children still share one request.

## Test-quality fixes found along the way

- **A flaky test.** `setSelection ... auto-stops after grace` slept a fixed
  250 ms for a 120 ms timer. It passed alone 5/5 but failed in the parallel
  full run, where the shim's node subprocesses get starved. Positive
  assertions now poll (`waitForCall`); negative ones wait 8x the grace
  window, so a pass means the timer was cancelled rather than merely late.
  Three consecutive full runs are clean.
- **A defective test helper.** The `wrapper` in two web test files built a
  `QueryClient` *inside* the wrapper component, so every re-render threw the
  cache away — which would have silently defeated the deduplication test.
  Built once per render call now.
- `dockerAvailable()` became dead once `statusAll()` subsumed it. Removed,
  along with the test that existed only to cover it.
