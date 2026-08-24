const { test } = require('node:test');
const assert = require('node:assert');
const { buildSqsEvent, runLoop, POLL_IDLE_MS, ERROR_BACKOFF_MS } = require('../server/trigger/sqs');
const inFlight = require('../server/api/in-flight');

function message(overrides = {}) {
  return {
    MessageId: 'm1',
    ReceiptHandle: 'rh1',
    Body: '{"hello":"world"}',
    MD5OfBody: 'abc123',
    Attributes: {
      ApproximateReceiveCount: '2',
      SentTimestamp: '1700000000000',
      SenderId: 'AIDAEXAMPLE',
      ApproximateFirstReceiveTimestamp: '1700000000100',
    },
    MessageAttributes: {},
    ...overrides,
  };
}

test('buildSqsEvent shapes a real Lambda SQS event Records array', () => {
  const event = buildSqsEvent(message(), 'my-queue');
  assert.strictEqual(event.Records.length, 1);
  const record = event.Records[0];
  assert.strictEqual(record.messageId, 'm1');
  assert.strictEqual(record.receiptHandle, 'rh1');
  assert.strictEqual(record.body, '{"hello":"world"}');
  assert.strictEqual(record.md5OfBody, 'abc123');
  assert.strictEqual(record.eventSource, 'aws:sqs');
  assert.strictEqual(record.eventSourceARN, 'arn:aws:sqs:elasticmq:000000000000:my-queue');
  assert.strictEqual(record.awsRegion, 'elasticmq');
  assert.deepStrictEqual(record.attributes, {
    ApproximateReceiveCount: '2',
    SentTimestamp: '1700000000000',
    SenderId: 'AIDAEXAMPLE',
    ApproximateFirstReceiveTimestamp: '1700000000100',
  });
});

test('buildSqsEvent fills in safe defaults when SQS omits optional attributes', () => {
  const event = buildSqsEvent(message({ Attributes: undefined, MessageAttributes: undefined }), 'my-queue');
  assert.deepStrictEqual(event.Records[0].attributes, {
    ApproximateReceiveCount: '1', SentTimestamp: '', SenderId: '', ApproximateFirstReceiveTimestamp: '',
  });
  assert.deepStrictEqual(event.Records[0].messageAttributes, {});
});

test('idle and error backoff default to a couple of seconds', () => {
  assert.strictEqual(POLL_IDLE_MS, 2000);
  assert.strictEqual(ERROR_BACKOFF_MS, 2000);
});

test('runLoop invokes the function for a received message and deletes it', async () => {
  const controller = new AbortController();
  const calls = { invoke: [], remove: [] };
  const receive = async () => ({ MessageId: 'm1', ReceiptHandle: 'rh1', Body: 'x', MD5OfBody: 'y' });
  const remove = async (rh) => { calls.remove.push(rh); controller.abort(); };
  const invokeFunction = async (input) => { calls.invoke.push(input); return { status: 200 }; };

  await runLoop({
    fn: { id: 'fn1', trigger: { queueName: 'q1' } },
    signal: controller.signal,
    receive, remove, invokeFunction,
  });

  assert.strictEqual(calls.invoke.length, 1);
  assert.strictEqual(calls.invoke[0].functionId, 'fn1');
  assert.deepStrictEqual(calls.invoke[0].source, { type: 'trigger', messageId: 'm1' });
  assert.strictEqual(calls.invoke[0].event.Records[0].messageId, 'm1');
  assert.deepStrictEqual(calls.remove, ['rh1']);
});

test('runLoop deletes the message even when the invoke fails', async () => {
  const controller = new AbortController();
  const removed = [];
  const receive = async () => ({ MessageId: 'm1', ReceiptHandle: 'rh1', Body: 'x' });
  const remove = async (rh) => { removed.push(rh); controller.abort(); };
  const invokeFunction = async () => ({ status: 500 });

  await runLoop({
    fn: { id: 'fn1', trigger: { queueName: 'q1' } }, signal: controller.signal,
    receive, remove, invokeFunction,
  });

  assert.deepStrictEqual(removed, ['rh1']);
});

test('runLoop skips a poll cycle while the function is already in flight', async () => {
  const controller = new AbortController();
  inFlight.add('fn1');
  let receiveCalls = 0;
  const receive = async () => { receiveCalls++; return null; };
  const statuses = [];
  const sleep = async () => { inFlight.delete('fn1'); controller.abort(); };

  await runLoop({
    fn: { id: 'fn1', trigger: { queueName: 'q1' } }, signal: controller.signal,
    receive, remove: async () => {}, invokeFunction: async () => ({ status: 200 }),
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
    if (attempts === 1) throw new Error('connection refused');
    controller.abort();
    return null;
  };
  const statuses = [];
  const sleep = async () => {};

  await runLoop({
    fn: { id: 'fn1', trigger: { queueName: 'q1' } }, signal: controller.signal,
    receive, remove: async () => {}, invokeFunction: async () => ({ status: 200 }),
    onStatus: (s) => statuses.push(s), sleep,
  });

  assert.strictEqual(attempts, 2);
  assert.ok(statuses.some((s) => s.state === 'error' && s.lastError === 'connection refused'));
});

test('runLoop exits cleanly when aborted mid-receive', async () => {
  const controller = new AbortController();
  const receive = async () => {
    controller.abort();
    throw new Error('aborted');
  };
  const statuses = [];

  await runLoop({
    fn: { id: 'fn1', trigger: { queueName: 'q1' } }, signal: controller.signal,
    receive, remove: async () => {}, invokeFunction: async () => ({ status: 200 }),
    onStatus: (s) => statuses.push(s),
  });

  assert.ok(!statuses.some((s) => s.state === 'error'));
});
