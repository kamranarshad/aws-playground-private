const { requireOptional } = require('../optional-deps');
const { awsClientOptions } = require('../services/registry');
const defaultStore = require('../persistence/store');
const defaultLocalServices = require('../services');
const poller = require('./poller');

const DYNAMODB_MISSING_MESSAGE =
  'DynamoDB Streams triggers need `@aws-sdk/client-dynamodb`; run `npm i @aws-sdk/client-dynamodb` to enable them.';
const DYNAMODB_STREAMS_MISSING_MESSAGE =
  'DynamoDB Streams triggers need `@aws-sdk/client-dynamodb-streams`; run `npm i @aws-sdk/client-dynamodb-streams` to enable them.';

// Both @aws-sdk/client-dynamodb and @aws-sdk/client-dynamodb-streams are
// optionalDependencies -- loaded on first use so a checkout without them can
// still boot and use every other trigger type.
let _dynamoSdk;
function dynamoSdk() {
  if (!_dynamoSdk) _dynamoSdk = requireOptional('@aws-sdk/client-dynamodb', DYNAMODB_MISSING_MESSAGE);
  return _dynamoSdk;
}

let _streamsSdk;
function streamsSdk() {
  if (!_streamsSdk) _streamsSdk = requireOptional('@aws-sdk/client-dynamodb-streams', DYNAMODB_STREAMS_MISSING_MESSAGE);
  return _streamsSdk;
}

function buildDynamoDbEvent(records, streamArn) {
  return {
    Records: records.map((r) => ({
      eventID: r.eventID,
      eventName: r.eventName,
      eventVersion: r.eventVersion ?? '1.1',
      eventSource: 'aws:dynamodb',
      awsRegion: r.awsRegion ?? 'local',
      dynamodb: {
        ApproximateCreationDateTime: r.dynamodb?.ApproximateCreationDateTime
          ? Math.floor(new Date(r.dynamodb.ApproximateCreationDateTime).getTime() / 1000)
          : undefined,
        Keys: r.dynamodb?.Keys ?? {},
        NewImage: r.dynamodb?.NewImage,
        OldImage: r.dynamodb?.OldImage,
        SequenceNumber: r.dynamodb?.SequenceNumber,
        SizeBytes: r.dynamodb?.SizeBytes,
        StreamViewType: r.dynamodb?.StreamViewType,
      },
      eventSourceARN: streamArn,
    })),
  };
}

function buildClients() {
  const { DynamoDBClient } = dynamoSdk();
  const { DynamoDBStreamsClient } = streamsSdk();
  const opts = awsClientOptions('dynamodb');
  return {
    dynamo: new DynamoDBClient({ ...opts, region: 'local' }),
    streams: new DynamoDBStreamsClient({ ...opts, region: 'local' }),
  };
}

// The table must already exist (there's no key schema to invent one from,
// unlike SQS's auto-created queue) — only the stream itself is ensured.
async function ensureStreamEnabled(dynamo, tableName) {
  const { DescribeTableCommand, UpdateTableCommand } = dynamoSdk();
  const { Table } = await dynamo.send(new DescribeTableCommand({ TableName: tableName }));
  if (Table.StreamSpecification?.StreamEnabled) return Table.LatestStreamArn;
  const { TableDescription } = await dynamo.send(new UpdateTableCommand({
    TableName: tableName,
    StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' },
  }));
  return TableDescription.LatestStreamArn;
}

// v1 tracks a single open shard — the last one DescribeStream reports
// without an EndingSequenceNumber. A concurrent multi-shard reshard is a
// documented non-goal, not something this walks ParentShardId lineage for.
async function resolveOpenShardIterator(streams, streamArn) {
  const { DescribeStreamCommand, GetShardIteratorCommand } = streamsSdk();
  const { StreamDescription } = await streams.send(new DescribeStreamCommand({ StreamArn: streamArn }));
  const shards = StreamDescription.Shards ?? [];
  const openShard = [...shards].reverse().find((s) => !s.SequenceNumberRange?.EndingSequenceNumber);
  if (!openShard) throw new Error(`no open shard found for stream ${streamArn}`);
  const { ShardIterator } = await streams.send(new GetShardIteratorCommand({
    StreamArn: streamArn, ShardId: openShard.ShardId, ShardIteratorType: 'LATEST',
  }));
  return ShardIterator;
}

// Wraps GetRecords with automatic re-resolution of the shard iterator on
// expiry or shard closure — always resuming at LATEST, per the "no
// checkpointing across restarts/reshards" scope decision. Returns null for
// an empty batch so the shared poller's generic "nothing to process" check
// works the same way SQS's null-message case does.
//
// The *stream* is re-resolved too, not just the shard. Recreating a table is
// ordinary during development and it replaces the table's stream; resolving
// the ARN once when the poller started left it pinned to the dead stream
// forever, delivering nothing until the playground was restarted. Both are
// looked up from the table name on demand, so anything that replaces the
// stream underneath simply costs one failed poll and a re-resolve.
function makeReceiver(dynamo, streams, tableName) {
  let streamArn = null;
  let shardIterator = null;
  const reset = () => { streamArn = null; shardIterator = null; };
  return async function receive() {
    const { GetRecordsCommand } = streamsSdk();
    try {
      if (!streamArn) streamArn = await ensureStreamEnabled(dynamo, tableName);
      if (!shardIterator) shardIterator = await resolveOpenShardIterator(streams, streamArn);
    } catch (err) {
      reset();
      throw err;
    }
    const currentArn = streamArn;
    let result;
    try {
      result = await streams.send(new GetRecordsCommand({ ShardIterator: shardIterator }));
    } catch (err) {
      reset();
      throw err;
    }
    shardIterator = result.NextShardIterator ?? null; // null means the shard closed
    const records = result.Records ?? [];
    return records.length ? { records, streamArn: currentArn } : null;
  };
}

function start(fn, { onStatus, invokeFunction }) {
  return poller.start(fn, {
    onStatus,
    setup: async () => {
      const { dynamo, streams } = buildClients();
      return { receive: makeReceiver(dynamo, streams, fn.trigger.tableName) };
    },
    buildEvent: (batch) => buildDynamoDbEvent(batch.records, batch.streamArn),
    buildSource: (batch) => ({ type: 'trigger', recordCount: batch.records.length }),
    sleepOnEmpty: true,
    invokeFunction,
  });
}

// functionId -> { tableName, stop, status } — one DynamoDB Streams poller
// per function, same one-poller-per-function shape as sqs.js's `running`.
const running = new Map();

function status(functionId) {
  return running.get(functionId)?.status;
}

function statusAll() {
  const out = {};
  for (const [id, r] of running) out[id] = r.status;
  return out;
}

function stop(functionId) {
  const r = running.get(functionId);
  if (!r) return;
  r.stop();
  running.delete(functionId);
}

async function startFor(fn, { store, localServices, invokeFunction }) {
  const st = { state: 'polling', lastError: null, lastPolledAt: null };
  const record = {
    tableName: fn.trigger.tableName,
    status: st,
    cancelled: false,
    stop: () => { record.cancelled = true; },
  };
  running.set(fn.id, record);
  try {
    const started = await localServices.start('dynamodb', { auto: false });
    if (record.cancelled) return;
    if (!store.get(fn.id)) {
      running.delete(fn.id);
      return;
    }
    if (!started.ok) {
      Object.assign(st, { state: 'error', lastError: started.output || 'DynamoDB Local failed to start' });
      return;
    }
    const handle = module.exports.start(fn, { onStatus: (patch) => Object.assign(st, patch), invokeFunction });
    if (record.cancelled) {
      handle.stop();
      return;
    }
    record.stop = handle.stop;
  } catch (err) {
    if (!record.cancelled) Object.assign(st, { state: 'error', lastError: err.message });
  }
}

async function sync(fn, trigger, deps = {}) {
  const store = deps.store ?? defaultStore;
  const localServices = deps.localServices ?? defaultLocalServices;
  const shouldRun = !!trigger.enabled;
  const current = running.get(fn.id);
  if (!shouldRun) {
    if (current) stop(fn.id);
    return;
  }
  if (current && current.tableName === trigger.tableName && current.status.state !== 'error') return;
  if (current) stop(fn.id);
  // Same reasoning as sqs.js's sync: pass the resolved effective trigger
  // through fn so startFor reads the right table name whether it came from
  // playground.json or the manually-stored trigger.
  await startFor({ ...fn, trigger }, { store, localServices, invokeFunction: deps.invokeFunction });
}

module.exports = {
  type: 'dynamodb',
  sync, stop, status, statusAll,
  buildDynamoDbEvent, buildClients, ensureStreamEnabled, resolveOpenShardIterator, makeReceiver, start,
};
