# S3 (MinIO) bucket-event trigger

**Date:** 2026-08-26
**Status:** Approved (design conversation), pending spec review

## Goal

Let a function be invoked automatically when an object is created or
removed in a local MinIO bucket — the S3-notification analog of the
existing SQS and HTTP triggers, completing the local dev loop for the
most common S3-triggered Lambda pattern. Explicitly anticipated as a
follow-up in both the SQS and HTTP trigger designs.

## Scope decisions (from brainstorming)

- One bucket per trigger, but multiple event types per trigger:
  `ObjectCreated` and/or `ObjectRemoved` (each maps to the real S3
  wildcard `s3:ObjectCreated:*` / `s3:ObjectRemoved:*` — no finer-grained
  event types in v1).
- Optional key-prefix and key-suffix filters, applied per trigger.
- Push-based (webhook), not polling: MinIO natively supports webhook
  notification targets, and a webhook keeps real event fidelity (accurate
  event name, size, timestamps) instead of diffing bucket listings on an
  interval. This is architecturally closer to the HTTP trigger's
  shared-listener pattern than to SQS's per-function poll loop.
- One shared webhook listener, always running from server startup
  (independent of whether any function currently has an S3 trigger) —
  this avoids a sequencing problem where MinIO validates webhook
  reachability against its notification-target config, which is itself
  baked into the container's env at startup.
- All real filtering (event type, prefix, suffix, which function(s) to
  invoke) happens in the playground's own webhook handler, not in MinIO's
  notification config. MinIO is always given one catch-all
  `PutBucketNotificationConfiguration` per bucket-with-a-trigger (both
  event types, no filter) — this sidesteps S3/MinIO's validation that
  rejects multiple overlapping per-config filters on the same bucket,
  which would otherwise make "one MinIO-side config per function" fragile
  the moment two functions watch the same bucket.
- The bucket is auto-created if it doesn't exist, matching the SQS
  trigger's `ensureQueue` behavior.
- No redelivery/backoff: MinIO's webhook delivery is fire-and-forget from
  the playground's side — a non-200 `invokeFunction` result (e.g. the
  409 in-flight guard) is simply dropped rather than retried.
- `playground.json`-declared S3 triggers are supported, matching the SQS
  trigger's declarative config (unlike the HTTP trigger, which is
  manual-UI-only).

## Data model

`web/src/lib/types.ts`: `FunctionTrigger` gains a third member —

```ts
export type FunctionTrigger =
  | { type: 'sqs'; queueName: string; enabled: boolean }
  | { type: 'http'; enabled: boolean }
  | {
      type: 's3'
      bucket: string
      events: ('ObjectCreated' | 'ObjectRemoved')[]
      prefix?: string
      suffix?: string
      enabled: boolean
    }
```

`prefix`/`suffix` are omitted (not empty strings) when unset, so
`playground.json` and the UI both have one unambiguous "no filter" shape.

Validation (`server/api/functions.js` `triggerError`):
- `type` whitelist extended to include `'s3'`.
- `type: 's3'` requires `bucket` to be a non-empty string (trimmed) and
  `events` to be a non-empty array whose entries are each `'ObjectCreated'`
  or `'ObjectRemoved'`.
- `prefix`/`suffix`, if present, must be strings (empty allowed, though the
  UI normalizes empty to omitted the same way the trigger button already
  normalizes an empty SQS queue name to "no trigger").
- `enabled` boolean check is unchanged and applies to all three types.

`server/projectconfig.js` `parseTrigger` gains an `'s3'` branch mirroring
the same validation, trimming `bucket`/`prefix`/`suffix` the same way the
SQS branch already trims `queueName` (recent hygiene fix in `aed3efc`) —
an invalid/incomplete declaration returns `null` (no file governance),
falling back to the function's manual config, same as every other
`parseTrigger` branch.

## Webhook listener & MinIO notification wiring

**MinIO container config** (`server/services/registry.js`, `minio` entry):
add fixed env vars so a webhook target is always defined, independent of
whether any trigger currently uses it —

```js
'-e', 'MINIO_NOTIFY_WEBHOOK_ENABLE_PLAYGROUND=on',
'-e', 'MINIO_NOTIFY_WEBHOOK_ENDPOINT_PLAYGROUND=http://host.docker.internal:9501/',
```

plus `--add-host=host.docker.internal:host-gateway` in `runArgs` (required
for the container to resolve `host.docker.internal` on Linux Docker;
already resolvable without it on Docker Desktop). This makes
`arn:minio:sqs::PLAYGROUND:webhook` a usable notification target with no
per-trigger container reconfiguration or restart.

**Shared listener** (new module `server/trigger/s3.js`, parallel to
`http.js`): one `http.createServer` bound to `127.0.0.1:9501`, started
once from `bin/cli.js` alongside `triggerManager.resumeAll()` and kept
running for the life of the process — unlike the HTTP trigger's listener,
this one is *not* started/stopped based on whether any function currently
has an S3 trigger, precisely because MinIO's own webhook-target env config
is static from container start and shouldn't depend on trigger state.

Holds a live route table, `Map<bucket, Array<{ functionId, events, prefix,
suffix }>>`, mutated as S3 triggers are enabled/disabled/reconfigured — no
listener restart needed to pick up route changes.

Request handling:
1. Parse MinIO's webhook body (`{ EventName, Key, Records: [...] }` —
   MinIO's native shape, structurally close to real S3 notifications but
   with `eventName`/`Records[].eventSource: 'minio:s3'`).
2. For each record, normalize `eventSource` to `'aws:s3'` (fixture/type
   compatibility with a standard `S3Event` shape) and derive the
   playground's own `'ObjectCreated' | 'ObjectRemoved'` category from the
   real `eventName` (`s3:ObjectCreated:*` → `ObjectCreated`, etc.).
3. Look up `record.s3.bucket.name` in the route table; for every entry
   whose `events` includes the derived category and whose `prefix`/`suffix`
   (if set) match `record.s3.object.key`, call
   `invokeFunction({ functionId, event: { Records: [record] }, source: { type: 'trigger', bucket, key, eventName } })`
   — the same choke point SQS and HTTP use.
4. Always respond `200` to MinIO immediately after dispatching invokes
   (fire-and-forget — MinIO doesn't wait on Lambda's result, matching real
   S3→Lambda semantics where delivery failures are the notification
   system's own concern, not something plumbed back to the sender).

**Per-bucket MinIO-side config**: `server/trigger/s3.js` also owns
ensuring the bucket exists (`CreateBucketCommand`, swallowing
`BucketAlreadyOwnedByYou`/`BucketAlreadyExists` the same way the
`node-s3` fixture already does) and keeping one catch-all
`PutBucketNotificationConfiguration` in place on any bucket referenced by
at least one enabled S3 trigger — recomputed (only when the *set of
buckets-with-triggers* changes, not on every `sync`) to add or remove that
bucket's config. When the last trigger referencing a bucket is
disabled/deleted, its notification config is cleared via
`PutBucketNotificationConfiguration` with an empty `QueueConfigurations`
list.

## Manager lifecycle, status, and history

`server/trigger/manager.js` `sync(fn)` gains an `'s3'` branch (alongside
the existing stale-registration cleanup that already runs when a
function's trigger type changes):
- On enable: upsert this function's `{ events, prefix, suffix }` into
  `s3.js`'s route table for `trigger.bucket`, then await
  `s3.ensureBucketConfig(trigger.bucket)`.
- On disable/delete/type-switch: remove this function's route-table entry
  and, if no function still references that bucket, clear its
  notification config.
- `resumeAll()`/`stopAll()`: no new caller wiring — both already iterate
  every function via `sync`, same as the HTTP trigger required none
  beyond what SQS's initial version already had. (`stopAll()` clears
  route-table entries but does **not** stop the shared listener itself —
  it's process-lifetime, matching the "always running" decision above.)
- **Status**: reuses the existing `'listening'` state (already used by the
  HTTP trigger) rather than introducing a new one — a push-based, always
  ready-to-receive trigger fits that state better than `'polling'`.
- **History**: `InvokeSource` (`web/src/lib/types.ts`) gains a fourth
  member, `{ type: 'trigger'; bucket: string; key: string; eventName: string }`,
  so the History tab can show which object/event caused the invoke,
  mirroring SQS's `messageId` and HTTP's `{ method, path }`.

## API / UI

- No new endpoints — `PATCH /functions/:id` already accepts arbitrary
  `ALLOWED_KEYS`; an `'s3'`-typed `trigger` rides the existing endpoint,
  and `GET /api/triggers` already reports per-function status generically.
- `web/src/components/trigger-button.tsx`: `TriggerType` gains `'s3'`, a
  third `<SelectItem>` ("S3 bucket"), and a third conditional block:
  a bucket-name text input, two checkboxes (Object Created / Object
  Removed), and optional prefix/suffix text inputs — following the same
  `useState` + reseed-on-open pattern the `sqs`/`http` blocks already use,
  and the same `save()` pattern of building the trigger payload
  conditionally on `triggerType`.
- `TriggerToggle`/`TriggerStatusBadge` need no changes — both are already
  trigger-type-agnostic (`{ ...trigger, enabled: next }` and the existing
  `state` union respectively).

## New dependency

`@aws-sdk/client-s3` — for `CreateBucketCommand` and
`PutBucketNotificationConfiguration`, added to `package.json`
`dependencies` alongside the existing `@aws-sdk/client-sqs`.

## Worked example

Point users at the existing `fixtures/typescript/node-s3` fixture
(`fixtures/typescript/node-s3/src/index.ts`) — enabling an S3 trigger on
the `playground` bucket it already reads/writes lets an external
`PutObjectCommand` (e.g. from `aws s3 cp` against the MinIO endpoint, or a
second playground function) invoke it automatically. README gets a
paragraph alongside the SQS/HTTP ones describing this.

## Non-goals

- Event types beyond the two top-level wildcards (no `Tagging`,
  `Restore`, `Replication`, or granular `Put`/`Post`/`Copy`/
  `CompleteMultipartUpload`/`Delete`/`DeleteMarkerCreated`).
- More than one prefix/suffix pair per trigger.
- A bucket-listing/picker UI (free-text bucket name only, matching SQS's
  free-text queue name).
- Webhook authentication/signature verification — `127.0.0.1`-only trust
  model, same as the HTTP trigger.
- Redelivery, DLQ, or backoff on invoke failure.
- Multiple buckets per trigger.

## Testing

- `tests/trigger-s3.test.js`: unit tests for MinIO-webhook-payload
  normalization and route-matching (event-type + prefix/suffix) against
  injected fakes, no real network or docker — same style as
  `tests/trigger-sqs.test.js`. Also covers notification-config
  aggregation logic in isolation: merging when a second function starts
  watching an already-configured bucket, clearing when the last watcher
  is removed.
- `tests/trigger-manager.test.js`: extend with `'s3'` sync scenarios —
  start on enable, no-op if unchanged, reconfigure on bucket/event/filter
  change, stop on disable, switching between trigger types, and
  `playground.json`-declared S3 trigger precedence — same docker-shim +
  monkeypatched-module technique already used for sqs/http.
- `tests/trigger-docker.test.js` (or a new sibling): real-docker e2e,
  skipped unless `docker info` succeeds and `minio/minio` is present
  locally — actually `PutObject`/`DeleteObject` via `@aws-sdk/client-s3`
  against a real MinIO container with the webhook wired up, then poll
  `api.listHistory` for a `source.type === 'trigger'` entry with the
  expected bucket/key/eventName. This is the test that empirically
  validates the riskiest assumption in this design — that MinIO's webhook
  can actually reach `host.docker.internal:9501` from inside the
  container — worth running early during implementation.
- `tests/effective-trigger.test.js`: add `'s3'` precedence cases.
- `tests/api.test.js` (or wherever `PATCH /functions/:id` validation is
  covered): `'s3'` trigger field validation (bucket required, events
  non-empty and from the allowed set, prefix/suffix optional strings).
- Web: extend `trigger-button.test.tsx` with the new picker fields.

## Verification

`npm run test:server`, `npm run test:web`, web typecheck, `npm run build`
to confirm `web/dist` picks up the new UI.
