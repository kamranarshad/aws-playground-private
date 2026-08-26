const { test } = require('node:test');
const assert = require('node:assert');
const {
  buildDynamoDbEvent, runLoop, POLL_IDLE_MS, ERROR_BACKOFF_MS,
} = require('../server/trigger/dynamodb');
const inFlight = require('../server/api/in-flight');

function record(overrides = {}) {
  return {
    eventID: 'e1',
    eventName: 'INSERT',
    eventVersion: '1.1',
    eventSource: 'aws:dynamodb',
    awsRegion: 'local',
    dynamodb: {
      ApproximateCreationDateTime: new Date(1700000000000),
      Keys: { id: { S: 'abc' } },
      NewImage: { id: { S: 'abc' }, name: { S: 'hi' } },
      SequenceNumber: '111',
      SizeBytes: 26,
      StreamViewType: 'NEW_AND_OLD_IMAGES',
    },
    ...overrides,
  };
}

test('buildDynamoDbEvent shapes a real Lambda DynamoDB Streams Records array', () => {
  const event = buildDynamoDbEvent([record()], 'arn:aws:dynamodb:local:000000000000:table/t/stream/2026-08-26T00:00:00.000');
  assert.strictEqual(event.Records.length, 1);
  const r = event.Records[0];
  assert.strictEqual(r.eventID, 'e1');
  assert.strictEqual(r.eventName, 'INSERT');
  assert.strictEqual(r.eventVersion, '1.1');
  assert.strictEqual(r.eventSource, 'aws:dynamodb');
  assert.strictEqual(r.awsRegion, 'local');
  assert.strictEqual(r.eventSourceARN, 'arn:aws:dynamodb:local:000000000000:table/t/stream/2026-08-26T00:00:00.000');
  assert.deepStrictEqual(r.dynamodb.Keys, { id: { S: 'abc' } });
  assert.deepStrictEqual(r.dynamodb.NewImage, { id: { S: 'abc' }, name: { S: 'hi' } });
  assert.strictEqual(r.dynamodb.SequenceNumber, '111');
  assert.strictEqual(r.dynamodb.SizeBytes, 26);
  assert.strictEqual(r.dynamodb.StreamViewType, 'NEW_AND_OLD_IMAGES');
  assert.strictEqual(r.dynamodb.ApproximateCreationDateTime, 1700000000);
});

test('buildDynamoDbEvent turns a whole GetRecords batch into one event, one entry per record', () => {
  const event = buildDynamoDbEvent([record({ eventID: 'e1' }), record({ eventID: 'e2', eventName: 'MODIFY' })], 'arn1');
  assert.strictEqual(event.Records.length, 2);
  assert.strictEqual(event.Records[0].eventID, 'e1');
  assert.strictEqual(event.Records[1].eventID, 'e2');
  assert.strictEqual(event.Records[1].eventName, 'MODIFY');
});

test('idle and error backoff default to a couple of seconds', () => {
  assert.strictEqual(POLL_IDLE_MS, 2000);
  assert.strictEqual(ERROR_BACKOFF_MS, 2000);
});

test('runLoop invokes the function with every record from a single receive() batch', async () => {
  const controller = new AbortController();
  const calls = { invoke: [] };
  const receive = async () => {
    controller.abort();
    return { records: [record({ eventID: 'e1' }), record({ eventID: 'e2' })], streamArn: 'arn1' };
  };
  const invokeFunction = async (input) => { calls.invoke.push(input); return { status: 200 }; };

  await runLoop({
    fn: { id: 'fn1', trigger: { tableName: 't1' } },
    signal: controller.signal,
    receive, invokeFunction,
  });

  assert.strictEqual(calls.invoke.length, 1);
  assert.strictEqual(calls.invoke[0].functionId, 'fn1');
  assert.deepStrictEqual(calls.invoke[0].source, { type: 'trigger', recordCount: 2 });
  assert.strictEqual(calls.invoke[0].event.Records.length, 2);
  assert.strictEqual(calls.invoke[0].event.Records[0].eventSourceARN, 'arn1');
});

test('runLoop sleeps and retries when a receive() batch is empty, without invoking', async () => {
  const controller = new AbortController();
  let receiveCalls = 0;
  const receive = async () => { receiveCalls++; return { records: [], streamArn: 'arn1' }; };
  let invokeCalls = 0;
  const invokeFunction = async () => { invokeCalls++; return { status: 200 }; };
  const sleep = async () => { controller.abort(); };

  await runLoop({
    fn: { id: 'fn1', trigger: { tableName: 't1' } }, signal: controller.signal,
    receive, invokeFunction, sleep,
  });

  assert.strictEqual(receiveCalls, 1);
  assert.strictEqual(invokeCalls, 0);
});

test('runLoop skips a poll cycle while the function is already in flight', async () => {
  const controller = new AbortController();
  inFlight.add('fn1');
  let receiveCalls = 0;
  const receive = async () => { receiveCalls++; return { records: [], streamArn: 'arn1' }; };
  const statuses = [];
  const sleep = async () => { inFlight.delete('fn1'); controller.abort(); };

  await runLoop({
    fn: { id: 'fn1', trigger: { tableName: 't1' } }, signal: controller.signal,
    receive, invokeFunction: async () => ({ status: 200 }),
    onStatus: (s) => statuses.push(s), sleep,
  });

  assert.strictEqual(receiveCalls, 0);
  assert.ok(statuses.some((s) => s.state === 'idle'));
});

test('runLoop backs off and retries after a receive error, without crashing', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const receive = async () => {
    attempts++;
    if (attempts === 1) throw new Error('ExpiredIteratorException');
    controller.abort();
    return { records: [], streamArn: 'arn1' };
  };
  const statuses = [];
  const sleep = async () => {};

  await runLoop({
    fn: { id: 'fn1', trigger: { tableName: 't1' } }, signal: controller.signal,
    receive, invokeFunction: async () => ({ status: 200 }),
    onStatus: (s) => statuses.push(s), sleep,
  });

  assert.strictEqual(attempts, 2);
  assert.ok(statuses.some((s) => s.state === 'error' && s.lastError === 'ExpiredIteratorException'));
});

test('runLoop exits cleanly when aborted mid-receive', async () => {
  const controller = new AbortController();
  const receive = async () => {
    controller.abort();
    throw new Error('aborted');
  };
  const statuses = [];

  await runLoop({
    fn: { id: 'fn1', trigger: { tableName: 't1' } }, signal: controller.signal,
    receive, invokeFunction: async () => ({ status: 200 }),
    onStatus: (s) => statuses.push(s),
  });

  assert.ok(!statuses.some((s) => s.state === 'error'));
});

test('runLoop does not need an ack/remove step — a failed invoke still moves on to the next poll', async () => {
  const controller = new AbortController();
  let polls = 0;
  const receive = async () => {
    polls++;
    if (polls === 1) return { records: [record()], streamArn: 'arn1' };
    controller.abort();
    return { records: [], streamArn: 'arn1' };
  };
  const invokeFunction = async () => ({ status: 500 });
  const sleep = async () => {};

  await runLoop({
    fn: { id: 'fn1', trigger: { tableName: 't1' } }, signal: controller.signal,
    receive, invokeFunction, sleep,
  });

  assert.strictEqual(polls, 2);
});
