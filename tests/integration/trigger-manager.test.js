const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeDockerShim, writeScenario } = require('../helpers');

// Hermetic like tests/services.test.js: a shim "docker" for the elasticmq/
// dynamodb-local start (localServices.start), and monkeypatched driver
// internals for the poll loop / listener itself — real network/docker is
// exercised by tests/trigger-docker.test.js. What's tested here is strictly
// manager-level: dispatching to the right driver, cleaning up stale
// registrations when a function switches trigger type, resolving the
// effective trigger, and the resumeAll/stopAll aggregation across drivers —
// each driver's own sync/stop/status state machine has its own test file.
const SHIM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-trig-mgr-'));
const { shim: SHIM, scenario: SCENARIO, calls: CALLS } = writeDockerShim(SHIM_DIR);
process.env.AWS_PLAYGROUND_DOCKER = SHIM;
process.env.AWS_PLAYGROUND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-trig-mgr-data-'));

function scenario(map) {
  writeScenario(SCENARIO, map);
  fs.writeFileSync(CALLS, '');
}

function elasticmqAlreadyRunning() {
  scenario({ inspect: { code: 0, stdout: 'true' } });
}

const sqs = require('../../server/trigger/sqs');
const store = require('../../server/persistence/store');
const localServices = require('../../server/services');
const manager = require('../../server/trigger/manager');
const httpTrigger = require('../../server/trigger/http');
const dynamodbTrigger = require('../../server/trigger/dynamodb');
const originalCreateListener = httpTrigger.createListener;
const s3Trigger = require('../../server/trigger/s3');
const originalEnsureBucketConfig = s3Trigger.ensureBucketConfig;

// Save the original localServices.start so we can restore it between tests
const originalLocalServicesStart = localServices.start;

test('resumeAll starts a poller for every function with an enabled trigger; stopAll tears them all down', async () => {
  elasticmqAlreadyRunning();
  // Monkeypatch localServices.start for fast hermetic test (no real TCP wait)
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  try {
    const started = [];
    sqs.start = (fn, { onStatus }) => {
      started.push(fn.id);
      onStatus({ state: 'polling', lastError: null });
      return { stop: () => {} };
    };
    const a = store.create({ name: 'a', path: '/tmp/a', runtime: 'node',
      trigger: { type: 'sqs', queueName: 'qa', enabled: true } });
    const b = store.create({ name: 'b', path: '/tmp/b', runtime: 'node' });

    await manager.resumeAll();

    assert.ok(started.includes(a.id));
    assert.ok(!started.includes(b.id));
    manager.stopAll();
    assert.deepStrictEqual(manager.status(a.id), { state: 'idle', lastError: null, lastPolledAt: null });
  } finally {
    localServices.start = originalLocalServicesStart;
  }
});

test('resumeAll starts a dynamodb poller for every function with an enabled trigger; stopAll tears them all down', async () => {
  elasticmqAlreadyRunning();
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  const started = [];
  dynamodbTrigger.start = (fn, { onStatus }) => {
    started.push(fn.id);
    onStatus({ state: 'polling', lastError: null });
    return { stop: () => {} };
  };
  const a = store.create({ name: 'da', path: '/tmp/da', runtime: 'node',
    trigger: { type: 'dynamodb', tableName: 'tbla', enabled: true } });
  const b = store.create({ name: 'db', path: '/tmp/db', runtime: 'node' });

  await manager.resumeAll();

  assert.ok(started.includes(a.id));
  assert.ok(!started.includes(b.id));
  manager.stopAll();
  assert.deepStrictEqual(manager.status(a.id), { state: 'idle', lastError: null, lastPolledAt: null });
  store.remove(a.id);
  store.remove(b.id);
  localServices.start = originalLocalServicesStart;
});

test('switching a function from an sqs trigger to a dynamodb trigger stops the sqs poller and starts the dynamodb one', async () => {
  elasticmqAlreadyRunning();
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  let sqsStopped = false;
  sqs.start = (fn, { onStatus }) => { onStatus({ state: 'polling', lastError: null }); return { stop: () => { sqsStopped = true; } }; };
  let dynamoCalls = 0;
  dynamodbTrigger.start = (fn, { onStatus }) => {
    dynamoCalls++;
    onStatus({ state: 'polling', lastError: null });
    return { stop: () => {} };
  };
  let fn = store.create({ name: 'd6', path: '/tmp/d6', runtime: 'node',
    trigger: { type: 'sqs', queueName: 'q6', enabled: true } });
  await manager.sync(fn);

  fn = store.update(fn.id, { trigger: { type: 'dynamodb', tableName: 'tbl6', enabled: true } });
  await manager.sync(fn);

  assert.strictEqual(sqsStopped, true);
  assert.strictEqual(dynamoCalls, 1);
  assert.deepStrictEqual(manager.status(fn.id), { state: 'polling', lastError: null, lastPolledAt: null });
  manager.stop(fn.id);
  store.remove(fn.id);
  localServices.start = originalLocalServicesStart;
});

test('sync resolves a dynamodb trigger declared only in playground.json (fn.trigger stays null)', async () => {
  elasticmqAlreadyRunning();
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-trig-mgr-eff-ddb-'));
  fs.writeFileSync(path.join(dir, 'playground.json'),
    JSON.stringify({ trigger: { type: 'dynamodb', tableName: 'from-file' } }));
  let startedTableName;
  dynamodbTrigger.start = (fn, { onStatus }) => {
    startedTableName = fn.trigger.tableName;
    onStatus({ state: 'polling', lastError: null });
    return { stop: () => {} };
  };
  const fn = store.create({ name: 'eff-ddb', path: dir, runtime: 'node' }); // no manual trigger

  await manager.sync(fn);

  assert.strictEqual(startedTableName, 'from-file');
  assert.deepStrictEqual(manager.status(fn.id), { state: 'polling', lastError: null, lastPolledAt: null });
  manager.stop(fn.id);
  store.remove(fn.id);
  localServices.start = originalLocalServicesStart;
});

test('switching a function from an sqs trigger to an http trigger stops the poller and registers the http route', async () => {
  elasticmqAlreadyRunning();
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  let sqsStopped = false;
  sqs.start = (fn, { onStatus }) => { onStatus({ state: 'polling', lastError: null }); return { stop: () => { sqsStopped = true; } }; };
  let httpCalls = 0;
  httpTrigger.createListener = async () => {
    httpCalls++;
    return { stop: () => {}, server: { address: () => ({ port: 9500 }) } };
  };
  try {
    let fn = store.create({ name: 'h5', path: '/tmp/h5', runtime: 'node',
      trigger: { type: 'sqs', queueName: 'q5', enabled: true } });
    await manager.sync(fn);

    fn = store.update(fn.id, { trigger: { type: 'http', enabled: true } });
    await manager.sync(fn);

    assert.strictEqual(sqsStopped, true);
    assert.strictEqual(httpCalls, 1);
    assert.deepStrictEqual(manager.status(fn.id), { state: 'listening', lastError: null, lastPolledAt: null });
    manager.stop(fn.id);
  } finally {
    localServices.start = originalLocalServicesStart;
    httpTrigger.createListener = originalCreateListener;
  }
});

test('resumeAll starts the shared listener for every function with an enabled http trigger; stopAll tears it down', async () => {
  let calls = 0;
  let stopped = false;
  httpTrigger.createListener = async () => {
    calls++;
    return { stop: () => { stopped = true; }, server: { address: () => ({ port: 9500 }) } };
  };
  try {
    const a = store.create({ name: 'h7a', path: '/tmp/h7a', runtime: 'node', trigger: { type: 'http', enabled: true } });
    const b = store.create({ name: 'h7b', path: '/tmp/h7b', runtime: 'node' });

    await manager.resumeAll();

    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(manager.status(a.id), { state: 'listening', lastError: null, lastPolledAt: null });
    assert.deepStrictEqual(manager.status(b.id), { state: 'idle', lastError: null, lastPolledAt: null });

    manager.stopAll();
    assert.strictEqual(stopped, true);
    assert.deepStrictEqual(manager.status(a.id), { state: 'idle', lastError: null, lastPolledAt: null });
  } finally {
    httpTrigger.createListener = originalCreateListener;
  }
});

test('sync resolves an sqs trigger declared only in playground.json (fn.trigger stays null)', async () => {
  elasticmqAlreadyRunning();
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-trig-mgr-eff-'));
    fs.writeFileSync(path.join(dir, 'playground.json'),
      JSON.stringify({ trigger: { type: 'sqs', queueName: 'from-file' } }));
    let startedQueueName;
    sqs.start = (fn, { onStatus }) => {
      startedQueueName = fn.trigger.queueName;
      onStatus({ state: 'polling', lastError: null });
      return { stop: () => {} };
    };
    const fn = store.create({ name: 'eff-sqs', path: dir, runtime: 'node' }); // no manual trigger

    await manager.sync(fn);

    assert.strictEqual(startedQueueName, 'from-file');
    assert.deepStrictEqual(manager.status(fn.id), { state: 'polling', lastError: null, lastPolledAt: null });
    manager.stop(fn.id);
  } finally {
    localServices.start = originalLocalServicesStart;
  }
});

test('sync resolves an http trigger declared only in playground.json, overriding a manual sqs one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-trig-mgr-eff2-'));
  fs.writeFileSync(path.join(dir, 'playground.json'), JSON.stringify({ trigger: { type: 'http' } }));
  let httpCalls = 0;
  httpTrigger.createListener = async () => {
    httpCalls++;
    return { stop: () => {}, server: { address: () => ({ port: 9500 }) } };
  };
  try {
    const fn = store.create({ name: 'eff-http', path: dir, runtime: 'node',
      trigger: { type: 'sqs', queueName: 'manual-queue', enabled: true } });

    await manager.sync(fn);

    assert.strictEqual(httpCalls, 1);
    assert.deepStrictEqual(manager.status(fn.id), { state: 'listening', lastError: null, lastPolledAt: null });
    manager.stop(fn.id);
  } finally {
    httpTrigger.createListener = originalCreateListener;
  }
});

test('a name containing "/" is never registered as an http route, even via playground.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-trig-mgr-eff3-'));
  fs.writeFileSync(path.join(dir, 'playground.json'), JSON.stringify({ trigger: { type: 'http' } }));
  let listenerCalls = 0;
  httpTrigger.createListener = async () => {
    listenerCalls++;
    return { stop: () => {}, server: { address: () => ({ port: 9500 }) } };
  };
  try {
    const fn = store.create({ name: 'has/slash', path: dir, runtime: 'node' });

    await manager.sync(fn);

    assert.strictEqual(listenerCalls, 0, 'no listener should ever start for an unroutable name');
    assert.deepStrictEqual(manager.status(fn.id), { state: 'idle', lastError: null, lastPolledAt: null });
  } finally {
    httpTrigger.createListener = originalCreateListener;
  }
});

test('switching a function from an s3 trigger to an sqs trigger clears its s3 route', async () => {
  elasticmqAlreadyRunning();
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  s3Trigger.ensureBucketConfig = async () => {};
  sqs.start = (fn, { onStatus }) => { onStatus({ state: 'polling', lastError: null }); return { stop: () => {} }; };
  try {
    let fn = store.create({ name: 's8', path: '/tmp/s8', runtime: 'node',
      trigger: { type: 's3', bucket: 'b8', events: ['ObjectCreated'], enabled: true } });
    await manager.sync(fn);
    fn = store.update(fn.id, { trigger: { type: 'sqs', queueName: 'q8', enabled: true } });
    await manager.sync(fn);

    assert.deepStrictEqual(manager.s3RoutesFor('b8'), []);
    assert.deepStrictEqual(manager.status(fn.id), { state: 'polling', lastError: null, lastPolledAt: null });
    manager.stop(fn.id);
    await manager.drainBucketConfigQueue();
  } finally {
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});

test('resumeAll configures every function with an enabled s3 trigger; stopAll tears them down', async () => {
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  s3Trigger.ensureBucketConfig = async () => {};
  try {
    const a = store.create({ name: 's9a', path: '/tmp/s9a', runtime: 'node',
      trigger: { type: 's3', bucket: 'b9', events: ['ObjectCreated'], enabled: true } });
    const b = store.create({ name: 's9b', path: '/tmp/s9b', runtime: 'node' });

    await manager.resumeAll();

    assert.deepStrictEqual(manager.status(a.id), { state: 'listening', lastError: null, lastPolledAt: null });
    assert.deepStrictEqual(manager.status(b.id), { state: 'idle', lastError: null, lastPolledAt: null });

    manager.stopAll();
    assert.deepStrictEqual(manager.s3RoutesFor('b9'), []);
    await manager.drainBucketConfigQueue();
  } finally {
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});

test('sync resolves an s3 trigger declared only in playground.json (fn.trigger stays null)', async () => {
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  s3Trigger.ensureBucketConfig = async () => {};
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-trig-mgr-eff-s3-'));
    fs.writeFileSync(path.join(dir, 'playground.json'),
      JSON.stringify({ trigger: { type: 's3', bucket: 'from-file', events: ['ObjectCreated'] } }));
    const fn = store.create({ name: 'eff-s3', path: dir, runtime: 'node' });

    await manager.sync(fn);

    assert.deepStrictEqual(manager.s3RoutesFor('from-file'),
      [{ functionId: fn.id, events: ['ObjectCreated'], prefix: undefined, suffix: undefined }]);
    manager.stop(fn.id);
    await manager.drainBucketConfigQueue();
  } finally {
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});

// The api/functions -> trigger/manager -> api/invoke cycle used to be dodged
// by lazily requiring ../api/invoke inside driver function bodies. It is now
// injected from the composition root instead, so what this pins is that the
// dependency actually travels manager.sync -> driver.sync -> driver.start
// rather than being silently re-required somewhere along the way.
test('manager.sync threads an injected invokeFunction down to the driver', async () => {
  elasticmqAlreadyRunning();
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  const originalSqsStart = sqs.start;
  try {
    const injected = async () => ({ status: 200, body: { ok: true } });
    let received;
    sqs.start = (fn, { onStatus, invokeFunction }) => {
      received = invokeFunction;
      onStatus({ state: 'polling', lastError: null });
      return { stop: () => {} };
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-trig-mgr-di-'));
    const fn = store.create({
      name: 'di-sqs', path: dir, runtime: 'node',
      trigger: { type: 'sqs', queueName: 'di-queue', enabled: true },
    });

    await manager.sync(fn, { invokeFunction: injected });

    assert.strictEqual(received, injected);
    manager.stop(fn.id);
  } finally {
    sqs.start = originalSqsStart;
    localServices.start = originalLocalServicesStart;
  }
});

// The invokeFunction dependency is injected rather than lazily required, so
// anything that forwards it has to pass the option *object* and not the bare
// function. Passing the function meant deps.invokeFunction was undefined and
// the poll loop called undefined(...) -- caught by runLoop and turned into an
// error status, so the only visible symptom was a trigger that quietly never
// fired. Nothing asserted the plumbing until this.
test('resumeAll forwards invokeFunction through to the driver', async () => {
  elasticmqAlreadyRunning();
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  try {
    let received;
    sqs.start = (fn, { onStatus, invokeFunction }) => {
      received = invokeFunction;
      onStatus({ state: 'polling', lastError: null });
      return { stop: () => {} };
    };
    store.create({ name: 'fwd', path: '/tmp/fwd', runtime: 'node',
      trigger: { type: 'sqs', queueName: 'q-fwd', enabled: true } });

    const invokeFunction = async () => ({ status: 200, body: {} });
    await manager.resumeAll({ invokeFunction });

    assert.strictEqual(received, invokeFunction,
      'the driver did not receive the injected invokeFunction');
  } finally {
    localServices.start = originalLocalServicesStart;
    manager.stopAll();
  }
});
