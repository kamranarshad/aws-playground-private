const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeDockerShim, writeScenario } = require('./helpers');

// Hermetic like tests/services.test.js: a shim "docker" for the elasticmq
// start (localServices.start), and a monkeypatched sqs.start for the poll
// loop itself — real network/docker is exercised by tests/trigger-docker.test.js.
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

const sqs = require('../server/trigger/sqs');
const store = require('../server/store');
const localServices = require('../server/services');
const manager = require('../server/trigger/manager');
const httpTrigger = require('../server/trigger/http');
const dynamodbTrigger = require('../server/trigger/dynamodb');
const originalCreateListener = httpTrigger.createListener;
const s3Trigger = require('../server/trigger/s3');
const originalEnsureBucketConfig = s3Trigger.ensureBucketConfig;

// Save the original localServices.start so we can restore it between tests
const originalLocalServicesStart = localServices.start;

test('sync starts elasticmq and the poll loop when a trigger is enabled', async () => {
  elasticmqAlreadyRunning();
  // Monkeypatch localServices.start for fast hermetic test (no real TCP wait)
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  try {
    const stop = () => { stop.called = true; };
    sqs.start = (fn, { onStatus }) => { onStatus({ state: 'polling', lastError: null }); return { stop }; };
    const fn = store.create({ name: 'f1', path: '/tmp/f1', runtime: 'node',
      trigger: { type: 'sqs', queueName: 'q1', enabled: true } });

    await manager.sync(fn);

    assert.deepStrictEqual(manager.status(fn.id), { state: 'polling', lastError: null, lastPolledAt: null });
    manager.stop(fn.id);
    assert.strictEqual(stop.called, true);
  } finally {
    localServices.start = originalLocalServicesStart;
  }
});

test('sync passes the injected invokeFunction stub straight through to sqs.start', async () => {
  elasticmqAlreadyRunning();
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  try {
    const invokeFunction = async () => ({ status: 200 });
    let received;
    sqs.start = (fn, opts) => { received = opts.invokeFunction; return { stop: () => {} }; };
    const fn = store.create({ name: 'f1-di', path: '/tmp/f1-di', runtime: 'node',
      trigger: { type: 'sqs', queueName: 'q1-di', enabled: true } });

    await manager.sync(fn, { invokeFunction });

    assert.strictEqual(received, invokeFunction);
    manager.stop(fn.id);
    store.remove(fn.id);
  } finally {
    localServices.start = originalLocalServicesStart;
  }
});

test('sync is a no-op when the trigger is already running with the same queue', async () => {
  elasticmqAlreadyRunning();
  // Monkeypatch localServices.start for fast hermetic test (no real TCP wait)
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  try {
    let starts = 0;
    sqs.start = (fn, { onStatus }) => { starts++; onStatus({ state: 'polling', lastError: null }); return { stop: () => {} }; };
    const fn = store.create({ name: 'f2', path: '/tmp/f2', runtime: 'node',
      trigger: { type: 'sqs', queueName: 'q2', enabled: true } });

    await manager.sync(fn);
    await manager.sync(fn);

    assert.strictEqual(starts, 1);
    manager.stop(fn.id);
  } finally {
    localServices.start = originalLocalServicesStart;
  }
});

test('sync restarts the loop when the queue name changes', async () => {
  elasticmqAlreadyRunning();
  // Monkeypatch localServices.start for fast hermetic test (no real TCP wait)
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
    await manager.sync(fn);
    fn = store.update(fn.id, { trigger: { type: 'sqs', queueName: 'q3-renamed', enabled: true } });
    await manager.sync(fn);

    assert.deepStrictEqual(stopped, [1]);
    assert.strictEqual(n, 2);
    manager.stop(fn.id);
  } finally {
    localServices.start = originalLocalServicesStart;
  }
});

test('sync stops the loop when the trigger is disabled', async () => {
  elasticmqAlreadyRunning();
  // Monkeypatch localServices.start for fast hermetic test (no real TCP wait)
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  try {
    let stopped = false;
    sqs.start = (fn, { onStatus }) => { onStatus({ state: 'polling', lastError: null }); return { stop: () => { stopped = true; } }; };
    let fn = store.create({ name: 'f4', path: '/tmp/f4', runtime: 'node',
      trigger: { type: 'sqs', queueName: 'q4', enabled: true } });
    await manager.sync(fn);
    fn = store.update(fn.id, { trigger: { type: 'sqs', queueName: 'q4', enabled: false } });
    await manager.sync(fn);

    assert.strictEqual(stopped, true);
    assert.deepStrictEqual(manager.status(fn.id), { state: 'idle', lastError: null, lastPolledAt: null });
  } finally {
    localServices.start = originalLocalServicesStart;
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

    await manager.sync(fn);

    const st = manager.status(fn.id);
    assert.strictEqual(st.state, 'error');
    assert.match(st.lastError, /port is already allocated/);
    manager.stop(fn.id);
  } finally {
    // No need to restore here since test 6 will set its own monkeypatch
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

    const syncPromise = manager.sync(fn); // don't await yet — it's stuck on localServices.start
    manager.stop(fn.id); // race: stop before elasticmq "finishes starting"
    resolveStart({ ok: true, state: 'running', output: '' }); // now let it finish
    await syncPromise;

    assert.strictEqual(sqsStartCalled, false, 'sqs.start must never be called once cancelled');
    assert.deepStrictEqual(manager.status(fn.id), { state: 'idle', lastError: null, lastPolledAt: null });
  } finally {
    localServices.start = originalLocalServicesStart;
  }
});

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

// The docker shim's "inspect" scenario key is container-agnostic (see
// writeDockerShim in helpers.js), so elasticmqAlreadyRunning()'s scenario
// setup works unchanged for the dynamodb-local container too.
//
// Every test below removes the function it created from the store once
// it's done (in addition to manager.stop) — an enabled trigger left behind
// in the shared in-process store would get resynced by a later
// resumeAll() call (the http tests further down make one), which would
// call the real localServices.start for 'dynamodb' if it happens to no
// longer be mocked by then. Real localServices.start really does block
// for its full ~30s waitReady timeout against a dynamodb-local endpoint
// nothing is listening on in this test process, so a leftover enabled
// function here would silently make an unrelated later test very slow.

test('sync starts dynamodb-local and the poll loop when a trigger is enabled', async () => {
  elasticmqAlreadyRunning();
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  const stop = () => { stop.called = true; };
  dynamodbTrigger.start = (fn, { onStatus }) => { onStatus({ state: 'polling', lastError: null }); return { stop }; };
  const fn = store.create({ name: 'd1', path: '/tmp/d1', runtime: 'node',
    trigger: { type: 'dynamodb', tableName: 'tbl1', enabled: true } });

  await manager.sync(fn);

  assert.deepStrictEqual(manager.status(fn.id), { state: 'polling', lastError: null, lastPolledAt: null });
  manager.stop(fn.id);
  assert.strictEqual(stop.called, true);
  store.remove(fn.id);
});

test('sync passes the injected invokeFunction stub straight through to dynamodb.start', async () => {
  elasticmqAlreadyRunning();
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  const invokeFunction = async () => ({ status: 200 });
  let received;
  dynamodbTrigger.start = (fn, opts) => { received = opts.invokeFunction; return { stop: () => {} }; };
  const fn = store.create({ name: 'd1-di', path: '/tmp/d1-di', runtime: 'node',
    trigger: { type: 'dynamodb', tableName: 'tbl1-di', enabled: true } });

  await manager.sync(fn, { invokeFunction });

  assert.strictEqual(received, invokeFunction);
  manager.stop(fn.id);
  store.remove(fn.id);
});

test('sync is a no-op when the dynamodb trigger is already running against the same table', async () => {
  elasticmqAlreadyRunning();
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  let starts = 0;
  dynamodbTrigger.start = (fn, { onStatus }) => { starts++; onStatus({ state: 'polling', lastError: null }); return { stop: () => {} }; };
  const fn = store.create({ name: 'd2', path: '/tmp/d2', runtime: 'node',
    trigger: { type: 'dynamodb', tableName: 'tbl2', enabled: true } });

  await manager.sync(fn);
  await manager.sync(fn);

  assert.strictEqual(starts, 1);
  manager.stop(fn.id);
  store.remove(fn.id);
});

test('sync restarts the dynamodb poller when the table name changes', async () => {
  elasticmqAlreadyRunning();
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  const stopped = [];
  let n = 0;
  dynamodbTrigger.start = (fn, { onStatus }) => {
    n++;
    const id = n;
    onStatus({ state: 'polling', lastError: null });
    return { stop: () => stopped.push(id) };
  };
  let fn = store.create({ name: 'd3', path: '/tmp/d3', runtime: 'node',
    trigger: { type: 'dynamodb', tableName: 'tbl3', enabled: true } });
  await manager.sync(fn);
  fn = store.update(fn.id, { trigger: { type: 'dynamodb', tableName: 'tbl3-renamed', enabled: true } });
  await manager.sync(fn);

  assert.deepStrictEqual(stopped, [1]);
  assert.strictEqual(n, 2);
  manager.stop(fn.id);
  store.remove(fn.id);
});

test('sync stops the dynamodb poller when the trigger is disabled', async () => {
  elasticmqAlreadyRunning();
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  let stopped = false;
  dynamodbTrigger.start = (fn, { onStatus }) => { onStatus({ state: 'polling', lastError: null }); return { stop: () => { stopped = true; } }; };
  let fn = store.create({ name: 'd4', path: '/tmp/d4', runtime: 'node',
    trigger: { type: 'dynamodb', tableName: 'tbl4', enabled: true } });
  await manager.sync(fn);
  fn = store.update(fn.id, { trigger: { type: 'dynamodb', tableName: 'tbl4', enabled: false } });
  await manager.sync(fn);

  assert.strictEqual(stopped, true);
  assert.deepStrictEqual(manager.status(fn.id), { state: 'idle', lastError: null, lastPolledAt: null });
  store.remove(fn.id);
});

test('a dynamodb-local start failure is reported as an error status, not thrown', async () => {
  scenario({ inspect: { code: 1, stdout: '' }, run: { code: 125, stdout: 'port is already allocated' } });
  // Restore the real localServices.start to exercise the real docker-shim
  // failure path (the docker run command fails before ever reaching
  // waitReady, so this is fast — the next test re-mocks it immediately).
  localServices.start = originalLocalServicesStart;
  const fn = store.create({ name: 'd5', path: '/tmp/d5', runtime: 'node',
    trigger: { type: 'dynamodb', tableName: 'tbl5', enabled: true } });

  await manager.sync(fn);

  const st = manager.status(fn.id);
  assert.strictEqual(st.state, 'error');
  assert.match(st.lastError, /port is already allocated/);
  manager.stop(fn.id);
  store.remove(fn.id);
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
});

test('sync registers an HTTP route and starts the shared listener when a trigger is enabled', async () => {
  let calls = 0;
  let stopped = false;
  httpTrigger.createListener = async () => {
    calls++;
    return { stop: () => { stopped = true; }, server: { address: () => ({ port: 9500 }) } };
  };
  try {
    const fn = store.create({ name: 'h1', path: '/tmp/h1', runtime: 'node',
      trigger: { type: 'http', enabled: true } });

    await manager.sync(fn);

    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(manager.status(fn.id), { state: 'listening', lastError: null, lastPolledAt: null });
    manager.stop(fn.id);
    assert.strictEqual(stopped, true);
    assert.deepStrictEqual(manager.status(fn.id), { state: 'idle', lastError: null, lastPolledAt: null });
  } finally {
    httpTrigger.createListener = originalCreateListener;
  }
});

test('sync passes the injected invokeFunction stub straight through to httpTrigger.createListener', async () => {
  const invokeFunction = async () => ({ status: 200 });
  let received;
  httpTrigger.createListener = async (opts) => {
    received = opts.invokeFunction;
    return { stop: () => {}, server: { address: () => ({ port: 9500 }) } };
  };
  try {
    const fn = store.create({ name: 'h1-di', path: '/tmp/h1-di', runtime: 'node',
      trigger: { type: 'http', enabled: true } });

    await manager.sync(fn, { invokeFunction });

    assert.strictEqual(received, invokeFunction);
    manager.stop(fn.id);
  } finally {
    httpTrigger.createListener = originalCreateListener;
  }
});

test('the shared listener starts once and keeps running for the other function when one of several is disabled', async () => {
  let calls = 0;
  httpTrigger.createListener = async () => {
    calls++;
    return { stop: () => {}, server: { address: () => ({ port: 9500 }) } };
  };
  try {
    const a = store.create({ name: 'h2a', path: '/tmp/h2a', runtime: 'node', trigger: { type: 'http', enabled: true } });
    const b = store.create({ name: 'h2b', path: '/tmp/h2b', runtime: 'node', trigger: { type: 'http', enabled: true } });

    await manager.sync(a);
    await manager.sync(b);
    assert.strictEqual(calls, 1);

    manager.stop(a.id);
    assert.deepStrictEqual(manager.status(b.id), { state: 'listening', lastError: null, lastPolledAt: null });
    manager.stop(b.id);
  } finally {
    httpTrigger.createListener = originalCreateListener;
  }
});

test('two functions enabling their http trigger concurrently only start one listener', async () => {
  let calls = 0;
  let resolveStart;
  httpTrigger.createListener = () => new Promise((resolve) => {
    calls++;
    resolveStart = () => resolve({ stop: () => {}, server: { address: () => ({ port: 9500 }) } });
  });
  try {
    const a = store.create({ name: 'h3a', path: '/tmp/h3a', runtime: 'node', trigger: { type: 'http', enabled: true } });
    const b = store.create({ name: 'h3b', path: '/tmp/h3b', runtime: 'node', trigger: { type: 'http', enabled: true } });

    const p1 = manager.sync(a);
    const p2 = manager.sync(b);
    resolveStart();
    await Promise.all([p1, p2]);

    assert.strictEqual(calls, 1);
    manager.stop(a.id);
    manager.stop(b.id);
  } finally {
    httpTrigger.createListener = originalCreateListener;
  }
});

test('sync moves the route when the function is renamed while the trigger stays enabled', async () => {
  let calls = 0;
  const registered = [];
  httpTrigger.createListener = async ({ resolveFunctionId }) => {
    calls++;
    registered.push(resolveFunctionId);
    return { stop: () => {}, server: { address: () => ({ port: 9500 }) } };
  };
  try {
    let fn = store.create({ name: 'h4', path: '/tmp/h4', runtime: 'node', trigger: { type: 'http', enabled: true } });
    await manager.sync(fn);
    fn = store.update(fn.id, { name: 'h4-renamed' });
    await manager.sync(fn);

    assert.strictEqual(calls, 1, 'a rename must not restart the shared listener');
    const resolve = registered[0];
    assert.strictEqual(resolve('h4'), null, 'the old name must no longer route');
    assert.strictEqual(resolve('h4-renamed'), fn.id);
    manager.stop(fn.id);
  } finally {
    httpTrigger.createListener = originalCreateListener;
  }
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

test('a listener start failure is reported as an error status', async () => {
  httpTrigger.createListener = async () => { throw new Error('EADDRINUSE: address already in use 127.0.0.1:9500'); };
  try {
    const fn = store.create({ name: 'h6', path: '/tmp/h6', runtime: 'node', trigger: { type: 'http', enabled: true } });
    await manager.sync(fn);
    const st = manager.status(fn.id);
    assert.strictEqual(st.state, 'error');
    assert.match(st.lastError, /EADDRINUSE/);
    manager.stop(fn.id);
  } finally {
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

test('a function disabling its http trigger while the shared listener is still starting leaves no listener bound', async () => {
  let stopped = false;
  let resolveStart;
  httpTrigger.createListener = () => new Promise((resolve) => {
    resolveStart = () => resolve({ stop: () => { stopped = true; }, server: { address: () => ({ port: 9500 }) } });
  });
  try {
    const fn = store.create({ name: 'h8', path: '/tmp/h8', runtime: 'node', trigger: { type: 'http', enabled: true } });

    const syncPromise = manager.sync(fn); // don't await yet — createListener is still pending
    manager.stop(fn.id); // race: disable before the listener finishes starting
    resolveStart(); // now let the create resolve, with httpRoutes already empty
    await syncPromise;

    assert.strictEqual(stopped, true, 'the orphaned listener must be stopped once its create resolves');
    assert.deepStrictEqual(manager.status(fn.id), { state: 'idle', lastError: null, lastPolledAt: null });
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

test('sync registers an s3 route, starts MinIO, and configures the bucket when a trigger is enabled', async () => {
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  const calls = [];
  s3Trigger.ensureBucketConfig = async (bucket, hasWatchers) => { calls.push({ bucket, hasWatchers }); };
  try {
    const fn = store.create({ name: 's1', path: '/tmp/s1', runtime: 'node',
      trigger: { type: 's3', bucket: 'my-bucket', events: ['ObjectCreated'], enabled: true } });

    await manager.sync(fn);

    assert.deepStrictEqual(calls, [{ bucket: 'my-bucket', hasWatchers: true }]);
    assert.deepStrictEqual(manager.status(fn.id), { state: 'listening', lastError: null, lastPolledAt: null });
    assert.deepStrictEqual(manager.s3RoutesFor('my-bucket'),
      [{ functionId: fn.id, events: ['ObjectCreated'], prefix: undefined, suffix: undefined }]);

    manager.stop(fn.id);
    assert.deepStrictEqual(manager.s3RoutesFor('my-bucket'), []);
    // removeS3Route fires the hasWatchers:false ensureBucketConfig call through the
    // per-bucket queue, fire-and-forget — settle it before asserting on `calls`
    // (and, just as importantly, before `finally` restores the real one).
    await manager.drainBucketConfigQueue();
    assert.deepStrictEqual(calls[1], { bucket: 'my-bucket', hasWatchers: false });
  } finally {
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});

test('sync is a no-op when the s3 trigger is unchanged', async () => {
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  let calls = 0;
  s3Trigger.ensureBucketConfig = async () => { calls++; };
  try {
    const fn = store.create({ name: 's2', path: '/tmp/s2', runtime: 'node',
      trigger: { type: 's3', bucket: 'b2', events: ['ObjectCreated'], enabled: true } });
    await manager.sync(fn);
    await manager.sync(fn);
    assert.strictEqual(calls, 1);
    manager.stop(fn.id);
    await manager.drainBucketConfigQueue();
  } finally {
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});

test('sync reconfigures when the events, prefix, or suffix change', async () => {
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  let calls = 0;
  s3Trigger.ensureBucketConfig = async () => { calls++; };
  try {
    let fn = store.create({ name: 's3fn', path: '/tmp/s3fn', runtime: 'node',
      trigger: { type: 's3', bucket: 'b3', events: ['ObjectCreated'], enabled: true } });
    await manager.sync(fn);
    fn = store.update(fn.id,
      { trigger: { type: 's3', bucket: 'b3', events: ['ObjectCreated', 'ObjectRemoved'], enabled: true } });
    await manager.sync(fn);

    assert.strictEqual(calls, 2);
    assert.deepStrictEqual(manager.s3RoutesFor('b3'),
      [{ functionId: fn.id, events: ['ObjectCreated', 'ObjectRemoved'], prefix: undefined, suffix: undefined }]);
    manager.stop(fn.id);
    await manager.drainBucketConfigQueue();
  } finally {
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});

test('an events change is still detected when the stored list holds a duplicate', async () => {
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  let calls = 0;
  s3Trigger.ensureBucketConfig = async () => { calls++; };
  try {
    // Both validators dedupe now, so this can only come from data written
    // before they did — store.create writes it verbatim, no validation.
    // The old length + includes() comparison called this equal to
    // ['ObjectCreated', 'ObjectRemoved'] and silently skipped the update.
    let fn = store.create({ name: 's3dup', path: '/tmp/s3dup', runtime: 'node',
      trigger: { type: 's3', bucket: 'bdup', events: ['ObjectCreated', 'ObjectCreated'], enabled: true } });
    await manager.sync(fn);
    fn = store.update(fn.id,
      { trigger: { type: 's3', bucket: 'bdup', events: ['ObjectCreated', 'ObjectRemoved'], enabled: true } });
    await manager.sync(fn);

    assert.strictEqual(calls, 2);
    assert.deepStrictEqual(manager.s3RoutesFor('bdup'),
      [{ functionId: fn.id, events: ['ObjectCreated', 'ObjectRemoved'], prefix: undefined, suffix: undefined }]);
    manager.stop(fn.id);
    await manager.drainBucketConfigQueue();
  } finally {
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});

test('re-syncing an unchanged route whose stored events merely reordered is still a no-op', async () => {
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  let calls = 0;
  s3Trigger.ensureBucketConfig = async () => { calls++; };
  try {
    let fn = store.create({ name: 's3reorder', path: '/tmp/s3reorder', runtime: 'node',
      trigger: { type: 's3', bucket: 'breorder', events: ['ObjectCreated', 'ObjectRemoved'], enabled: true } });
    await manager.sync(fn);
    fn = store.update(fn.id,
      { trigger: { type: 's3', bucket: 'breorder', events: ['ObjectRemoved', 'ObjectCreated'], enabled: true } });
    await manager.sync(fn);

    assert.strictEqual(calls, 1);
    manager.stop(fn.id);
    await manager.drainBucketConfigQueue();
  } finally {
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});

test('sync stops the route and clears the bucket config when the trigger is disabled', async () => {
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  const calls = [];
  s3Trigger.ensureBucketConfig = async (bucket, hasWatchers) => { calls.push({ bucket, hasWatchers }); };
  try {
    let fn = store.create({ name: 's4', path: '/tmp/s4', runtime: 'node',
      trigger: { type: 's3', bucket: 'b4', events: ['ObjectCreated'], enabled: true } });
    await manager.sync(fn);
    fn = store.update(fn.id, { trigger: { type: 's3', bucket: 'b4', events: ['ObjectCreated'], enabled: false } });
    await manager.sync(fn);
    await manager.drainBucketConfigQueue();

    assert.deepStrictEqual(manager.s3RoutesFor('b4'), []);
    assert.deepStrictEqual(manager.status(fn.id), { state: 'idle', lastError: null, lastPolledAt: null });
    assert.deepStrictEqual(calls[calls.length - 1], { bucket: 'b4', hasWatchers: false });
  } finally {
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});

test('the bucket config is only cleared once the last function watching it is removed', async () => {
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  const calls = [];
  s3Trigger.ensureBucketConfig = async (bucket, hasWatchers) => { calls.push({ bucket, hasWatchers }); };
  try {
    const a = store.create({ name: 's5a', path: '/tmp/s5a', runtime: 'node',
      trigger: { type: 's3', bucket: 'shared', events: ['ObjectCreated'], enabled: true } });
    const b = store.create({ name: 's5b', path: '/tmp/s5b', runtime: 'node',
      trigger: { type: 's3', bucket: 'shared', events: ['ObjectRemoved'], enabled: true } });
    await manager.sync(a);
    await manager.sync(b);

    manager.stop(a.id);
    assert.deepStrictEqual(manager.s3RoutesFor('shared'),
      [{ functionId: b.id, events: ['ObjectRemoved'], prefix: undefined, suffix: undefined }]);
    assert.strictEqual(calls.filter((c) => c.hasWatchers === false).length, 0);

    manager.stop(b.id);
    assert.deepStrictEqual(manager.s3RoutesFor('shared'), []);
    // Same fire-and-forget queued call as above — settle it before asserting.
    await manager.drainBucketConfigQueue();
    assert.strictEqual(calls.filter((c) => c.hasWatchers === false).length, 1);
  } finally {
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});

test('a MinIO start failure is reported as an error status, not thrown', async () => {
  localServices.start = async () => ({ ok: false, state: 'stopped', output: 'port is already allocated' });
  // Stubbed even though the failing start means no enable-path call: the
  // manager.stop() below still queues the disable-path clear, which would
  // otherwise reach a real MinIO over the network.
  s3Trigger.ensureBucketConfig = async () => {};
  try {
    const fn = store.create({ name: 's6', path: '/tmp/s6', runtime: 'node',
      trigger: { type: 's3', bucket: 'b6', events: ['ObjectCreated'], enabled: true } });
    await manager.sync(fn);
    const st = manager.status(fn.id);
    assert.strictEqual(st.state, 'error');
    assert.match(st.lastError, /port is already allocated/);
    manager.stop(fn.id);
    await manager.drainBucketConfigQueue();
  } finally {
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});

test('a bucket-config failure is reported as an error status, not thrown', async () => {
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  s3Trigger.ensureBucketConfig = async () => { throw new Error('MinIO not running'); };
  const originalWarn = console.warn; // the disable path below logs; asserted on in its own test
  console.warn = () => {};
  try {
    const fn = store.create({ name: 's7', path: '/tmp/s7', runtime: 'node',
      trigger: { type: 's3', bucket: 'b7', events: ['ObjectCreated'], enabled: true } });
    await manager.sync(fn);
    const st = manager.status(fn.id);
    assert.strictEqual(st.state, 'error');
    assert.match(st.lastError, /MinIO not running/);
    manager.stop(fn.id);
    await manager.drainBucketConfigQueue();
  } finally {
    console.warn = originalWarn;
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});

test('a failure to clear a bucket config on disable is logged rather than swallowed', async () => {
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  s3Trigger.ensureBucketConfig = async (bucket, hasWatchers) => {
    if (!hasWatchers) throw new Error('MinIO not running');
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    const fn = store.create({ name: 's7b', path: '/tmp/s7b', runtime: 'node',
      trigger: { type: 's3', bucket: 'b7b', events: ['ObjectCreated'], enabled: true } });
    await manager.sync(fn);
    manager.stop(fn.id);
    await manager.drainBucketConfigQueue();

    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /b7b/);
    assert.match(warnings[0], /MinIO not running/);
  } finally {
    console.warn = originalWarn;
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
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

test('disabling then immediately re-enabling an s3 trigger on the same bucket keeps ensureBucketConfig calls strictly ordered', async () => {
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  const calls = [];
  let releaseDisableCall;
  const disableGate = new Promise((resolve) => { releaseDisableCall = resolve; });
  // Only the disable call (hasWatchers: false) is delayed — this simulates the
  // disable's real network call being slow (e.g. SDK retry/backoff) while the
  // re-enable races ahead with more synchronous work of its own (starting MinIO).
  // If ensureBucketConfig calls for the same bucket weren't serialized, the
  // re-enable's call could resolve first and then be clobbered when the slow
  // disable call finally lands, leaving the bucket's live config empty.
  s3Trigger.ensureBucketConfig = async (bucket, hasWatchers) => {
    if (hasWatchers === false) await disableGate;
    calls.push({ bucket, hasWatchers });
  };
  try {
    let fn = store.create({ name: 's10', path: '/tmp/s10', runtime: 'node',
      trigger: { type: 's3', bucket: 'race-bucket', events: ['ObjectCreated'], enabled: true } });
    await manager.sync(fn);

    fn = store.update(fn.id,
      { trigger: { type: 's3', bucket: 'race-bucket', events: ['ObjectCreated'], enabled: false } });
    const disableSync = manager.sync(fn); // fires the (delayed) hasWatchers:false call, fire-and-forget

    fn = store.update(fn.id,
      { trigger: { type: 's3', bucket: 'race-bucket', events: ['ObjectCreated'], enabled: true } });
    const enableSync = manager.sync(fn); // must queue its hasWatchers:true call behind the pending disable call

    releaseDisableCall();
    await Promise.all([disableSync, enableSync]);

    assert.deepStrictEqual(calls, [
      { bucket: 'race-bucket', hasWatchers: true },
      { bucket: 'race-bucket', hasWatchers: false },
      { bucket: 'race-bucket', hasWatchers: true },
    ]);
    assert.deepStrictEqual(manager.s3RoutesFor('race-bucket'),
      [{ functionId: fn.id, events: ['ObjectCreated'], prefix: undefined, suffix: undefined }]);
    manager.stop(fn.id);
    await manager.drainBucketConfigQueue();
  } finally {
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});

test('a failed S3 listener bind is surfaced as an error status on every s3-triggered function', async () => {
  localServices.start = async () => ({ ok: true, state: 'running', output: '' });
  s3Trigger.ensureBucketConfig = async () => {};
  try {
    const fn = store.create({ name: 's11', path: '/tmp/s11', runtime: 'node',
      trigger: { type: 's3', bucket: 'b11', events: ['ObjectCreated'], enabled: true } });
    await manager.sync(fn);
    assert.deepStrictEqual(manager.status(fn.id), { state: 'listening', lastError: null, lastPolledAt: null });

    // bin/cli.js reports the shared listener's bind failure in here; without
    // it the function would keep claiming 'listening' with nothing able to
    // reach it.
    manager.setS3ListenerError(new Error('EADDRINUSE: address already in use 127.0.0.1:9501'));
    assert.deepStrictEqual(manager.status(fn.id), {
      state: 'error',
      lastError: 'EADDRINUSE: address already in use 127.0.0.1:9501',
      lastPolledAt: null,
    });
    assert.deepStrictEqual(manager.statusAll()[fn.id], manager.status(fn.id));

    manager.stop(fn.id);
    await manager.drainBucketConfigQueue();
    // Nothing is registered any more, so the dead listener stops colouring it.
    assert.deepStrictEqual(manager.status(fn.id), { state: 'idle', lastError: null, lastPolledAt: null });
  } finally {
    manager.setS3ListenerError(null);
    localServices.start = originalLocalServicesStart;
    s3Trigger.ensureBucketConfig = originalEnsureBucketConfig;
  }
});
