const { DynamoDBClient, DescribeTableCommand, UpdateTableCommand } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBStreamsClient, DescribeStreamCommand, GetShardIteratorCommand, GetRecordsCommand,
} = require('@aws-sdk/client-dynamodb-streams');
const { awsClientOptions } = require('../services/registry');
const defaultStore = require('../store');
const defaultLocalServices = require('../services');
const poller = require('./poller');

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
  const opts = awsClientOptions('dynamodb');
  return {
    dynamo: new DynamoDBClient({ ...opts, region: 'local' }),
    streams: new DynamoDBStreamsClient({ ...opts, region: 'local' }),
  };
}

// The table must already exist (there's no key schema to invent one from,
// unlike SQS's auto-created queue) — only the stream itself is ensured.
async function ensureStreamEnabled(dynamo, tableName) {
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
function makeReceiver(streams, streamArn) {
  let shardIterator = null;
  return async function receive() {
    if (!shardIterator) shardIterator = await resolveOpenShardIterator(streams, streamArn);
    let result;
    try {
      result = await streams.send(new GetRecordsCommand({ ShardIterator: shardIterator }));
    } catch (err) {
      shardIterator = null;
      throw err;
    }
    shardIterator = result.NextShardIterator ?? null; // null means the shard closed
    const records = result.Records ?? [];
    return records.length ? { records, streamArn } : null;
  };
}

function start(fn, { onStatus }) {
  return poller.start(fn, {
    onStatus,
    setup: async () => {
      const { dynamo, streams } = buildClients();
      const streamArn = await ensureStreamEnabled(dynamo, fn.trigger.tableName);
      return { receive: makeReceiver(streams, streamArn) };
    },
    buildEvent: (batch) => buildDynamoDbEvent(batch.records, batch.streamArn),
    buildSource: (batch) => ({ type: 'trigger', recordCount: batch.records.length }),
    sleepOnEmpty: true,
    invokeFunction: require('../api/invoke').invokeFunction,
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

async function startFor(fn, { store, localServices }) {
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
    const handle = module.exports.start(fn, { onStatus: (patch) => Object.assign(st, patch) });
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
  await startFor({ ...fn, trigger }, { store, localServices });
}

module.exports = {
  type: 'dynamodb',
  sync, stop, status, statusAll,
  buildDynamoDbEvent, buildClients, ensureStreamEnabled, resolveOpenShardIterator, makeReceiver, start,
};
