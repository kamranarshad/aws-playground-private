const { requireOptional } = require('../optional-deps');
const { entry, AWS_DUMMY_CREDS } = require('../services/registry');
const inFlight = require('../api/in-flight');

const POLL_IDLE_MS = 2000;
const ERROR_BACKOFF_MS = 2000;

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

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
}

// GetRecords doesn't long-poll like SQS's ReceiveMessage — an empty result
// comes back immediately, so every empty batch and every error backs off by
// sleeping rather than hot-looping the API.
async function runLoop({ fn, signal, onStatus = () => {},
  receive, invokeFunction,
  idleMs = POLL_IDLE_MS, errorBackoffMs = ERROR_BACKOFF_MS, sleep = defaultSleep }) {
  while (!signal.aborted) {
    if (inFlight.has(fn.id)) {
      onStatus({ state: 'idle', lastError: null });
      try { await sleep(idleMs, signal); } catch { break; }
      continue;
    }
    let batch;
    try {
      onStatus({ state: 'polling', lastError: null });
      batch = await receive({ signal });
    } catch (err) {
      if (signal.aborted) break;
      onStatus({ state: 'error', lastError: err.message });
      try { await sleep(errorBackoffMs, signal); } catch { break; }
      continue;
    }
    onStatus({ state: 'polling', lastError: null, lastPolledAt: Date.now() });
    if (!batch.records || batch.records.length === 0) {
      try { await sleep(idleMs, signal); } catch { break; }
      continue;
    }
    const event = buildDynamoDbEvent(batch.records, batch.streamArn);
    // No ack/delete step — the shard iterator (tracked inside `receive`)
    // already advanced past this batch regardless of what happens next, the
    // DynamoDB-Streams equivalent of SQS deleting a message whether the
    // invoke succeeds or fails.
    try {
      await invokeFunction({
        functionId: fn.id,
        event,
        source: { type: 'trigger', recordCount: batch.records.length },
      });
    } catch (err) {
      onStatus({ state: 'error', lastError: `invoke failed: ${err.message}` });
    }
  }
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
  const svc = entry('dynamodb');
  const credentials = {
    accessKeyId: AWS_DUMMY_CREDS.AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_DUMMY_CREDS.AWS_SECRET_ACCESS_KEY,
  };
  return {
    dynamo: new DynamoDBClient({ endpoint: svc.endpoint, region: 'local', credentials }),
    streams: new DynamoDBStreamsClient({ endpoint: svc.endpoint, region: 'local', credentials }),
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
// checkpointing across restarts/reshards" scope decision.
function makeReceiver(streams, streamArn) {
  let shardIterator = null;
  return async function receive() {
    const { GetRecordsCommand } = streamsSdk();
    if (!shardIterator) shardIterator = await resolveOpenShardIterator(streams, streamArn);
    let result;
    try {
      result = await streams.send(new GetRecordsCommand({ ShardIterator: shardIterator }));
    } catch (err) {
      shardIterator = null;
      throw err;
    }
    shardIterator = result.NextShardIterator ?? null; // null means the shard closed
    return { records: result.Records ?? [], streamArn };
  };
}

function start(fn, { onStatus }) {
  const controller = new AbortController();
  (async () => {
    try {
      const { dynamo, streams } = buildClients();
      const streamArn = await ensureStreamEnabled(dynamo, fn.trigger.tableName);
      const receive = makeReceiver(streams, streamArn);
      await runLoop({
        fn,
        signal: controller.signal,
        onStatus,
        receive,
        invokeFunction: require('../api/invoke').invokeFunction,
      });
    } catch (err) {
      if (!controller.signal.aborted) onStatus({ state: 'error', lastError: err.message });
    }
  })();
  return { stop: () => controller.abort() };
}

module.exports = {
  buildDynamoDbEvent, runLoop, POLL_IDLE_MS, ERROR_BACKOFF_MS,
  buildClients, ensureStreamEnabled, resolveOpenShardIterator, makeReceiver, start,
};
