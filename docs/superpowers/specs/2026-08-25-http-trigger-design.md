# HTTP (API Gateway) trigger

**Date:** 2026-08-25
**Status:** Approved (design conversation), pending spec review

## Goal

Let a function be invoked by a real HTTP request from another app on the
same machine — the API-Gateway-shaped analog of the existing SQS trigger.
A shared listener on its own port routes incoming requests to the right
function by name and returns the handler's return value as the actual
HTTP response, so another app can integrate against it like it would a
real API Gateway HTTP API.

## Scope decisions (from brainstorming)

- One shared HTTP listener, on its own dedicated port (not the playground
  UI's port), routes by path prefix to the right function — not one port
  per function.
- The route prefix is the function's existing `name` field, not a new
  user-set field: `http://localhost:9500/<name>/<...rest>`.
- Function `name` becomes globally unique (create/update reject a
  duplicate) — broader than strictly required for routing, but the chosen
  scope (option 2 from brainstorming) rather than scoping the check to
  only functions with an HTTP trigger enabled.
- A function can have an SQS trigger or an HTTP trigger, not both —
  `trigger` stays a single object, matching the SQS design's stated
  one-trigger-per-function scope. No `triggers` list/migration.
- No queueing: an HTTP request that arrives while an invoke is already in
  flight for that function gets `429`, reusing the existing single-invoke
  guard rather than adding concurrency.
- Malformed or errored handler responses get `502`, mirroring real API
  Gateway's "malformed Lambda proxy response" behavior.
- Fixed port (9500), no CLI flag to change it — matches how the local
  services' ports are fixed today.

## Data model

`server/store.js`: `trigger` gains a second shape alongside the existing
SQS one:

```js
trigger: input.trigger ?? null
// { type: 'sqs', queueName: string, enabled: boolean }
// { type: 'http', enabled: boolean }
```

No queue-name-equivalent field for `http` — the route is derived from
`fn.name` at routing time, not stored redundantly on the trigger.

Validation (`server/api/functions.js` `fieldError`):
- If `trigger` is present and non-null: `type` must be `'sqs'` or
  `'http'`, `enabled` must be a boolean.
- `type: 'sqs'` additionally requires non-empty string `queueName`
  (existing rule, unchanged).
- `type: 'http'` additionally requires `name` not contain `/` (would
  break path-segment routing) — checked wherever `trigger.enabled` is
  true for an http trigger, both on create and update.
- `name` uniqueness: create/update reject if another function already
  has the same `name` (case-sensitive exact match), independent of
  whether either function has a trigger configured. Same `fieldError`
  pattern as the other field checks so a PATCH can't put the store in a
  state POST would've rejected.

## Shared listener

New module `server/trigger/http.js`:

- One `http.createServer` bound to `127.0.0.1:9500`, started lazily by
  the manager the first time any function has
  `trigger.type === 'http' && trigger.enabled`, stopped when none do.
- Holds a live route table, `Map<name, functionId>`, rebuilt as triggers
  are toggled or functions with an enabled HTTP trigger are
  created/updated/deleted — no listener restart needed to pick up route
  changes, only to start/stop the listener itself.
- Request handling:
  1. Parse the first path segment (URL-decoded) as `name`; look it up in
     the route table. No match → `404` JSON `{ error: 'no function
     registered for "<name>"' }`.
  2. Build an API Gateway **HTTP API payload v2** event:
     ```js
     {
       rawPath: '/' + restOfPathAfterName, // '/' if nothing left
       rawQueryString: url.search.slice(1),
       queryStringParameters: Object.fromEntries(url.searchParams) || undefined,
       headers: req.headers,
       requestContext: { http: { method: req.method, path: req.url } },
       body: bodyString, // base64 if not valid UTF-8 text
       isBase64Encoded: boolean,
     }
     ```
     This matches what `fixtures/typescript/apigw` already expects
     (`rawPath`, `requestContext.http.method`, `queryStringParameters`,
     `body`, `isBase64Encoded`).
  3. `invokeFunction({ functionId, event, source: { type: 'trigger',
     method: req.method, path: req.url } })`.
  4. If the invoke result is `409` (in-flight guard): respond `429`
     `{ error: 'an invoke is already in flight for this function' }` —
     unlike the SQS poller (which just skips its cycle), an HTTP caller
     needs an actual response now.
  5. If the invoke succeeded (`result.ok`) and `result.response` is
     `{ statusCode: number, body?: string, headers?: object,
     isBase64Encoded?: boolean }`: write that back as the real HTTP
     response (decode body from base64 if `isBase64Encoded`).
  6. Otherwise (handler threw, or returned something that isn't a valid
     proxy-response shape): respond `502` JSON describing the problem —
     the real error/response is still visible in the History tab exactly
     like a manual invoke's would be.

## Manager lifecycle

`server/trigger/manager.js`, extended rather than replaced:

- `sync(fn)` branches on `fn.trigger?.type`:
  - `'sqs'`: unchanged — today's per-function poll-loop start/stop.
  - `'http'`: updates the shared listener's route table
    (add/remove/rename `fn.name → fn.id`) and ensures the shared listener
    is running if any function needs it, stopped if none do.
  - no trigger / disabled: removes any route entry for `fn.id`; stops the
    shared listener if it was the last one.
- `resumeAll()`/`stopAll()`: no caller changes — both already iterate
  every function via `sync`, so `bin/cli.js` needs no new wiring beyond
  what SQS already required.
- `status(functionId)` / `statusAll()`: same `{ state, lastError,
  lastPolledAt }` shape. For `http`, `state` is `'listening'` while the
  shared listener is up and this function has a route, `'error'` if the
  listener failed to bind (e.g. port 9500 already in use) or the route
  couldn't be registered (duplicate name — shouldn't happen given the
  uniqueness check, but surfaced defensively).

## History

Reuses `source: { type: 'trigger', ... }` end to end — no changes to
`history.append` or the History tab's badge rendering. HTTP invokes carry
`{ method, path }` instead of SQS's `{ messageId }`.

## API / UI

- `GET /api/triggers` unchanged in shape; now also reports `http`-type
  functions using the same per-function status map.
- `PATCH /functions/:id` already accepts arbitrary `ALLOWED_KEYS` —
  `trigger` with `type: 'http'` rides the existing endpoint. The handler
  calls `manager.sync(fn)` after a successful update when `trigger` (or
  `name`, since renaming affects an active HTTP route) was in the patch.
- Function detail page's existing "Trigger" section gains a type selector
  (None / SQS / HTTP):
  - SQS mode: unchanged (queue name input, enable switch, status pill).
  - HTTP mode: read-only, copyable computed URL
    (`http://localhost:9500/<name>/...`, live-updated if the name field
    changes before saving), enable switch, status pill.
- Function name field: surfaces the new uniqueness `fieldError` inline,
  same as other field-level validation errors already do.

## Worked example

Point users at the existing `fixtures/typescript/apigw` fixture — it
already returns `{statusCode, headers, body}` for `GET /hello?name=...`
and `POST /sum`, so enabling the HTTP trigger on it and running
`curl localhost:9500/<name>/hello?name=you` works with the fixture
unchanged. README gets a paragraph alongside the SQS one describing this,
matching the existing "worked example" pattern for every other feature.

## Non-goals

- Configurable port (fixed `9500`, no CLI flag).
- Request queueing or any concurrency beyond the existing single-invoke
  guard (concurrent requests to the same function get `429`).
- HTTPS/TLS or auth on the listener — `127.0.0.1`-only, same trust model
  the rest of the playground already uses.
- `playground.json`-declared HTTP triggers (manual UI config only,
  matching the SQS trigger's same decision).
- Payload v1 (REST API) event shape — v2 (HTTP API) only, matching the
  existing `apigw` fixture.

## Testing

- `server/trigger/http.test.js` (or under `tests/`, matching the existing
  flat layout): real requests against a real listener bound to 9500 —
  success path via the `apigw` fixture (`GET /hello`, `POST /sum`), `404`
  for an unregistered name, `502` for a handler that throws or returns a
  malformed shape, `429` when an invoke is already in flight, route
  removed when the trigger is disabled or the function deleted, listener
  stops when the last HTTP trigger is disabled, resumes correctly after a
  fresh `resumeAll()` (simulating a server restart).
- `tests/api.test.js`: name uniqueness on create/update; `PATCH
  /functions/:id` validates `trigger.type === 'http'`; a `/` in `name`
  is rejected while an HTTP trigger is enabled.
- Web: Trigger section's type selector renders SQS/HTTP correctly and
  shows the computed URL; History row still shows the trigger badge for
  HTTP-sourced invokes.

## Verification

`npm run test:server`, `npm run test:web`, web typecheck, `npm run build`
to confirm `web/dist` picks up the new UI.
