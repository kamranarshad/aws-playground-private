# DynamoDB Streams trigger

**Date:** 2026-08-26
**Status:** Approved (mirrors the SQS trigger's rationale)

## Goal

Let a function be invoked automatically when an item changes in a local
DynamoDB (Local) table's stream — the third "event trigger" type after SQS
(`docs/superpowers/specs/2026-08-24-sqs-trigger-design.md`) and HTTP
(`docs/superpowers/specs/2026-08-25-http-trigger-design.md`). Same overall
shape as SQS (one poller per function, not a shared listener like HTTP),
adapted for how DynamoDB Streams actually works.

## Scope decisions

- `trigger.type: 'dynamodb'`, config is `{ type: 'dynamodb', tableName: string, enabled: boolean }`
  — `tableName`, not `queueName`, but otherwise the same shape SQS uses, and
  the same `trigger` field (no migration) other trigger types already share.
- The **table** is not auto-created (unlike SQS's queue) — there's no key
  schema to invent one from. It must already exist (created by the
  function's own code, a setup script, or the DynamoDB Local console). The
  trigger only ensures the table's **stream** is enabled, which is
  something the trigger can safely default: `UpdateTable` with
  `StreamSpecification: { StreamEnabled: true, StreamViewType:
  'NEW_AND_OLD_IMAGES' }` if the table doesn't already have one. If a
  stream is already enabled with a different view type, that's left alone
  — the trigger reads whatever the stream is already producing rather than
  fighting existing config.
- Single-shard simplification: v1 tracks only the current open shard of
  the table's stream. DynamoDB Local doesn't reshard under normal
  dev-loop usage, so this covers the common case; a stream with several
  concurrently open shards (mid-reshard) is a non-goal, same posture as
  SQS's non-goals list. If the tracked shard closes (or its iterator
  expires), the poller re-resolves the stream's current open shard from
  scratch and keeps going — it does not walk `ParentShardId` lineage, so a
  reshard boundary can skip or duplicate a handful of records. Documented
  tradeoff, not a bug to chase.
- Shard iterator type is always `LATEST` — only records written after the
  poller (re)starts, mirroring SQS's "no backfill/redelivery" simplicity
  (no `TRIM_HORIZON` replay, no checkpoint persisted across restarts). A
  server restart resumes at `LATEST` and may miss records written while
  the playground was down — same "no redelivery/DLQ" non-goal spirit as
  SQS's message deletion happening regardless of invoke outcome.
- Batch shape: whatever a single `GetRecords` call returns becomes one
  invoke's `Records` array — no manual batching window, no artificial
  one-record-at-a-time splitting. `GetRecords` already batches; there's
  nothing to add on top.
- No ack/delete step: shard iterators advance automatically via
  `NextShardIterator`, regardless of whether the invoke succeeded. This is
  the DynamoDB-Streams equivalent of SQS deleting the message after every
  invoke whether it succeeds or fails.
- `GetRecords` doesn't long-poll like SQS's `ReceiveMessage` — an empty
  result returns immediately. The loop sleeps `POLL_IDLE_MS` (~2s, same
  constant SQS uses for its own idle/backoff) between empty polls instead
  of hot-looping.
- Enabling a trigger promotes `dynamodb` (DynamoDB Local) to user-managed
  via `localServices.start('dynamodb', { auto: false })`, the same call
  SQS's trigger makes for `elasticmq` and the Services page's manual
  "Start" button makes. Disabling a trigger does not stop the service.

## Poller lifecycle

New module `server/trigger/dynamodb.js`, same split as `sqs.js`:
build-a-client helpers + `runLoop` + `start()`. Not layered on top of
`sqs.js`'s `runLoop` — its `receive`/`remove`/single-message shape doesn't
fit a batch-of-records, no-ack source, so this gets its own loop, the same
way `http.js` is its own module rather than shoehorned into `sqs.js`.

`ensureStreamEnabled(dynamoClient, tableName)`:
1. `DescribeTableCommand({ TableName })`. If the table doesn't exist, this
   throws — surfaced as the poller's `error` status (table must already
   exist; see Non-goals).
2. If `Table.StreamSpecification?.StreamEnabled` is falsy, call
   `UpdateTableCommand({ TableName, StreamSpecification: { StreamEnabled:
   true, StreamViewType: 'NEW_AND_OLD_IMAGES' } })` and read
   `TableDescription.LatestStreamArn` off its response.
3. Otherwise return `Table.LatestStreamArn` directly — no separate
   `ListStreams` call needed, `DescribeTable` already carries the current
   stream ARN once streaming is on.

`resolveOpenShard(streamsClient, streamArn)`: `DescribeStreamCommand({
StreamArn })`, then the last shard in `StreamDescription.Shards` without an
`EndingSequenceNumber` (still open). `GetShardIteratorCommand({ StreamArn,
ShardId, ShardIteratorType: 'LATEST' })` for a fresh iterator.

**Poll loop body**, per function, runs until stopped — shaped like SQS's
`runLoop` (in-flight skip, error backoff, `onStatus` patches) but `receive`
returns `{ records, streamArn }` instead of a single message, and there's
no `remove` step:
```
loop:
  if inFlight.has(fn.id): sleep(POLL_IDLE_MS); continue
  try:
    { records, streamArn } = await receive()   # GetRecords on the current iterator;
                                                  # re-resolves the shard + iterator on
                                                  # ExpiredIteratorException, a closed
                                                  # shard (no NextShardIterator), or any
                                                  # other client error
  catch (err):
    status = { state: 'error', message: err.message }
    sleep(ERROR_BACKOFF_MS); continue
  if records.length === 0: sleep(POLL_IDLE_MS); continue
  event = buildDynamoDbEvent(records, streamArn)
  await invokeFunction({ functionId: fn.id, event, source: { type: 'trigger', recordCount: records.length } })
```
No delete/remove call — advancing the shard iterator (`NextShardIterator`,
tracked internally by `receive`) is the only "consume" step, and it always
advances regardless of the invoke's outcome.

Credentials/endpoint: same dummy `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`
and the `dynamodb` entry's `endpoint` (`http://127.0.0.1:9402`)
`server/services/registry.js` already defines — read via `registry.entry('dynamodb')`,
the same way `sqs.js` reads `registry.entry('elasticmq')`. Both the
`DynamoDBClient` (table/stream admin calls) and `DynamoDBStreamsClient`
(shard/record calls) point at that one endpoint — DynamoDB Local serves
both APIs off the same port.

## Event shape

`buildDynamoDbEvent` produces the same shape a real Lambda DynamoDB Streams
event source mapping delivers — including the marshalled `AttributeValue`
format (`{ id: { S: 'abc' } }`) for `Keys`/`NewImage`/`OldImage`, since
that's what real AWS delivers too (unlike SQS/HTTP, Lambda does not
unmarshal DynamoDB images for you):
```js
{
  Records: [{
    eventID: record.eventID,
    eventName: record.eventName, // INSERT | MODIFY | REMOVE
    eventVersion: record.eventVersion ?? '1.1',
    eventSource: 'aws:dynamodb',
    awsRegion: record.awsRegion ?? 'local',
    dynamodb: {
      ApproximateCreationDateTime: /* epoch seconds, not a Date */,
      Keys: record.dynamodb.Keys,
      NewImage: record.dynamodb.NewImage,
      OldImage: record.dynamodb.OldImage,
      SequenceNumber: record.dynamodb.SequenceNumber,
      SizeBytes: record.dynamodb.SizeBytes,
      StreamViewType: record.dynamodb.StreamViewType,
    },
    eventSourceARN: streamArn, // added here — GetRecords itself doesn't include it,
                                // the same way a real event source mapping adds it
  }],
}
```

## History

Reuses the existing `source` tagging (`invokeFunction`'s `source` param,
already generic since the SQS trigger added it). Since a DynamoDB-triggered
invoke is inherently a batch (unlike SQS's one-message-per-invoke), there's
no single message id to tag it with — `source: { type: 'trigger',
recordCount: records.length }`. The History tab's existing `source?.type
=== 'trigger'` badge already renders for any trigger type with no changes
needed.

## Manager wiring

`server/trigger/manager.js` gains a third branch in `sync()`, structured
like the existing `sqs`/`http` branches: its own `Map<functionId, {tableName,
stop, status, cancelled}>` (`runningDynamo`, paralleling `running` for SQS),
`stopDynamo(functionId)`, folded into `stop()`, `stopAll()`, `status()`,
`statusAll()`. The existing mutual-exclusion cleanup (stopping a function's
registration under one trigger type when `sync` sees a different type) is
extended to cover all three types pairwise, the same reasoning that already
covers switching sqs \<-\> http on one function.

## Validation

`server/api/functions.js`'s `triggerError`: `trigger.type` accepts
`'dynamodb'`; when it does, `trigger.tableName` must be a non-empty string
(same rule shape as `queueName`).

`server/projectconfig.js`'s `parseTrigger`: a `playground.json` can declare
`{"trigger": {"type": "dynamodb", "tableName": "my-table"}}`, same as it
already does for `sqs`/`http`.

## API / UI

- No new endpoints — `GET /api/triggers` and `PATCH /functions/:id`
  already handle any trigger type generically.
- Trigger picker (`web/src/components/trigger-button.tsx`): a third
  `Select` option "DynamoDB Streams", with a table-name text input
  (mirrors the SQS queue-name input). `TriggerToggle` and
  `TriggerStatusBadge` need no changes — both are already generic over
  `trigger.enabled` / `status.state` (the `polling` state SQS uses fits
  the dynamodb poller too, no new status states).

## New dependencies

`@aws-sdk/client-dynamodb` (table describe/update, to read and enable the
stream) and `@aws-sdk/client-dynamodb-streams` (`DescribeStream`,
`GetShardIterator`, `GetRecords`) — both added to `package.json`
`dependencies`, alongside the existing `@aws-sdk/client-sqs`.

## Non-goals

- Auto-creating the table itself (no key schema to infer it from — the
  table must already exist).
- Multi-shard / concurrent-open-shard handling during an active reshard.
- Checkpointing or replay across restarts — every (re)start reads from
  `LATEST`.
- Configurable poll interval, view type, or shard-selection strategy.
- `TRIM_HORIZON` backfill.

## Testing

- `tests/trigger-dynamodb.test.js`: hermetic, mirroring
  `tests/trigger-sqs.test.js` — `buildDynamoDbEvent` shaping (including the
  `ApproximateCreationDateTime` Date→epoch-seconds conversion and the
  `eventSourceARN` injection), and `runLoop` behavior (in-flight skip,
  error backoff, batch-per-`GetRecords`-call, no remove/ack step, idle
  sleep on an empty batch) against injected `receive`/`invokeFunction`
  fakes.
- `tests/trigger-manager.test.js`: a `dynamodb` branch alongside the
  existing `sqs`/`http` cases — starts the poller and promotes the
  `dynamodb` service, no-ops when already running against the same table,
  restarts on a table-name change, stops on disable, mutual exclusion
  against the other two trigger types, `resumeAll`/`stopAll`.
- `tests/effective-trigger.test.js`: a `playground.json`-declared
  `dynamodb` trigger case, mirroring the existing `sqs`/`http` cases.
- `tests/api.test.js`: `triggerError` validation for `type: 'dynamodb'`
  (missing/blank `tableName` rejected, valid shape accepted).
- `tests/trigger-docker.test.js`: real-docker end-to-end against
  `amazon/dynamodb-local`, matching the existing SQS end-to-end tests'
  skip-if-unavailable pattern — enable a trigger against a table created
  ahead of time, `PutItem` directly, assert the function was invoked with
  a real DynamoDB Streams `Records` shape and a `source.recordCount`-tagged
  history entry.
- Web: `trigger-button.test.tsx` gains a `dynamodb` case mirroring the
  existing `sqs` one (seeds/saves `tableName`, clears on blank).

## Verification

`npm run test:server`, `npm run test:web`, web typecheck, `npm run build`.
