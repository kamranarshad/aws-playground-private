const { test, after } = require('node:test');
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
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const s3Trigger = require('../server/trigger/s3');

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
// python3 too: both s3 cases invoke the fixtures/python/hello fixture, the
// same one the elasticmq cases above use.
const s3Ready = daemonUp && imagePresent('minio/minio') && hasRuntime('python3');

let s3ListenerPromise;
function ensureS3Listener() {
  if (!s3ListenerPromise) {
    s3ListenerPromise = s3Trigger.createListener({
      port: 9501,
      routesFor: manager.s3RoutesFor,
      invokeFunction: require('../server/api/invoke').invokeFunction,
    });
  }
  return s3ListenerPromise;
}

function s3Client() {
  return new S3Client({
    endpoint: 'http://127.0.0.1:9400',
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'playground', secretAccessKey: 'playground123' },
  });
}

// Unlike production (where the S3 webhook listener is process-lifetime,
// started once from bin/cli.js), this file starts it directly to exercise
// the real webhook path — close it once every test here has run so the
// open port doesn't keep this test file's process alive indefinitely.
after(async () => {
  if (!s3ListenerPromise) return;
  const listener = await s3ListenerPromise;
  listener.stop();
});

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

  await manager.resumeAll(api.invokeFunction); // simulate a fresh process reading functions.json
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

test('enabling an S3 trigger invokes the function when an object is created, and tags history',
  { skip: s3Ready ? false : 'docker daemon, minio image, or python3 not available' }, async () => {
  await ensureS3Listener();
  const created = api.createFunction({ name: 's3-trig-e2e', path: path.join(FIXTURES, 'python/hello'),
    runtime: 'python', handler: 'app.handler' });
  const fn = api.updateFunction(created.body.id,
    { trigger: { type: 's3', bucket: 's3-trigger-e2e-bucket', events: ['ObjectCreated'], enabled: true } }).body;

  await retryUntilReachable(() => fetch('http://127.0.0.1:9400/minio/health/live'));
  await sleep(1000); // let manager.sync's ensureBucketConfig create the bucket + webhook config

  const client = s3Client();
  await client.send(new PutObjectCommand({ Bucket: 's3-trigger-e2e-bucket', Key: 'hello.txt', Body: 'hi' }));

  const entry = await waitForTriggerEntry(fn.id);
  assert.ok(entry, 'expected a trigger-sourced history entry');
  assert.strictEqual(entry.source.bucket, 's3-trigger-e2e-bucket');
  assert.strictEqual(entry.source.key, 'hello.txt');
  assert.strictEqual(entry.event.Records[0].eventSource, 'aws:s3');
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

test('a prefix filter only matches keys under that prefix',
  { skip: s3Ready ? false : 'docker daemon, minio image, or python3 not available' }, async () => {
  await ensureS3Listener();
  const created = api.createFunction({ name: 's3-trig-e2e-prefix', path: path.join(FIXTURES, 'python/hello'),
    runtime: 'python', handler: 'app.handler' });
  const fn = api.updateFunction(created.body.id,
    { trigger: { type: 's3', bucket: 's3-trigger-e2e-bucket', events: ['ObjectCreated'],
      prefix: 'images/', enabled: true } }).body;

  await retryUntilReachable(() => fetch('http://127.0.0.1:9400/minio/health/live'));
  await sleep(1000);

  const client = s3Client();
  await client.send(new PutObjectCommand({ Bucket: 's3-trigger-e2e-bucket', Key: 'not-matching.txt', Body: 'x' }));
  await client.send(new PutObjectCommand({ Bucket: 's3-trigger-e2e-bucket', Key: 'images/pic.png', Body: 'x' }));

  const entry = await waitForTriggerEntry(fn.id);
  assert.ok(entry);
  assert.strictEqual(entry.source.key, 'images/pic.png');

  manager.stop(fn.id);
});
