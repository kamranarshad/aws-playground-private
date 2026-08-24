# SQS trigger

**Date:** 2026-08-24
**Status:** Approved (design conversation), pending spec review

## Goal

Let a function be invoked automatically when a message lands in a local
SQS queue (ElasticMQ), instead of only ever being invoked manually from the
UI. First cut of a broader "event trigger" idea; S3/MinIO triggers are an
explicit non-goal here and would follow the same pattern later.

## Scope decisions (from brainstorming)

- SQS only for v1 (simpler than MinIO's webhook-notification wiring).
- Trigger config lives per-function in `functions.json` (not
  `playground.json`) — set from the UI.
- Enabling a trigger auto-starts ElasticMQ and keeps it running for as long
  as the trigger is enabled, independent of what's selected in the UI.
- One message per invoke (no batching).
- The queue is auto-created if it doesn't exist.
- The message is deleted after every invoke, success or failure — no
  redelivery/DLQ in v1.
- Trigger state persists across server restarts; the server resumes
  polling on startup for every function with an enabled trigger.
- Triggered invokes appear in the History tab, tagged so they're
  distinguishable from manual invokes.

## Data model

`server/store.js`: add `trigger` to `ALLOWED_KEYS` and to the shape
`create()` writes:

```js
trigger: input.trigger ?? null // { type: 'sqs', queueName: string, enabled: boolean }
```

`type` is fixed to `'sqs'` for now (the field name stays generic so a
future S3 trigger type doesn't need a migration). `null` means no trigger
configured — the common case today.

Validation (`server/api/functions.js` `fieldError`): if `trigger` is
present and non-null, `type` must be `'sqs'`, `queueName` must be a
non-empty string, `enabled` must be a boolean. Reuses the existing
create/update-share-validation pattern so a PATCH can't put the store in a
state POST would've rejected.

## Poller lifecycle

New module `server/trigger/`:

- `sqs.js` — one function's poll loop: ensure ElasticMQ running, resolve
  the queue URL, long-poll, invoke, delete.
- `manager.js` — tracks the running loops (`Map<functionId, {stop, status}>`),
  exposes `sync(fn)`, `resumeAll()`, `stopAll()`, `status(functionId)`.

**`sync(fn)`** (called after every function create/update/delete):
- If `fn.trigger?.enabled`, and no loop is running for `fn.id`: start one.
- If a loop is running for `fn.id` but the function no longer has
  `trigger.enabled` true (disabled or function deleted): stop it.
- Starting a loop calls `localServices.start('elasticmq', { auto: false })`
  first — the same call the Services page's manual "Start" button makes.
  This promotes ElasticMQ to user-managed, so the existing 15s
  selection-driven grace-stop timer (built for UI tab selection) never
  touches it. Disabling a trigger does not stop the service — symmetric
  with today's manual-start semantics, and avoids yanking a service another
  enabled trigger or a manual invoke might still be using.
- Then `CreateQueueCommand` (idempotent — returns the existing URL if the
  queue already exists) to resolve the queue URL, and enters the poll loop.

**`resumeAll()`**: called once from `bin/cli.js` after `startWebServer`
resolves — reads `store.list()`, calls `sync(fn)` for every function with
an enabled trigger. Same call `sync` already makes on every update, so no
separate code path.

**`stopAll()`**: called from the shutdown sweep in `bin/cli.js`, before
`localServices.stopAutoStarted()` — stops every poll loop (in-flight
invokes are allowed to finish; see below) so nothing is mid-invoke when
services start tearing down.

**Poll loop body** (`sqs.js`), per function, runs until stopped:
```
loop:
  if inFlight.has(fn.id): sleep(POLL_IDLE_MS); continue
  try:
    { Messages } = ReceiveMessage(QueueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 10)
    status = 'polling'
  catch (err):
    status = { state: 'error', message: err.message }
    sleep(ERROR_BACKOFF_MS); continue
  if no message: continue   # long poll already waited ~10s
  event = buildSqsEvent(message, fn)
  await invokeFunction({ functionId: fn.id, event, source: { type: 'trigger', messageId: message.MessageId } })
  try: DeleteMessage(QueueUrl, ReceiptHandle: message.ReceiptHandle)
  catch (err): status = { state: 'error', message: `delete failed: ${err.message}` }
```
`POLL_IDLE_MS` (in-flight backoff) and `ERROR_BACKOFF_MS` (receive/delete
failure backoff) are both small fixed constants (~2s) — no configurability
in v1. `stop()` sets a flag the loop checks between iterations and aborts
the in-progress `ReceiveMessage` via `AbortSignal`; it does not cancel an
invoke already underway.

Credentials/endpoint: same dummy `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`
(`playground`/`playground123`) and `AWS_ENDPOINT_URL_SQS`
(`http://127.0.0.1:9324`) values `server/services/registry.js` already
defines — the poller's own SQS client reads them from there rather than
duplicating the constants.

## Event shape

`buildSqsEvent` produces the same shape a real Lambda SQS event source
mapping delivers, so handler code written against real AWS is unchanged:

```js
{
  Records: [{
    messageId: message.MessageId,
    receiptHandle: message.ReceiptHandle,
    body: message.Body,
    attributes: {
      ApproximateReceiveCount: message.Attributes?.ApproximateReceiveCount ?? '1',
      SentTimestamp: message.Attributes?.SentTimestamp ?? '',
      SenderId: message.Attributes?.SenderId ?? '',
      ApproximateFirstReceiveTimestamp: message.Attributes?.ApproximateFirstReceiveTimestamp ?? '',
    },
    messageAttributes: message.MessageAttributes ?? {},
    md5OfBody: message.MD5OfBody,
    eventSource: 'aws:sqs',
    eventSourceARN: `arn:aws:sqs:elasticmq:000000000000:${fn.trigger.queueName}`,
    awsRegion: 'elasticmq',
  }],
}
```

## History

`invokeFunction` (`server/api/invoke.js`) gains an optional `source` field
on its input, defaulting to `{ type: 'manual' }`; it's passed straight
through to `history.append`. `history.append` stores it as-is (no size
capping needed — it's a small fixed-shape object). The History tab reads
`entry.source.type` to render a "Trigger" badge next to triggered runs.

The existing in-flight guard (`inFlight.has(fn.id)` → 409) already
prevents a triggered invoke and a manual invoke from racing each other;
the poller respects the same guard by skipping its cycle rather than
calling `invokeFunction` and eating the 409.

## API / UI

- `GET /api/triggers` → `{ [functionId]: { state: 'idle'|'polling'|'error', lastError, lastPolledAt } }`,
  wired the same way `listServices` is: a new `server/api/triggers.js`
  reading `manager.status()`, exported from `server/api/index.js`, called
  from `web/src/lib/backend.ts`. Polled by the UI the way the Services
  page already polls docker state.
- `PATCH /functions/:id` already accepts arbitrary `ALLOWED_KEYS`; `trigger`
  rides the existing endpoint — no new write endpoint needed. The handler
  calls `manager.sync(fn)` after a successful `store.update` when `trigger`
  was in the patch.
- `deleteFunction` calls `manager.sync` (effectively `stop`) before
  `store.remove`, so a deleted function's poll loop doesn't outlive it.
- Function detail page: new "Trigger" section beside the existing Local
  Services toggles — queue name text input, enable switch, live status
  pill (idle/polling/error, with the error message on hover) sourced from
  `GET /api/triggers`.

## New dependency

`@aws-sdk/client-sqs` — the server has no runtime dependencies today (only
`oxlint` as a dev dependency); this is the first. Added to `package.json`
`dependencies`.

## Non-goals

- S3/MinIO triggers (follow-up, same pattern).
- Batching multiple messages into one invoke.
- Redelivery/DLQ handling — every message is deleted after invoke
  regardless of outcome.
- Configurable poll interval, batch size, or backoff timing.
- `playground.json`-declared triggers (manual UI config only, matching the
  "option 1" decision).

## Testing

- `server/trigger/*.test.js` (or under `tests/`, matching the existing
  flat layout in `tests/*.test.js`): integration-style against a real
  ElasticMQ container the way `tests/services-docker.test.js` already
  exercises real docker — enable a trigger, send a message directly via
  an SQS client, assert the function was invoked with the expected
  `Records` shape, the message was deleted, and a history entry with
  `source.type === 'trigger'` was recorded. Also: disabling a trigger
  stops the loop; a function delete stops its loop; an invoke error still
  deletes the message; server restart (calling `resumeAll()` fresh)
  resumes a previously-enabled trigger.
- `tests/api.test.js`: `PATCH /functions/:id` accepts/validates `trigger`;
  `GET /api/triggers` reports status.
- Web: Trigger section renders and toggles; History row shows the trigger
  badge when `source.type === 'trigger'`.

## Verification

`npm run test:server`, `npm run test:web`, web typecheck, `npm run build`
to confirm `web/dist` picks up the new UI.
