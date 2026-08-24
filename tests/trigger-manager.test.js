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
const manager = require('../server/trigger/manager');

test('sync starts elasticmq and the poll loop when a trigger is enabled', async () => {
  elasticmqAlreadyRunning();
  const stop = () => { stop.called = true; };
  sqs.start = (fn, { onStatus }) => { onStatus({ state: 'polling', lastError: null }); return { stop }; };
  const fn = store.create({ name: 'f1', path: '/tmp/f1', runtime: 'node',
    trigger: { type: 'sqs', queueName: 'q1', enabled: true } });

  await manager.sync(fn);

  assert.deepStrictEqual(manager.status(fn.id), { state: 'polling', lastError: null, lastPolledAt: null });
  manager.stop(fn.id);
  assert.strictEqual(stop.called, true);
});

test('sync is a no-op when the trigger is already running with the same queue', async () => {
  elasticmqAlreadyRunning();
  let starts = 0;
  sqs.start = (fn, { onStatus }) => { starts++; onStatus({ state: 'polling', lastError: null }); return { stop: () => {} }; };
  const fn = store.create({ name: 'f2', path: '/tmp/f2', runtime: 'node',
    trigger: { type: 'sqs', queueName: 'q2', enabled: true } });

  await manager.sync(fn);
  await manager.sync(fn);

  assert.strictEqual(starts, 1);
  manager.stop(fn.id);
});

test('sync restarts the loop when the queue name changes', async () => {
  elasticmqAlreadyRunning();
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
});

test('sync stops the loop when the trigger is disabled', async () => {
  elasticmqAlreadyRunning();
  let stopped = false;
  sqs.start = (fn, { onStatus }) => { onStatus({ state: 'polling', lastError: null }); return { stop: () => { stopped = true; } }; };
  let fn = store.create({ name: 'f4', path: '/tmp/f4', runtime: 'node',
    trigger: { type: 'sqs', queueName: 'q4', enabled: true } });
  await manager.sync(fn);
  fn = store.update(fn.id, { trigger: { type: 'sqs', queueName: 'q4', enabled: false } });
  await manager.sync(fn);

  assert.strictEqual(stopped, true);
  assert.deepStrictEqual(manager.status(fn.id), { state: 'idle', lastError: null, lastPolledAt: null });
});

test('a service start failure is reported as an error status, not thrown', async () => {
  scenario({ inspect: { code: 1, stdout: '' }, run: { code: 125, stdout: 'port is already allocated' } });
  const fn = store.create({ name: 'f5', path: '/tmp/f5', runtime: 'node',
    trigger: { type: 'sqs', queueName: 'q5', enabled: true } });

  await manager.sync(fn);

  const st = manager.status(fn.id);
  assert.strictEqual(st.state, 'error');
  assert.match(st.lastError, /port is already allocated/);
  manager.stop(fn.id);
});

test('resumeAll starts a poller for every function with an enabled trigger; stopAll tears them all down', async () => {
  elasticmqAlreadyRunning();
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
});
