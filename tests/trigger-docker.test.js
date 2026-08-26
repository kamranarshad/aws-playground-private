const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hasRuntime } = require('./helpers');
const {
  SQSClient, CreateQueueCommand, SendMessageCommand, GetQueueAttributesCommand,
} = require('@aws-sdk/client-sqs');
const { DynamoDBClient, CreateTableCommand, PutItemCommand } = require('@aws-sdk/client-dynamodb');

function imagePresent(image) {
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

const daemonUp = (() => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
})();

const ready = daemonUp && imagePresent('softwaremill/elasticmq-native') && hasRuntime('python3');
const readyDynamo = daemonUp && imagePresent('amazon/dynamodb-local') && hasRuntime('python3');

delete process.env.AWS_PLAYGROUND_DOCKER; // real docker, not a shim
process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-trig-e2e-'));

const api = require('../server/api');
const manager = require('../server/trigger/manager');
const localServices = require('../server/services');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function sqsClient() {
  return new SQSClient({
    endpoint: 'http://127.0.0.1:9324',
    region: 'elasticmq',
    credentials: { accessKeyId: 'playground', secretAccessKey: 'playground123' },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTriggerEntry(functionId, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    const entry = api.listHistory(functionId).body.entries.find((e) => e.source?.type === 'trigger');
    if (entry) return entry;
    await sleep(1000);
  }
  return null;
}

// updateFunction() fires manager.sync(fn) internally as fire-and-forget (the
// API stays synchronous by design), which starts ElasticMQ asynchronously.
// manager.status()'s `state` isn't a usable "confirmed ready" signal here:
// a freshly-created record defaults to state:'polling' optimistically,
// before localServices.start() has even been called — so polling for that
// state returns instantly regardless of whether ElasticMQ is actually up
// yet. Retrying the real network call directly is the reliable way to wait
// out the container's startup latency.
async function retryUntilReachable(action, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await action();
    } catch (err) {
      if (i === attempts - 1) throw err;
      await sleep(250);
    }
  }
}

test('enabling a trigger invokes the function when a message arrives, deletes it, and tags history',
  { skip: ready ? false : 'docker daemon, elasticmq image, or python3 not available' }, async () => {
  const created = api.createFunction({ name: 'trig-e2e', path: path.join(FIXTURES, 'python/hello'),
    runtime: 'python', handler: 'app.handler' });
  const fn = api.updateFunction(created.body.id,
    { trigger: { type: 'sqs', queueName: 'trigger-e2e-queue', enabled: true } }).body;

  const client = sqsClient();
  const { QueueUrl } = await retryUntilReachable(() =>
    client.send(new CreateQueueCommand({ QueueName: 'trigger-e2e-queue' })));
  await client.send(new SendMessageCommand({ QueueUrl, MessageBody: JSON.stringify({ hello: 'world' }) }));

  const entry = await waitForTriggerEntry(fn.id);
  assert.ok(entry, 'expected a trigger-sourced history entry');
  assert.strictEqual(entry.source.messageId.length > 0, true);
  assert.strictEqual(entry.event.Records[0].body, JSON.stringify({ hello: 'world' }));
  assert.strictEqual(entry.event.Records[0].eventSource, 'aws:sqs');
  assert.strictEqual(entry.ok, true);

  const attrs = await client.send(new GetQueueAttributesCommand({
    QueueUrl, AttributeNames: ['ApproximateNumberOfMessages'],
  }));
  assert.strictEqual(attrs.Attributes.ApproximateNumberOfMessages, '0');

  manager.stop(fn.id);
});

test('disabling a trigger stops consuming — the message is left on the queue',
  { skip: ready ? false : 'docker daemon, elasticmq image, or python3 not available' }, async () => {
  const created = api.createFunction({ name: 'trig-e2e-disable', path: path.join(FIXTURES, 'python/hello'),
    runtime: 'python', handler: 'app.handler' });
  let fn = api.updateFunction(created.body.id,
    { trigger: { type: 'sqs', queueName: 'trigger-e2e-disable-queue', enabled: true } }).body;

  const client = sqsClient();
  const { QueueUrl } = await retryUntilReachable(() =>
    client.send(new CreateQueueCommand({ QueueName: 'trigger-e2e-disable-queue' })));

  fn = api.updateFunction(created.body.id,
    { trigger: { type: 'sqs', queueName: 'trigger-e2e-disable-queue', enabled: false } }).body;
  await manager.sync(fn);

  await client.send(new SendMessageCommand({ QueueUrl, MessageBody: 'untouched' }));
  await sleep(3000);

  const before = api.listHistory(fn.id).body.entries.filter((e) => e.source?.type === 'trigger');
  assert.strictEqual(before.length, 0);
  const attrs = await client.send(new GetQueueAttributesCommand({
    QueueUrl, AttributeNames: ['ApproximateNumberOfMessages'],
  }));
  assert.strictEqual(attrs.Attributes.ApproximateNumberOfMessages, '1');
});

test('resumeAll resumes a previously enabled trigger after a simulated restart',
  { skip: ready ? false : 'docker daemon, elasticmq image, or python3 not available' }, async () => {
  const created = api.createFunction({ name: 'trig-e2e-resume', path: path.join(FIXTURES, 'python/hello'),
    runtime: 'python', handler: 'app.handler' });
  const fn = api.updateFunction(created.body.id,
    { trigger: { type: 'sqs', queueName: 'trigger-e2e-resume-queue', enabled: true } }).body;

  const client = sqsClient();
  const { QueueUrl } = await retryUntilReachable(() =>
    client.send(new CreateQueueCommand({ QueueName: 'trigger-e2e-resume-queue' })));

  manager.stopAll(); // simulate shutdown

  await manager.resumeAll(); // simulate a fresh process reading functions.json
  await client.send(new SendMessageCommand({ QueueUrl, MessageBody: 'after-restart' }));

  const entry = await waitForTriggerEntry(fn.id);
  assert.ok(entry, 'expected the resumed trigger to pick up the message');

  manager.stopAll();
});

function dynamoClient() {
  return new DynamoDBClient({
    endpoint: 'http://127.0.0.1:9402',
    region: 'local',
    credentials: { accessKeyId: 'playground', secretAccessKey: 'playground123' },
  });
}

// The table must already exist before a dynamodb trigger can be enabled
// (the trigger only ensures the stream, not the table itself — see the
// design doc's non-goals) — so, unlike the SQS tests above where enabling
// the trigger is what starts ElasticMQ, these tests must start DynamoDB
// Local themselves first, create the table, and only then enable the
// trigger.
async function ensureTable(tableName) {
  await localServices.start('dynamodb', { auto: false });
  const client = dynamoClient();
  try {
    await retryUntilReachable(() => client.send(new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    })));
  } catch (err) {
    if (!err.name?.includes('ResourceInUseException')) throw err;
  }
  return client;
}

test('enabling a dynamodb trigger invokes the function on a real stream record and tags history',
  { skip: readyDynamo ? false : 'docker daemon, dynamodb-local image, or python3 not available' }, async () => {
  const created = api.createFunction({ name: 'trig-e2e-ddb', path: path.join(FIXTURES, 'python/hello'),
    runtime: 'python', handler: 'app.handler' });
  const client = await ensureTable('trigger-e2e-table');
  const fn = api.updateFunction(created.body.id,
    { trigger: { type: 'dynamodb', tableName: 'trigger-e2e-table', enabled: true } }).body;

  // The trigger uses a LATEST shard iterator (see the design doc), and
  // exactly when that iterator gets resolved relative to manager.status()
  // flipping to 'polling' is an internal detail with no reliable external
  // signal (status flips optimistically at the top of the poll loop,
  // before the receive() call that actually resolves the iterator) — so,
  // unlike SQS where a message just waits on the queue for the poller to
  // catch up, a single write here can race the iterator and get missed.
  // Retry with a fresh item each time until one lands.
  let entry;
  for (let i = 0; i < 15 && !entry; i++) {
    await client.send(new PutItemCommand({
      TableName: 'trigger-e2e-table', Item: { id: { S: `item-${i}` }, name: { S: 'hello' } },
    }));
    entry = await waitForTriggerEntry(fn.id, 2);
  }
  assert.ok(entry, 'expected a trigger-sourced history entry');
  assert.strictEqual(entry.source.recordCount >= 1, true);
  assert.strictEqual(entry.event.Records[0].eventSource, 'aws:dynamodb');
  assert.strictEqual(entry.event.Records[0].eventName, 'INSERT');
  assert.match(entry.event.Records[0].dynamodb.Keys.id.S, /^item-\d+$/);
  assert.strictEqual(entry.ok, true);

  manager.stop(fn.id);
});

test('disabling a dynamodb trigger stops consuming — no new history entry is recorded',
  { skip: readyDynamo ? false : 'docker daemon, dynamodb-local image, or python3 not available' }, async () => {
  const created = api.createFunction({ name: 'trig-e2e-ddb-disable', path: path.join(FIXTURES, 'python/hello'),
    runtime: 'python', handler: 'app.handler' });
  const client = await ensureTable('trigger-e2e-ddb-disable-table');
  let fn = api.updateFunction(created.body.id,
    { trigger: { type: 'dynamodb', tableName: 'trigger-e2e-ddb-disable-table', enabled: true } }).body;

  fn = api.updateFunction(created.body.id,
    { trigger: { type: 'dynamodb', tableName: 'trigger-e2e-ddb-disable-table', enabled: false } }).body;
  await manager.sync(fn);

  await client.send(new PutItemCommand({
    TableName: 'trigger-e2e-ddb-disable-table', Item: { id: { S: 'item-1' } },
  }));
  await sleep(3000);

  const entries = api.listHistory(fn.id).body.entries.filter((e) => e.source?.type === 'trigger');
  assert.strictEqual(entries.length, 0);
});
