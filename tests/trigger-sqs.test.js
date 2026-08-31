const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeDockerShim, writeScenario } = require('./helpers');

// Hermetic like tests/services.test.js: a shim "docker" for the elasticmq
// start (localServices.start), and a monkeypatched poller.start for the poll
// loop itself — real network/docker is exercised by tests/trigger-docker.test.js.
const SHIM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-trig-sqs-'));
const { shim: SHIM, scenario: SCENARIO, calls: CALLS } = writeDockerShim(SHIM_DIR);
process.env.AWS_PLAYGROUND_DOCKER = SHIM;
process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-trig-sqs-data-'));

function scenario(map) {
  writeScenario(SCENARIO, map);
  fs.writeFileSync(CALLS, '');
}

function elasticmqAlreadyRunning() {
  scenario({ inspect: { code: 0, stdout: 'true' } });
}

const sqs = require('../server/trigger/sqs');
const store = require('../server/persistence/store');
const localServices = require('../server/services');
const originalLocalServicesStart = localServices.start;
const originalStart = sqs.start;

const { buildSqsEvent } = sqs;

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

// Shared in-flight guard / backoff / ack behavior lives in poller.js now and
// is tested once, generically, in tests/trigger-poller.test.js.

test('sync starts elasticmq and the poll loop when a trigger is enabled', async () => {
  elasticmqAlreadyRunning();
  // Monkeypatch localServices.start for fast hermetic test (no real TCP wait)
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  try {
    const stop = () => { stop.called = true; };
    sqs.start = (fn, { onStatus }) => { onStatus({ state: 'polling', lastError: null }); return { stop }; };
    const fn = store.create({ name: 'f1', path: '/tmp/f1', runtime: 'node',
      trigger: { type: 'sqs', queueName: 'q1', enabled: true } });

    await sqs.sync(fn, fn.trigger);

    assert.deepStrictEqual(sqs.status(fn.id), { state: 'polling', lastError: null, lastPolledAt: null });
    sqs.stop(fn.id);
    assert.strictEqual(stop.called, true);
  } finally {
    localServices.start = originalLocalServicesStart;
    sqs.start = originalStart;
  }
});

test('sync is a no-op when the trigger is already running with the same queue', async () => {
  elasticmqAlreadyRunning();
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  try {
    let starts = 0;
    sqs.start = (fn, { onStatus }) => { starts++; onStatus({ state: 'polling', lastError: null }); return { stop: () => {} }; };
    const fn = store.create({ name: 'f2', path: '/tmp/f2', runtime: 'node',
      trigger: { type: 'sqs', queueName: 'q2', enabled: true } });

    await sqs.sync(fn, fn.trigger);
    await sqs.sync(fn, fn.trigger);

    assert.strictEqual(starts, 1);
    sqs.stop(fn.id);
  } finally {
    localServices.start = originalLocalServicesStart;
    sqs.start = originalStart;
  }
});

test('sync restarts the loop when the queue name changes', async () => {
  elasticmqAlreadyRunning();
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  try {
    const stopped = [];
    let n = 0;
    sqs.start = (fn, { onStatus }) => {
      n++;
      const id = n;
      onStatus({ state: 'polling', lastError: null });
      return { stop: () => stopped.push(id) };
    };
    let fn = store.create({ name: 'f3', path: '/tmp/f3', runtime: 'node',
      trigger: { type: 'sqs', queueName: 'q3', enabled: true } });
    await sqs.sync(fn, fn.trigger);
    fn = store.update(fn.id, { trigger: { type: 'sqs', queueName: 'q3-renamed', enabled: true } });
    await sqs.sync(fn, fn.trigger);

    assert.deepStrictEqual(stopped, [1]);
    assert.strictEqual(n, 2);
    sqs.stop(fn.id);
  } finally {
    localServices.start = originalLocalServicesStart;
    sqs.start = originalStart;
  }
});

test('sync stops the loop when the trigger is disabled', async () => {
  elasticmqAlreadyRunning();
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  try {
    let stopped = false;
    sqs.start = (fn, { onStatus }) => { onStatus({ state: 'polling', lastError: null }); return { stop: () => { stopped = true; } }; };
    let fn = store.create({ name: 'f4', path: '/tmp/f4', runtime: 'node',
      trigger: { type: 'sqs', queueName: 'q4', enabled: true } });
    await sqs.sync(fn, fn.trigger);
    fn = store.update(fn.id, { trigger: { type: 'sqs', queueName: 'q4', enabled: false } });
    await sqs.sync(fn, fn.trigger);

    assert.strictEqual(stopped, true);
    assert.strictEqual(sqs.status(fn.id), undefined);
  } finally {
    localServices.start = originalLocalServicesStart;
    sqs.start = originalStart;
  }
});

test('a service start failure is reported as an error status, not thrown', async () => {
  scenario({ inspect: { code: 1, stdout: '' }, run: { code: 125, stdout: 'port is already allocated' } });
  // Restore the original localServices.start to exercise the real docker-shim failure path
  // (The docker run command fails before reaching the waitReady check)
  localServices.start = originalLocalServicesStart;
  try {
    const fn = store.create({ name: 'f5', path: '/tmp/f5', runtime: 'node',
      trigger: { type: 'sqs', queueName: 'q5', enabled: true } });

    await sqs.sync(fn, fn.trigger);

    const st = sqs.status(fn.id);
    assert.strictEqual(st.state, 'error');
    assert.match(st.lastError, /port is already allocated/);
    sqs.stop(fn.id);
  } finally {
    // No need to restore here since the next test sets its own monkeypatch
  }
});

test('stop() called while sync() is still starting elasticmq prevents the poller from ever starting', async () => {
  let resolveStart;
  localServices.start = () => new Promise((resolve) => { resolveStart = resolve; });
  try {
    let sqsStartCalled = false;
    sqs.start = (fn, { onStatus }) => {
      sqsStartCalled = true;
      onStatus({ state: 'polling', lastError: null });
      return { stop: () => {} };
    };
    const fn = store.create({ name: 'f6', path: '/tmp/f6', runtime: 'node',
      trigger: { type: 'sqs', queueName: 'q6', enabled: true } });

    const syncPromise = sqs.sync(fn, fn.trigger); // don't await yet — it's stuck on localServices.start
    sqs.stop(fn.id); // race: stop before elasticmq "finishes starting"
    resolveStart({ ok: true, state: 'running', output: '' }); // now let it finish
    await syncPromise;

    assert.strictEqual(sqsStartCalled, false, 'sqs.start must never be called once cancelled');
    assert.strictEqual(sqs.status(fn.id), undefined);
  } finally {
    localServices.start = originalLocalServicesStart;
    sqs.start = originalStart;
  }
});
