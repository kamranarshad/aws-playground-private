# Faster service start/stop

**Date:** 2026-08-09
**Status:** Approved (design conversation), pending spec review

## Goal

Cut the seconds a user waits on the two service-lifecycle paths: starting
services when a `playground.json` lambda's selection syncs (or a service
checkbox is checked), and stopping the container when a checkbox is
unchecked.

## Measurements (this machine, warm containers)

| service | `docker start` | ready after | `docker stop` |
| --- | --- | --- | --- |
| minio | 171ms | +443ms | 323ms |
| elasticmq | 182ms | +113ms | 306ms |
| dynamodb | 175ms | +2632ms | 626ms |
| redis | 229ms | +104ms | 331ms |
| postgres | 174ms | +1ms | 209ms |

Docker itself is fast; the app adds latency in three places: readiness
polling on a 400ms grid, sequential starts/stops, and — dominating the
uncheck path — the 15s auto-stop grace applied even to explicit unchecks.
DynamoDB's ~2.6s JVM boot is inherent and out of scope.

## Design

All in `server/services.js` unless noted.

1. **Readiness poll: 400ms → 100ms** (`waitReady`). Saves 300–700ms per
   service start; poll cost is one local TCP connect or HTTP fetch.
2. **Parallel starts and stops.** `setSelection` starts all needed services
   concurrently (`Promise.all` over the per-service `start()` calls;
   `autoStarted` bookkeeping happens per-result exactly as today).
   `stopAutoStarted` stops concurrently the same way. Multi-service
   selections and the quit sweep drop from sum to max latency.
3. **`stopNow` for explicit unchecks.** `setSelection(needed, { stopNow })`:
   when `stopNow` is true, auto-started services that fell out of the needed
   set are stopped immediately (concurrently) instead of getting the 15s
   grace timer; the response's `scheduledStop` reports them as today.
   - `server/api.js` `setSelection` passes `stopNow` from the request body.
   - `web/src/lib/api.ts` `setSelection` gains an optional `stopNow`
     parameter; only the checkbox-toggle path
     (`local-service-toggles.tsx` mutation flow) passes it. Selection
     changes from switching functions and the unload beacon keep the 15s
     grace, so function-hopping still doesn't thrash slow-booting services.
   - The manual-service rule is unchanged: services the user started by
     hand are not in `autoStarted` and are never auto-stopped.
4. **Bound worst-case stops:** `docker stop -t 2` everywhere the app stops
   containers. All five services stop in <1s today; this only caps a wedged
   container at 2s instead of Docker's 10s default.

## Non-goals

- No change to DynamoDB's boot time, the grace default (15s), the manual
  start/stop buttons, or the services registry.
- No UI changes beyond the toggle mutation passing `stopNow`.

## Testing

- `tests/services.test.js` / `tests/services-docker.test.js` (fake docker
  via `AWS_PLAYGROUND_DOCKER`): `stopNow: true` stops a dropped auto
  service immediately (no pending timer; fake docker records `stop -t 2`);
  `stopNow` absent keeps today's grace behavior; `stop` args include
  `-t 2`; parallel start still records every `run`/`start`.
- `tests/api.test.js`: `/api/selection` accepts `stopNow` and passes it
  through.
- Web: the toggle mutation calls `setSelection` with `stopNow: true`
  (extend the existing component/queries test where the mutation lives).

## Verification

Full gates (`npm run test:server`, `npm run test:web`, typecheck), rerun
the timing script for the uncheck path (container should be stopped in
<1s), rebuild `web/dist`.
