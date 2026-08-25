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

delete process.env.AWS_PLAYGROUND_DOCKER; // real docker, not a shim
process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-trig-e2e-'));

const api = require('../server/api');
const manager = require('../server/trigger/manager');

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
