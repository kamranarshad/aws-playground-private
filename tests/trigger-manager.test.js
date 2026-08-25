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
const originalCreateListener = httpTrigger.createListener;

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
